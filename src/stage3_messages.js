const MAX_MEMORY_ANSWER_CHARS = 8_000;

export const BUDGET_EXHAUSTED_TEXT =
  "התקציב היומי למודל הסתיים. שאילתות מקומיות עדיין זמינות; אפשר לנסות שוב מחר.";
export const AMBIGUOUS_WRITE_TEXT =
  "תוצאת הכתיבה לשיטס אינה ודאית. לא אנסה לכתוב שוב אוטומטית כדי למנוע כפילות.";
export const WRITE_UNAVAILABLE_TEXT =
  "הכתיבה לשיטס מושבתת בסביבת הדמו. לא נשמר דבר.";

export function memorySafeText(text) {
  if (text.length <= MAX_MEMORY_ANSWER_CHARS) return text;
  return `${text.slice(0, MAX_MEMORY_ANSWER_CHARS - 18)}\n[המשך לא נשמר]`;
}

export function budgetResponse() {
  return {
    text: BUDGET_EXHAUSTED_TEXT,
    usage: { totalTokens: 0 },
    budget: null,
    modelCalled: false,
  };
}
