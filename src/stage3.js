import { BudgetExceededError, ModelTokenBudget } from "./budget.js";
import { routeEvent } from "./router.js";
import { evaluateRules } from "./rules.js";

function telegramMessage(event) {
  if (event?.kind === "album" || event?.payload?.kind === "album") {
    const first = event.updates?.[0] ?? event.payload?.updates?.[0];
    return first?.message ?? first?.edited_message ?? null;
  }
  const update = event?.payload?.update ?? event?.update ?? event;
  return update?.message ?? update?.edited_message ?? update?.callback_query?.message ?? null;
}

function userIdFrom(event) {
  return String(
    event?.userId ??
    event?.payload?.userId ??
    event?.payload?.update?.callback_query?.from?.id ??
    event?.update?.callback_query?.from?.id ??
    telegramMessage(event)?.from?.id ??
    "",
  );
}

function textFrom(event, route) {
  const update = event?.payload?.update ?? event?.update ?? event;
  return String(
    event?.text ??
    event?.payload?.text ??
    update?.callback_query?.data ??
    telegramMessage(event)?.text ??
    route?.params?.text ??
    "",
  ).trim();
}

function daysSinceRun(state) {
  const days = state?.counters?.daysSinceRun;
  return {
    counter: "daysSinceRun",
    value: days ?? null,
    text: days == null
      ? "אין ריצה שהושלמה ביומן."
      : days === 0 ? "הריצה האחרונה הייתה היום." : `עברו ${days} ימים מאז הריצה.`,
  };
}

function searchAnswer(results) {
  if (!results.length) return "לא מצאתי בשיחות הקודמות אזכור מתאים.";
  return results.map((result) => `${result.createdAt}: ${result.content}`).join("\n");
}

function usageTotal(...results) {
  return results.reduce((sum, result) => sum + Number(result?.usage?.totalTokens ?? 0), 0);
}

export function createStageThreeEngine({
  stateProvider,
  asOfProvider,
  budget,
  memory,
  coach,
  summarizer,
  extractionWorkflow,
  mediaResolver,
}) {
  if (typeof stateProvider !== "function" || typeof asOfProvider !== "function") {
    throw new TypeError("stateProvider and asOfProvider are required");
  }
  if (!(budget instanceof ModelTokenBudget)) throw new TypeError("A ModelTokenBudget is required");
  if (!memory || !coach || !summarizer || !extractionWorkflow || !mediaResolver) {
    throw new TypeError("Stage 3 services are required");
  }

  async function summarize(userId) {
    try {
      budget.reserve("summarize");
    } catch (error) {
      if (error instanceof BudgetExceededError) return { status: "budget_skipped", usage: null };
      throw error;
    }
    try {
      const result = await summarizer.summarize({
        session: memory.getSession(userId),
        conversation: memory.recent(userId),
      });
      memory.setSession(userId, result);
      return { status: "updated", usage: result.usage };
    } catch (error) {
      return { status: "failed", usage: null, error: error.message };
    }
  }

  async function recordDirectAnswer(userId, question, answer) {
    if (!userId) return;
    memory.addMessage({ userId, role: "user", content: question });
    memory.addMessage({ userId, role: "assistant", content: answer });
  }

  return {
    async handle(event) {
      const route = routeEvent(event);
      const userId = userIdFrom(event);
      const text = textFrom(event, route);

      if (route.handler === "query" && route.params.query === "days_since_run") {
        const answer = daysSinceRun(await stateProvider());
        await recordDirectAnswer(userId, text, answer.text);
        return { route, answer, tokenUsage: 0 };
      }

      if (route.handler === "query" && route.params.query === "conversation_search") {
        if (!userId) throw new TypeError("Conversation search requires a user id");
        const matches = memory.search(userId, route.params.text);
        const answer = { text: searchAnswer(matches), matches };
        await recordDirectAnswer(userId, text, answer.text);
        return { route, answer, tokenUsage: 0 };
      }

      if (route.handler === "extract") {
        if (!userId) throw new TypeError("Extraction requires a user id");
        const reservedTokens = budget.reserve("extract");
        const images = await mediaResolver.resolve(event);
        const result = await extractionWorkflow.submit({
          userId,
          images,
          asOf: asOfProvider(),
        });
        return { route, ...result, reservedTokens, tokenUsage: usageTotal(result) };
      }

      if (route.handler === "update" && route.params.update === "confirm_extraction") {
        const result = await extractionWorkflow.confirm({
          pendingId: route.params.pendingId,
          userId,
          approved: true,
        });
        return { route, ...result, tokenUsage: 0 };
      }

      if (route.handler === "update" && route.params.update === "cancel_extraction") {
        return { route, ...extractionWorkflow.cancel({
          pendingId: route.params.pendingId,
          userId,
        }), tokenUsage: 0 };
      }

      if (route.handler === "update") {
        return { route, status: "routed", tokenUsage: 0 };
      }

      if (!userId || !text) throw new TypeError("Chat requires a user id and text");
      const context = memory.context(userId);
      memory.addMessage({ userId, role: "user", content: text });
      const state = await stateProvider();
      const verdict = route.params.workout
        ? evaluateRules({ state, workout: route.params.workout, counters: state.counters })
        : { verdict: "informational", ruleId: null, reason: "conversation" };
      let reservedTokens = 0;
      if (verdict.verdict !== "block") reservedTokens = budget.reserve("coach");
      const response = await coach.respond({
        verdict,
        state,
        memory: context,
        userMessage: text,
      });
      memory.addMessage({
        userId,
        role: "assistant",
        content: response.text,
        tokens: response.usage?.outputTokens ?? 0,
      });
      const session = verdict.verdict === "block"
        ? { status: "block_skipped", usage: null }
        : await summarize(userId);
      return {
        route,
        answer: { text: response.text },
        reservedTokens,
        tokenUsage: usageTotal(response, session),
        sessionStatus: session.status,
        verdict,
      };
    },

    async judgeAndCoach({ userId, workout, userMessage }) {
      if (!String(userId ?? "") || typeof userMessage !== "string" || !userMessage.trim()) {
        throw new TypeError("judgeAndCoach requires a user id and message");
      }
      const state = await stateProvider();
      const verdict = evaluateRules({ state, workout, counters: state.counters });
      const context = memory.context(userId);
      memory.addMessage({ userId, role: "user", content: userMessage });
      let reservedTokens = 0;
      if (verdict.verdict !== "block") reservedTokens = budget.reserve("coach");
      const response = await coach.respond({ verdict, state, memory: context, userMessage });
      memory.addMessage({ userId, role: "assistant", content: response.text });
      return { verdict, answer: response.text, reservedTokens, tokenUsage: usageTotal(response) };
    },
  };
}
