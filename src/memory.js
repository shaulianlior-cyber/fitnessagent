const DAY_MS = 86_400_000;
const MAX_MESSAGE_CHARS = 8_000;
const SEARCH_STOP_WORDS = new Set([
  "מה", "אמרנו", "על", "את", "של", "עם", "the", "what", "did", "we", "say", "about",
]);

function isoNow(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return value.toISOString();
}

function parseItems(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function tokens(text) {
  return [...new Set(
    String(text)
      .toLocaleLowerCase("he")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)) ?? [],
  )];
}

function score(content, searchTokens) {
  const normalized = content.toLocaleLowerCase("he");
  return searchTokens.reduce((total, token) => total + (normalized.includes(token) ? 1 : 0), 0);
}

export class MemoryStore {
  constructor(db, { now = () => new Date() } = {}) {
    if (!db) throw new TypeError("A database is required");
    this.db = db;
    this.now = now;
  }

  addMessage({ userId, role, content, tokens: tokenCount = 0, createdAt = null }) {
    if (!new Set(["user", "assistant"]).has(role)) throw new TypeError("Invalid conversation role");
    if (typeof content !== "string" || !content.trim()) throw new TypeError("Message content is required");
    if (content.length > MAX_MESSAGE_CHARS) throw new TypeError("Message content is too large");
    if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) throw new TypeError("Invalid token count");
    const timestamp = createdAt ?? isoNow(this.now);
    const result = this.db.prepare(`
      INSERT INTO conversations (user_id, role, content, tokens, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(userId), role, content.trim(), tokenCount, timestamp);
    return Number(result.lastInsertRowid);
  }

  recent(userId, limit = 15) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError("Invalid limit");
    return this.db.prepare(`
      SELECT id, role, content, tokens, created_at AS createdAt
      FROM conversations WHERE user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(String(userId), limit).reverse();
  }

  getSession(userId) {
    const row = this.db.prepare(`
      SELECT summary, open_items AS openItems, updated_at AS updatedAt
      FROM sessions WHERE user_id = ?
    `).get(String(userId));
    if (!row) return { summary: "", openItems: [], updatedAt: null };
    return { summary: row.summary, openItems: parseItems(row.openItems), updatedAt: row.updatedAt };
  }

  setSession(userId, { summary, openItems = [] }) {
    if (typeof summary !== "string" || summary.length > 4_000) throw new TypeError("Invalid session summary");
    if (!Array.isArray(openItems) || openItems.some((item) => typeof item !== "string")) {
      throw new TypeError("openItems must be strings");
    }
    const updatedAt = isoNow(this.now);
    this.db.prepare(`
      INSERT INTO sessions (user_id, summary, open_items, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        summary = excluded.summary,
        open_items = excluded.open_items,
        updated_at = excluded.updated_at
    `).run(String(userId), summary.trim(), JSON.stringify(openItems), updatedAt);
    return { summary: summary.trim(), openItems, updatedAt };
  }

  approvePreference(userId, { key, value }) {
    if (!key?.trim() || !value?.trim()) throw new TypeError("Preference key and value are required");
    const approvedAt = isoNow(this.now);
    this.db.prepare(`
      INSERT INTO preferences (user_id, key, value, approved_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET
        value = excluded.value,
        approved_at = excluded.approved_at
    `).run(String(userId), key.trim(), value.trim(), approvedAt);
    return { key: key.trim(), value: value.trim(), approvedAt };
  }

  preferences(userId) {
    return Object.fromEntries(this.db.prepare(`
      SELECT key, value FROM preferences WHERE user_id = ? ORDER BY key
    `).all(String(userId)).map((row) => [row.key, row.value]));
  }

  search(userId, query, limit = 5) {
    const searchTokens = tokens(query);
    if (!searchTokens.length) return [];
    const rows = this.db.prepare(`
      SELECT id, role, content, created_at AS createdAt
      FROM conversations WHERE user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1000
    `).all(String(userId));
    return rows
      .map((row) => ({ ...row, score: score(row.content, searchTokens) }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(({ score: ignored, ...row }) => row);
  }

  context(userId) {
    const conversation = this.recent(userId);
    const last = conversation.at(-1);
    const currentTime = this.now().valueOf();
    const lastTime = last ? Date.parse(last.createdAt) : currentTime;
    const gapDays = Math.max(0, Math.floor((currentTime - lastTime) / DAY_MS));
    const session = this.getSession(userId);
    return {
      conversation,
      session,
      preferences: this.preferences(userId),
      gapDays,
      continuityNote: gapDays >= 3
        ? `עברו ${gapDays} ימים. השארנו פתוח: ${session.openItems.join(", ") || "אין פריט פתוח"}.`
        : null,
    };
  }
}

const SUMMARY_SYSTEM = `Summarize the active running-coach session in Hebrew.
Return JSON only: {"summary":"one short paragraph","openItems":["..."]}.
Preserve concrete decisions and unresolved items. Never invent health status.`;

function parseSummary(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  let payload;
  try {
    payload = JSON.parse(cleaned);
  } catch {
    throw new TypeError("Session summarizer returned invalid JSON");
  }
  if (typeof payload.summary !== "string" || !Array.isArray(payload.openItems)) {
    throw new TypeError("Session summarizer returned an invalid shape");
  }
  return { summary: payload.summary, openItems: payload.openItems.filter((item) => typeof item === "string") };
}

export function createSessionSummarizer({ model }) {
  if (!model || typeof model.generate !== "function") throw new TypeError("A model client is required");
  return {
    async summarize({ session, conversation }) {
      const response = await model.generate({
        tier: "haiku",
        system: SUMMARY_SYSTEM,
        messages: [{ role: "user", content: JSON.stringify({ session, conversation }) }],
        maxTokens: 384,
        cache: true,
      });
      return { ...parseSummary(response.text), usage: response.usage };
    },
  };
}
