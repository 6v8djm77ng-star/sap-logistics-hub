/**
 * Demo data - realistic Israeli customers, orders, drivers, runs.
 * Used by demoServer.js to show the full system without SQL/SAP.
 */
import { format, addDays, subDays } from 'date-fns';

const today = new Date();
const todayStr = format(today, 'yyyy-MM-dd');
const yesterday = format(subDays(today, 1), 'yyyy-MM-dd');

// ---- Companies ----
export const companies = [
  { CompanyId: 1, Code: 'A', Name: 'OIG - חברה ראשית', SapCompanyDb: 'SAP_OIG_TEST_290724', TaxId: '512345678', IsActive: true },
  { CompanyId: 2, Code: 'B', Name: 'Unico', SapCompanyDb: 'Test_Unico', TaxId: '512345679', IsActive: true },
];

// ---- Zones ----
export const zones = [
  { ZoneId: 1, Code: 'NORTH',     Name: 'צפון',         Description: 'חיפה, קריות, גליל',         ColorHex: '#2563eb', SortOrder: 1, IsActive: true },
  { ZoneId: 2, Code: 'SHARON',    Name: 'שרון',         Description: 'נתניה, הרצליה, רעננה',       ColorHex: '#0891b2', SortOrder: 2, IsActive: true },
  { ZoneId: 3, Code: 'CENTER',    Name: 'מרכז',         Description: 'תל אביב, רמת גן, גבעתיים',  ColorHex: '#059669', SortOrder: 3, IsActive: true },
  { ZoneId: 4, Code: 'JERUSALEM', Name: 'ירושלים',      Description: 'ירושלים והסביבה',            ColorHex: '#ca8a04', SortOrder: 4, IsActive: true },
  { ZoneId: 5, Code: 'SHFELA',    Name: 'שפלה',         Description: 'רחובות, ראשון, רמלה, לוד',  ColorHex: '#dc2626', SortOrder: 5, IsActive: true },
  { ZoneId: 6, Code: 'SOUTH-1',   Name: 'דרום - אשדוד', Description: 'אשדוד, אשקלון, קרית גת',    ColorHex: '#9333ea', SortOrder: 6, IsActive: true },
  { ZoneId: 7, Code: 'SOUTH-2',   Name: 'דרום - ב"ש',   Description: 'באר שבע והדרום',             ColorHex: '#db2777', SortOrder: 7, IsActive: true },
];

// ---- Drivers ----
export const drivers = [
  { DriverId: 1, Code: 'DRV-01', FullName: 'דוד כהן', Phone: '050-1234567', Email: 'david@oig.local', VehiclePlate: '12-345-67', VehicleCapacity: 30, IsActive: true, LastLoginAt: todayStr, Zones: 'NORTH,SHARON,CENTER,JERUSALEM' },
  { DriverId: 2, Code: 'DRV-02', FullName: 'משה לוי',  Phone: '050-7654321', Email: 'moshe@oig.local', VehiclePlate: '89-876-54', VehicleCapacity: 30, IsActive: true, LastLoginAt: todayStr, Zones: 'SHFELA,SOUTH-1,SOUTH-2' },
];

// ---- Users ----
export const users = [
  { UserId: 1, Username: 'admin',   FullName: 'איציק ישראלי',   Email: 'admin@oig.local',   Phone: '050-0000001', Role: 'ADMIN',     IsActive: true, LastLoginAt: todayStr, PreferredLanguage: 'he' },
  { UserId: 2, Username: 'planner', FullName: 'רונית המתכננת',  Email: 'ronit@oig.local',   Phone: '050-0000002', Role: 'PLANNER',   IsActive: true, LastLoginAt: todayStr, PreferredLanguage: 'he' },
  { UserId: 3, Username: 'warehouse', FullName: 'יעקב המחסנאי', Email: 'yaakov@oig.local', Phone: '050-0000003', Role: 'WAREHOUSE', IsActive: true, LastLoginAt: todayStr, PreferredLanguage: 'he' },
];

