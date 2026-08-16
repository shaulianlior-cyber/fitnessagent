import assert from "node:assert/strict";
import test from "node:test";
import {
  BudgetExceededError,
  ModelTokenBudget,
  PersistentDailyModelTokenBudget,
} from "../src/budget.js";
import { createCoach } from "../src/coach.js";
import { openDatabase } from "../src/db.js";
import { createExtractionWorkflow } from "../src/extract.js";
import { MemoryStore, createSessionSummarizer } from "../src/memory.js";
import { createAnthropicClient, createBudgetedModel } from "../src/model.js";
import { createStageThreeProcessor } from "../src/processor.js";
import { routeEvent } from "../src/router.js";
import {
  OutboxStore,
  StageThreeEventStore,
  TELEGRAM_TEXT_LIMIT,
  outboundMessagesForResult,
} from "../src/runtime_store.js";
import { createStageThreeEngine } from "../src/stage3.js";
import { createTelegramClient } from "../src/telegram.js";
import { ReadOnlySheetsError } from "../src/sheets.js";

const NOW = () => new Date("2026-08-16T10:00:00.000Z");
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function queueMessage(text = "נתח את הריצה") {
  return {
    kind: "update",
    update: {
      update_id: 501,
      message: { chat: { id: 99 }, from: { id: 7 }, text },
    },
  };
}

function engineServices(db, model) {
  return {
    memory: new MemoryStore(db, { now: NOW }),
    coach: createCoach({ model }),
    summarizer: createSessionSummarizer({ model }),
    extractionWorkflow: createExtractionWorkflow({
      db,
      sheets: { write: async () => {} },
      extractor: { extract: async () => assert.fail("unexpected extraction") },
      now: NOW,
    }),
    mediaResolver: { resolve: async () => [] },
    eventStore: new StageThreeEventStore(db, { now: NOW }),
  };
}

test("queue-shaped callback data reaches the extraction update route", () => {
  const event = {
    kind: "update",
    update: {
      callback_query: {
        data: "confirm_extraction:42",
        from: { id: 7 },
        message: { chat: { id: 99 } },
      },
    },
  };
  assert.deepEqual(routeEvent(event), {
    handler: "update",
    params: { update: "confirm_extraction", pendingId: 42 },
  });
});

test("a time-only workout recommendation fails closed into deterministic rules", async () => {
  assert.deepEqual(routeEvent({ text: "מה כדאי לעשות מחר?" }), {
    handler: "chat",
    params: { text: "מה כדאי לעשות מחר?", workout: {} },
  });
  const db = openDatabase(":memory:");
  let modelCalls = 0;
  const services = engineServices(db, {
    async generate() {
      modelCalls += 1;
      throw new Error("blocked requests must not call the model");
    },
  });
  const engine = createStageThreeEngine({
    stateProvider: async () => ({ counters: {} }),
    asOfProvider: () => "2026-08-16",
    ...services,
  });
  const result = await engine.handle({ text: "מה כדאי לעשות מחר?", userId: "7" });
  assert.equal(result.verdict.verdict, "block");
  assert.equal(result.verdict.ruleId, "load_change_required");
  assert.equal(modelCalls, 0);
  for (const text of [
    "תבנה לי תוכנית למחר",
    "איזה אימון לעשות מחר?",
    "תן לי ריצה למחר",
    "מחר אני רוצה לרוץ יותר",
  ]) {
    const routed = routeEvent({ text });
    assert.deepEqual(routed.params.workout, {}, text);
    const blocked = await engine.handle({ text, userId: "7" });
    assert.equal(blocked.verdict.verdict, "block", text);
  }
  db.close();
});

