# מדריך פרודקשן - SAP Logistics Hub

מדריך מלא להתקנה, הפעלה ותחזוקה של המערכת בפרודקשן.

---

## 🚀 התקנה מהירה (מומלץ)

### אפשרות 1: סקריפט התקנה אוטומטי
```powershell
cd 'C:\path\to\sap-logistics-hub'
powershell -ExecutionPolicy Bypass -File install.ps1
```
הסקריפט מבצע את כל הצעדים: בודק prerequisites, מתקין חבילות, מחולל JWT, מריץ migrations, עושה build, ומפעיל דרך PM2.

### אפשרות 2: Docker (הכי פשוט לפרודקשן)
```powershell
cd sap-logistics-hub
cp backend/.env.example backend/.env
notepad backend/.env   # ערוך ומלא את LOGISTICS_SQL_*
docker-compose up -d --build
```

### אפשרות 3: ידנית
ראה [QUICK_START.md](../QUICK_START.md)

---

## 🔌 חיבור ל-SAP (הכי חשוב!)

המערכת **תתחיל לרוץ גם בלי SAP מוגדר**. תוכל להגדיר חיבור דרך הממשק הגרפי:

### שלב 1: הפעל את המערכת
גם בלי SAP - הכנס ב-`.env` רק את:
```ini
JWT_SECRET=<חולל אוטומטית ע"י install.ps1>
LOGISTICS_SQL_HOST=localhost
LOGISTICS_SQL_USER=sa
LOGISTICS_SQL_PASSWORD=<סיסמה>
LOGISTICS_SQL_DB=SAP_Logistics_Hub
```

### שלב 2: התחבר כ-admin
- כתובת: `http://localhost:4000`
- משתמש: `admin` / סיסמה: `admin123`
- **שנה סיסמה מיד** (משתמשים → admin → איפוס סיסמה)

### שלב 3: עבור ל"הגדרות + SAP"
בתפריט הצדדי תמצא את הסעיף הזה. לחץ **"בדוק חיבור"**.

המערכת תבדוק **4 חיבורים**:
| בדיקה | מה נבדק |
|-------|---------|
| SQL - חברה א | נגישות TCP, login, קיום הטבלאות OCRD/OITM/ORDR/RDR1, מספרי רשומות |
| SQL - חברה ב | אותו דבר לחברה השנייה |
| Service Layer - חברה א | TCP, login, session timeout |
| Service Layer - חברה ב | אותו דבר |

### שלב 4: קריאת שגיאות
אם משהו נכשל, תקבל **שגיאה + רמז מה לתקן**:

| השגיאה אמרה | מה לעשות |
|------------|----------|
| `Cannot reach host:1433` | בדוק שהשרת רץ + firewall פתוח + TCP/IP enabled ב-SQL Configuration Manager |
| `Login failed for user` | שם משתמש/סיסמה שגויים ב-`SAP_SQL_USER` / `SAP_SQL_PASSWORD` |
| `Cannot open database` | שם ה-DB ב-`SAP_SQL_DB_A` שגוי |
| `Missing tables: OCRD` | ה-DB שהזנת אינו SAP B1 CompanyDB |
| `Cannot reach Service Layer` | SL לא רץ או פורט 50000 חסום |
| `Error code -304` | שם משתמש/סיסמה שגויים ל-SAP_SL |
| `Company "xyz" not found` | `SAP_SL_COMPANY_DB_A` לא מדויק |

### שלב 5: בדוק דוגמאות
ברגע שחברה נחברה בהצלחה, יופיע סעיף "תצוגה מקדימה" עם:
- 10 לקוחות
- 10 פריטים
- 10 הזמנות פתוחות אחרונות

אם הנתונים האלה נראים הגיוניים - המערכת מחוברת כמו שצריך!

### החברות של OIG (סביבת טסט)
ברירת המחדל ב-`.env.example` כבר מוגדרת עם:
- **חברה א**: `SAP_OIG_TEST_290724`
- **חברה ב**: `Test_Unico`

---

