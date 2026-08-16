import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelTokenBudget } from "./budget.js";
import { openDatabase } from "./db.js";
import { createIngestor } from "./ingest.js";
import { createStageTwoProcessor } from "./processor.js";
import { PersistentQueue } from "./queue.js";
import { rebuildDerivedState } from "./rebuild.js";
import { createReadOnlySheets } from "./sheets.js";
import { createStageTwoEngine } from "./stage2.js";
import { createWebhookServer } from "./webhook.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const databasePath = resolve(projectRoot, process.env.DB_PATH ?? "data/stage2.sqlite");
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
const stateProvider = () => rebuildDerivedState({
  sheets,
  asOf: new Date().toISOString().slice(0, 10),
});
const engine = createStageTwoEngine({ stateProvider, budget });
const processor = createStageTwoProcessor({ engine });
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
  console.info(`stage-2 webhook listening on http://${host}:${port}`);
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