test("token preflight reserves actual input plus maximum output before generation", async () => {
  let generateCalls = 0;
  const base = {
    countTokens: async () => 8_000,
    generate: async () => {
      generateCalls += 1;
      return { text: "should not run", usage: USAGE };
    },
  };
  const model = createBudgetedModel({ model: base, budget: new ModelTokenBudget(8_192) });
  await assert.rejects(
    () => model.generate({ tier: "sonnet", messages: [], maxTokens: 1_024 }),
    BudgetExceededError,
  );
  assert.equal(generateCalls, 0);

  const budget = new ModelTokenBudget(2_000);
  const allowed = createBudgetedModel({
    model: {
      countTokens: async () => 600,
      generate: async () => ({ text: "ok", usage: USAGE }),
    },
    budget,
  });
  const result = await allowed.generate({ tier: "haiku", messages: [], maxTokens: 400 });
  assert.deepEqual(result.budget, {
    inputTokens: 600,
    maxOutputTokens: 400,
    reservedTokens: 1_000,
  });
  assert.equal(budget.used, 1_000);
});

test("Anthropic token preflight uses the count-tokens endpoint without generating", async () => {
  let request;
  const client = createAnthropicClient({
    apiKey: "test-key",
    endpoint: "https://anthropic.test/v1/messages",
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ input_tokens: 321 }));
    },
  });
  const count = await client.countTokens({
    tier: "haiku",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(count, 321);
  assert.equal(request.url, "https://anthropic.test/v1/messages/count_tokens");
  assert.equal(Object.hasOwn(request.body, "max_tokens"), false);
});

test("daily model budget survives restart, resets on the next UTC day, and notifies the user", async () => {
  const db = openDatabase(":memory:");
  let current = new Date("2026-08-16T23:59:00.000Z");
  const first = new PersistentDailyModelTokenBudget(db, {
    ceiling: 100,
    now: () => current,
  });
  first.reserveTokens(40);
  const afterRestart = new PersistentDailyModelTokenBudget(db, {
    ceiling: 100,
    now: () => current,
  });
  assert.equal(afterRestart.used, 40);
  assert.throws(() => afterRestart.reserveTokens(61), BudgetExceededError);

  let countCalls = 0;
  const model = createBudgetedModel({
    budget: afterRestart,
    model: {
      countTokens: async () => { countCalls += 1; return 1; },
      generate: async () => assert.fail("exhausted budget generated a response"),
    },
  });
  const services = engineServices(db, model);
  const engine = createStageThreeEngine({
    stateProvider: async () => ({ counters: {} }),
    asOfProvider: () => "2026-08-16",
    ...services,
  });
  const result = await engine.handle({ text: "נתח את הריצה", userId: "7" });
  assert.equal(result.status, "budget_exhausted");
  assert.match(result.answer.text, /התקציב היומי/);
  assert.equal(countCalls, 0);
  assert.equal(services.memory.recent("7").length, 2);

  current = new Date("2026-08-17T00:01:00.000Z");
  assert.equal(afterRestart.used, 0);
  assert.equal(afterRestart.remaining, 100);
  db.close();
});

test("a Telegram send retry reuses the saved result and outbox without another model call", async () => {
  const db = openDatabase(":memory:");
  const replies = [
    "תשובת מאמן",
    JSON.stringify({ summary: "סיכום", openItems: [] }),
  ];
  let modelCalls = 0;
  const model = {
    async generate() {
      modelCalls += 1;
      return { text: replies.shift(), usage: USAGE };
    },
  };
  const services = engineServices(db, model);
  const engine = createStageThreeEngine({
    stateProvider: async () => ({ counters: {} }),
    asOfProvider: () => "2026-08-16",
    ...services,
  });
  const outbox = new OutboxStore(db, { now: NOW });
  let sends = 0;
  const telegram = {
    async sendMessage() {
      sends += 1;
      if (sends === 1) throw new Error("temporary Telegram failure");
    },
  };
  const processor = createStageThreeProcessor({ engine, outbox, telegram, logger: {} });
  const item = { id: 17, payload: queueMessage() };

  await assert.rejects(() => processor(item), /temporary Telegram failure/);
  const result = await processor(item);

  assert.equal(result.answer.text, "תשובת מאמן");
  assert.equal(modelCalls, 2);
  assert.equal(services.memory.recent("7").length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stage3_events").get().count, 1);
  assert.deepEqual(outbox.get("queue:17:message"), {
    dedupeKey: "queue:17:message",
    chatId: "99",
    text: "תשובת מאמן",
    replyMarkup: null,
    status: "sent",
    attempts: 2,
    error: null,
    createdAt: "2026-08-16T10:00:00.000Z",
    sentAt: "2026-08-16T10:00:00.000Z",
  });
  db.close();
});

test("processor sends long answers in ordered idempotent outbox chunks", async () => {
  const db = openDatabase(":memory:");
  const answer = "א".repeat(TELEGRAM_TEXT_LIMIT * 2 + 17);
  const engine = {
    handle: async () => ({ route: { handler: "chat" }, answer: { text: answer }, tokenUsage: 0 }),
  };
  const outbox = new OutboxStore(db, { now: NOW });
  const sent = [];
  const telegram = { sendMessage: async ({ text }) => sent.push(text) };
  const processor = createStageThreeProcessor({ engine, outbox, telegram, logger: {} });
  const item = { id: 19, payload: queueMessage() };
  await processor(item);
  await processor(item);
  assert.equal(sent.length, 3);
  assert.equal(sent.join(""), answer);
  assert.ok(sent.every((text) => Array.from(text).length <= TELEGRAM_TEXT_LIMIT));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM outbox").get().count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'sent'").get().count, 3);
  db.close();
});