// ---- Normalized addresses ----
export const addresses = [
  { AddressId: 1, NormalizedKey: 'הרצל|45|תל אביב', Street: 'הרצל', BuildingNumber: '45', City: 'תל אביב', ZipCode: '6100000', BranchName: 'שופרסל דיל רמת החייל', Latitude: 32.1156, Longitude: 34.8008, ZoneId: 3, ContactPhone: '03-5550001', ContactName: 'משה כהן', ContactEmail: 'shufersal.rc@example.com', DeliveryWindowStart: '09:00:00', DeliveryWindowEnd: '11:00:00', DeliveryDays: 'SUN,MON,TUE,WED,THU', DeliveryNotes: 'כניסה מהחנייה האחורית', SmsOptIn: true, EmailOptIn: true },
  { AddressId: 2, NormalizedKey: 'דיזנגוף|99|תל אביב', Street: 'דיזנגוף', BuildingNumber: '99', City: 'תל אביב', ZipCode: '6329302', BranchName: 'מגה דיזנגוף סנטר', Latitude: 32.0775, Longitude: 34.7748, ZoneId: 3, ContactPhone: '03-5550002', ContactName: 'רחל אברהם', ContactEmail: null, DeliveryWindowStart: '07:00:00', DeliveryWindowEnd: '10:00:00', DeliveryDays: 'SUN,TUE,THU', DeliveryNotes: 'לצלצל בפעמון מחסן', SmsOptIn: true, EmailOptIn: false },
  { AddressId: 3, NormalizedKey: 'בן יהודה|15|ירושלים', Street: 'בן יהודה', BuildingNumber: '15', City: 'ירושלים', ZipCode: '9423315', BranchName: 'רמי לוי', Latitude: 31.7816, Longitude: 35.2179, ZoneId: 4, ContactPhone: '02-5550003', ContactName: 'יוסי מזרחי', ContactEmail: 'rami.levy@example.com', DeliveryWindowStart: '08:00:00', DeliveryWindowEnd: '13:00:00', DeliveryDays: null, DeliveryNotes: null, SmsOptIn: true, EmailOptIn: true },
  { AddressId: 4, NormalizedKey: 'סוקולוב|30|הרצליה', Street: 'סוקולוב', BuildingNumber: '30', City: 'הרצליה', ZipCode: '4651030', BranchName: 'יינות ביתן הרצליה', Latitude: 32.1624, Longitude: 34.8442, ZoneId: 2, ContactPhone: '09-5550004', ContactName: 'שירה לוי', ContactEmail: 'ybitan.herzliya@example.com', DeliveryWindowStart: null, DeliveryWindowEnd: null, DeliveryDays: null, DeliveryNotes: 'מחסן בכניסה', SmsOptIn: true, EmailOptIn: true },
  { AddressId: 5, NormalizedKey: 'המלכים|8|חיפה', Street: 'המלכים', BuildingNumber: '8', City: 'חיפה', ZipCode: '3505208', BranchName: 'ויקטורי חיפה', Latitude: 32.7940, Longitude: 34.9896, ZoneId: 1, ContactPhone: '04-5550005', ContactName: 'אלון פרץ', ContactEmail: null, DeliveryWindowStart: '07:30:00', DeliveryWindowEnd: '11:00:00', DeliveryDays: 'SUN,MON,TUE,WED,THU,FRI', DeliveryNotes: null, SmsOptIn: true, EmailOptIn: false },
  { AddressId: 6, NormalizedKey: 'רוטשילד|4|ראשון לציון', Street: 'רוטשילד', BuildingNumber: '4', City: 'ראשון לציון', ZipCode: '7521714', BranchName: 'מחסני השוק', Latitude: 31.9730, Longitude: 34.7925, ZoneId: 5, ContactPhone: '03-5550006', ContactName: 'מיכל דהן', ContactEmail: 'machsanei.shuk@example.com', DeliveryWindowStart: '09:00:00', DeliveryWindowEnd: '12:00:00', DeliveryDays: 'SUN,TUE,THU', DeliveryNotes: 'יש לעבור דרך מחסן הצד', SmsOptIn: true, EmailOptIn: true },
  { AddressId: 7, NormalizedKey: 'העצמאות|67|באר שבע', Street: 'העצמאות', BuildingNumber: '67', City: 'באר שבע', ZipCode: '8410067', BranchName: 'קו-אופ שיווק', Latitude: 31.2518, Longitude: 34.7915, ZoneId: 7, ContactPhone: '08-5550007', ContactName: 'דני יוסף', ContactEmail: null, DeliveryWindowStart: null, DeliveryWindowEnd: null, DeliveryDays: null, DeliveryNotes: null, SmsOptIn: true, EmailOptIn: false },
  { AddressId: 8, NormalizedKey: 'ויצמן|112|אשדוד', Street: 'ויצמן', BuildingNumber: '112', City: 'אשדוד', ZipCode: '7731112', BranchName: 'מגה בעיר אשדוד', Latitude: 31.8044, Longitude: 34.6553, ZoneId: 6, ContactPhone: '08-5550008', ContactName: 'גיל ברק', ContactEmail: 'mega.ashdod@example.com', DeliveryWindowStart: '10:00:00', DeliveryWindowEnd: '13:00:00', DeliveryDays: 'SUN,MON,WED,THU', DeliveryNotes: null, SmsOptIn: true, EmailOptIn: true },
];