## 🔧 מבנה פריסה בפרודקשן

### תלויות
- **Node.js 20+** - runtime
- **SQL Server 2019+** - DB של המערכת שלנו + SAP
- **PM2** (אופציונלי) - process manager

### פורטים
- **4000** - שרת backend + serves frontend (production)
- **5173** - frontend dev server (פיתוח בלבד)
- **1433** - SQL Server (ברירת מחדל של MSSQL)
- **50000** - SAP Service Layer

### משתני סביבה חיוניים

```ini
# ==== חובה ====
JWT_SECRET=<32+ chars random>          # חולל ע"י install.ps1
LOGISTICS_SQL_HOST=localhost
LOGISTICS_SQL_USER=sa
LOGISTICS_SQL_PASSWORD=<password>
LOGISTICS_SQL_DB=SAP_Logistics_Hub

# ==== SAP (אפשר מאוחר יותר דרך UI) ====
SAP_SL_URL=https://sap-server:50000/b1s/v1
SAP_SL_USERNAME=manager
SAP_SL_PASSWORD=<password>
SAP_SL_COMPANY_DB_A=SAP_OIG_TEST_290724
SAP_SL_COMPANY_DB_B=Test_Unico

SAP_SQL_HOST=localhost
SAP_SQL_USER=sa
SAP_SQL_PASSWORD=<password>
SAP_SQL_DB_A=SAP_OIG_TEST_290724
SAP_SQL_DB_B=Test_Unico

# ==== אימייל (אופציונלי) ====
SMTP_HOST=smtp.gmail.com               # או שרת המייל שלך
SMTP_PORT=587
SMTP_USER=you@yourdomain.com
SMTP_PASSWORD=<app-specific password>
SMTP_FROM="SAP Logistics Hub <noreply@yourdomain.com>"
```

---

## 🎛️ ניהול שירות (PM2)

```powershell
# סטטוס
pm2 status

# לוגים (live tail)
pm2 logs logistics-backend
pm2 logs logistics-backend --lines 100   # 100 שורות אחרונות

# restart
pm2 restart logistics-backend

# stop / start
pm2 stop logistics-backend
pm2 start logistics-backend

# הפעל אוטומטית בעת boot של Windows
pm2-startup install
pm2 save
```

### ניקוי לוגים תקופתי
```powershell
pm2 flush    # מנקה את הלוגים
```

## 🎛️ ניהול שירות (Docker)

```powershell
# סטטוס
docker-compose ps

# לוגים
docker-compose logs -f app

# restart
docker-compose restart app

# stop / start
docker-compose down
docker-compose up -d

# re-build אחרי שינוי קוד
docker-compose up -d --build
```

---

## 🔍 מוניטורינג ובריאות

### Health check endpoint
```
GET http://localhost:4000/health
```
מחזיר:
```json
{
  "ok": true,
  "time": "2026-04-23T15:00:00Z",
  "checks": {
    "logisticsDb": { "ok": true, "latencyMs": 5 },
    "sapSqlA": { "ok": true, "latencyMs": 12 },
    "sapSqlB": { "ok": true, "latencyMs": 14 },
    "sapSlA": { "ok": true, "latencyMs": 180 },
    "sapSlB": { "ok": true, "latencyMs": 195 }
  }
}
```
- **status=200** אם הכל תקין
- **status=503** אם משהו נכשל

הוסף את זה למערכת monitoring חיצונית (UptimeRobot, Zabbix, etc.)

### לוגים
לוגים נכתבים ל:
- **Console** - כולל צבעים (דרך PM2 log)
- `backend/logs/error.log` - ERROR בלבד (JSON)
- `backend/logs/combined.log` - הכל (JSON)
- `backend/logs/pm2-out.log` + `pm2-error.log` (דרך PM2)

### Background workers
שני workers רצים בתוך ה-process:
1. **SAP sync worker** (כל 30s) - retry לתעודות משלוח/חזרות שנכשלו
2. **Daily digest worker** (07:00 בבוקר) - מייל סיכום למנהל

