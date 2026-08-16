import { BudgetExceededError } from "./budget.js";
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
  memory,
  coach,
  summarizer,
  extractionWorkflow,
  mediaResolver,
  eventStore,
}) {
  if (typeof stateProvider !== "function" || typeof asOfProvider !== "function") {
    throw new TypeError("stateProvider and asOfProvider are required");
  }
  if (!memory || !coach || !summarizer || !extractionWorkflow || !mediaResolver || !eventStore) {
    throw new TypeError("Stage 3 services are required");
  }

  async function summarize(userId) {
    try {
      const result = await summarizer.summarize({
        session: memory.getSession(userId),
        conversation: memory.recent(userId),
      });
      memory.setSession(userId, result);
      return { status: "updated", usage: result.usage, budget: result.budget };
    } catch (error) {
      if (error instanceof BudgetExceededError) return { status: "budget_skipped", usage: null };
      return { status: "failed", usage: null, error: error.message };
    }
  }

  function recordDirectAnswer(userId, question, answer, eventKey) {
    if (!userId) return;
    memory.addMessage({
      userId,
      role: "user",
      content: question,
      sourceKey: eventKey ? `${eventKey}:user` : null,
    });
    memory.addMessage({
      userId,
      role: "assistant",
      content: answer,
      sourceKey: eventKey ? `${eventKey}:assistant` : null,
    });
  }

  return {
    async handle(event, { eventKey = null } = {}) {
      const cached = eventStore.get(eventKey);
      if (cached) return cached;
      const complete = (result) => eventStore.save(eventKey, result);
      const route = routeEvent(event);
      const userId = userIdFrom(event);
      const text = textFrom(event, route);

      if (route.handler === "query" && route.params.query === "days_since_run") {
        const answer = daysSinceRun(await stateProvider());
        recordDirectAnswer(userId, text, answer.text, eventKey);
        return complete({ route, answer, tokenUsage: 0 });
      }

      if (route.handler === "query" && route.params.query === "conversation_search") {
        if (!userId) throw new TypeError("Conversation search requires a user id");
        const matches = memory.search(userId, route.params.text);
        const answer = { text: searchAnswer(matches), matches };
        recordDirectAnswer(userId, text, answer.text, eventKey);
        return complete({ route, answer, tokenUsage: 0 });
      }

      if (route.handler === "extract") {
        if (!userId) throw new TypeError("Extraction requires a user id");
        const images = await mediaResolver.resolve(event);
        const result = await extractionWorkflow.submit({
          userId,
          images,
          asOf: asOfProvider(),
          eventKey,
        });
        return complete({
          route,
          ...result,
          reservedTokens: result.budget?.reservedTokens ?? 0,
          tokenUsage: usageTotal(result),
        });
      }

      if (route.handler === "update" && route.params.update === "confirm_extraction") {
        const result = await extractionWorkflow.confirm({
          pendingId: route.params.pendingId,
          userId,
          approved: true,
        });
        return complete({ route, ...result, tokenUsage: 0 });
      }

      if (route.handler === "update" && route.params.update === "cancel_extraction") {
        return complete({ route, ...extractionWorkflow.cancel({
          pendingId: route.params.pendingId,
          userId,
        }), tokenUsage: 0 });
      }

      if (route.handler === "update") {
        return complete({ route, status: "routed", tokenUsage: 0 });
      }

      if (!userId || !text) throw new TypeError("Chat requires a user id and text");
      const context = memory.context(userId);
      memory.addMessage({
        userId,
        role: "user",
        content: text,
        sourceKey: eventKey ? `${eventKey}:user` : null,
      });
      const state = await stateProvider();
      const verdict = route.params.workout
        ? evaluateRules({ state, workout: route.params.workout, counters: state.counters })
        : { verdict: "informational", ruleId: null, reason: "conversation" };
      const savedAnswer = memory.findBySourceKey(eventKey ? `${eventKey}:assistant` : null);
      const response = savedAnswer
        ? { text: savedAnswer.content, usage: null, budget: null, modelCalled: false }
        : await coach.respond({ verdict, state, memory: context, userMessage: text });
      memory.addMessage({
        userId,
        role: "assistant",
        content: response.text,
        tokens: response.usage?.outputTokens ?? 0,
        sourceKey: eventKey ? `${eventKey}:assistant` : null,
      });
      const session = verdict.verdict === "block"
        ? { status: "block_skipped", usage: null }
        : savedAnswer
          ? { status: "retry_skipped", usage: null }
          : await summarize(userId);
      return complete({
        route,
        answer: { text: response.text },
        reservedTokens: response.budget?.reservedTokens ?? 0,
        tokenUsage: usageTotal(response, session),
        sessionStatus: session.status,
        verdict,
      });
    },

    async judgeAndCoach({ userId, workout, userMessage }) {
      if (!String(userId ?? "") || typeof userMessage !== "string" || !userMessage.trim()) {
        throw new TypeError("judgeAndCoach requires a user id and message");
      }
      const state = await stateProvider();
      const verdict = evaluateRules({ state, workout, counters: state.counters });
      const context = memory.context(userId);
      memory.addMessage({ userId, role: "user", content: userMessage });
      const response = await coach.respond({ verdict, state, memory: context, userMessage });
      memory.addMessage({ userId, role: "assistant", content: response.text });
      return {
        verdict,
        answer: response.text,
        reservedTokens: response.budget?.reservedTokens ?? 0,
        tokenUsage: usageTotal(response),
      };
    },
  };
}