test("a retry after a saved coach answer skips both coach and summarizer models", async () => {
  const db = openDatabase(":memory:");
  let modelCalls = 0;
  const services = engineServices(db, {
    async generate() {
      modelCalls += 1;
      throw new Error("retry must not call a model");
    },
  });
  services.memory.addMessage({
    userId: "7",
    role: "user",
    content: "נתח את הריצה",
    sourceKey: "queue:18:user",
  });
  services.memory.addMessage({
    userId: "7",
    role: "assistant",
    content: "תשובה שכבר נשמרה",
    sourceKey: "queue:18:assistant",
  });
  const engine = createStageThreeEngine({
    stateProvider: async () => ({ counters: {} }),
    asOfProvider: () => "2026-08-16",
    ...services,
  });
  const result = await engine.handle(queueMessage(), { eventKey: "queue:18" });
  assert.equal(result.answer.text, "תשובה שכבר נשמרה");
  assert.equal(result.sessionStatus, "retry_skipped");
  assert.equal(modelCalls, 0);
  assert.equal(services.memory.recent("7").length, 2);
  db.close();
});

test("an extraction event key prevents duplicate model work and pending rows", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const workflow = createExtractionWorkflow({
    db,
    sheets: { write: async () => {} },
    extractor: {
      async extract() {
        calls += 1;
        return {
          row: { Date: "2026-08-16", "Workout Type": "Easy", Source: "ocr" },
          missing: [],
          errors: [],
          confidence: 0.9,
          usage: USAGE,
          budget: { inputTokens: 500, maxOutputTokens: 100, reservedTokens: 600 },
        };
      },
    },
    now: NOW,
  });
  const request = {
    userId: "7",
    images: [{ mediaType: "image/jpeg", data: "abc" }],
    asOf: "2026-08-16",
    eventKey: "queue:44",
  };
  const first = await workflow.submit(request);
  const second = await workflow.submit(request);
  assert.equal(first.pendingId, second.pendingId);
  assert.equal(second.budget.reservedTokens, 600);
  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pending_extractions").get().count, 1);
  db.close();
});

test("long history search is memory-safe and splits into Telegram-sized messages", async () => {
  const db = openDatabase(":memory:");
  const services = engineServices(db, {
    async generate() {
      assert.fail("history search must not call the model");
    },
  });
  for (let index = 0; index < 5; index += 1) {
    services.memory.addMessage({
      userId: "12",
      role: "user",
      content: `נעליים ${"א".repeat(5_000)}`,
    });
  }
  const engine = createStageThreeEngine({
    stateProvider: async () => ({ counters: {} }),
    asOfProvider: () => "2026-08-16",
    ...services,
  });
  const result = await engine.handle({ userId: "12", text: "מה אמרנו על נעליים?" });
  const messages = outboundMessagesForResult(result);
  assert.ok(result.answer.text.length > TELEGRAM_TEXT_LIMIT);
  assert.ok(messages.length > 1);
  assert.ok(messages.every(({ text }) => Array.from(text).length <= TELEGRAM_TEXT_LIMIT));
  assert.equal(messages.map(({ text }) => text).join(""), result.answer.text);
  assert.ok(services.memory.recent("12").at(-1).content.length <= 8_000);
  db.close();
});