שניהם מופעלים/נעצרים אוטומטית עם השרת.

---

## 💾 גיבוי

### מה לגבות
1. **מסד הנתונים `SAP_Logistics_Hub`** - כל הנתונים הלוגיסטיים
2. **תיקיית `backend/uploads/`** - חתימות לקוחות + תמונות מסירות/כשלים
3. **`backend/.env`** - הגדרות

### SQL Server backup
```sql
BACKUP DATABASE SAP_Logistics_Hub
TO DISK = 'D:\Backups\SAP_Logistics_Hub_20260423.bak'
WITH COMPRESSION, CHECKSUM;
```

### Automated (Windows Scheduled Task)
שמור את זה כ-`backup.ps1` והרץ יומית ב-2:00 לילה:
```powershell
$date = Get-Date -Format 'yyyyMMdd_HHmmss'
$backup = "D:\Backups\SAP_Logistics_Hub_$date.bak"

sqlcmd -S localhost -U sa -P "$env:SQL_PASS" -Q @"
BACKUP DATABASE SAP_Logistics_Hub
TO DISK = N'$backup' WITH COMPRESSION, CHECKSUM;
"@

# זיפ של uploads
Compress-Archive -Path 'C:\path\sap-logistics-hub\backend\uploads' -DestinationPath "D:\Backups\uploads_$date.zip"

# מחק גיבויים ישנים מ-30 יום
Get-ChildItem D:\Backups\ -Filter 'SAP_Logistics_Hub_*.bak' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  Remove-Item
```

---

## 🔐 אבטחה

### Checklist לפני העברה לפרודקשן
- [ ] שינוי סיסמת `admin` ברירת מחדל
- [ ] `JWT_SECRET` חזק (>32 chars, אקראי)
- [ ] סיסמאות SQL Server לא ברירת מחדל
- [ ] HTTPS לפנייה חיצונית (דרך reverse proxy: nginx/IIS/CloudFlare)
- [ ] גיבויים אוטומטיים עובדים (בדוק רסטור!)
- [ ] גישה ל-SQL רק מ-IPs מורשים
- [ ] פורטים לא נדרשים חסומים ב-firewall (רק 80/443 לציבור, 4000 פנימי)
- [ ] לוגים מסונכרנים ל-centralized logging (אופציונלי)

### HTTPS (reverse proxy)
מומלץ להציג את המערכת מאחורי **nginx** או **IIS** עם HTTPS:

**nginx config:**
```nginx
server {
    listen 443 ssl http2;
    server_name logistics.yourcompany.com;

    ssl_certificate /path/cert.pem;
    ssl_certificate_key /path/key.pem;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

server {
    listen 80;
    server_name logistics.yourcompany.com;
    return 301 https://$server_name$request_uri;
}
```

עדכן את `PORTAL_BASE_URL=https://logistics.yourcompany.com` ב-.env כדי שלינקי המעקב ללקוחות יעבדו עם HTTPS.

---

## 🧪 בדיקות

### בדיקות יחידה
```powershell
cd backend
npm test
```
מריץ את `addressNormalizer.test.js` (13 טסטים).

### בדיקה ידנית end-to-end
1. התחבר כ-admin → עבור ל"הגדרות + SAP" → "בדוק חיבור" → ודא שהכל ירוק
2. "תכנון יומי" → בחר תאריך שיש בו הזמנות → "תכנון אוטומטי"
3. "מסלולי הפצה" → לחץ על מסלול → ודא שיש עצירות
4. "ליקוט מחסן" → צור גל ליקוט
5. התחבר כ-DRV-01 במובייל → ודא שרואים את המסלול
6. סמן עצירה כ"הגעתי" ← "סיים עצירה" ← חתום דיגיטלית → ודא שתעודת משלוח נוצרת ב-SAP
7. סמן עצירה אחרת ככשל → ודא שמגיע מייל למנהל ושמופיע ב-"ניהול כשלים"
8. "ניתוח ביצועים" → ודא שהנתונים מתעדכנים

---