// ---- Runs + stops + orders ----
export const runs = [
  {
    RunId: 1, RunNumber: `RUN-${todayStr}-01`, RunDate: todayStr,
    ZoneId: 3, ZoneCode: 'CENTER', ZoneName: 'מרכז', ZoneColor: '#059669',
    DriverId: 1, DriverName: 'דוד כהן', DriverPhone: '050-1234567', VehiclePlate: '12-345-67',
    Status: 'IN_TRANSIT',
    PlannedStartTime: `${todayStr} 08:00:00`,
    ActualStartTime: `${todayStr} 08:15:00`,
    ActualEndTime: null,
    Notes: 'תכנון אוטומטי - 3 עצירות',
    CreatedAt: `${todayStr} 07:00:00`,
    StopCount: 3, OrderCount: 5,
  },
  {
    RunId: 2, RunNumber: `RUN-${todayStr}-02`, RunDate: todayStr,
    ZoneId: 2, ZoneCode: 'SHARON', ZoneName: 'שרון', ZoneColor: '#0891b2',
    DriverId: 1, DriverName: 'דוד כהן', DriverPhone: '050-1234567', VehiclePlate: '12-345-67',
    Status: 'LOADED',
    PlannedStartTime: `${todayStr} 13:00:00`,
    ActualStartTime: null, ActualEndTime: null, Notes: 'לאחר ארוחת צהריים',
    CreatedAt: `${todayStr} 07:00:00`,
    StopCount: 2, OrderCount: 3,
  },
  {
    RunId: 3, RunNumber: `RUN-${todayStr}-03`, RunDate: todayStr,
    ZoneId: 5, ZoneCode: 'SHFELA', ZoneName: 'שפלה', ZoneColor: '#dc2626',
    DriverId: 2, DriverName: 'משה לוי', DriverPhone: '050-7654321', VehiclePlate: '89-876-54',
    Status: 'PLANNED',
    PlannedStartTime: `${todayStr} 08:00:00`,
    ActualStartTime: null, ActualEndTime: null, Notes: null,
    CreatedAt: `${todayStr} 07:00:00`,
    StopCount: 2, OrderCount: 2,
  },
  {
    RunId: 4, RunNumber: `RUN-${yesterday}-01`, RunDate: yesterday,
    ZoneId: 1, ZoneCode: 'NORTH', ZoneName: 'צפון', ZoneColor: '#2563eb',
    DriverId: 1, DriverName: 'דוד כהן', DriverPhone: '050-1234567', VehiclePlate: '12-345-67',
    Status: 'COMPLETED',
    PlannedStartTime: `${yesterday} 07:00:00`,
    ActualStartTime: `${yesterday} 07:05:00`,
    ActualEndTime: `${yesterday} 14:30:00`,
    Notes: null,
    CreatedAt: `${yesterday} 06:30:00`,
    StopCount: 3, OrderCount: 4,
  },
];

