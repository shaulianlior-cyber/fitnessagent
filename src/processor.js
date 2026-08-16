export function createStageOneProcessor({ sheets, logger = console }) {
  if (!sheets) throw new TypeError("A read-only sheets adapter is required");

  return async function processStageOneEvent(item) {
    // Stage 1 intentionally proves the read boundary only. No real or demo sheet
    // is mutated; later stages can replace this processor behind the queue contract.
    const demoRuns = await sheets.read("Runs", { start: 0, end: 1 });
    logger.info?.("processed stage-1 event", {
      queueId: item.id,
      kind: item.payload.kind,
      demoRowsRead: demoRuns.length,
    });
  };
}

export function createStageTwoProcessor({ engine, logger = console }) {
  if (!engine || typeof engine.handle !== "function") {
    throw new TypeError("A Stage 2 engine is required");
  }

  return async function processStageTwoEvent(item) {
    const result = await engine.handle(item.payload);
    logger.info?.("processed stage-2 event", {
      queueId: item.id,
      route: result.route.handler,
      status: result.status ?? "answered",
      answer: result.answer?.text ?? null,
      tokenUsage: result.tokenUsage,
    });
    return result;
  };
}

export function createStageThreeProcessor({ engine, logger = console }) {
  if (!engine || typeof engine.handle !== "function") {
    throw new TypeError("A Stage 3 engine is required");
  }

  return async function processStageThreeEvent(item) {
    const result = await engine.handle(item.payload);
    logger.info?.("processed stage-3 event", {
      queueId: item.id,
      route: result.route.handler,
      status: result.status ?? "answered",
      answer: result.answer?.text ?? null,
      tokenUsage: result.tokenUsage,
    });
    return result;
  };
}
