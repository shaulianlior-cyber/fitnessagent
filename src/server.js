import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";
import { createIngestor } from "./ingest.js";
import { createStageOneProcessor } from "./processor.js";
import { PersistentQueue } from "./queue.js";
import { createReadOnlySheets } from "./sheets.js";
import { createWebhookServer } from "./webhook.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const databasePath = resolve(projectRoot, process.env.DB_PATH ?? "data/stage1.sqlite");
const fixturePath = resolve(
  projectRoot,
  process.env.DEMO_SHEETS_PATH ?? "data/demo-sheets.json",
);
const albumWindowMs = Number(process.env.ALBUM_WINDOW_MS ?? 2_000);
const webhookSecret = process.env.WEBHOOK_SECRET?.trim() ?? "";

const db = openDatabase(databasePath);
const queue = new PersistentQueue(db);
const sheets = createReadOnlySheets(fixturePath);
const processor = createStageOneProcessor({ sheets });
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
  console.info(`stage-1 webhook listening on http://${host}:${port}`);
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