export const stops = [
  // Run 1 - center today
  { StopId: 1, RunId: 1, AddressId: 1, StopOrder: 1, Status: 'DELIVERED', ArrivedAt: `${todayStr} 09:05`, CompletedAt: `${todayStr} 09:25`, SignatureUrl: null, PhotoUrl: null, Notes: null, Street: 'הרצל', BuildingNumber: '45', City: 'תל אביב', BranchName: 'שופרסל דיל רמת החייל', Latitude: 32.1156, Longitude: 34.8008, DeliveryWindowStart: '09:00:00', DeliveryWindowEnd: '11:00:00', DeliveryDays: 'SUN,MON,TUE,WED,THU', ContactPhone: '03-5550001', ContactName: 'משה כהן', DeliveryNotes: 'כניסה מהחנייה האחורית' },
  { StopId: 2, RunId: 1, AddressId: 2, StopOrder: 2, Status: 'ARRIVED',  ArrivedAt: `${todayStr} 10:15`, CompletedAt: null, SignatureUrl: null, PhotoUrl: null, Notes: null, Street: 'דיזנגוף', BuildingNumber: '99', City: 'תל אביב', BranchName: 'מגה דיזנגוף סנטר', Latitude: 32.0775, Longitude: 34.7748, DeliveryWindowStart: '07:00:00', DeliveryWindowEnd: '10:00:00', DeliveryDays: 'SUN,TUE,THU', ContactPhone: '03-5550002', ContactName: 'רחל אברהם', DeliveryNotes: 'לצלצל בפעמון מחסן' },
  { StopId: 3, RunId: 1, AddressId: 3, StopOrder: 3, Status: 'PENDING',   ArrivedAt: null, CompletedAt: null, SignatureUrl: null, PhotoUrl: null, Notes: null, Street: 'בן יהודה', BuildingNumber: '15', City: 'ירושלים', BranchName: 'רמי לוי', Latitude: 31.7816, Longitude: 35.2179, DeliveryWindowStart: '08:00:00', DeliveryWindowEnd: '13:00:00', DeliveryDays: null, ContactPhone: '02-5550003', ContactName: 'יוסי מזרחי', DeliveryNotes: null },

  // Run 2 - sharon today
  { StopId: 4, RunId: 2, AddressId: 4, StopOrder: 1, Status: 'PENDING', ArrivedAt: null, CompletedAt: null, SignatureUrl: null, PhotoUrl: null, Notes: null, Street: 'סוקולוב', BuildingNumber: '30', City: 'הרצליה', BranchName: 'יינות ביתן הרצליה', Latitude: 32.1624, Longitude: 34.8442, DeliveryWindowStart: null, DeliveryWindowEnd: null, DeliveryDays: null, ContactPhone: '09-5550004', ContactName: 'שירה לוי', DeliveryNotes: 'מחסן בכניסה' },

  // Run 3 - shfela today
  { StopId: 5, RunId: 3, AddressId: 6, StopOrder: 1, Status: 'PENDING', ArrivedAt: null, CompletedAt: null, SignatureUrl: null, PhotoUrl: null, Notes: null, Street: 'רוטשילד', BuildingNumber: '4', City: 'ראשון לציון', BranchName: 'מחסני השוק', Latitude: 31.9730, Longitude: 34.7925, DeliveryWindowStart: '09:00:00', DeliveryWindowEnd: '12:00:00', DeliveryDays: 'SUN,TUE,THU', ContactPhone: '03-5550006', ContactName: 'מיכל דהן', DeliveryNotes: 'יש לעבור דרך מחסן הצד' },
  { StopId: 6, RunId: 3, AddressId: 8, StopOrder: 2, Status: 'PENDING', ArrivedAt: null, CompletedAt: null, SignatureUrl: null, PhotoUrl: null, Notes: null, Street: 'ויצמן', BuildingNumber: '112', City: 'אשדוד', BranchName: 'מגה בעיר אשדוד', Latitude: 31.8044, Longitude: 34.6553, DeliveryWindowStart: '10:00:00', DeliveryWindowEnd: '13:00:00', DeliveryDays: 'SUN,MON,WED,THU', ContactPhone: '08-5550008', ContactName: 'גיל ברק', DeliveryNotes: null },

  // Run 4 - yesterday completed
  { StopId: 7, RunId: 4, AddressId: 5, StopOrder: 1, Status: 'DELIVERED', ArrivedAt: `${yesterday} 09:00`, CompletedAt: `${yesterday} 09:20`, SignatureUrl: null, PhotoUrl: null, Notes: null, Street: 'המלכים', BuildingNumber: '8', City: 'חיפה', BranchName: 'ויקטורי חיפה', Latitude: 32.7940, Longitude: 34.9896, DeliveryWindowStart: '07:30:00', DeliveryWindowEnd: '11:00:00', DeliveryDays: 'SUN,MON,TUE,WED,THU,FRI', ContactPhone: '04-5550005', ContactName: 'אלון פרץ', DeliveryNotes: null },
  { StopId: 8, RunId: 4, AddressId: 1, StopOrder: 2, Status: 'FAILED',    ArrivedAt: `${yesterday} 11:00`, CompletedAt: `${yesterday} 11:15`, SignatureUrl: null, PhotoUrl: null, Notes: 'חנות הייתה סגורה', Street: 'הרצל', BuildingNumber: '45', City: 'תל אביב', BranchName: 'שופרסל דיל רמת החייל', Latitude: 32.1156, Longitude: 34.8008, DeliveryWindowStart: '09:00:00', DeliveryWindowEnd: '11:00:00', DeliveryDays: 'SUN,MON,TUE,WED,THU', ContactPhone: '03-5550001', ContactName: 'משה כהן', DeliveryNotes: 'כניסה מהחנייה האחורית' },
];

