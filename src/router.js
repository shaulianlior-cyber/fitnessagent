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
    event?.update?.callback_query?.data ??
    event?.payload?.update?.callback_query?.data ??
    message?.text ??
    "";

  return typeof value === "string" ? value.trim() : "";
}

function isPhotoEvent(event) {
  if (event?.type === "photo" || event?.kind === "album" || event?.payload?.kind === "album") {
    return true;
  }
  return Boolean(telegramMessage(event)?.photo?.length);
}

function mediaCount(event) {
  if (event?.kind === "album") {
    return event.updates?.length ?? 0;
  }
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

function extractionConfirmation(text) {
  const match = /^(confirm|cancel)_extraction:(\d+)$/u.exec(text);
  if (!match) return null;
  return {
    update: `${match[1]}_extraction`,
    pendingId: Number(match[2]),
  };
}

function historySearch(text) {
  const match = /^(?:מה\s+אמרנו\s+על|what\s+did\s+we\s+say\s+about)\s+(.+?)[?？.]?$/iu.exec(text);
  return match?.[1]?.trim() || null;
}

function loadChangeIntent(text) {
  if (
    /(?:להעלות|להגדיל|להגביר|להוסיף|תעלה|תגדיל|תגביר|תוסיף|נעלה|נגדיל|נגביר|נוסיף)\s+(?:(?:את|לי)\s+){0,2}(?:ה)?(?:עומס|מרחק|קילומטראז|קצב|קילומטר(?:ים)?)/u.test(text) ||
    /(?:increase|raise|add)\s+(?:the\s+|my\s+)?(?:load|mileage|distance|intensity|kilometers?)/iu.test(text) ||
    /(?:run|workout)\s+(?:harder|faster|longer)/iu.test(text)
  ) return "increase";
  if (
    /(?:להוריד|להפחית)\s+(?:את\s+)?(?:ה)?(?:עומס|מרחק|קילומטראז|קצב)/u.test(text) ||
    /(?:decrease|reduce)\s+(?:the\s+|my\s+)?(?:load|mileage|distance|intensity)/iu.test(text)
  ) return "decrease";
  if (
    /(?:לשמור|להישאר)\s+(?:על\s+)?(?:אותו\s+)?(?:עומס|מרחק|קצב)/u.test(text) ||
    /(?:maintain|keep)\s+(?:the\s+|my\s+|same\s+)?(?:load|mileage|distance|intensity)/iu.test(text)
  ) return "maintain";
  return null;
}

function isTrainingDecisionRequest(text) {
  const training = /(?:אימון|ריצה|לרוץ|עומס|מרחק|קצב|מנוחה|אינטרוול|טמפו|זון|ק(?:"|״)?מ|קילומטר(?:ים)?|workout|run|load|mileage|distance|pace|rest|interval|tempo|zone|kilometers?)/iu;
  const decision = /(?:כדאי|מומלץ|המלצה|מותר|מה\s+לעשות|תמליץ|תבנה|תכנן|תן\s+לי|איזה\s+(?:אימון|ריצה|מרחק|קצב)|רוצה\s+(?:לרוץ|לעשות)|האם\s+(?:אני\s+)?(?:יכול|כדאי|מותר|לעשות|לרוץ)|אפשר\s+(?:לי\s+)?(?:לעשות|לרוץ)|should|recommend|may\s+i|can\s+i|what\s+should|build|plan|give\s+me|which\s+(?:workout|run|distance|pace)|want\s+to\s+(?:run|train))/iu;
  const planning = /(?:מחר|בהמשך|בפעם\s+הבאה|(?:ה)?(?:אימון|ריצה)\s+הבא(?:ה)?|השבוע|בשבוע\s+הבא|tomorrow|later|next\s+(?:time|workout|run|week)|this\s+week)/iu;
  const proposal = /(?:בוא(?:ו)?\s+(?:נעשה|נרוץ|נתאמן|נעלה|נגדיל|נוסיף|נגביר|נשמור|נוריד|נפחית)|(?:אני\s+)?(?:אעשה|ארוץ)|נעשה|נרוץ|let'?s\s+(?:run|train|do)|i(?:'ll|\s+will)\s+(?:run|train|do))/iu;
  const scheduled = /(?:אני\s+עושה|i(?:'m|\s+am)\s+(?:running|training|doing))/iu;
  const approval = /(?:אוקיי|בסדר|מאשר|okay|ok|right)\s*[?？]?$/iu;

  return (
    (decision.test(text) && (training.test(text) || planning.test(text))) ||
    (training.test(text) && proposal.test(text)) ||
    (training.test(text) && planning.test(text) && (scheduled.test(text) || approval.test(text)))
  );
}

export function routeEvent(event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("routeEvent requires an event object");
  }

  if (isPhotoEvent(event)) {
    return { handler: "extract", params: { mediaCount: mediaCount(event) } };
  }

  const text = eventText(event);
  const confirmation = extractionConfirmation(text);
  if (confirmation) return { handler: "update", params: confirmation };

  if (isDaysSinceRunQuery(text)) {
    return { handler: "query", params: { query: "days_since_run" } };
  }

  const search = historySearch(text);
  if (search) {
    return { handler: "query", params: { query: "conversation_search", text: search } };
  }

  if (isCompletionUpdate(text)) {
    return { handler: "update", params: { update: "activity_completed" } };
  }

  const loadChange = loadChangeIntent(text);
  const workout = loadChange
    ? { loadChange }
    : isTrainingDecisionRequest(text) ? {} : null;
  return {
    handler: "chat",
    params: workout ? { text, workout } : { text },
  };
}
