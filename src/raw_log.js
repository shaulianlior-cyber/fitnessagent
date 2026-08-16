function getMessage(update) {
  return (
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post ??
    update.callback_query?.message ??
    null
  );
}

export function getUserId(update) {
  const message = getMessage(update);
  const value =
    update.callback_query?.from?.id ??
    message?.from?.id ??
    message?.chat?.id ??
    null;

  return value === null ? null : String(value);
}

export function getMediaGroupId(update) {
  return getMessage(update)?.media_group_id ?? null;
}

export function classifyUpdate(update) {
  const message = getMessage(update);
  if (message?.photo?.length) return "photo";
  if (typeof message?.text === "string") return "text";
  if (update.callback_query) return "callback";
  return "other";
}

export function recordRawUpdate(db, update, receivedAt = new Date().toISOString()) {
  if (!Number.isSafeInteger(update?.update_id)) {
    throw new TypeError("Telegram update_id must be a safe integer");
  }

  const result = db.prepare(`
    INSERT OR IGNORE INTO raw_log(update_id, user_id, payload, received_at)
    VALUES (?, ?, ?, ?)
  `).run(
    update.update_id,
    getUserId(update),
    JSON.stringify(update),
    receivedAt,
  );

  const row = db.prepare(`
    SELECT id, update_id, user_id, payload, received_at
      FROM raw_log
     WHERE update_id = ?
  `).get(update.update_id);

  return {
    id: Number(row.id),
    duplicate: result.changes === 0,
    updateId: Number(row.update_id),
    userId: row.user_id,
    receivedAt: row.received_at,
  };
}
