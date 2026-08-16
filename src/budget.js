export const MODEL_ROUTE_TOKEN_COST = Object.freeze({
  extract: 1_024,
  chat: 2_048,
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
    if (requested > this.remaining) {
      throw new BudgetExceededError({ requested, remaining: this.remaining });
    }
    this.#used += requested;
    return requested;
  }
}

export async function runBudgetedModelAction({ budget, route, action }) {
  if (!(budget instanceof ModelTokenBudget)) {
    throw new TypeError("A ModelTokenBudget is required");
  }
  if (typeof action !== "function") throw new TypeError("A model action is required");

  const reservedTokens = budget.reserve(route);
  const result = await action({ maxTokens: reservedTokens });
  return { result, tokenUsage: reservedTokens };
}