## 🆘 פתרון בעיות נפוצות

### "הפורט 4000 תפוס"
```powershell
# מצא מה תופס
Get-NetTCPConnection -LocalPort 4000 | Select-Object OwningProcess
Get-Process -Id <pid>

# הרוג אותו או שנה PORT ב-.env
```

### "LOGISTICS_SQL_* failed"
בדוק:
1. SQL Server רץ: `Get-Service MSSQLSERVER` (או שם שלך)
2. TCP/IP מאופשר ב-SQL Server Configuration Manager
3. משתמש/סיסמה נכונים
4. firewall: `New-NetFirewallRule -DisplayName 'MSSQL' -Direction Inbound -LocalPort 1433 -Protocol TCP -Action Allow`

### "PWA לא מתקין במובייל"
PWA עובד רק על HTTPS (חוץ מ-localhost). אם אתה ב-http:// דרך IP → הדפדפן לא יציע התקנה. הגדר HTTPS דרך reverse proxy.

### "תעודות משלוח לא נוצרות ב-SAP"
ראה "ניהול חריגים" → "תעודות משלוח שלא נוצרו ב-SAP". אם יש שם פריטים:
1. בדוק `GET /health` אם SAP SL זמין
2. ה-retry worker ינסה שוב אוטומטית
3. אם ממשיך להיכשל - בדוק את הלוג:
```powershell
pm2 logs logistics-backend | Select-String "createDeliveryNote"
```

### "הודעות לא נשלחות"
1. בדוק ב-DB: `SELECT TOP 20 * FROM NotificationLog ORDER BY CreatedAt DESC`
2. סטטוס `QUEUED` = SMTP לא מוגדר
3. סטטוס `FAILED` = יש הודעת שגיאה בעמודה ErrorMessage
4. ודא שב-`.env` יש `SMTP_HOST` ושהוא נכון

---

## 📊 ביצועים

### צפי לסביבה של OIG
- **5 משתמשים במקביל** (מתכנן + מחסנאי + 2 נהגים + ViewOnly)
- **~100 הזמנות ביום**
- **~30 עצירות ביום**
- **~1000 טרנזאקציות SAP ביום**

### פרופיל משאבים
- **RAM**: ~200MB בעבודה רגילה, עד 400MB בעומס
- **CPU**: מינימלי חוץ מ-build של גל ליקוט (5-15 שניות)
- **Disk**: ~50MB לשבוע לוגים + תמונות (תלוי בפעילות)

### אם יש עומס גבוה יותר
- הוסף indexing על `RunOrders(SapDocEntry, CompanyId)`, `DeliveryStops(Status)`, `ReturnRequests(Status)`
- שקול Redis cache לתצוגות כבדות
- Load balancer עם כמה instances של backend (שימו לב ל-Socket.IO sticky sessions)

---

## 📞 תחזוקה שוטפת

### יומי
- [ ] בדיקת מייל סיכום יומי (מגיע ב-07:00)
- [ ] פתיחת "ניהול כשלים" וטיפול בכשלים פתוחים

### שבועי
- [ ] בדיקת "חריגים" - כתובות ללא אזור, תעודות משלוח תקועות
- [ ] סקירת "ניתוח ביצועים" - השוואה לשבוע קודם

### חודשי
- [ ] בדיקה שגיבויים עובדים (רסטור לבדיקה)
- [ ] עדכון סיסמאות משתמשים
- [ ] ניקוי רשומות ישנות: `DELETE FROM NotificationLog WHERE CreatedAt < DATEADD(MONTH, -3, GETDATE())`
- [ ] ניקוי tracking tokens ישנים (`cleanupExpiredTokens` - אפשר להוסיף כ-cron)
- [ ] ניקוי `AuditLog` ישן יותר מ-6 חודשים (לפי דרישות שלך)

### רבעוני
- [ ] עדכון Node.js לגרסה אחרונה של ה-LTS
- [ ] `npm audit fix` לסגירת פרצות
- [ ] עדכון SAP B1 patches אם יש
