export const MODEL_ROUTE_TOKEN_COST = Object.freeze({
  extract: 1_024,
  chat: 2_048,
  coach: 6_144,
  summarize: 1_024,
});

export const DEFAULT_MODEL_TOKEN_CEILING = 8_192;

export class BudgetExceededError extends Error {
  constructor({ requested, remaining }) {
    super(`Model token budget exhausted: requested ${requested}, remaining ${remaining}`);
    this.name = "BudgetExceededError";
    this.requested = requested;
    this.remaining = remaining;
  }
}

export class ModelTokenBudget {
  #ceiling;
  #used = 0;

  constructor(ceiling = DEFAULT_MODEL_TOKEN_CEILING) {
    if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
      throw new TypeError("Token ceiling must be a non-negative safe integer");
    }
    this.#ceiling = ceiling;
  }

  get ceiling() {
    return this.#ceiling;
  }

  get used() {
    return this.#used;
  }

  get remaining() {
    return this.#ceiling - this.#used;
  }

  reserve(route) {
    const requested = MODEL_ROUTE_TOKEN_COST[route];
    if (!requested) throw new TypeError(`Route '${route}' is not model-routed`);
    return this.reserveTokens(requested);
  }

  reserveTokens(requested) {
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new TypeError("Requested tokens must be a non-negative safe integer");
    }
    if (requested > this.remaining) {
      throw new BudgetExceededError({ requested, remaining: this.remaining });
    }
    this.#used += requested;
    return requested;
  }
}

function utcSnapshot(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return { day: value.toISOString().slice(0, 10), timestamp: value.toISOString() };
}

export class PersistentDailyModelTokenBudget extends ModelTokenBudget {
  constructor(db, { ceiling = DEFAULT_MODEL_TOKEN_CEILING, now = () => new Date() } = {}) {
    super(ceiling);
    if (!db) throw new TypeError("A database is required");
    this.db = db;
    this.now = now;
  }

  get used() {
    const { day } = utcSnapshot(this.now);
    return Number(this.db.prepare(
      "SELECT used FROM model_budget_daily WHERE day = ?",
    ).get(day)?.used ?? 0);
  }

  get remaining() {
    return this.ceiling - this.used;
  }

  reserveTokens(requested) {
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new TypeError("Requested tokens must be a non-negative safe integer");
    }
    const { day, timestamp } = utcSnapshot(this.now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = Number(this.db.prepare(
        "SELECT used FROM model_budget_daily WHERE day = ?",
      ).get(day)?.used ?? 0);
      const remaining = this.ceiling - used;
      if (requested > remaining) throw new BudgetExceededError({ requested, remaining });
      this.db.prepare(`
        INSERT INTO model_budget_daily (day, used, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET
          used = model_budget_daily.used + excluded.used,
          updated_at = excluded.updated_at
      `).run(day, requested, timestamp);
      this.db.exec("COMMIT");
      return requested;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
