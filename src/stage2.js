import { runBudgetedModelAction } from "./budget.js";
import { routeEvent } from "./router.js";

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

export function createStageTwoEngine({ stateProvider, budget, modelAction }) {
  if (typeof stateProvider !== "function") {
    throw new TypeError("A stateProvider is required");
  }
  if (typeof modelAction !== "function") {
    throw new TypeError("A modelAction boundary is required");
  }

  return {
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

      const execution = await runBudgetedModelAction({
        budget,
        route: route.handler,
        action: ({ maxTokens }) => modelAction(event, route, { maxTokens }),
      });
      return { route, ...execution };
    },
  };
}
