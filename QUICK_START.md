# מדריך התקנה מהיר - SAP Logistics Hub

## דרישות מערכת
- Node.js 20+ ([להורדה](https://nodejs.org))
- SQL Server 2019+ (קיים - אותו שרת של SAP B1)
- SAP B1 עם Service Layer פעיל

## התקנה - שלב אחר שלב

### 1. הגדרת מסד נתונים

הרץ את הסקריפט המוכן ב-SQL Server Management Studio או מהשורה הפקודה.
תצור מסד נתונים `SAP_Logistics_Hub` חדש (לא נוגע בנתוני SAP).

```powershell
# או לחילופין ב-PowerShell:
cd sap-logistics-hub
sqlcmd -S localhost -U sa -P YourPassword -i database/migrations/001_initial_schema.sql
sqlcmd -S localhost -U sa -P YourPassword -i database/migrations/002_seed_data.sql
```

### 2. הגדרת Backend

```powershell
cd backend
npm install
copy .env.example .env
# ערוך .env והזן פרטי חיבור לשרת SAP שלך
```

**ערכים חשובים ב-.env:**
```
SAP_SL_URL=https://your-sap-server:50000/b1s/v1
SAP_SL_USERNAME=manager
SAP_SL_PASSWORD=your-password
SAP_SL_COMPANY_DB_A=שם_DB_חברה_א
SAP_SL_COMPANY_DB_B=שם_DB_חברה_ב

SAP_SQL_HOST=localhost
SAP_SQL_USER=sa
SAP_SQL_PASSWORD=your-password
SAP_SQL_DB_A=שם_DB_חברה_א
SAP_SQL_DB_B=שם_DB_חברה_ב

LOGISTICS_SQL_HOST=localhost
LOGISTICS_SQL_USER=sa
LOGISTICS_SQL_PASSWORD=your-password
```

הרץ migrations:
```powershell
npm run migrate
```

הפעל את השרת:
```powershell
npm run dev
```

השרת זמין ב: http://localhost:4000

### 3. הגדרת Frontend

```powershell
cd frontend
npm install
npm run dev
```

הממשק זמין ב: http://localhost:5173

### 4. התחברות ראשונה

- **משתמש מנהל:** admin / admin123 (שנה מיד!)
- **נהג ברירת מחדל:** DRV-01 (הגדר סיסמה דרך המערכת)

## בדיקת חיבורים
אחרי שהשרת רץ, גש ל: `http://localhost:4000/health`
המערכת תבדוק אוטומטית חיבור ל: Logistics DB, SAP SQL (A+B), SAP Service Layer (A+B).
חייבים להופיע כ-`ok: true` לפני שמפעילים במובייל.

## נקודות קצה ב-API

### Auth
- `POST /api/auth/login` - התחברות מנהל/מתכנן
- `POST /api/auth/driver-login` - התחברות נהג (למובייל)

### Orders (הזמנות)
- `GET /api/orders/open` - רשימת הזמנות פתוחות משתי החברות
- `GET /api/orders/unified` - הזמנות מאוחדות לפי כתובת יעד
- `GET /api/orders/stats` - סטטיסטיקות איחוד

### Delivery Runs (מסלולי הפצה)
- `GET /api/runs` - רשימת מסלולים
- `POST /api/runs/auto-plan` - תכנון אוטומטי יומי
- `PATCH /api/runs/:id/status` - שינוי סטטוס
- `POST /api/runs/:id/wave` - יצירת גל ליקוט

### Driver (נהג)
- `GET /api/driver/my-runs` - מסלולי היום של הנהג
- `GET /api/driver/runs/:id/manifest` - דף נהג מלא
- `PATCH /api/driver/stops/:stopId/status` - עדכון סטטוס עצירה

### Returns (חזרות)
- `GET /api/returns` - חזרות ממתינות
- `POST /api/returns` - יצירת בקשת החזרה
- `POST /api/returns/:id/assign-to-run/:runId` - שיוך למסלול
- `POST /api/returns/:id/pickup` - סימון כנאסף (יוצר מסמך SAP)

### Reports (דוחות)
- `GET /api/reports/runs/:id/manifest.pdf` - דף נהג להדפסה
- `GET /api/reports/waves/:id/picking.xlsx` - רשימת ליקוט Excel
- `GET /api/reports/exceptions` - דוח חריגים (JSON)

### Audit (עקיבות)
- `GET /api/audit/:entityType/:entityId` - היסטוריית שינויים

## Deploy ל-Production

```powershell
docker-compose up -d --build
```

המערכת תרוץ על פורט 80 (אפליקציה) ו-4000 (API).

## מבנה הפרויקט

```
sap-logistics-hub/
├── backend/                  # Node.js + Express API
│   ├── src/
│   │   ├── config/          # env configuration
│   │   ├── db/              # connection + migrations
│   │   ├── middleware/      # auth, error handler
│   │   ├── routes/          # REST endpoints
│   │   ├── services/
│   │   │   ├── sap/         # SAP integration (SL + SQL)
│   │   │   ├── orderUnification.js
│   │   │   ├── deliveryRuns.js
│   │   │   ├── wavePicking.js
│   │   │   └── returnRequests.js
│   │   ├── sockets/         # Socket.IO real-time
│   │   └── server.js        # entry point
├── frontend/                 # React + Vite + Tailwind
│   ├── src/
│   │   ├── components/      # shared UI
│   │   ├── pages/
│   │   │   └── driver/      # PWA driver pages
│   │   ├── services/        # API client + socket
│   │   └── stores/          # Zustand auth store
├── database/
│   └── migrations/          # SQL schema + seed
└── docs/
```

## תהליכי עבודה עיקריים

### תכנון יומי (מתכנן לוגיסטיקה)
1. כניסה למערכת כ-PLANNER
2. "תכנון יומי" → בחר תאריך
3. לחץ "תכנון אוטומטי" → נוצרות מסלולים לפי אזור
4. בדוק ותקן ידנית במידת הצורך
5. ב-"מסלולי הפצה" → "צור גל ליקוט" לכל מסלול

### ליקוט (מחסנאי)
1. קבל רשימת ליקוט מאוחדת למסלול
2. סרוק פריטים → המערכת מעדכנת כמויות
3. סיום → המסלול עוברת אוטומטית ל-"הועמס"

### הפצה (נהג)
1. כניסה למובייל - /driver/login
2. בחר מסלול → רואה את כל העצירות + אפשרות ניווט
3. בכל עצירה: "הגעתי" → מסירת הזמנות → "סיום עצירה"
4. חזרות: רשום כמות בפועל → המערכת יוצרת מסמך SAP

### חזרות (שירות לקוחות)
1. לקוח מבקש החזרה → פותח "בקשת החזרה" במערכת
2. המתכנן משייך למסלול קיימת באזור
3. הנהג אוסף במהלך המסלול
4. המערכת יוצרת Return Request ב-SAP אוטומטית

## פתרון בעיות

**"Service Layer login failed"** - בדוק שה-URL כולל https:// ושהפורט (50000) פתוח

**"Cannot connect to SQL Server"** - ודא ש-TCP/IP enabled ב-SQL Configuration Manager

**"Session expired"** - המערכת מתחברת מחדש אוטומטית. אם ממשיך - בדוק את סיסמת SAP.

## תכונות מתקדמות

### Offline queue לנהגים
אפליקציית הנהג שומרת פעולות בתור כשאין אינטרנט.
כשהחיבור חוזר - היא שולחת אותן אוטומטית (עם retry).
הנהג רואה אינדיקטור "x בתור" ב-header.

### חתימה דיגיטלית
בסיום עצירה הנהג לוחץ "חתום וסיים עצירה".
נפתח canvas עם חתימה באצבע.
החתימה נשמרת כ-PNG בשרת ומקושרת לעצירה.

### תעודות משלוח אוטומטיות
כשנהג מסיים עצירה - המערכת יוצרת אוטומטית **תעודת משלוח** ב-SAP
עבור כל הזמנה (כל אחת ב-ח.פ שלה).
אם SAP לא זמין - ההזמנה מסומנת כנמסרה וה-batch retry ינסה שוב.

### Wave Picking חכם
המערכת מאחדת פריטים מכל ההזמנות במסלול לרשימת ליקוט אחת ממוינת לפי מיקום במחסן.
בזמן ליקוט - המערכת מתעדת איזה יחידה הולכת לאיזו הזמנה
(שומר על הפרדה חשבונאית בין החברות).

### דוח חריגים (Exceptions)
מופיע תחת "חריגים" בסרגל הצד.
מציג: כתובות ללא אזור, עצירות שנכשלו, חזרות לא משויכות,
ותעודות משלוח שלא הצליחו להיווצר ב-SAP.

### מעקב חי
תחת "מעקב חי" - מראה בזמן אמת את כל המסלולים הפעילות
עם פיד של אירועים (עצירות שהושלמו, הזמנות שנמסרו, פריטים שנלקטו).
מבוסס על Socket.IO.
