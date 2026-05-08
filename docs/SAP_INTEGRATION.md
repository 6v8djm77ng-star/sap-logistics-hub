# אינטגרציית SAP Business One - מדריך הטמעה

מסמך זה מסביר כיצד המערכת משתלבת עם SAP B1 ואיך להתאים אותה לסביבה שלך.

## שתי שכבות אינטגרציה

### 1. SAP Service Layer (REST API) - לכתיבה
המערכת משתמשת ב-Service Layer ליצירת מסמכים חדשים ב-SAP:
- **Delivery Notes** (תעודות משלוח) - אחרי שהנהג מסיים הזמנה
- **Return Requests** (בקשות החזרה) - אחרי איסוף חזרה אצל לקוח
- **Returns** (תעודות החזרה) - השלב השני אחרי בקשת החזרה

כל חברה (A, B) מקבלת session נפרד. המערכת דואגת ל-relogin אוטומטי.

### 2. SQL Server ישיר - לקריאה
לקריאות (הזמנות פתוחות, לקוחות, פריטים, מלאי) - המערכת ניגשת ישירות ל-SQL כי:
- מהיר 10x-50x מה-Service Layer
- מאפשר joins בין טבלאות וחברות
- אין rate limits

## טבלאות SAP שבהן המערכת משתמשת

| טבלה | תיאור | שימוש |
|------|-------|--------|
| **ORDR** | Sales Orders | קריאת הזמנות פתוחות |
| **RDR1** | Sales Order Lines | שורות הזמנה |
| **OCRD** | Business Partners | לקוחות |
| **CRD1** | BP Addresses | כתובות משלוח |
| **OITM** | Items Master | פריטים |
| **OITW** | Items in Warehouse | מלאי |
| **ODLN** | Delivery Notes | תעודות משלוח (כתיבה) |
| **ORRR** | Return Requests | בקשות החזרה (כתיבה) |
| **ORDN** | Returns | תעודות החזרה (כתיבה) |

## שדות מותאמים (UDFs)

**מיקום הקובץ:** `backend/src/config/sapFields.js`

המערכת תומכת במספר UDFs נפוצים. אם ב-SAP שלכם שמות השדות שונים, עדכן:

```javascript
export const SAP_FIELDS = {
  CUSTOMER_BRANCH_FIELD: 'U_BranchName',  // שם סניף הלקוח
  ITEM_BIN_LOCATION_FIELD: 'U_BinLoc',    // מיקום מדף במחסן
  ORDER_SHIPTO_CODE_FIELD: 'U_ShipToCode', // קוד כתובת משלוח
  DEFAULT_WAREHOUSE_CODE: '01',           // מחסן ברירת מחדל
};
```

### איך לבדוק אילו UDFs יש ב-SAP שלכם?

הרץ ב-SSMS נגד ה-DB של החברה:

```sql
-- UDFs על OCRD (לקוחות):
SELECT AliasID, Descr, TypeOfField
FROM CUFD
WHERE TableID = 'OCRD';

-- UDFs על OITM (פריטים):
SELECT AliasID, Descr, TypeOfField
FROM CUFD
WHERE TableID = 'OITM';

-- UDFs על ORDR (הזמנות):
SELECT AliasID, Descr, TypeOfField
FROM CUFD
WHERE TableID = 'ORDR';
```

## זרימת יצירת תעודת משלוח

```
נהג מסמן "נמסר" במובייל
        ↓
POST /api/driver/orders/:runOrderId/deliver
        ↓
deliveryNotes.createDeliveryNoteForOrder()
  1. שולף פרטי RunOrder מה-DB שלנו
  2. שולף שורות הזמנה מ-SAP SQL (RDR1)
  3. בונה DocumentLines עם BaseType=17 (Sales Order)
  4. שולח POST ל-/b1s/v1/DeliveryNotes
  5. שומר SapDeliveryDocEntry בחזרה ב-RunOrder
        ↓
אם נכשל - SapSyncWorker מנסה שוב עם backoff
```

## דוגמה: יצירת Delivery Note ידנית דרך Service Layer

```bash
# 1. Login (get session cookie)
curl -k -c cookies.txt -X POST https://your-sap:50000/b1s/v1/Login \
  -H "Content-Type: application/json" \
  -d '{"UserName":"manager","Password":"pass","CompanyDB":"SBO_COMPANY_A"}'

# 2. Create Delivery Note (based on Sales Order DocEntry=123)
curl -k -b cookies.txt -X POST https://your-sap:50000/b1s/v1/DeliveryNotes \
  -H "Content-Type: application/json" \
  -d '{
    "CardCode": "C12345",
    "DocDate": "2026-04-23",
    "DocumentLines": [
      {
        "ItemCode": "ITEM001",
        "Quantity": 10,
        "WarehouseCode": "01",
        "BaseType": 17,
        "BaseEntry": 123,
        "BaseLine": 0
      }
    ]
  }'
```

## טבלאות שלנו (לא ב-SAP!)

המערכת שומרת את השכבה הלוגיסטית שלה ב-DB חדש בשם `SAP_Logistics_Hub`:

- **Companies** - מיפוי ח"פ ↔ SAP CompanyDB
- **Zones** - 7 אזורי הפצה
- **Drivers** - נהגים + שיוך לאזורים
- **NormalizedAddresses** - כתובות מאוחדות מקנוניזציה
- **CustomerAddressLinks** - גשר SAP CardCode ↔ כתובת מנורמלת
- **DeliveryRuns** - מסלולי הפצה
- **DeliveryStops** - עצירות במסלול
- **RunOrders** - קישור עצירה ↔ הזמנת SAP
- **PickingWaves** - גלי ליקוט
- **ReturnRequests** - בקשות החזרה (לפני SAP)
- **AuditLog** - עקיבות שינויים
- **DriverLocations** - GPS חי
- **SapRetryQueue** - תור לפעולות SAP שנכשלו

**כלל זהב:** כל שינוי במסמכי SAP חייב לעבור דרך ה-Service Layer. אסור לעדכן
טבלאות SAP ישירות ב-SQL - זה ישבור constraints של SAP.

## ביצועים וטרייד-אוף

- **קריאה מ-SQL ישירה:** ~50ms לשאילתת הזמנות פתוחות
- **קריאה דרך Service Layer:** ~500-2000ms
- **כתיבה דרך Service Layer:** ~1-3 שניות למסמך

המערכת מתוכננת ל-5 משתמשים במקביל עם עומס של ~100 הזמנות ביום.
לצרכים גדולים יותר - כדאי לשקול caching ב-Redis.

## פתרון בעיות

### "CONNECTION_FAILED_TO_SERVER" ב-Service Layer
בדוק:
1. פורט 50000 פתוח ב-firewall
2. SSL certificate - אם self-signed, וודא `SAP_SL_SSL_REJECT_UNAUTHORIZED=false`
3. שם ה-CompanyDB מדויק (case-sensitive)

### "Invalid login session" אחרי 30 דקות
זה נורמלי - המערכת אמורה לעשות relogin אוטומטית.
אם לא עובד - ה-`-100` SAP timeout setting אולי נמוך מדי.

### "BaseEntry doesn't match" בעת יצירת Delivery Note
המשמעות: ההזמנה כבר סגורה ב-SAP (DocStatus='C').
פתרון: פותחים מחדש ב-SAP או ממחקים את ה-RunOrder ויוצרים מחדש.

### Performance איטי בשאילתות מורכבות
הוסף אינדקסים על ה-UDFs שאתה מסנן לפיהם:
```sql
CREATE INDEX IX_ORDR_U_ShipToCode ON ORDR(U_ShipToCode);
```
