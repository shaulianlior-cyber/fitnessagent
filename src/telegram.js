const DEFAULT_API_ROOT = "https://api.telegram.org";

export class TelegramRequestError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "TelegramRequestError";
    this.status = status;
  }
}

export function createTelegramClient({
  botToken,
  fetchImpl = globalThis.fetch,
  apiRoot = DEFAULT_API_ROOT,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");

  return {
    async sendMessage({ chatId, text, replyMarkup = null }) {
      if (!botToken?.trim()) throw new TelegramRequestError("TELEGRAM_BOT_TOKEN is required");
      if (chatId === null || chatId === undefined || chatId === "" || !text?.trim()) {
        throw new TypeError("Telegram message requires a chat id and text");
      }
      const body = { chat_id: String(chatId), text: text.trim() };
      if (replyMarkup) body.reply_markup = replyMarkup;
      const response = await fetchImpl(`${apiRoot}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new TelegramRequestError(`Telegram sendMessage failed with status ${response.status}`, {
          status: response.status,
        });
      }
      const payload = await response.json();
      if (!payload?.ok) throw new TelegramRequestError("Telegram rejected sendMessage");
      return payload.result;
    },
  };
}
