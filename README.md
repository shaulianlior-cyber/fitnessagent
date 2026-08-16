# Running Coach Agent

סוכן אימון אישי בטלגרם. מחליף מערכת ידנית קיימת המבוססת על Google Sheets,
עוזרי AI, דאשבורד והעתקות ידניות.

**גרסת מפרט:** 1.0 · **תאריך:** 2026-08-16 · **בעלים:** ליאור

## מצב נוכחי

שלב 0 הושלם. שלב 1 ממומש כשלד מקומי בלבד, ללא AI וללא חיבור כתיבה ל־Google
Sheets.

השלד כולל:

- Telegram-compatible HTTP webhook
- לוג גולמי append-only עם מניעת כפילויות לפי `update_id`
- תור SQLite סדרתי ועמיד להפעלה מחדש
- איחוד אלבום Telegram לאירוע אחד לאחר חלון של שתי שניות
- `sheets.js` לקריאה בלבד מנתוני דמה מקומיים
- בדיקת חיים ב־`GET /health`

## הרצה מקומית

נדרש Node.js 24 ומעלה. אין צורך בהתקנת חבילות.

```powershell
npm test
npm start
```

ה־webhook זמין בכתובת:

```text
POST http://127.0.0.1:3000/telegram/webhook
```

דוגמת בקשה מקומית:

```powershell
$body = '{"update_id":1,"message":{"message_id":1,"from":{"id":123},"chat":{"id":123},"text":"demo"}}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/telegram/webhook -ContentType application/json -Body $body
```

נתוני זמן הריצה נשמרים ב־`data/stage1.sqlite` ואינם נכנסים ל־Git.

## גבול Google Sheets

בשלב 1, `src/sheets.js` קורא רק את `data/demo-sheets.json`. הפעולות `write()`
ו־`update()` תמיד זורקות `ReadOnlySheetsError`. אין בקוד פרטי התחברות, Google
API client או כתיבה לשיטס האמיתי.

## סדר קריאה

| קובץ | מתי |
|---|---|
| `07_AI_ONBOARDING.md` | כלי AI שמצטרף — ראשון |
| `BUILD_LOG.md` | מה כבר נבנה ומה פתוח |
| `DECISIONS.md` | החלטות העיצוב המחייבות |
| `01_ARCHITECTURE.md` | לפני עבודת קוד |
| `02_SCHEMA.md` | כשנוגעים בנתונים |
| `03_RULES.md` | כשנוגעים בכללים |
| `04_MEMORY.md` | כשנוגעים בשיחה ובקונטקסט |
| `05_BUILD_PLAN.md` | לתכנון שלב |
| `06_FAILURE_MODES.md` | לפני החלטת עיצוב |

יומנים חיים: `BUILD_LOG.md` · `DECISIONS.md` · `CHANGELOG.md`.

## שלושת חוקי הברזל

1. השיטס הוא מקור האמת; המצב המקומי הוא מטמון נגזר.
2. הבטיחות נמצאת בקוד, לא בפרומפט.
3. הבוט אינו משנה כלל בעצמו; הוא מציע והמשתמש מאשר.

## תוכנית הבנייה

```text
שלב 0  ניקוי נתונים + מפרט             הושלם
שלב 1  שלד מקומי ללא AI                הושלם
שלב 2  מנוע כללים + ניתוב              הבא
שלב 3  מאמן + זיכרון + תמונות
שלב 4  יזום
שלב 5  למידה + הלבשת הדומיין
```
