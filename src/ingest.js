import {
  classifyUpdate,
  getMediaGroupId,
  recordRawUpdate,
} from "./raw_log.js";

export function createIngestor(options) {
  const {
    db,
    queue,
    albumWindowMs = 2_000,
    now = () => Date.now(),
  } = options;

  if (!db || !queue) {
    throw new TypeError("createIngestor requires db and queue");
  }

  return {
    ingest(update) {
      const receivedAt = new Date(now()).toISOString();

      // Durability boundary: the untouched update is recorded before routing or work.
      const rawEvent = recordRawUpdate(db, update, receivedAt);
      if (rawEvent.duplicate) {
        return {
          accepted: false,
          duplicate: true,
          eventId: rawEvent.id,
          updateId: rawEvent.updateId,
        };
      }

      const mediaGroupId = getMediaGroupId(update);
      const queueItem = queue.enqueueUpdate({
        rawEvent,
        update,
        mediaGroupId,
        albumWindowMs,
      });

      return {
        accepted: true,
        duplicate: false,
        eventId: rawEvent.id,
        queueId: queueItem.id,
        type: classifyUpdate(update),
        grouped: Boolean(mediaGroupId),
      };
    },
  };
}