export const runOrders = [
  { RunOrderId: 1, StopId: 1, CompanyId: 1, CompanyCode: 'A', CompanyName: 'OIG - חברה ראשית', SapDocEntry: 1001, SapDocNum: 2001, SapCardCode: 'C001', SapCardName: 'שופרסל דיל רמת החייל', OrderTotal: 12500, LinesCount: 8, Status: 'DELIVERED', SapDeliveryDocEntry: 8001 },
  { RunOrderId: 2, StopId: 1, CompanyId: 2, CompanyCode: 'B', CompanyName: 'Unico',               SapDocEntry: 3001, SapDocNum: 4001, SapCardCode: 'C001B', SapCardName: 'שופרסל דיל רמת החייל', OrderTotal: 4200, LinesCount: 3, Status: 'DELIVERED', SapDeliveryDocEntry: 8002 },
  { RunOrderId: 3, StopId: 2, CompanyId: 1, CompanyCode: 'A', CompanyName: 'OIG - חברה ראשית', SapDocEntry: 1002, SapDocNum: 2002, SapCardCode: 'C002', SapCardName: 'מגה דיזנגוף סנטר',       OrderTotal: 8900,  LinesCount: 5, Status: 'PENDING', SapDeliveryDocEntry: null },
  { RunOrderId: 4, StopId: 3, CompanyId: 1, CompanyCode: 'A', CompanyName: 'OIG - חברה ראשית', SapDocEntry: 1003, SapDocNum: 2003, SapCardCode: 'C003', SapCardName: 'רמי לוי',                 OrderTotal: 15400, LinesCount: 11, Status: 'PENDING', SapDeliveryDocEntry: null },
  { RunOrderId: 5, StopId: 3, CompanyId: 2, CompanyCode: 'B', CompanyName: 'Unico',               SapDocEntry: 3002, SapDocNum: 4002, SapCardCode: 'C003B', SapCardName: 'רמי לוי',             OrderTotal: 2100, LinesCount: 2, Status: 'PENDING', SapDeliveryDocEntry: null },
  { RunOrderId: 6, StopId: 4, CompanyId: 1, CompanyCode: 'A', CompanyName: 'OIG - חברה ראשית', SapDocEntry: 1004, SapDocNum: 2004, SapCardCode: 'C004', SapCardName: 'יינות ביתן הרצליה',      OrderTotal: 6700, LinesCount: 4, Status: 'PENDING', SapDeliveryDocEntry: null },
  { RunOrderId: 7, StopId: 4, CompanyId: 2, CompanyCode: 'B', CompanyName: 'Unico',               SapDocEntry: 3003, SapDocNum: 4003, SapCardCode: 'C004B', SapCardName: 'יינות ביתן הרצליה',  OrderTotal: 3300, LinesCount: 3, Status: 'PENDING', SapDeliveryDocEntry: null },
  { RunOrderId: 8, StopId: 4, CompanyId: 1, CompanyCode: 'A', CompanyName: 'OIG - חברה ראשית', SapDocEntry: 1005, SapDocNum: 2005, SapCardCode: 'C004', SapCardName: 'יינות ביתן הרצליה',      OrderTotal: 1800, LinesCount: 2, Status: 'PENDING', SapDeliveryDocEntry: null },
  { RunOrderId: 9, StopId: 5, CompanyId: 1, CompanyCode: 'A', CompanyName: 'OIG - חברה ראשית', SapDocEntry: 1006, SapDocNum: 2006, SapCardCode: 'C006', SapCardName: 'מחסני השוק',             OrderTotal: 9200, LinesCount: 6, Status: 'PENDING', SapDeliveryDocEntry: null },
  { RunOrderId: 10, StopId: 6, CompanyId: 1, CompanyCode: 'A', CompanyName: 'OIG - חברה ראשית', SapDocEntry: 1007, SapDocNum: 2007, SapCardCode: 'C008', SapCardName: 'מגה בעיר אשדוד',       OrderTotal: 11500, LinesCount: 7, Status: 'PENDING', SapDeliveryDocEntry: null },
];

// ---- Failure ----
export const failures = [
  {
    FailureId: 1, StopId: 8, RunId: 4, RunNumber: runs[3].RunNumber, RunDate: yesterday,
    ReasonCode: 'STORE_CLOSED', ReasonName: 'החנות סגורה', Category: 'STORE', Severity: 'HIGH',
    SuggestedAction: 'RESCHEDULE',
    Notes: 'הגענו ב-11:00, החנות הייתה כבר סגורה. חלון הקבלה הרשמי הוא 09:00-11:00 אבל הם סגרו מוקדם בגלל חג.',
    PhotoUrl: null,
    ResolutionStatus: 'OPEN',
    ResolvedAt: null, RescheduledToRunId: null,
    CreatedAt: `${yesterday} 11:15:00`,
    CustomerName: 'שופרסל דיל רמת החייל', CardCode: 'C001', CompanyCode: 'A',
    DriverName: 'דוד כהן',
    ZoneName: 'צפון', ZoneColor: '#2563eb',
    Street: 'הרצל', BuildingNumber: '45', City: 'תל אביב', BranchName: 'שופרסל דיל רמת החייל',
    AddressId: 1, OrdersCount: 2,
  },
];

