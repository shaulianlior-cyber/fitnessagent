const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";

export const DEFAULT_CLAUDE_MODELS = Object.freeze({
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
});

function responseText(payload) {
  return (payload?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
  };
}

export class ModelRequestError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "ModelRequestError";
    this.status = status;
  }
}

export function createAnthropicClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  models = DEFAULT_CLAUDE_MODELS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (!models?.haiku || !models?.sonnet) {
    throw new TypeError("Both haiku and sonnet model ids are required");
  }

  return {
    async generate({ tier, system, messages, maxTokens, cache = true }) {
      if (!apiKey?.trim()) {
        throw new ModelRequestError("ANTHROPIC_API_KEY is required for model-routed actions");
      }
      if (!Object.hasOwn(models, tier)) throw new TypeError(`Unknown model tier: ${tier}`);
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
        throw new TypeError("maxTokens must be a positive safe integer");
      }

      const body = {
        model: models[tier],
        max_tokens: maxTokens,
        system,
        messages,
      };
      if (cache) body.cache_control = { type: "ephemeral" };

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new ModelRequestError(`Claude API request failed with status ${response.status}`, {
          status: response.status,
        });
      }

      const payload = await response.json();
      const text = responseText(payload);
      if (!text) throw new ModelRequestError("Claude API returned no text content");
      return {
        text,
        model: payload.model ?? models[tier],
        stopReason: payload.stop_reason ?? null,
        usage: normalizeUsage(payload.usage),
      };
    },
  };
}
