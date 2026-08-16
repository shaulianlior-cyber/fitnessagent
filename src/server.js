import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelTokenBudget } from "./budget.js";
import { createCoach } from "./coach.js";
import { openDatabase } from "./db.js";
import { createExtractionWorkflow, createWorkoutExtractor } from "./extract.js";
import { createIngestor } from "./ingest.js";
import { MemoryStore, createSessionSummarizer } from "./memory.js";
import { createAnthropicClient, createBudgetedModel, DEFAULT_CLAUDE_MODELS } from "./model.js";
import { createStageThreeProcessor } from "./processor.js";
import { PersistentQueue } from "./queue.js";
import { rebuildDerivedState } from "./rebuild.js";
import { createReadOnlySheets } from "./sheets.js";
import { createStageThreeEngine } from "./stage3.js";
import { OutboxStore, StageThreeEventStore } from "./runtime_store.js";
import { createTelegramClient } from "./telegram.js";
import { createTelegramMediaResolver } from "./telegram_media.js";
import { createWebhookServer } from "./webhook.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const databasePath = resolve(projectRoot, process.env.DB_PATH ?? "data/stage3.sqlite");
const fixturePath = resolve(
  projectRoot,
  process.env.DEMO_SHEETS_PATH ?? "data/stage2-demo-sheets.json",
);
const albumWindowMs = Number(process.env.ALBUM_WINDOW_MS ?? 2_000);
const webhookSecret = process.env.WEBHOOK_SECRET?.trim() ?? "";

const db = openDatabase(databasePath);
const queue = new PersistentQueue(db);
const sheets = createReadOnlySheets(fixturePath);
const budget = new ModelTokenBudget();
const anthropic = createAnthropicClient({
  apiKey: process.env.ANTHROPIC_API_KEY,
  models: {
    haiku: process.env.ANTHROPIC_HAIKU_MODEL ?? DEFAULT_CLAUDE_MODELS.haiku,
    sonnet: process.env.ANTHROPIC_SONNET_MODEL ?? DEFAULT_CLAUDE_MODELS.sonnet,
  },
});
const model = createBudgetedModel({ model: anthropic, budget });
const memory = new MemoryStore(db);
const coach = createCoach({ model });
const summarizer = createSessionSummarizer({ model });
const extractor = createWorkoutExtractor({ model });
const extractionWorkflow = createExtractionWorkflow({ db, sheets, extractor });
const mediaResolver = createTelegramMediaResolver({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
});
const eventStore = new StageThreeEventStore(db);
const outbox = new OutboxStore(db);
const telegram = createTelegramClient({ botToken: process.env.TELEGRAM_BOT_TOKEN });
const stateProvider = () => rebuildDerivedState({
  sheets,
  asOf: new Date().toISOString().slice(0, 10),
});
const engine = createStageThreeEngine({
  stateProvider,
  asOfProvider: () => new Date().toISOString().slice(0, 10),
  memory,
  coach,
  summarizer,
  extractionWorkflow,
  mediaResolver,
  eventStore,
});
const processor = createStageThreeProcessor({ engine, outbox, telegram });
const ingestor = createIngestor({ db, queue, albumWindowMs });
const server = createWebhookServer({
  ingestor,
  queue,
  webhookPath: process.env.WEBHOOK_PATH ?? "/telegram/webhook",
  secretToken: webhookSecret,
});

queue.start(processor);
if (!webhookSecret && process.env.NODE_ENV !== "test") {
  console.error([
    "!!!!!!!!!!!!!!!! WEBHOOK SECURITY WARNING !!!!!!!!!!!!!!!!",
    "WEBHOOK_SECRET is empty: the Telegram webhook is completely open.",
    "Set WEBHOOK_SECRET before exposing this server beyond local development.",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  ].join("\n"));
}
server.listen(port, host, () => {
  console.info(`stage-3 webhook listening on http://${host}:${port}`);
});

function shutdown() {
  queue.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
