import { ModelTokenBudget } from "./budget.js";
import { routeEvent } from "./router.js";
import { evaluateRules } from "./rules.js";

function answerDaysSinceRun(state) {
  const days = state?.counters?.daysSinceRun;
  if (days === null || days === undefined) {
    return { counter: "daysSinceRun", value: null, text: "אין ריצה שהושלמה ביומן." };
  }
  return {
    counter: "daysSinceRun",
    value: days,
    text: days === 0 ? "הריצה האחרונה הייתה היום." : `עברו ${days} ימים מאז הריצה.`,
  };
}

export function createStageTwoEngine({ stateProvider, budget }) {
  if (typeof stateProvider !== "function") {
    throw new TypeError("A stateProvider is required");
  }
  if (!(budget instanceof ModelTokenBudget)) {
    throw new TypeError("A ModelTokenBudget is required");
  }

  return {
    async judge(workout) {
      const state = await stateProvider();
      return evaluateRules({ state, workout, counters: state.counters });
    },

    async handle(event) {
      const route = routeEvent(event);

      if (route.handler === "query" && route.params.query === "days_since_run") {
        return {
          route,
          answer: answerDaysSinceRun(await stateProvider()),
          tokenUsage: 0,
        };
      }

      if (route.handler === "update") {
        return { route, status: "routed", tokenUsage: 0 };
      }

      const reservedTokens = budget.reserve(route.handler);
      return {
        route,
        status: "model_required",
        reservedTokens,
        tokenUsage: 0,
      };
    },
  };
}