// ---- Returns ----
export const returnRequests = [
  {
    ReturnId: 1, ReturnNumber: `RET-${todayStr}-001`,
    CompanyId: 1, CompanyCode: 'A', CompanyName: 'OIG - חברה ראשית',
    SapCardCode: 'C003', SapCardName: 'רמי לוי',
    AddressId: 3, Street: 'בן יהודה', BuildingNumber: '15', City: 'ירושלים', BranchName: 'רמי לוי',
    RequestedDate: todayStr, Status: 'OPEN',
    Reason: 'פריט פגום שהגיע במשלוח הקודם',
    StopId: null, LinesCount: 2,
    CreatedAt: `${todayStr} 08:30:00`,
  },
];

// ---- Unified orders preview (for Planner page) ----
export const unifiedGroups = [
  {
    addressId: 1,
    address: addresses[0],
    zoneId: 3,
    orderCount: 2,
    hasCompanyA: true,
    hasCompanyB: true,
    totalLines: 11,
    orders: [
      { companyCode: 'A', docEntry: 1001, docNum: 2001, cardCode: 'C001', cardName: 'שופרסל דיל רמת החייל', total: 12500, linesCount: 8 },
      { companyCode: 'B', docEntry: 3001, docNum: 4001, cardCode: 'C001B', cardName: 'שופרסל דיל רמת החייל', total: 4200, linesCount: 3 },
    ],
  },
  {
    addressId: 3,
    address: addresses[2],
    zoneId: 4,
    orderCount: 2,
    hasCompanyA: true,
    hasCompanyB: true,
    totalLines: 13,
    orders: [
      { companyCode: 'A', docEntry: 1003, docNum: 2003, cardCode: 'C003', cardName: 'רמי לוי', total: 15400, linesCount: 11 },
      { companyCode: 'B', docEntry: 3002, docNum: 4002, cardCode: 'C003B', cardName: 'רמי לוי', total: 2100, linesCount: 2 },
    ],
  },
  {
    addressId: 4,
    address: addresses[3],
    zoneId: 2,
    orderCount: 3,
    hasCompanyA: true,
    hasCompanyB: true,
    totalLines: 9,
    orders: [
      { companyCode: 'A', docEntry: 1004, docNum: 2004, cardCode: 'C004', cardName: 'יינות ביתן הרצליה', total: 6700, linesCount: 4 },
      { companyCode: 'A', docEntry: 1005, docNum: 2005, cardCode: 'C004', cardName: 'יינות ביתן הרצליה', total: 1800, linesCount: 2 },
      { companyCode: 'B', docEntry: 3003, docNum: 4003, cardCode: 'C004B', cardName: 'יינות ביתן הרצליה', total: 3300, linesCount: 3 },
    ],
  },
];

// ---- Stats ----
export const stats = {
  totalOrders: 10,
  totalStops: 8,
  stopsSaved: 2,
  mergeRatio: 0.25,
  mergedStops: 3,
};

// ---- Analytics ----
export const analyticsSummary = {
  overall: {
    totalRuns: 4, completedRuns: 1,
    totalStops: 8, deliveredStops: 3, partialStops: 0, failedStops: 1,
    totalOrders: 10, deliveredOrders: 2,
    ordersCompanyA: 7, ordersCompanyB: 3,
    avgStopMinutes: 22, avgRunMinutes: 445,
    successRate: 0.75, failureRate: 0.125,
    unifiedStops: 8, mergedStops: 3, mergerRatio: 0.375,
  },
  daily: (() => {
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const d = subDays(today, i);
      arr.push({
        RunDate: format(d, 'yyyy-MM-dd'),
        Runs: 2 + Math.floor(Math.random() * 3),
        Stops: 5 + Math.floor(Math.random() * 10),
        Delivered: 4 + Math.floor(Math.random() * 8),
        Failed: Math.floor(Math.random() * 2),
        Orders: 8 + Math.floor(Math.random() * 12),
      });
    }
    return arr;
  })(),
  drivers: [
    { DriverId: 1, Code: 'DRV-01', FullName: 'דוד כהן', Runs: 12, TotalStops: 43, DeliveredStops: 39, FailedStops: 2, AvgStopMinutes: 18, AvgRunMinutes: 420 },
    { DriverId: 2, Code: 'DRV-02', FullName: 'משה לוי', Runs: 10, TotalStops: 35, DeliveredStops: 33, FailedStops: 1, AvgStopMinutes: 25, AvgRunMinutes: 480 },
  ],
  zones: zones.map((z) => ({
    ...z,
    Runs: Math.floor(Math.random() * 10) + 2,
    TotalStops: Math.floor(Math.random() * 30) + 5,
    DeliveredStops: Math.floor(Math.random() * 25) + 4,
    FailedStops: Math.floor(Math.random() * 3),
    TotalOrders: Math.floor(Math.random() * 40) + 10,
  })),
  failures: [
    { ReasonCode: 'STORE_CLOSED', Name: 'החנות סגורה', Category: 'STORE', Severity: 'HIGH', Count: 5, Rescheduled: 3, Resolved: 1, Cancelled: 0, StillOpen: 1 },
    { ReasonCode: 'CUSTOMER_NOT_AVAILABLE', Name: 'הלקוח לא זמין / לא נמצא', Category: 'CUSTOMER', Severity: 'MEDIUM', Count: 3, Rescheduled: 2, Resolved: 1, Cancelled: 0, StillOpen: 0 },
    { ReasonCode: 'ADDRESS_NOT_FOUND', Name: 'כתובת שגויה / לא נמצאה', Category: 'ADDRESS', Severity: 'HIGH', Count: 1, Rescheduled: 0, Resolved: 0, Cancelled: 1, StillOpen: 0 },
  ],
  syncHealth: {
    PendingDeliveryNotes: 2,
    SyncedDeliveryNotes: 45,
    PendingReturnRequests: 0,
    QueueBacklog: 0,
    PermanentFailures: 0,
  },
};

