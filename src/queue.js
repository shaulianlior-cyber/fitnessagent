const DEFAULT_POLL_MS = 100;
const DEFAULT_RETRY_MS = 250;

function parsePayload(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function queueRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    eventId: Number(row.event_id),
    dedupeKey: row.dedupe_key,
    status: row.status,
    attempts: Number(row.attempts),
    error: row.error,
    payload: parsePayload(row.payload),
    availableAt: Number(row.available_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class PersistentQueue {
  constructor(db, options = {}) {
    this.db = db;
    this.now = options.now ?? (() => Date.now());
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.handler = null;
    this.timer = null;
    this.running = false;
    this.processing = false;
  }

  enqueueUpdate({ rawEvent, update, mediaGroupId, albumWindowMs = 2_000 }) {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const isAlbum = Boolean(mediaGroupId);
    const baseKey = isAlbum
      ? `album:${rawEvent.userId ?? "unknown"}:${mediaGroupId}`
      : `update:${rawEvent.updateId}`;

    return transaction(this.db, () => {
      const existing = this.db.prepare(`
        SELECT * FROM queue WHERE dedupe_key = ?
      `).get(baseKey);

      if (existing?.status === "pending" && isAlbum) {
        const payload = parsePayload(existing.payload);
        const updates = [...payload.updates, update]
          .filter((item, index, all) =>
            all.findIndex((candidate) => candidate.update_id === item.update_id) === index,
          )
          .sort((left, right) => left.update_id - right.update_id);

        this.db.prepare(`
          UPDATE queue
             SET payload = ?, available_at = ?, updated_at = ?
           WHERE id = ?
        `).run(
          JSON.stringify({ ...payload, updates }),
          nowMs + albumWindowMs,
          nowIso,
          existing.id,
        );
        return queueRow(this.db.prepare("SELECT * FROM queue WHERE id = ?").get(existing.id));
      }

      if (existing && isAlbum && existing.status !== "pending") {
        const lateKey = `late:${mediaGroupId}:${rawEvent.updateId}`;
        const latePayload = {
          kind: "update",
          update,
          late: true,
          lateArrivalFor: mediaGroupId,
        };

        const result = this.db.prepare(`
          INSERT INTO queue(
            event_id, dedupe_key, status, attempts, error,
            payload, available_at, created_at, updated_at
          ) VALUES (?, ?, 'pending', 0, NULL, ?, ?, ?, ?)
        `).run(
          rawEvent.id,
          lateKey,
          JSON.stringify(latePayload),
          nowMs,
          nowIso,
          nowIso,
        );

        return queueRow(
          this.db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid),
        );
      }

      if (existing) {
        return queueRow(existing);
      }

      const payload = isAlbum
        ? { kind: "album", mediaGroupId, updates: [update] }
        : { kind: "update", update };
      const availableAt = isAlbum ? nowMs + albumWindowMs : nowMs;

      const result = this.db.prepare(`
        INSERT INTO queue(
          event_id, dedupe_key, status, attempts, error,
          payload, available_at, created_at, updated_at
        ) VALUES (?, ?, 'pending', 0, NULL, ?, ?, ?, ?)
      `).run(
        rawEvent.id,
        baseKey,
        JSON.stringify(payload),
        availableAt,
        nowIso,
        nowIso,
      );

      return queueRow(
        this.db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid),
      );
    });
  }

  claimNext() {
    return transaction(this.db, () => {
      const row = this.db.prepare(`
        SELECT *
          FROM queue
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY available_at ASC, id ASC
         LIMIT 1
      `).get(this.now());

      if (!row) return null;

      this.db.prepare(`
        UPDATE queue
           SET status = 'processing', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'
      `).run(new Date(this.now()).toISOString(), row.id);

      return queueRow(this.db.prepare("SELECT * FROM queue WHERE id = ?").get(row.id));
    });
  }

  complete(id) {
    this.db.prepare(`
      UPDATE queue
         SET status = 'done', error = NULL, updated_at = ?
       WHERE id = ? AND status = 'processing'
    `).run(new Date(this.now()).toISOString(), id);
  }

  fail(item, error) {
    const finalAttempt = item.attempts >= this.maxAttempts;
    this.db.prepare(`
      UPDATE queue
         SET status = ?, error = ?, available_at = ?, updated_at = ?
       WHERE id = ? AND status = 'processing'
    `).run(
      finalAttempt ? "failed" : "pending",
      String(error?.stack ?? error),
      this.now() + this.retryMs,
      new Date(this.now()).toISOString(),
      item.id,
    );
  }

  async processOne(handler = this.handler) {
    if (typeof handler !== "function") {
      throw new TypeError("A queue handler is required");
    }

    const item = this.claimNext();
    if (!item) return false;

    try {
      await handler(item);
      this.complete(item.id);
    } catch (error) {
      this.fail(item, error);
    }
    return true;
  }

  start(handler) {
    if (this.running) return;
    this.handler = handler;
    this.running = true;
    this.wake();
  }

  wake() {
    if (!this.running || this.processing || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      this.processing = true;
      try {
        while (this.running && await this.processOne()) {
          // One serial consumer deliberately drains ready work in order.
        }
      } finally {
        this.processing = false;
        if (this.running) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.wake();
          }, this.pollMs);
          this.timer.unref?.();
        }
      }
    }, 0);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getById(id) {
    return queueRow(this.db.prepare("SELECT * FROM queue WHERE id = ?").get(id));
  }

  count(status = null) {
    const row = status
      ? this.db.prepare("SELECT COUNT(*) AS count FROM queue WHERE status = ?").get(status)
      : this.db.prepare("SELECT COUNT(*) AS count FROM queue").get();
    return Number(row.count);
  }
}
