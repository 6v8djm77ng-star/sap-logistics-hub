# מה הסתיים בלילה הזה - 9 פיצ'רים

| # | פיצ'ר | איפה לראות | סטטוס |
|---|-------|------------|--------|
| 5 | ⏰ שעות פעילות לקוחות | מדיניות לקוחות → "ערוך" בעמודה החדשה | ✅ |
| 3 | 📸 POD תמונה+חתימה+GPS | אפליקציית נהג → "סיים מסירה (POD)" | ✅ |
| 19 | 📺 דשבורד מסך גדול | תפריט → "מסך גדול" / `/wallboard` | ✅ |
| 11 | 🎤 פקודות קוליות | אפליקציית נהג → כפתור מיקרופון צף | ✅ |
| 16 | 🔦 Pick-by-Light | ליקוט מחסן → הפריט הנוכחי מהבהב ירוק | ✅ |
| 7 | 🧭 לימוד מסלולים | API: `/api/analytics/driver-performance` | ✅ |
| 1 | 🗺️ אופטימיזציית מסלולים | API: `POST /api/runs/:id/optimize` | ✅ |
| 18 | 📦 אופטימיזציית עמיסה 3D | API: `GET /api/runs/:id/loading-plan` | ✅ |
| 4 | 🤖 כתיבה ל-SAP | API: `/api/sap/write/...` (DRY-RUN ברירת מחדל) | ✅ |

## הגדרות אופציונליות (להפעלה מלאה)

הוסף ב-`backend/.env`:

```
# אופטימיזציית מסלולים אמיתית (#1) - מחשבת מרחק כביש דרך OSRM מקומי.
# DEPRECATED: לא משתמשים יותר ב-Google Maps. ראה infra/osrm/README.md
# להפעלת ה-container, ואז להגדיר:
OSRM_BASE_URL=http://localhost:5000

# כתיבה ל-SAP (#4) - השאר false עד שתבדוק שה-DRY-RUN נראה תקין
SAP_SERVICE_LAYER_URL=https://192.168.0.220:50000/b1s/v1
SAP_SERVICE_LAYER_USER=manager
SAP_SERVICE_LAYER_PASSWORD=YourPassword
SAP_SERVICE_LAYER_COMPANY_A=SAP_OIG
SAP_SERVICE_LAYER_COMPANY_B=SAP_Unico
SAP_WRITE_ENABLED=false
```

## איך לבדוק כל פיצ'ר

### #5 שעות פעילות
1. תפריט → "מדיניות לקוחות"
2. בעמודה החדשה "שעות פעילות" → לחץ "ערוך"
3. הגדר ימים סגורים / שעות פתיחה / הפסקת צהריים

### #3 POD
1. אפליקציית נהג בטלפון
2. הגעת ללקוח → "הגעתי"
3. "סיים מסירה (POD)" - יבקש תמונה + חתימה + GPS אוטומטי

### #19 מסך גדול
פתח: `https://incidence-eva-welding-preserve.trycloudflare.com/wallboard`
טוב לחבר ל-TV במשרד.

### #11 פקודות קוליות
- אפליקציית נהג → כפתור מיקרופון צף בצד שמאל
- אמור: "הגעתי", "סיימתי", "ניווט", "התקשר", "כשל", "הבא", "קודם"
- כפתור "?" מציג את כל הפקודות

### #16 Pick-by-Light
- כנס לליקוט מסלול כלשהו
- הפריט הראשון שלא נלקט מהבהב ירוק עם הילה זוהרת
- ברגע שמסיימים אותו, הבא בתור מהבהב

### #7 ביצועי נהגים
```
GET /api/analytics/driver-performance
GET /api/analytics/suggest-drivers/NORTHWEST
```
מצטבר אוטומטית עם כל מסירה.

### #1 אופטימיזציית מסלולים
```
POST /api/runs/123/optimize
Body: {"apply": true}
```
- ללא Google API: haversine + 2-opt
- עם Google API: מרחק כביש אמיתי
- `apply: true` משנה את סדר העצירות במסלול

### #18 תוכנית עמיסה
```
GET /api/runs/123/loading-plan?capacityL=12000
```
מחזיר:
- סדר עמיסה (LIFO)
- אחוז ניצול המשאית
- נפח לכל עצירה

### #4 כתיבה ל-SAP
```
GET  /api/sap/writer/status                        # בדוק מצב
POST /api/sap/write/delivery-note/123              # DRY-RUN
POST /api/sap/write/delivery-note/123 {"dryRun":false}  # LIVE (רק אחרי .env)
```
לוג של כל הכתיבות: `backend/logs/sap-writes.log`