// ---- Failure reasons catalog (for dialogs) ----
export const failureReasons = [
  { ReasonCode: 'STORE_CLOSED',           Name: 'החנות סגורה',                   Category: 'STORE',    Severity: 'HIGH',   RequiresPhoto: 0, RequiresNotes: 1, SuggestedAction: 'RESCHEDULE',       SortOrder: 10 },
  { ReasonCode: 'STORE_REFUSED',          Name: 'החנות סירבה לקבל סחורה',       Category: 'STORE',    Severity: 'HIGH',   RequiresPhoto: 1, RequiresNotes: 1, SuggestedAction: 'CONTACT_CUSTOMER', SortOrder: 20 },
  { ReasonCode: 'STORE_FULL_NO_STORAGE',  Name: 'אין מקום אחסון בחנות',         Category: 'STORE',    Severity: 'MEDIUM', RequiresPhoto: 0, RequiresNotes: 1, SuggestedAction: 'RESCHEDULE',       SortOrder: 30 },
  { ReasonCode: 'STORE_WRONG_HOURS',      Name: 'מחוץ לחלון קבלת סחורה',        Category: 'STORE',    Severity: 'MEDIUM', RequiresPhoto: 0, RequiresNotes: 0, SuggestedAction: 'RESCHEDULE',       SortOrder: 40 },
  { ReasonCode: 'CUSTOMER_NOT_AVAILABLE', Name: 'הלקוח לא זמין / לא נמצא',      Category: 'CUSTOMER', Severity: 'MEDIUM', RequiresPhoto: 0, RequiresNotes: 0, SuggestedAction: 'CONTACT_CUSTOMER', SortOrder: 50 },
  { ReasonCode: 'CUSTOMER_REFUSED',       Name: 'הלקוח סירב לקבל',               Category: 'CUSTOMER', Severity: 'HIGH',   RequiresPhoto: 1, RequiresNotes: 1, SuggestedAction: 'CONTACT_CUSTOMER', SortOrder: 60 },
  { ReasonCode: 'CUSTOMER_NOT_READY',     Name: 'הלקוח לא מוכן לקבל',            Category: 'CUSTOMER', Severity: 'MEDIUM', RequiresPhoto: 0, RequiresNotes: 1, SuggestedAction: 'CONTACT_CUSTOMER', SortOrder: 70 },
  { ReasonCode: 'ADDRESS_NOT_FOUND',      Name: 'כתובת שגויה / לא נמצאה',        Category: 'ADDRESS',  Severity: 'HIGH',   RequiresPhoto: 0, RequiresNotes: 1, SuggestedAction: 'MANUAL_REVIEW',    SortOrder: 80 },
  { ReasonCode: 'ADDRESS_ACCESS_BLOCKED', Name: 'אין גישה לכתובת',              Category: 'ADDRESS',  Severity: 'MEDIUM', RequiresPhoto: 1, RequiresNotes: 1, SuggestedAction: 'RESCHEDULE',       SortOrder: 90 },
  { ReasonCode: 'GOODS_DAMAGED',          Name: 'סחורה פגומה',                   Category: 'GOODS',    Severity: 'HIGH',   RequiresPhoto: 1, RequiresNotes: 1, SuggestedAction: 'MANUAL_REVIEW',    SortOrder: 100 },
  { ReasonCode: 'WRONG_ITEMS_PICKED',     Name: 'פריטים שגויים נלקטו',          Category: 'GOODS',    Severity: 'HIGH',   RequiresPhoto: 0, RequiresNotes: 1, SuggestedAction: 'MANUAL_REVIEW',    SortOrder: 110 },
  { ReasonCode: 'TRUCK_FAILURE',          Name: 'תקלת רכב',                      Category: 'OTHER',    Severity: 'HIGH',   RequiresPhoto: 0, RequiresNotes: 1, SuggestedAction: 'RESCHEDULE',       SortOrder: 120 },
  { ReasonCode: 'WEATHER',                Name: 'מזג אוויר / כביש חסום',        Category: 'OTHER',    Severity: 'MEDIUM', RequiresPhoto: 0, RequiresNotes: 1, SuggestedAction: 'RESCHEDULE',       SortOrder: 130 },
  { ReasonCode: 'OTHER',                  Name: 'אחר',                            Category: 'OTHER',    Severity: 'LOW',    RequiresPhoto: 0, RequiresNotes: 1, SuggestedAction: 'MANUAL_REVIEW',    SortOrder: 999 },
];

