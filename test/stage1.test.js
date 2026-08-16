import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.js";
import { createIngestor } from "../src/ingest.js";
import { PersistentQueue } from "../src/queue.js";
import {
  createReadOnlySheets,
  ReadOnlySheetsError,
} from "../src/sheets.js";
import { createWebhookServer } from "../src/webhook.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function telegramUpdate(updateId, overrides = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 123 },
      chat: { id: 123 },
      text: `message ${updateId}`,
      ...overrides,
    },
  };
}

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "running-coach-stage1-"));
  const databasePath = join(directory, "test.sqlite");
  t.after(() => {
    const safePrefix = resolve(tmpdir()).toLowerCase();
    const resolvedDirectory = resolve(directory).toLowerCase();
    if (resolvedDirectory.startsWith(safePrefix)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return databasePath;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail("Timed out waiting for condition");
}

test("duplicate Telegram updates are raw-logged and queued only once", () => {
  const db = openDatabase(":memory:");
  const queue = new PersistentQueue(db);
  const ingestor = createIngestor({ db, queue });

  const first = ingestor.ingest(telegramUpdate(100));
  const duplicate = ingestor.ingest(telegramUpdate(100));

  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM raw_log").get().count, 1);
  assert.equal(queue.count(), 1);
  db.close();
});

test("raw update remains durable when enqueueing fails", () => {
  const db = openDatabase(":memory:");
  const brokenQueue = {
    enqueueUpdate() {
      throw new Error("simulated queue failure");
    },
  };
  const ingestor = createIngestor({ db, queue: brokenQueue });

  assert.throws(() => ingestor.ingest(telegramUpdate(101)), /queue failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM raw_log").get().count, 1);
  db.close();
});

test("four photos in one media group become one delayed queue item", async () => {
  let currentTime = 1_000;
  const now = () => currentTime;
  const db = openDatabase(":memory:");
  const queue = new PersistentQueue(db, { now });
  const ingestor = createIngestor({ db, queue, now, albumWindowMs: 2_000 });

  for (let index = 0; index < 4; index += 1) {
    ingestor.ingest(telegramUpdate(200 + index, {
      text: undefined,
      media_group_id: "album-1",
      photo: [{ file_id: `photo-${index}` }],
    }));
    currentTime += 100;
  }

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM raw_log").get().count, 4);
  assert.equal(queue.count(), 1);
  assert.equal(queue.claimNext(), null);

  currentTime = 3_300;
  const claimed = queue.claimNext();
  assert.equal(claimed.payload.kind, "album");
  assert.equal(claimed.payload.updates.length, 4);
  queue.complete(claimed.id);
  assert.equal(queue.count("done"), 1);
  db.close();
});

test("a photo arriving after its album is claimed gets a separate queue item", () => {
  let currentTime = 1_000;
  const now = () => currentTime;
  const db = openDatabase(":memory:");
  const queue = new PersistentQueue(db, { now });
  const ingestor = createIngestor({ db, queue, now, albumWindowMs: 2_000 });

  ingestor.ingest(telegramUpdate(250, {
    text: undefined,
    media_group_id: "album-late",
    photo: [{ file_id: "photo-first" }],
  }));

  currentTime = 3_000;
  const album = queue.claimNext();
  assert.equal(album.status, "processing");
  assert.equal(album.payload.kind, "album");

  const lateResult = ingestor.ingest(telegramUpdate(251, {
    text: undefined,
    media_group_id: "album-late",
    photo: [{ file_id: "photo-late" }],
  }));

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM raw_log").get().count, 2);
  assert.equal(queue.count(), 2);
  assert.equal(queue.count("processing"), 1);
  assert.equal(queue.count("pending"), 1);
  assert.notEqual(lateResult.queueId, album.id);

  const lateItem = queue.getById(lateResult.queueId);
  assert.equal(lateItem.dedupeKey, "late:album-late:251");
  assert.equal(lateItem.payload.kind, "update");
  assert.equal(lateItem.payload.update.update_id, 251);
  assert.equal(lateItem.payload.late, true);
  assert.equal(lateItem.payload.lateArrivalFor, "album-late");

  queue.complete(album.id);
  const claimedLateItem = queue.claimNext();
  assert.equal(claimedLateItem.id, lateResult.queueId);
  queue.complete(claimedLateItem.id);
  db.close();
});

test("an item claimed before shutdown is recovered and processed after restart", async (t) => {
  const databasePath = temporaryDatabase(t);
  let db = openDatabase(databasePath);
  let queue = new PersistentQueue(db);
  const ingestor = createIngestor({ db, queue });

  ingestor.ingest(telegramUpdate(300));
  const claimed = queue.claimNext();
  assert.equal(claimed.status, "processing");
  db.close();

  db = openDatabase(databasePath);
  queue = new PersistentQueue(db);
  let processed = 0;
  assert.equal(queue.getById(claimed.id).status, "pending");
  await queue.processOne(async () => {
    processed += 1;
  });

  assert.equal(processed, 1);
  assert.equal(queue.getById(claimed.id).status, "done");
  db.close();
});

test("restart recovery cannot exceed maxAttempts", async (t) => {
  const databasePath = temporaryDatabase(t);
  let currentTime = 1_000;
  const now = () => currentTime;
  let db = openDatabase(databasePath);
  let queue = new PersistentQueue(db, { maxAttempts: 3, now, retryMs: 10 });
  const ingestor = createIngestor({ db, queue, now });

  ingestor.ingest(telegramUpdate(301));
  for (let attempt = 1; attempt < 3; attempt += 1) {
    const claimed = queue.claimNext();
    assert.equal(claimed.attempts, attempt);
    queue.fail(claimed, new Error(`failure ${attempt}`));
    currentTime += 10;
  }

  const claimedFinalAttempt = queue.claimNext();
  assert.equal(claimedFinalAttempt.attempts, 3);
  assert.equal(claimedFinalAttempt.status, "processing");
  db.close();

  db = openDatabase(databasePath);
  assert.equal(
    db.prepare("SELECT status FROM queue WHERE id = ?").get(claimedFinalAttempt.id).status,
    "processing",
  );

  queue = new PersistentQueue(db, { maxAttempts: 3, now });
  const recovered = queue.getById(claimedFinalAttempt.id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.attempts, 3);
  assert.match(recovered.error, /Maximum attempts reached during restart recovery/);

  // Also clean up state left pending by the older, unsafe recovery behavior.
  db.prepare("UPDATE queue SET status = 'pending' WHERE id = ?")
    .run(claimedFinalAttempt.id);
  queue = new PersistentQueue(db, { maxAttempts: 3, now });
  assert.equal(queue.getById(claimedFinalAttempt.id).status, "failed");

  let processed = 0;
  assert.equal(await queue.processOne(async () => { processed += 1; }), false);
  assert.equal(processed, 0);
  db.close();
});

test("webhook responds after durable enqueue without waiting for processing", async (t) => {
  const db = openDatabase(":memory:");
  const queue = new PersistentQueue(db, { pollMs: 10 });
  const ingestor = createIngestor({ db, queue });
  let releaseProcessor;
  const processorGate = new Promise((resolvePromise) => {
    releaseProcessor = resolvePromise;
  });
  queue.start(async () => processorGate);

  const server = createWebhookServer({ ingestor, queue });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => {
    queue.stop();
    server.close();
    db.close();
  });

  const { port } = server.address();
  const response = await Promise.race([
    fetch(`http://127.0.0.1:${port}/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramUpdate(400)),
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("webhook waited for processor")), 500),
    ),
  ]);

  assert.equal(response.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM raw_log").get().count, 1);
  assert.equal(queue.count(), 1);
  releaseProcessor();
  await waitFor(() => queue.count("done") === 1);
});

test("sheets adapter reads local demo data and rejects all writes", async () => {
  const sheets = createReadOnlySheets(join(projectRoot, "data", "demo-sheets.json"));
  const runs = await sheets.read("Runs");

  assert.equal(runs.length, 1);
  assert.equal(runs[0]["Workout Type"], "Demo Run");
  await assert.rejects(() => sheets.write("Runs", {}), ReadOnlySheetsError);
  await assert.rejects(() => sheets.update("Runs", 1, {}), ReadOnlySheetsError);
});
