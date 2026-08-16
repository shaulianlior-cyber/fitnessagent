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