// ---- GPS locations ----
export const driverLocations = [
  {
    DriverId: 1, RunId: 1, DriverName: 'דוד כהן', VehiclePlate: '12-345-67',
    RunNumber: runs[0].RunNumber, RunStatus: 'IN_TRANSIT',
    ZoneName: 'מרכז', ZoneColor: '#059669',
    Latitude: 32.0775, Longitude: 34.7748,
    Accuracy: 15, Heading: 180, SpeedKmh: 42, BatteryLevel: 78,
    UpdatedAt: new Date().toISOString(),
  },
  {
    DriverId: 2, RunId: null, DriverName: 'משה לוי', VehiclePlate: '89-876-54',
    RunNumber: null, RunStatus: null,
    ZoneName: null, ZoneColor: null,
    Latitude: 32.0850, Longitude: 34.7818,
    Accuracy: 10, Heading: 0, SpeedKmh: 0, BatteryLevel: 95,
    UpdatedAt: new Date().toISOString(),
  },
];

// ---- Wave for run 2 (in LOADED state - implies wave exists) ----
export const wave = {
  WaveId: 1, WaveNumber: `WAVE-${runs[1].RunNumber}`,
  RunId: 2, RunNumber: runs[1].RunNumber, RunDate: todayStr,
  Status: 'COMPLETED',
  StartedAt: `${todayStr} 07:30:00`,
  CompletedAt: `${todayStr} 08:20:00`,
  lines: [
    { WaveLineId: 1, WaveId: 1, SapItemCode: 'DAVO-V10', SapItemName: 'שואב אבק DAVO V10 Pro', TotalQuantity: 5, PickedQuantity: 5, BinLocation: 'A-01-03', Status: 'COMPLETED', AllocationCount: 2 },
    { WaveLineId: 2, WaveId: 1, SapItemCode: 'TINECO-S5', SapItemName: 'שואב Tineco S5 Steam', TotalQuantity: 3, PickedQuantity: 3, BinLocation: 'A-02-01', Status: 'COMPLETED', AllocationCount: 1 },
    { WaveLineId: 3, WaveId: 1, SapItemCode: 'NOVO-MOP1', SapItemName: 'מטאטא רובוטי NOVO', TotalQuantity: 2, PickedQuantity: 2, BinLocation: 'B-01-05', Status: 'COMPLETED', AllocationCount: 1 },
  ],
};

// ---- Notifications sent (for demo) ----
export const notifications = [
  { LogId: 1, EventType: 'RUN_STARTED', Channel: 'SMS', Recipient: '03-5550001', Status: 'SENT', SentAt: `${todayStr} 08:16:00`, Subject: null, Body: 'שלום משה, המשלוח שלכם יצא לדרך...' },
  { LogId: 2, EventType: 'PROOF_OF_DELIVERY', Channel: 'EMAIL', Recipient: 'shufersal.rc@example.com', Status: 'SENT', SentAt: `${todayStr} 09:26:00`, Subject: 'אישור מסירה - RUN-...', Body: null },
  { LogId: 3, EventType: 'STOP_FAILED_HIGH', Channel: 'EMAIL', Recipient: 'admin@oig.local', Status: 'SENT', SentAt: `${yesterday} 11:16:00`, Subject: '🚨 כשל קריטי במסירה...', Body: null },
];