test("an ambiguous Sheets response locks confirmation and cannot write twice", async () => {
  const db = openDatabase(":memory:");
  let writes = 0;
  const workflow = createExtractionWorkflow({
    db,
    sheets: {
      async write() {
        writes += 1;
        throw new Error("connection closed after request");
      },
    },
    extractor: {
      extract: async () => ({
        row: { Date: "2026-08-16", "Workout Type": "Easy", Source: "ocr" },
        missing: [], errors: [], confidence: 1, usage: null,
      }),
    },
    now: NOW,
  });
  const pending = await workflow.submit({ userId: "7", images: [{}], asOf: "2026-08-16" });
  const engine = createStageThreeEngine({
    stateProvider: async () => ({ counters: {} }),
    asOfProvider: () => "2026-08-16",
    memory: new MemoryStore(db, { now: NOW }),
    coach: {}, summarizer: {}, extractionWorkflow: workflow, mediaResolver: {},
    eventStore: new StageThreeEventStore(db, { now: NOW }),
  });
  const event = { userId: "7", text: `confirm_extraction:${pending.pendingId}` };
  const first = await engine.handle(event);
  const second = await engine.handle(event);
  assert.equal(first.status, "write_ambiguous");
  assert.equal(second.status, "write_ambiguous");
  assert.match(first.answer.text, /לא אנסה לכתוב שוב/);
  assert.equal(writes, 1);
  const stored = db.prepare(
    "SELECT status, write_started_at, write_error FROM pending_extractions WHERE id = ?",
  ).get(pending.pendingId);
  assert.equal(stored.status, "pending");
  assert.equal(stored.write_started_at, "2026-08-16T10:00:00.000Z");
  assert.match(stored.write_error, /connection closed/);
  db.close();
});

test("known no-write Sheets failures return a demo notice and remain retryable", async () => {
  const db = openDatabase(":memory:");
  const workflow = createExtractionWorkflow({
    db,
    sheets: { write: async () => { throw new ReadOnlySheetsError("write"); } },
    extractor: {
      extract: async () => ({
        row: { Date: "2026-08-16", "Workout Type": "Easy", Source: "ocr" },
        missing: [], errors: [], confidence: 1, usage: null,
      }),
    },
    now: NOW,
  });
  const pending = await workflow.submit({ userId: "7", images: [{}], asOf: "2026-08-16" });
  const engine = createStageThreeEngine({
    stateProvider: async () => ({ counters: {} }),
    asOfProvider: () => "2026-08-16",
    memory: new MemoryStore(db, { now: NOW }),
    coach: {}, summarizer: {}, extractionWorkflow: workflow, mediaResolver: {},
    eventStore: new StageThreeEventStore(db, { now: NOW }),
  });
  const result = await engine.handle({
    userId: "7",
    text: `confirm_extraction:${pending.pendingId}`,
  });
  assert.equal(result.status, "write_unavailable");
  assert.match(result.answer.text, /סביבת הדמו/);
  const stored = db.prepare(
    "SELECT status, write_started_at FROM pending_extractions WHERE id = ?",
  ).get(pending.pendingId);
  assert.equal(stored.status, "pending");
  assert.equal(stored.write_started_at, null);
  db.close();
});

test("Telegram client sends inline keyboards as JSON", async () => {
  let request;
  const client = createTelegramClient({
    botToken: "secret",
    apiRoot: "https://telegram.test",
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    },
  });
  const replyMarkup = {
    inline_keyboard: [[{ text: "אישור", callback_data: "confirm_extraction:1" }]],
  };
  await client.sendMessage({ chatId: 99, text: "בדיקה", replyMarkup });
  assert.equal(request.url, "https://telegram.test/botsecret/sendMessage");
  assert.deepEqual(request.body, { chat_id: "99", text: "בדיקה", reply_markup: replyMarkup });
  await assert.rejects(
    () => client.sendMessage({ chatId: 99, text: "א".repeat(TELEGRAM_TEXT_LIMIT + 1) }),
    /exceeds 4096/,
  );
});
