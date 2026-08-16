const COACH_SYSTEM = `You are a direct Hebrew running coach.
Be practical, concise, and never flattering. Give one decision, not a menu.
Separate fact, assessment, and uncertainty when that distinction matters.
The verdict supplied by deterministic code is an immutable fact. You may explain
or phrase it, but never change it, weaken it, or claim a different verdict.
An informational verdict is not permission to prescribe a future workout or load.
Missing health data is unknown, never clean. Do not invent measurements.`;

const BLOCK_REASONS = Object.freeze({
  next_day_missing: "נתוני היום־שאחרי חסרים",
  next_day_issue: "דווחה בעיה בנתוני היום־שאחרי",
  load_change_missing: "סיווג שינוי העומס חסר",
  load_change_required: "סיווג שינוי העומס חסר",
  load_change_invalid: "סיווג שינוי העומס אינו חוקי",
});

function validateVerdict(verdict) {
  if (!verdict || !new Set(["allow", "block", "informational"]).has(verdict.verdict)) {
    throw new TypeError("Coach requires a deterministic verdict");
  }
}

function blockedText(verdict) {
  const reason = BLOCK_REASONS[verdict.reason] ?? verdict.reason ?? "כלל בטיחות קשיח הופעל";
  return `לא. הפעולה חסומה: ${reason}. אי אפשר לעקוף חסימת בטיחות דרך השיחה.`;
}

function messagesFrom(memory, userMessage, context) {
  const history = (memory?.conversation ?? []).slice(-12).map(({ role, content }) => ({
    role,
    content,
  }));
  while (history[0]?.role === "assistant") history.shift();
  const payload = JSON.stringify({
    verdict: context.verdict,
    state: context.state,
    session: memory?.session ?? null,
    preferences: memory?.preferences ?? {},
    continuityNote: memory?.continuityNote ?? null,
  });
  return [
    ...history,
    { role: "user", content: `Context from deterministic code:\n${payload}\n\nUser message:\n${userMessage}` },
  ];
}

export function createCoach({ model }) {
  if (!model || typeof model.generate !== "function") throw new TypeError("A model client is required");

  return {
    async respond({ verdict, state = {}, memory = {}, userMessage }) {
      validateVerdict(verdict);
      if (typeof userMessage !== "string" || !userMessage.trim()) {
        throw new TypeError("Coach requires a user message");
      }
      if (verdict.verdict === "block") {
        return {
          text: blockedText(verdict),
          usage: { totalTokens: 0 },
          modelCalled: false,
        };
      }

      const response = await model.generate({
        tier: "sonnet",
        system: COACH_SYSTEM,
        messages: messagesFrom(memory, userMessage.trim(), { verdict, state }),
        maxTokens: 1_024,
        cache: true,
      });
      if (!response.text?.trim()) throw new TypeError("Coach returned an empty response");
      return {
        text: response.text.trim(),
        usage: response.usage,
        budget: response.budget ?? null,
        modelCalled: true,
      };
    },
  };
}
