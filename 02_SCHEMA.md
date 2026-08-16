# 02 — סכימת נתונים

## כלל-על: תלת-מצב

**כל שדה קריטי הוא תלת-מצבי, לא בינארי.**

| ערך | משמעות |
|---|---|
| `clean` | נבדק, תקין |
| `issue` | נבדק, בעייתי |
| `` (ריק) | **לא דווח** |

**ריק ≠ נקי. "לא דווח" חוסם העלאת עומס בדיוק כמו "בעייתי".**

זה הכשל שהסתיר במערכת הקודמת ארבעה חודשים ללא ביצוע שגרת ברך. **חייב להיות בסכימה מהיום הראשון** — להוסיף אחר כך = לגעת בכל שכבה.

---

## Google Sheets

### `Runs` — כל האימון
עמודות קיימות נשמרות. **נוספות:**

| עמודה | טיפוס | הערה |
|---|---|---|
| `Next-Day Knee` | tri-state | |
| `Next-Day Groin` | tri-state | |
| `Next-Day Calf-Achilles` | tri-state | |
| `Groin During` | 0-10 \| ריק | לברך יש 3 עמודות, למפשעה לא הייתה אף אחת |
| `Knee Routine Done` | bool \| ריק | **מדידת ציות, לא דיווח** |
| `Recommendation ID` | string | לולאת התוצאות |
| `Followed` | full\|partial\|no\|adapted \| ריק | |
| `Source` | manual\|ocr\|import | מאיפה הגיע |

### `Rules` — הכללים כדאטה
`rule_id · type · condition · action · severity · confidence · approved_date · approved_by · superseded_by · evidence · counter_examples`

מסונכרן ל-`rules.json`. ראה `03_RULES.md`.

### `Conversation Log`
`timestamp · topic · decided · open_items`

**למה:** החלטות שנאמרו בשיחה ולא נכנסו לשום שדה נעלמות. זה קרה במערכת הקודמת.

### `Recommendations`
`rec_id · date · content · rule_basis · followed · outcome · outcome_date`

**זו לולאת הלמידה.** בלעדיה יש תיעוד, לא שיפור.

### טאבים קיימים שנשארים
`Weight Tracker` · `Splits` · `Goals` · `Apple Periodic Research`

---

## SQLite מקומי

```sql
raw_log(id, update_id UNIQUE, user_id, payload, received_at)
-- append-only. אף פעם לא נמחק.
-- זה הביטוח: אפשר לבנות הכל מחדש ממנו.

queue(id, event_id, status, attempts, error, created_at)
-- כותב אחד בכל רגע. סדרתי.

conversations(id, user_id, role, content, tokens, created_at)

session(user_id, summary, open_items, updated_at)

preferences(user_id, key, value, approved_at)
-- מה שאושר במפורש. לא נדחס לעולם.

state_cache(user_id, json, rebuilt_at)
-- נגזר. ניתן לזריקה. rebuild בונה מחדש מהשיטס.

costs(date, model, tokens_in, tokens_out, cost)
-- לתקרה היומית.
```

---

## חוקי נתונים

1. **תא ריק נשאר ריק.** אין `0` ואין `00:00:00` כ-placeholder.
2. **קריאת עמודות לפי שם.** שינוי בשיטס לא ישבור את הפרסר.
3. **תאריכים: UTC פנימית**, המרה ל-`Asia/Jerusalem` בשכבה אחת בלבד.
   - ריצה ב-23:30 נרשמת ליום הנכון
   - תזכורת בוקר לא מגיעה ב-3 לפנות בוקר
4. **פורמט תאריך אחיד** בכל הטאבים: `YYYY-MM-DD`.
5. **מזהה שורה יציב** — לא מספר שורה. מספרי שורות זזים.

---

## ולידציה — לפני כל כתיבה

| בדיקה | טווח |
|---|---|
| דופק | 30–200 |
| מרחק | 0–50 ק"מ |
| קצב | 3:00–15:00 /ק"מ |
| סכום זונים | = משך ±60 שניות |
| RPE | 1–10 |
| כאב | 0–10 |
| תאריך | לא בעתיד |

**נכשל → נשאל, לא מנוחש.**

---

## שלב 0 — לפני קוד

ניקוי שגיאות ידועות בשיטס הקיים:

- [ ] `21.06` — 12 שעות בזון 4
- [ ] `18.06` — עמודות מוזזות (קריותרפיה)
- [ ] `06.05` — `#REF!`
- [ ] `Splits` — עמודה I לא חוקית
- [ ] placeholders `0.00` / `00:00:00` (29.06, 15.07, 27.07, 29.07)
- [ ] פורמט תאריכים — `Weight Tracker` מול `Runs`
- [ ] `Goals` — שורה יתומה
- [ ] `13.08` — תגובת יום-אחרי לא מסונכרנת

**אסור להתחיל קוד לפני שזה סגור.** כל באג שיישאר יהפוך ללוגיקה.
