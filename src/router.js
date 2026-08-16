function telegramMessage(event) {
  const update = event?.payload?.update ?? event?.update ?? event;
  return (
    update?.message ??
    update?.edited_message ??
    update?.callback_query?.message ??
    null
  );
}

function eventText(event) {
  const message = telegramMessage(event);
  const value =
    event?.text ??
    event?.payload?.text ??
    event?.callback_query?.data ??
    event?.payload?.update?.callback_query?.data ??
    message?.text ??
    "";

  return typeof value === "string" ? value.trim() : "";
}

function isPhotoEvent(event) {
  if (event?.type === "photo" || event?.payload?.kind === "album") return true;
  return Boolean(telegramMessage(event)?.photo?.length);
}

function mediaCount(event) {
  if (event?.payload?.kind === "album") {
    return event.payload.updates?.length ?? 0;
  }
  return isPhotoEvent(event) ? 1 : 0;
}

function isDaysSinceRunQuery(text) {
  return (
    /כמה\s+ימים\s+מאז\s+(?:ה)?ריצה/u.test(text) ||
    /מתי\s+רצתי\s+לאחרונה/u.test(text) ||
    /how\s+many\s+days\s+since\s+(?:(?:my|the)\s+last\s+|a\s+)?run/iu.test(text)
  );
}

function isCompletionUpdate(text) {
  return /^(?:בוצע|ביצעתי|עשיתי|done|completed)[.!\s]*$/iu.test(text);
}

export function routeEvent(event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("routeEvent requires an event object");
  }

  if (isPhotoEvent(event)) {
    return { handler: "extract", params: { mediaCount: mediaCount(event) } };
  }

  const text = eventText(event);
  if (isDaysSinceRunQuery(text)) {
    return { handler: "query", params: { query: "days_since_run" } };
  }

  if (isCompletionUpdate(text)) {
    return { handler: "update", params: { update: "activity_completed" } };
  }

  return { handler: "chat", params: { text } };
}
