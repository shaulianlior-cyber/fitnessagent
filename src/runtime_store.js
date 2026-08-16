function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return value.toISOString();
}

export const TELEGRAM_TEXT_LIMIT = 4_096;

function splitTelegramText(text) {
  const characters = Array.from(text);
  const chunks = [];
  for (let index = 0; index < characters.length; index += TELEGRAM_TEXT_LIMIT) {
    chunks.push(characters.slice(index, index + TELEGRAM_TEXT_LIMIT).join(""));
  }
  return chunks;
}

function outboxRow(row) {
  if (!row) return null;
  return {
    dedupeKey: row.dedupe_key,
    chatId: row.chat_id,
    text: row.text,
    replyMarkup: row.reply_markup_json ? JSON.parse(row.reply_markup_json) : null,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

export class StageThreeEventStore {
  constructor(db, { now = () => new Date() } = {}) {
    if (!db) throw new TypeError("A database is required");
    this.db = db;
    this.now = now;
  }

  get(eventKey) {
    if (!eventKey) return null;
    const row = this.db.prepare(
      "SELECT result_json FROM stage3_events WHERE event_key = ?",
    ).get(String(eventKey));
    return row ? JSON.parse(row.result_json) : null;
  }

  save(eventKey, result) {
    if (!eventKey) return result;
    this.db.prepare(`
      INSERT OR IGNORE INTO stage3_events (event_key, result_json, created_at)
      VALUES (?, ?, ?)
    `).run(String(eventKey), JSON.stringify(result), timestamp(this.now));
    return this.get(eventKey);
  }
}

export class OutboxStore {
  constructor(db, { now = () => new Date() } = {}) {
    if (!db) throw new TypeError("A database is required");
    this.db = db;
    this.now = now;
  }

  get(dedupeKey) {
    return outboxRow(this.db.prepare(
      "SELECT * FROM outbox WHERE dedupe_key = ?",
    ).get(String(dedupeKey)));
  }

  enqueue({ dedupeKey, chatId, text, replyMarkup = null }) {
    if (!dedupeKey || chatId === null || chatId === undefined || chatId === "" || !text?.trim()) {
      throw new TypeError("Outbox message requires a key, chat id and text");
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox
        (dedupe_key, chat_id, text, reply_markup_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(dedupeKey),
      String(chatId),
      text.trim(),
      replyMarkup ? JSON.stringify(replyMarkup) : null,
      timestamp(this.now),
    );
    return this.get(dedupeKey);
  }

  async deliver(dedupeKey, telegram) {
    const message = this.get(dedupeKey);
    if (!message) throw new Error("Outbox message does not exist");
    if (message.status === "sent") return message;
    this.db.prepare(`
      UPDATE outbox SET attempts = attempts + 1, error = NULL WHERE dedupe_key = ?
    `).run(String(dedupeKey));
    try {
      await telegram.sendMessage({
        chatId: message.chatId,
        text: message.text,
        replyMarkup: message.replyMarkup,
      });
    } catch (error) {
      this.db.prepare("UPDATE outbox SET error = ? WHERE dedupe_key = ?")
        .run(error.message, String(dedupeKey));
      throw error;
    }
    this.db.prepare(`
      UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL WHERE dedupe_key = ?
    `).run(timestamp(this.now), String(dedupeKey));
    return this.get(dedupeKey);
  }
}

export function chatIdFrom(event) {
  if (event?.kind === "album") {
    return event.updates?.[0]?.message?.chat?.id ?? null;
  }
  if (event?.payload?.kind === "album") {
    return event.payload.updates?.[0]?.message?.chat?.id ?? null;
  }
  const update = event?.payload?.update ?? event?.update ?? event;
  const message = update?.message ?? update?.edited_message ?? update?.callback_query?.message;
  return message?.chat?.id ?? null;
}

function extractionPreview(result) {
  const fields = Object.entries(result.row ?? {}).map(([key, value]) => `${key}: ${value ?? "חסר"}`);
  const problems = [
    ...(result.missing ?? []).map((field) => `חסר: ${field}`),
    ...(result.errors ?? []).map((error) => `שגיאה: ${error.field}`),
  ];
  return ["זוהתה שורת אימון:", ...fields, ...problems].join("\n");
}

export function outboundForResult(result) {
  if (result.status === "awaiting_confirmation") {
    const buttons = [];
    if (result.canConfirm) {
      buttons.push({ text: "אישור", callback_data: `confirm_extraction:${result.pendingId}` });
    }
    buttons.push({ text: "ביטול", callback_data: `cancel_extraction:${result.pendingId}` });
    return {
      text: extractionPreview(result),
      replyMarkup: { inline_keyboard: [buttons] },
    };
  }
  if (result.status === "confirmed") return { text: "האימון אושר ונשמר." };
  if (result.status === "cancelled") return { text: "החילוץ בוטל ולא נכתב." };
  if (result.answer?.text) return { text: result.answer.text };
  return null;
}

export function outboundMessagesForResult(result) {
  const outbound = outboundForResult(result);
  if (!outbound) return [];
  const chunks = splitTelegramText(outbound.text);
  return chunks.map((text, index) => ({
    text,
    ...(index === chunks.length - 1 && outbound.replyMarkup
      ? { replyMarkup: outbound.replyMarkup }
      : {}),
  }));
}
