/**
 * Persistent Store - saves all editable data to a JSON file.
 * Drivers, users, zones all live here and survive restarts.
 *
 * File: backend/data/store.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.resolve(__dirname, '../../data/store.json');

let cache = null;

function getDefault() {
  const adminHash = bcrypt.hashSync('admin123', 10);
  return {
    drivers: [
      { DriverId: 1, Code: 'DRV-01', FullName: 'דוד כהן', Phone: '050-1234567', Email: 'david@oig.local', VehiclePlate: '12-345-67', VehicleCapacity: 30, IsActive: true, Zones: 'NORTH,SHARON,CENTER,JERUSALEM' },
      { DriverId: 2, Code: 'DRV-02', FullName: 'משה לוי', Phone: '050-7654321', Email: 'moshe@oig.local', VehiclePlate: '89-876-54', VehicleCapacity: 30, IsActive: true, Zones: 'SHFELA,SOUTH-1,SOUTH-2' },
    ],
    nextDriverId: 3,
    users: [
      { UserId: 1, Username: 'admin', FullName: 'איציק - מנהל מערכת', Email: 'admin@oig.local', Phone: '050-0000001', Role: 'ADMIN', IsActive: true, PreferredLanguage: 'he', PasswordHash: adminHash, LastLoginAt: null, CreatedAt: new Date().toISOString() },
    ],
    nextUserId: 2,
    zones: [
      { ZoneId: 1, Code: 'NORTH',     Name: 'צפון',         Description: 'חיפה, קריות, גליל',         ColorHex: '#2563eb', SortOrder: 1, IsActive: true },
      { ZoneId: 2, Code: 'SHARON',    Name: 'שרון',         Description: 'נתניה, הרצליה, רעננה',       ColorHex: '#0891b2', SortOrder: 2, IsActive: true },
      { ZoneId: 3, Code: 'CENTER',    Name: 'מרכז',         Description: 'תל אביב, רמת גן, גבעתיים',  ColorHex: '#059669', SortOrder: 3, IsActive: true },
      { ZoneId: 4, Code: 'JERUSALEM', Name: 'ירושלים',      Description: 'ירושלים והסביבה',            ColorHex: '#ca8a04', SortOrder: 4, IsActive: true },
      { ZoneId: 5, Code: 'SHFELA',    Name: 'שפלה',         Description: 'רחובות, ראשון, רמלה, לוד',  ColorHex: '#dc2626', SortOrder: 5, IsActive: true },
      { ZoneId: 6, Code: 'SOUTH-1',   Name: 'דרום - אשדוד', Description: 'אשדוד, אשקלון, קרית גת',    ColorHex: '#9333ea', SortOrder: 6, IsActive: true },
      { ZoneId: 7, Code: 'SOUTH-2',   Name: 'דרום - ב"ש',   Description: 'באר שבע והדרום',             ColorHex: '#db2777', SortOrder: 7, IsActive: true },
    ],
    nextZoneId: 8,
  };
}

export function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      cache = JSON.parse(raw);
      // Migrate older stores that lack users/zones
      const def = getDefault();
      if (!cache.users) { cache.users = def.users; cache.nextUserId = def.nextUserId; }
      if (!cache.zones) { cache.zones = def.zones; cache.nextZoneId = def.nextZoneId; }
      console.log(`[store] Loaded ${cache.drivers?.length || 0} drivers, ${cache.users?.length || 0} users, ${cache.zones?.length || 0} zones`);
    } else {
      cache = getDefault();
      save();
      console.log(`[store] Created default store at ${STORE_PATH}`);
    }
  } catch (err) {
    console.error('[store] Load failed:', err.message);
    cache = getDefault();
  }
  return cache;
}

export function save() {
  if (!cache) return;
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] Save failed:', err.message);
  }
}

// ============================================================================
// Drivers
// ============================================================================
export function getDrivers() {
  return load().drivers;
}

export function addDriver(data) {
  const store = load();
  // Default capacities per vehicle type. TRUCK = full delivery truck (e.g. Sprinter),
  // COMMERCIAL = light commercial / van. Capacity is in litres + kilos.
  const vehicleType = data.vehicleType || 'TRUCK';
  const defaults = vehicleType === 'COMMERCIAL'
    ? { capacityL: 4000, capacityKg: 800 }
    : { capacityL: 12000, capacityKg: 3500 };
  const newDriver = {
    DriverId: store.nextDriverId++,
    Code: data.code || `DRV-${String(store.nextDriverId).padStart(2, '0')}`,
    FullName: data.fullName || '',
    Phone: data.phone || '',
    Email: data.email || '',
    VehiclePlate: data.vehiclePlate || '',
    VehicleType: vehicleType,                                  // TRUCK | COMMERCIAL
    VehicleCapacityL: Number(data.vehicleCapacityL ?? defaults.capacityL),
    VehicleCapacityKg: Number(data.vehicleCapacityKg ?? defaults.capacityKg),
    // Loading workflow:
    //   COMMERCIAL → 'BY_ITEM' (aggregate items, each customer takes their share)
    //   TRUCK      → 'BY_CUSTOMER' (each customer's items boxed together, LIFO)
    LoadingMode: data.loadingMode || (vehicleType === 'COMMERCIAL' ? 'BY_ITEM' : 'BY_CUSTOMER'),
    VehicleCapacity: data.vehicleCapacity || 30,                // legacy field kept for compat
    IsActive: data.isActive !== false,
    Zones: data.zones || '',
  };
  store.drivers.push(newDriver);
  save();
  return newDriver;
}

export function updateDriver(id, updates) {
  const store = load();
  const driver = store.drivers.find((d) => d.DriverId === Number(id));
  if (!driver) return null;
  const map = { code: 'Code', fullName: 'FullName', phone: 'Phone', email: 'Email',
    vehiclePlate: 'VehiclePlate', vehicleCapacity: 'VehicleCapacity',
    vehicleType: 'VehicleType', vehicleCapacityL: 'VehicleCapacityL',
    vehicleCapacityKg: 'VehicleCapacityKg', loadingMode: 'LoadingMode',
    isActive: 'IsActive', zones: 'Zones' };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) driver[to] = updates[from];
  }
  save();
  return driver;
}

export function deleteDriver(id) {
  const store = load();
  const idx = store.drivers.findIndex((d) => d.DriverId === Number(id));
  if (idx < 0) return false;
  store.drivers.splice(idx, 1);
  save();
  return true;
}

// ============================================================================
// Pickers (warehouse handheld terminal users)
// ============================================================================
export function getPickers() {
  const s = load();
  if (!s.pickers) {
    s.pickers = [];
    s.nextPickerId = 1;
    save();
  }
  return s.pickers;
}

export function addPicker(data) {
  const store = load();
  if (!store.pickers) { store.pickers = []; store.nextPickerId = 1; }
  const newPicker = {
    PickerId: store.nextPickerId++,
    Code: data.code || `PICK-${String(store.nextPickerId).padStart(2, '0')}`,
    FullName: data.fullName || '',
    Phone: data.phone || '',
    IsActive: data.isActive !== false,
    CreatedAt: new Date().toISOString(),
  };
  store.pickers.push(newPicker);
  save();
  return newPicker;
}

export function updatePicker(id, updates) {
  const store = load();
  const picker = store.pickers?.find((p) => p.PickerId === Number(id));
  if (!picker) return null;
  const map = { code: 'Code', fullName: 'FullName', phone: 'Phone', isActive: 'IsActive' };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) picker[to] = updates[from];
  }
  save();
  return picker;
}

export function deletePicker(id) {
  const store = load();
  if (!store.pickers) return false;
  const idx = store.pickers.findIndex((p) => p.PickerId === Number(id));
  if (idx < 0) return false;
  store.pickers.splice(idx, 1);
  save();
  return true;
}

export function getPickerByCode(code) {
  const list = getPickers();
  return list.find((p) => p.Code === code);
}

// ============================================================================
// Users
// ============================================================================
export function getUsers() {
  return load().users.map((u) => {
    const { PasswordHash, ...safe } = u;
    return safe;
  });
}

export function getUserByUsername(username) {
  return load().users.find((u) => u.Username === username);
}

export function getUserById(id) {
  return load().users.find((u) => u.UserId === Number(id));
}

export async function verifyUserPassword(username, password) {
  const user = getUserByUsername(username);
  if (!user || !user.IsActive || !user.PasswordHash) return null;
  const ok = await bcrypt.compare(password, user.PasswordHash);
  return ok ? user : null;
}

export async function addUser(data) {
  const store = load();
  if (store.users.some((u) => u.Username === data.username)) {
    throw new Error(`שם המשתמש '${data.username}' כבר קיים`);
  }
  const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : null;
  const newUser = {
    UserId: store.nextUserId++,
    Username: data.username,
    FullName: data.fullName || '',
    Email: data.email || '',
    Phone: data.phone || '',
    Role: data.role || 'VIEWER',
    IsActive: data.isActive !== false,
    PreferredLanguage: data.preferredLanguage || 'he',
    PasswordHash: passwordHash,
    LastLoginAt: null,
    CreatedAt: new Date().toISOString(),
  };
  store.users.push(newUser);
  save();
  const { PasswordHash, ...safe } = newUser;
  return safe;
}

export async function updateUser(id, updates) {
  const store = load();
  const user = store.users.find((u) => u.UserId === Number(id));
  if (!user) return null;

  if (updates.username && updates.username !== user.Username) {
    if (store.users.some((u) => u.Username === updates.username && u.UserId !== user.UserId)) {
      throw new Error(`שם המשתמש '${updates.username}' כבר תפוס`);
    }
    user.Username = updates.username;
  }

  const map = { fullName: 'FullName', email: 'Email', phone: 'Phone',
    role: 'Role', isActive: 'IsActive', preferredLanguage: 'PreferredLanguage' };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) user[to] = updates[from];
  }
  save();
  const { PasswordHash, ...safe } = user;
  return safe;
}

export async function setUserPassword(id, newPassword) {
  const store = load();
  const user = store.users.find((u) => u.UserId === Number(id));
  if (!user) return false;
  user.PasswordHash = await bcrypt.hash(newPassword, 10);
  save();
  return true;
}

export function deleteUser(id, requesterId) {
  const store = load();
  if (Number(id) === Number(requesterId)) {
    throw new Error('לא ניתן למחוק את עצמך');
  }
  const idx = store.users.findIndex((u) => u.UserId === Number(id));
  if (idx < 0) return false;
  const user = store.users[idx];
  if (user.Role === 'ADMIN') {
    const otherActiveAdmins = store.users.filter((u) =>
      u.Role === 'ADMIN' && u.UserId !== user.UserId && u.IsActive
    ).length;
    if (otherActiveAdmins === 0) throw new Error('לא ניתן למחוק את המנהל האחרון');
  }
  store.users.splice(idx, 1);
  save();
  return true;
}

export function updateLastLogin(userId) {
  const store = load();
  const user = store.users.find((u) => u.UserId === Number(userId));
  if (user) {
    user.LastLoginAt = new Date().toISOString();
    save();
  }
}

// ============================================================================
// Zones
// ============================================================================
export function getZones() {
  return [...load().zones].sort((a, b) => a.SortOrder - b.SortOrder);
}

export function addZone(data) {
  const store = load();
  if (store.zones.some((z) => z.Code === data.code)) {
    throw new Error(`קוד אזור '${data.code}' כבר קיים`);
  }
  const newZone = {
    ZoneId: store.nextZoneId++,
    Code: data.code,
    Name: data.name || '',
    Description: data.description || '',
    ColorHex: data.colorHex || '#6b7280',
    SortOrder: data.sortOrder || store.zones.length + 1,
    IsActive: data.isActive !== false,
  };
  store.zones.push(newZone);
  save();
  return newZone;
}

export function updateZone(id, updates) {
  const store = load();
  const zone = store.zones.find((z) => z.ZoneId === Number(id));
  if (!zone) return null;
  const map = { code: 'Code', name: 'Name', description: 'Description',
    colorHex: 'ColorHex', sortOrder: 'SortOrder', isActive: 'IsActive' };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) zone[to] = updates[from];
  }
  save();
  return zone;
}

export function deleteZone(id) {
  const store = load();
  const idx = store.zones.findIndex((z) => z.ZoneId === Number(id));
  if (idx < 0) return false;
  store.zones.splice(idx, 1);
  save();
  return true;
}

// ============================================================================
// Runs + Stops + Orders - manual route editing
// ============================================================================

function ensureRunsStore() {
  const s = load();
  if (!s.runs) { s.runs = []; s.nextRunId = 1; }
  if (!s.stops) { s.stops = []; s.nextStopId = 1; }
  if (!s.runOrders) { s.runOrders = []; s.nextRunOrderId = 1; }
  return s;
}

export function getRuns() {
  return ensureRunsStore().runs;
}

export function addRun(data) {
  const s = ensureRunsStore();
  const today = new Date().toISOString().slice(0, 10);
  const runDate = data.runDate || today;
  const zone = s.zones.find((z) => z.ZoneId === Number(data.zoneId));
  const driver = s.drivers.find((d) => d.DriverId === Number(data.driverId));
  const seq = s.runs.filter((r) => r.RunDate === runDate).length + 1;

  const newRun = {
    RunId: s.nextRunId++,
    RunNumber: `RUN-${runDate}-${String(seq).padStart(2, '0')}`,
    RunDate: runDate,
    ZoneId: data.zoneId,
    ZoneCode: zone?.Code || '',
    ZoneName: zone?.Name || '',
    ZoneColor: zone?.ColorHex || '#6b7280',
    DriverId: data.driverId,
    DriverName: driver?.FullName || '',
    DriverPhone: driver?.Phone || '',
    VehiclePlate: driver?.VehiclePlate || '',
    Status: data.status || 'OPEN',
    PlannedStartTime: data.plannedStartTime || null,
    ActualStartTime: null,
    ActualEndTime: null,
    Notes: data.notes || '',
    CreatedAt: new Date().toISOString(),
    StopCount: 0,
    OrderCount: 0,
  };
  s.runs.push(newRun);
  save();
  return newRun;
}

export function updateRun(id, updates) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(id));
  if (!run) return null;
  if (updates.status !== undefined) run.Status = updates.status;
  if (updates.driverId !== undefined) {
    run.DriverId = updates.driverId;
    const driver = s.drivers.find((d) => d.DriverId === Number(updates.driverId));
    if (driver) {
      run.DriverName = driver.FullName;
      run.DriverPhone = driver.Phone;
      run.VehiclePlate = driver.VehiclePlate;
    }
  }
  if (updates.notes !== undefined) run.Notes = updates.notes;
  save();
  return run;
}

export function deleteRun(id) {
  const s = ensureRunsStore();
  const runId = Number(id);
  s.runs = s.runs.filter((r) => r.RunId !== runId);
  const stopIds = s.stops.filter((st) => st.RunId === runId).map((st) => st.StopId);
  s.stops = s.stops.filter((st) => st.RunId !== runId);
  s.runOrders = s.runOrders.filter((o) => !stopIds.includes(o.StopId));
  save();
  return true;
}

/** Get run with its stops + orders nested. */
export function getRunDetails(runId) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return null;
  const stops = s.stops
    .filter((st) => st.RunId === run.RunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0))
    .map((stop) => ({
      ...stop,
      orders: s.runOrders.filter((o) => o.StopId === stop.StopId),
      returns: [],
    }));
  return { ...run, stops };
}

// Mapping of common Israeli cities to zone codes (used for auto-assign)
const CITY_TO_ZONE = {
  // NORTH (חיפה, קריות, גליל)
  'חיפה': 'NORTH', 'נשר': 'NORTH', 'טירת הכרמל': 'NORTH', 'טירת כרמל': 'NORTH',
  'קריית אתא': 'NORTH', 'קרית אתא': 'NORTH', 'קריית ביאליק': 'NORTH', 'קרית ביאליק': 'NORTH',
  'קריית מוצקין': 'NORTH', 'קרית מוצקין': 'NORTH', 'קריית ים': 'NORTH', 'קרית ים': 'NORTH',
  'נהריה': 'NORTH', 'עכו': 'NORTH', 'כרמיאל': 'NORTH', 'מעלות': 'NORTH',
  'מעלות תרשיחא': 'NORTH', 'תרשיחא': 'NORTH', 'מעיליא': 'NORTH', 'חורפיש': 'NORTH',
  'רגבה': 'NORTH', 'קיבוץ רגבה': 'NORTH', 'עין המפרץ': 'NORTH', 'מתחם עין המפרץ': 'NORTH',
  'תל חנן': 'NORTH', 'עפולה': 'NORTH', 'טבריה': 'NORTH', 'צפת': 'NORTH',
  'קרית שמונה': 'NORTH', 'קריית שמונה': 'NORTH', 'נוף הגליל': 'NORTH', 'נצרת': 'NORTH',
  'נצרת עילית': 'NORTH', 'זכרון יעקב': 'NORTH', 'חדרה': 'NORTH', 'פרדס חנה': 'NORTH',
  'בנימינה': 'NORTH', 'קיסריה': 'NORTH', 'אור עקיבא': 'NORTH', 'כפר כנא': 'NORTH',
  'מגדל העמק': 'NORTH', 'בית שאן': 'NORTH', 'כפר קרע': 'NORTH', 'באקה אל גרבייה': 'NORTH',
  'באקה': 'NORTH', 'טייבה': 'NORTH', 'טירה': 'NORTH', 'אום אל פחם': 'NORTH',
  'ג\'דיידה': 'NORTH', 'כאבול': 'NORTH', 'יקנעם': 'NORTH', 'יקנעם עילית': 'NORTH',
  // SHARON (נתניה, רעננה, הרצליה)
  'נתניה': 'SHARON', 'הרצליה': 'SHARON', 'רעננה': 'SHARON', 'כפר סבא': 'SHARON',
  'הוד השרון': 'SHARON', 'רמת השרון': 'SHARON', 'ראש העין': 'SHARON',
  'אבן יהודה': 'SHARON', 'כפר יונה': 'SHARON', 'תל מונד': 'SHARON', 'חריש': 'SHARON',
  'אלפי מנשה': 'SHARON',
  // CENTER (ת"א, ר"ג, גבעתיים)
  'תל אביב': 'CENTER', 'תל אביב יפו': 'CENTER', 'תל אביב-יפו': 'CENTER',
  'רמת גן': 'CENTER', 'גבעתיים': 'CENTER', 'בני ברק': 'CENTER', 'בת ים': 'CENTER',
  'פתח תקווה': 'CENTER', 'פתח תקוה': 'CENTER', 'חולון': 'CENTER',
  'גני תקווה': 'CENTER', 'גני תקוה': 'CENTER', 'קרית אונו': 'CENTER',
  'קריית אונו': 'CENTER', 'אור יהודה': 'CENTER', 'יהוד': 'CENTER',
  'יהוד מונוסון': 'CENTER', 'איירפורט סיטי': 'CENTER', 'נתב"ג': 'CENTER',
  'נתבג': 'CENTER', 'אזור': 'CENTER', 'גבעת שמואל': 'CENTER', 'סביון': 'CENTER',
  // JERUSALEM (ירושלים והסביבה)
  'ירושלים': 'JERUSALEM', 'בית שמש': 'JERUSALEM', 'מבשרת ציון': 'JERUSALEM',
  'מעלה אדומים': 'JERUSALEM', 'גבעת זאב': 'JERUSALEM', 'ביתר עילית': 'JERUSALEM',
  'אפרת': 'JERUSALEM',
  // SHFELA (רחובות, ראשון, מודיעין)
  'רחובות': 'SHFELA', 'ראשון לציון': 'SHFELA', 'ראשל"צ': 'SHFELA', 'ראשלצ': 'SHFELA',
  'רמלה': 'SHFELA', 'לוד': 'SHFELA', 'נס ציונה': 'SHFELA',
  'מודיעין': 'SHFELA', 'מודיעין מכבים רעות': 'SHFELA', 'יבנה': 'SHFELA',
  'גדרה': 'SHFELA', 'בילו': 'SHFELA', 'קסטינה': 'SHFELA', 'ביג קסטינה': 'SHFELA',
  'צומת סגולה': 'SHFELA', 'סגולה': 'SHFELA', 'באר טוביה': 'SHFELA',
  'מזכרת בתיה': 'SHFELA', 'צומת שילת': 'SHFELA', 'שילת': 'SHFELA',
  'אריאל': 'SHFELA', 'שוהם': 'SHFELA', 'צור יצחק': 'SHFELA',
  // SOUTH-1 (אשדוד, אשקלון, קרית גת)
  'אשדוד': 'SOUTH-1', 'אשקלון': 'SOUTH-1', 'קרית גת': 'SOUTH-1',
  'קריית גת': 'SOUTH-1', 'כרמי גת': 'SOUTH-1', 'ביג כרמי גת': 'SOUTH-1',
  'קרית מלאכי': 'SOUTH-1', 'קריית מלאכי': 'SOUTH-1', 'שדרות': 'SOUTH-1',
  'נתיבות': 'SOUTH-1', 'ניר עם': 'SOUTH-1', 'קיבוץ ניר עם': 'SOUTH-1',
  'שדרות': 'SOUTH-1', 'אופקים': 'SOUTH-1',
  // SOUTH-2 (ב"ש ודרום)
  'באר שבע': 'SOUTH-2', 'ב"ש': 'SOUTH-2', 'בש': 'SOUTH-2', 'ערד': 'SOUTH-2',
  'דימונה': 'SOUTH-2', 'אילת': 'SOUTH-2', 'מצפה רמון': 'SOUTH-2', 'ירוחם': 'SOUTH-2',
  'רהט': 'SOUTH-2', 'תל שבע': 'SOUTH-2', 'להבים': 'SOUTH-2', 'מיתר': 'SOUTH-2',
};

function findZoneByCity(city) {
  if (!city) return null;
  const s = ensureRunsStore();
  const normalized = String(city).trim();
  // 1) User overrides (set via "drag city to another zone" UI) win first
  const overrides = s.cityZoneOverrides || {};
  if (overrides[normalized]) {
    return s.zones.find((z) => z.Code === overrides[normalized]);
  }
  // 2) Hardcoded exact match
  const exactCode = CITY_TO_ZONE[normalized];
  if (exactCode) return s.zones.find((z) => z.Code === exactCode);
  // 3) Partial match (contains)
  for (const [mappedCity, zoneCode] of Object.entries(CITY_TO_ZONE)) {
    if (normalized.includes(mappedCity) || mappedCity.includes(normalized)) {
      return s.zones.find((z) => z.Code === zoneCode);
    }
  }
  return null;
}

/**
 * Return every known city + its currently assigned zone code.
 * Combines built-in CITY_TO_ZONE with user overrides.
 */
export function listCitiesWithZones() {
  const s = ensureRunsStore();
  const overrides = s.cityZoneOverrides || {};
  const all = new Map(); // city -> zoneCode
  for (const [city, code] of Object.entries(CITY_TO_ZONE)) all.set(city, code);
  for (const [city, code] of Object.entries(overrides)) all.set(city, code);
  return [...all.entries()].map(([city, code]) => {
    const zone = s.zones.find((z) => z.Code === code);
    return {
      city,
      zoneCode: code,
      zoneId: zone?.ZoneId ?? null,
      zoneName: zone?.Name ?? null,
      zoneColor: zone?.ColorHex ?? null,
      isOverride: !!overrides[city],
    };
  });
}

/**
 * Move a city from its current zone to another zone (or to none).
 */
export function setCityZone(city, zoneCode) {
  const s = ensureRunsStore();
  if (!s.cityZoneOverrides) s.cityZoneOverrides = {};
  const trimmed = String(city || '').trim();
  if (!trimmed) return false;
  if (zoneCode) {
    s.cityZoneOverrides[trimmed] = zoneCode;
  } else {
    // Reset → use hardcoded default again
    delete s.cityZoneOverrides[trimmed];
  }
  save();
  return true;
}

// ============================================================================
// Customer document policy (delivery-note vs invoice).
// Stored per "parent" customer name so all branches inherit.
// ============================================================================

/**
 * Reduce a SAP CardName to its parent / chain name, so multiple branches of
 * the same customer collapse into a single row in the policy UI.
 *
 * Examples:
 *   "אלקטרה קמעונאות בע"מ - מחסני חשמל ראשל"צ 104"
 *      → "אלקטרה קמעונאות בע"מ"
 *   "א.ל.מ סחר 2000 בע"מ-עפולה"
 *      → "א.ל.מ סחר 2000 בע"מ"
 *   "מנגל בקצב הים בע"מ"
 *      → "מנגל בקצב הים בע"מ"  (no branch suffix)
 */
export function parentNameOf(cardName) {
  if (!cardName) return '';
  let s = String(cardName).trim();
  // First try " - " separator (with spaces)
  const dashSpace = s.indexOf(' - ');
  if (dashSpace > 0) return s.slice(0, dashSpace).trim();
  // Then try "- " (dash + space, no space before)
  const dashAfter = s.indexOf('- ');
  if (dashAfter > 0) return s.slice(0, dashAfter).trim();
  // Then try " -" (space + dash, no space after)
  const dashBefore = s.indexOf(' -');
  if (dashBefore > 0) return s.slice(0, dashBefore).trim();
  // Then a hyphen that comes right after "בע\"מ" (a common chain pattern)
  const m = s.match(/^(.+?בע"מ)\s*-\s*.+$/);
  if (m) return m[1].trim();
  return s;
}

// ============================================================================
// Departure Approval - manager signs off a route before the driver leaves.
// Acts as a final gate after picking + QC + loading.
// ============================================================================

/**
 * Mark a run as approved for departure. Run moves from LOADED → READY_TO_DEPART.
 * Driver app will only show this run after this gate is passed.
 */
export function approveRunDeparture(runId, opts = {}) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return { ok: false, error: 'Run not found' };
  if (!['LOADED', 'PENDING_DEPARTURE', 'OPEN', 'PLANNED'].includes(run.Status)) {
    return { ok: false, error: `המסלול בסטטוס ${run.Status} - לא ניתן לאשר יציאה` };
  }
  // Sanity checks
  const stops = s.stops.filter((st) => st.RunId === run.RunId);
  if (stops.length === 0) {
    return { ok: false, error: 'אין עצירות במסלול' };
  }
  if (!run.DriverId) {
    return { ok: false, error: 'לא משויך נהג - אי אפשר לאשר יציאה' };
  }

  run.Status = 'READY_TO_DEPART';
  run.DepartureApprovedAt = new Date().toISOString();
  run.DepartureApprovedBy = opts.approvedBy || null;
  run.DepartureNotes = opts.notes || null;
  run.DepartureChecklist = {
    pickingComplete: opts.checklist?.pickingComplete ?? true,
    truckLoaded: opts.checklist?.truckLoaded ?? true,
    documentsPrinted: opts.checklist?.documentsPrinted ?? false,
    fuelOk: opts.checklist?.fuelOk ?? true,
    driverPresent: opts.checklist?.driverPresent ?? true,
  };
  save();
  return { ok: true, run };
}

/**
 * Cancel an already-issued departure approval (e.g. driver hasn't left yet
 * and we found a problem). Run drops back to LOADED.
 */
export function cancelDepartureApproval(runId, opts = {}) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return { ok: false, error: 'Run not found' };
  if (run.Status !== 'READY_TO_DEPART') {
    return { ok: false, error: 'אישור היציאה כבר לא רלוונטי' };
  }
  run.Status = 'LOADED';
  run.DepartureRejectedAt = new Date().toISOString();
  run.DepartureRejectedBy = opts.rejectedBy || null;
  run.DepartureRejectReason = opts.reason || null;
  save();
  return { ok: true, run };
}

// ============================================================================
// Per-line actual delivery tracking (partial delivery + damage report).
// One record per WaveLine/Allocation that records what was ACTUALLY delivered
// to the customer at the door (vs what was loaded onto the truck).
// ============================================================================

/**
 * Record what actually arrived at the customer.
 *
 * @param {number} stopId
 * @param {Array} items - [{ allocationId, deliveredQty, damagedQty, missingQty,
 *                            damageNotes, damagePhotoUrl }]
 */
export function recordLineDeliveries(stopId, items, opts = {}) {
  const s = ensureRunsStore();
  if (!s.lineDeliveries) s.lineDeliveries = [];
  if (!s.nextLineDeliveryId) s.nextLineDeliveryId = 1;
  const created = [];
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return { ok: false, error: 'Stop not found' };

  for (const it of items || []) {
    const rec = {
      LineDeliveryId: s.nextLineDeliveryId++,
      StopId: stop.StopId,
      RunId: stop.RunId,
      AllocationId: it.allocationId ? Number(it.allocationId) : null,
      WaveLineId: it.waveLineId ? Number(it.waveLineId) : null,
      ItemCode: it.itemCode || null,
      ItemName: it.itemName || null,
      OrderedQty: Number(it.orderedQty || 0),
      DeliveredQty: Number(it.deliveredQty || 0),
      DamagedQty: Number(it.damagedQty || 0),
      MissingQty: Number(it.missingQty || 0),
      DamageNotes: it.damageNotes || null,
      DamagePhotoUrl: it.damagePhotoUrl || null,
      DeliveryStatus:
        Number(it.deliveredQty || 0) >= Number(it.orderedQty || 0) ? 'FULL' :
        Number(it.deliveredQty || 0) > 0 ? 'PARTIAL' : 'NONE',
      RecordedBy: opts.recordedBy || null,
      RecordedAt: new Date().toISOString(),
    };
    s.lineDeliveries.push(rec);
    created.push(rec);
  }
  save();
  return { ok: true, created };
}

/**
 * Get all line deliveries for a stop / run.
 */
export function getLineDeliveriesForStop(stopId) {
  const s = ensureRunsStore();
  return (s.lineDeliveries || []).filter((d) => d.StopId === Number(stopId));
}

export function getLineDeliveriesForRun(runId) {
  const s = ensureRunsStore();
  return (s.lineDeliveries || []).filter((d) => d.RunId === Number(runId));
}

/**
 * Summary of damage / partial delivery for a stop - used for credit memo
 * generation. Returns {damagedItems, partialItems, totalLines}
 */
export function summariseStopDeliveryIssues(stopId) {
  const recs = getLineDeliveriesForStop(stopId);
  return {
    totalLines: recs.length,
    damagedItems: recs.filter((r) => r.DamagedQty > 0),
    partialItems: recs.filter((r) => r.DeliveryStatus === 'PARTIAL'),
    notDelivered: recs.filter((r) => r.DeliveryStatus === 'NONE'),
    needsCreditMemo: recs.some((r) => r.DamagedQty > 0 || r.MissingQty > 0),
  };
}

// ============================================================================
// Cash on Delivery (COD) - track money the driver collected on each stop.
// Stored as separate records linked to runs/stops so we can reconcile at
// end-of-day (driver hands cash to office).
// ============================================================================

export function listCodCollections(runDate) {
  const s = ensureRunsStore();
  const all = s.codCollections || [];
  if (!runDate) return all;
  // Match by linked run's date
  const runs = (s.runs || []).filter((r) => r.RunDate === runDate);
  const runIds = new Set(runs.map((r) => r.RunId));
  return all.filter((c) => runIds.has(c.RunId));
}

export function recordCodCollection(data) {
  const s = ensureRunsStore();
  if (!s.codCollections) {
    s.codCollections = [];
    s.nextCodId = 1;
  }
  const stop = (s.stops || []).find((st) => st.StopId === Number(data.stopId));
  if (!stop) throw new Error('Stop not found');
  const run = (s.runs || []).find((r) => r.RunId === stop.RunId);
  const rec = {
    CodId: s.nextCodId++,
    RunId: stop.RunId,
    StopId: stop.StopId,
    DriverId: run?.DriverId || null,
    DriverName: run?.DriverName || '',
    BranchName: stop.BranchName,
    City: stop.City,
    Amount: Number(data.amount || 0),
    Method: data.method || 'CASH',           // CASH / CHEQUE / TRANSFER
    ReceiptNumber: data.receiptNumber || null,
    Notes: data.notes || null,
    Status: 'COLLECTED',                     // COLLECTED → DEPOSITED
    CollectedAt: new Date().toISOString(),
    DepositedAt: null,
  };
  s.codCollections.push(rec);
  save();
  return rec;
}

export function markCodDeposited(codId, depositedBy) {
  const s = ensureRunsStore();
  const rec = (s.codCollections || []).find((c) => c.CodId === Number(codId));
  if (!rec) return null;
  rec.Status = 'DEPOSITED';
  rec.DepositedAt = new Date().toISOString();
  rec.DepositedBy = depositedBy;
  save();
  return rec;
}

export function summariseCodForDriver(driverId, runDate) {
  const all = listCodCollections(runDate).filter((c) => c.DriverId === Number(driverId));
  const total = all.reduce((s, c) => s + Number(c.Amount || 0), 0);
  const collected = all.filter((c) => c.Status === 'COLLECTED');
  const deposited = all.filter((c) => c.Status === 'DEPOSITED');
  return {
    driverId,
    runDate,
    total,
    pendingDeposit: collected.reduce((s, c) => s + Number(c.Amount || 0), 0),
    deposited: deposited.reduce((s, c) => s + Number(c.Amount || 0), 0),
    count: all.length,
    items: all,
  };
}

// ============================================================================
// Driver performance tracking (smart route learning).
// Records per-driver per-zone metrics so the planner can suggest the best
// driver for each route, and the dashboard can show a leaderboard.
// ============================================================================

/**
 * Record a delivery event for performance tracking.
 * Called when a stop is completed (success / failure).
 */
export function recordDriverPerformance(driverId, zoneCode, event) {
  const s = ensureRunsStore();
  if (!s.driverStats) s.driverStats = {};
  const key = `${driverId}|${zoneCode || 'NONE'}`;
  if (!s.driverStats[key]) {
    s.driverStats[key] = {
      DriverId: Number(driverId),
      ZoneCode: zoneCode,
      TotalStops: 0,
      Delivered: 0,
      Failed: 0,
      AvgMinutesPerStop: 0,   // exponential moving avg
      LastUpdated: null,
    };
  }
  const r = s.driverStats[key];
  r.TotalStops += 1;
  if (event.delivered) r.Delivered += 1;
  if (event.failed) r.Failed += 1;
  if (event.minutesAtStop != null && event.minutesAtStop >= 0) {
    // EMA with alpha=0.3 — weights recent stops more
    const a = 0.3;
    r.AvgMinutesPerStop = r.AvgMinutesPerStop > 0
      ? Math.round((1 - a) * r.AvgMinutesPerStop + a * event.minutesAtStop)
      : event.minutesAtStop;
  }
  r.LastUpdated = new Date().toISOString();
  save();
  return r;
}

/**
 * Read all stats. Used by analytics page + planner suggestions.
 */
export function getDriverPerformance() {
  const s = ensureRunsStore();
  return Object.values(s.driverStats || {});
}

/**
 * Suggest the best driver for a given zone, based on success rate and speed.
 * Returns the driver IDs sorted best-first (with score).
 */
export function suggestDriversForZone(zoneCode) {
  const stats = getDriverPerformance().filter(
    (r) => r.ZoneCode === zoneCode && r.TotalStops >= 3
  );
  const scored = stats.map((r) => {
    const successRate = r.TotalStops > 0 ? r.Delivered / r.TotalStops : 0;
    // Lower minutes-per-stop is better. Normalise: 10min=1.0, 30min=0.0
    const speedScore = r.AvgMinutesPerStop > 0
      ? Math.max(0, Math.min(1, (30 - r.AvgMinutesPerStop) / 20))
      : 0.5;
    const experience = Math.min(1, r.TotalStops / 100);
    const score = Math.round(
      (successRate * 0.5 + speedScore * 0.3 + experience * 0.2) * 100
    );
    return { ...r, SuccessRate: successRate, Score: score };
  });
  scored.sort((a, b) => b.Score - a.Score);
  return scored;
}

// ============================================================================
// Customer business hours (when each chain is open / closed for delivery)
// Stored per parent customer name. All branches inherit.
// ============================================================================

/**
 * Default windows for an unconfigured customer (08:00-17:00, no break, all days).
 */
const DEFAULT_HOURS = {
  monday:    { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
  tuesday:   { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
  wednesday: { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
  thursday:  { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
  friday:    { open: '08:00', close: '13:00', breakStart: null, breakEnd: null, closed: false },
  saturday:  { open: null,    close: null,    breakStart: null, breakEnd: null, closed: true },
  sunday:    { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
};

export function getDefaultBusinessHours() {
  return JSON.parse(JSON.stringify(DEFAULT_HOURS));
}

export function listCustomerHours() {
  const s = ensureRunsStore();
  return s.customerHours || {};
}

export function setCustomerHours(parentName, hours) {
  const s = ensureRunsStore();
  if (!s.customerHours) s.customerHours = {};
  const key = parentNameOf(parentName);
  if (!key) return false;
  if (hours == null) {
    delete s.customerHours[key];
  } else {
    // Light validation
    s.customerHours[key] = hours;
  }
  save();
  return true;
}

/**
 * Resolve hours for a CardName → returns the day-by-day schedule.
 * Falls back to DEFAULT_HOURS if not configured.
 */
export function resolveHoursForCardName(cardName) {
  const s = ensureRunsStore();
  const all = s.customerHours || {};
  const parent = parentNameOf(cardName);
  return all[parent] || getDefaultBusinessHours();
}

/**
 * Given a Date and a hours object, return a description of whether the
 * customer is open at that time (used by route planning + driver UI).
 */
export function getOpenStatusAt(hours, date = new Date()) {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const day = days[date.getDay()];
  const dayHours = hours[day] || {};
  if (dayHours.closed) return { open: false, reason: 'סגור היום' };
  if (!dayHours.open || !dayHours.close) return { open: true };
  const minutes = date.getHours() * 60 + date.getMinutes();
  const toMin = (s) => {
    const [h, m] = (s || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  if (minutes < toMin(dayHours.open)) return { open: false, reason: `נפתח ב-${dayHours.open}` };
  if (minutes >= toMin(dayHours.close)) return { open: false, reason: `סגור מ-${dayHours.close}` };
  if (dayHours.breakStart && dayHours.breakEnd) {
    const bs = toMin(dayHours.breakStart);
    const be = toMin(dayHours.breakEnd);
    if (minutes >= bs && minutes < be) {
      return { open: false, reason: `הפסקה ${dayHours.breakStart}-${dayHours.breakEnd}` };
    }
  }
  return { open: true };
}

const VALID_DOC_TYPES = ['DELIVERY_NOTE', 'INVOICE'];

/**
 * Default doc type for any customer not yet configured.
 * Most B2B customers in OIG/Unico get an invoice → INVOICE.
 */
export const DEFAULT_DOC_TYPE = 'INVOICE';

export function listCustomerDocPolicies() {
  const s = ensureRunsStore();
  return s.customerDocPolicies || {};
}

/**
 * Set a doc type for a parent (chain) name. Pass null to remove the override.
 */
export function setCustomerDocPolicy(parentName, docType) {
  const s = ensureRunsStore();
  if (!s.customerDocPolicies) s.customerDocPolicies = {};
  const key = parentNameOf(parentName);
  if (!key) return false;
  if (docType == null) {
    delete s.customerDocPolicies[key];
  } else {
    if (!VALID_DOC_TYPES.includes(docType)) return false;
    s.customerDocPolicies[key] = docType;
  }
  save();
  return true;
}

/**
 * Resolve a single CardName → its current doc type (with default fallback).
 */
export function resolveDocTypeForCardName(cardName) {
  const s = ensureRunsStore();
  const policies = s.customerDocPolicies || {};
  const parent = parentNameOf(cardName);
  return policies[parent] || DEFAULT_DOC_TYPE;
}

export function addStop(runId, data) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return null;

  const existing = s.stops.filter((st) => st.RunId === run.RunId);

  // Auto-detect zone based on city for informational purposes
  const autoZone = findZoneByCity(data.city);

  const newStop = {
    StopId: s.nextStopId++,
    RunId: run.RunId,
    AddressId: data.addressId || null,
    StopOrder: existing.length + 1,
    Status: 'PENDING',
    ArrivedAt: null,
    CompletedAt: null,
    SignatureUrl: null,
    PhotoUrl: null,
    Notes: data.notes || null,
    Street: data.street || '',
    BuildingNumber: data.buildingNumber || '',
    City: data.city || '',
    BranchName: data.branchName || '',
    Latitude: data.latitude || null,
    Longitude: data.longitude || null,
    DeliveryWindowStart: data.deliveryWindowStart || null,
    DeliveryWindowEnd: data.deliveryWindowEnd || null,
    DeliveryDays: data.deliveryDays || null,
    ContactPhone: data.contactPhone || null,
    ContactName: data.contactName || null,
    DeliveryNotes: data.deliveryNotes || null,
    SuggestedZoneId: autoZone?.ZoneId || null,
    SuggestedZoneName: autoZone?.Name || null,
  };
  s.stops.push(newStop);
  updateRunCounts(run.RunId);
  save();
  return newStop;
}

/**
 * Find the zone code that matches a city name. Exported for UI suggestions.
 */
export function suggestZoneForCity(city) {
  return findZoneByCity(city);
}

export function deleteStop(stopId) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return false;
  const runId = stop.RunId;
  s.stops = s.stops.filter((st) => st.StopId !== Number(stopId));
  s.runOrders = s.runOrders.filter((o) => o.StopId !== Number(stopId));
  // Resequence
  const remaining = s.stops
    .filter((st) => st.RunId === runId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));
  remaining.forEach((st, i) => { st.StopOrder = i + 1; });
  updateRunCounts(runId);
  save();
  return true;
}

/**
 * Smart sort stops in a run:
 *  - Group by city (same city = consecutive stops)
 *  - Within each city, sort alphabetically by street
 *  - Cities ordered by the CityOrder sequence of the zone
 */
const CITY_DRIVE_ORDER = {
  // NORTHWEST: coastal route from Hadera up to Nahariya
  NORTHWEST: ['חדרה', 'פרדס חנה', 'פרדס חנה כרכור', 'בנימינה', 'זכרון יעקב', 'קיסריה', 'עתלית', 'טירת הכרמל', 'טירת כרמל', 'חיפה', 'נשר', 'קריית אתא', 'קרית אתא', 'קריית ביאליק', 'קרית ביאליק', 'קריית מוצקין', 'קרית מוצקין', 'קריית ים', 'קרית ים', 'עכו', 'נהריה', 'מעלות', 'מעלות תרשיחא'],
  // NORTH inland route (Galilee + Lower Galilee)
  NORTH: ['כרמיאל', 'עפולה', 'נצרת', 'נוף הגליל', 'מגדל העמק', 'טבריה', 'צפת', 'קריית שמונה'],
  SHARON: ['ראש העין', 'הוד השרון', 'רמת השרון', 'הרצליה', 'רעננה', 'כפר סבא', 'כפר יונה', 'אבן יהודה', 'נתניה', 'חריש'],
  CENTER: ['בני ברק', 'גבעתיים', 'רמת גן', 'תל אביב', 'חולון', 'בת ים', 'אור יהודה', 'יהוד', 'קרית אונו', 'פתח תקווה', 'גני תקווה'],
  JERUSALEM: ['מבשרת ציון', 'ירושלים', 'גבעת זאב', 'מעלה אדומים', 'בית שמש'],
  SHFELA: ['יבנה', 'גדרה', 'רחובות', 'נס ציונה', 'ראשון לציון', 'רמלה', 'לוד', 'מודיעין'],
  'SOUTH-1': ['אשקלון', 'אשדוד', 'קרית מלאכי', 'קריית מלאכי', 'קרית גת', 'קריית גת', 'כרמי גת', 'שדרות', 'נתיבות', 'אופקים'],
  'SOUTH-2': ['רהט', 'להבים', 'באר שבע', 'דימונה', 'ערד', 'ירוחם', 'מצפה רמון', 'אילת'],
};

/**
 * Split a large run in half - creates a new run in the same zone,
 * moves the second half of stops to it. Returns the new run.
 */
export function splitRun(runId, maxStopsPerRun = 25) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return null;

  const stops = s.stops
    .filter((st) => st.RunId === run.RunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));

  if (stops.length <= maxStopsPerRun) return null;

  // Split in roughly equal halves
  const splitAt = Math.ceil(stops.length / 2);
  const keepStops = stops.slice(0, splitAt);
  const moveStops = stops.slice(splitAt);

  // Create new run (same zone, same date)
  const seq = s.runs.filter((r) => r.RunDate === run.RunDate).length + 1;
  const newRun = {
    RunId: s.nextRunId++,
    RunNumber: `RUN-${run.RunDate}-${String(seq).padStart(2, '0')}`,
    RunDate: run.RunDate,
    ZoneId: run.ZoneId, ZoneCode: run.ZoneCode, ZoneName: run.ZoneName, ZoneColor: run.ZoneColor,
    DriverId: null, DriverName: '', DriverPhone: '', VehiclePlate: '',
    Status: 'OPEN',
    PlannedStartTime: null, ActualStartTime: null, ActualEndTime: null,
    Notes: `פוצל אוטומטית מ-${run.RunNumber}`,
    CreatedAt: new Date().toISOString(),
    StopCount: 0, OrderCount: 0,
  };
  s.runs.push(newRun);

  // Move stops to new run
  moveStops.forEach((st, i) => {
    st.RunId = newRun.RunId;
    st.StopOrder = i + 1;
  });
  // Re-number kept stops
  keepStops.forEach((st, i) => { st.StopOrder = i + 1; });

  updateRunCounts(run.RunId);
  updateRunCounts(newRun.RunId);
  save();
  return newRun;
}

/**
 * Move a stop (and its orders) to a different run.
 */
export function moveStopToRun(stopId, targetRunId) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return null;
  const target = s.runs.find((r) => r.RunId === Number(targetRunId));
  if (!target) return null;

  const oldRunId = stop.RunId;
  stop.RunId = target.RunId;

  // Put at end of target run
  const targetStops = s.stops.filter((st) => st.RunId === target.RunId);
  stop.StopOrder = targetStops.length;

  // Renumber old run
  const oldStops = s.stops
    .filter((st) => st.RunId === oldRunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));
  oldStops.forEach((st, i) => { st.StopOrder = i + 1; });

  updateRunCounts(oldRunId);
  updateRunCounts(target.RunId);
  save();
  return { stopId: stop.StopId, oldRunId, newRunId: target.RunId };
}

export function smartSortStops(runId) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return false;

  const siblings = s.stops.filter((st) => st.RunId === run.RunId);
  const zoneOrder = CITY_DRIVE_ORDER[run.ZoneCode] || [];

  const getCityRank = (city) => {
    if (!city) return 999;
    const normalized = String(city).trim();
    for (let i = 0; i < zoneOrder.length; i++) {
      const mappedCity = zoneOrder[i];
      if (normalized === mappedCity || normalized.includes(mappedCity) || mappedCity.includes(normalized)) {
        return i;
      }
    }
    return 500; // Unknown cities sorted between ordered and empty
  };

  siblings.sort((a, b) => {
    const rankA = getCityRank(a.City);
    const rankB = getCityRank(b.City);
    if (rankA !== rankB) return rankA - rankB;
    // Same city - sort by street
    const streetA = (a.Street || a.BranchName || '').trim();
    const streetB = (b.Street || b.BranchName || '').trim();
    return streetA.localeCompare(streetB, 'he');
  });

  siblings.forEach((st, i) => { st.StopOrder = i + 1; });
  save();
  return true;
}

export function moveStop(stopId, direction) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return false;
  const siblings = s.stops
    .filter((st) => st.RunId === stop.RunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));
  const idx = siblings.findIndex((st) => st.StopId === stop.StopId);
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= siblings.length) return false;
  [siblings[idx].StopOrder, siblings[target].StopOrder] =
    [siblings[target].StopOrder, siblings[idx].StopOrder];
  save();
  return true;
}

export function updateStop(stopId, updates) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return null;
  const map = {
    street: 'Street', buildingNumber: 'BuildingNumber', city: 'City',
    branchName: 'BranchName', contactName: 'ContactName',
    contactPhone: 'ContactPhone', deliveryNotes: 'DeliveryNotes',
    deliveryWindowStart: 'DeliveryWindowStart', deliveryWindowEnd: 'DeliveryWindowEnd',
    notes: 'Notes', status: 'Status',
  };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) stop[to] = updates[from];
  }
  save();
  return stop;
}

export function addOrderToStop(stopId, orderData) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return null;
  const exists = s.runOrders.find((o) =>
    o.StopId === Number(stopId) &&
    o.CompanyCode === orderData.companyCode &&
    o.SapDocEntry === orderData.docEntry
  );
  if (exists) return exists;

  const newOrder = {
    RunOrderId: s.nextRunOrderId++,
    StopId: Number(stopId),
    CompanyId: orderData.companyCode === 'A' ? 1 : 2,
    CompanyCode: orderData.companyCode,
    CompanyName: orderData.companyCode === 'A' ? 'OIG' : 'Unico',
    SapDocEntry: orderData.docEntry,
    SapDocNum: orderData.docNum,
    SapCardCode: orderData.cardCode,
    SapCardName: orderData.cardName,
    OrderTotal: orderData.total || 0,
    LinesCount: orderData.linesCount || 0,
    Status: 'PENDING',
    SapDeliveryDocEntry: null,
  };
  s.runOrders.push(newOrder);
  updateRunCounts(stop.RunId);
  save();
  return newOrder;
}

export function deleteRunOrder(runOrderId) {
  const s = ensureRunsStore();
  const order = s.runOrders.find((o) => o.RunOrderId === Number(runOrderId));
  if (!order) return false;
  const stopId = order.StopId;
  s.runOrders = s.runOrders.filter((o) => o.RunOrderId !== Number(runOrderId));
  const stop = s.stops.find((st) => st.StopId === stopId);
  if (stop) updateRunCounts(stop.RunId);
  save();
  return true;
}

function updateRunCounts(runId) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return;
  const stops = s.stops.filter((st) => st.RunId === run.RunId);
  run.StopCount = stops.length;
  const stopIds = stops.map((st) => st.StopId);
  run.OrderCount = s.runOrders.filter((o) => stopIds.includes(o.StopId)).length;
}

// ============================================================================
// Picking Waves
// ============================================================================

function ensureWavesStore() {
  const s = ensureRunsStore();
  if (!s.waves) { s.waves = []; s.nextWaveId = 1; }
  if (!s.waveLines) { s.waveLines = []; s.nextWaveLineId = 1; }
  if (!s.waveAllocations) { s.waveAllocations = []; s.nextWaveAllocationId = 1; }
  return s;
}

/**
 * Create a new picking wave for a run.
 * Takes pre-fetched SAP order lines and aggregates them by ItemCode.
 * lines: [{ CompanyCode, DocEntry, LineNum, ItemCode, ItemName, OpenQty, WarehouseCode, Barcode, DocNum, CardName, ... }]
 */
export function createWaveFromLines(runId, orderLines) {
  const s = ensureWavesStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return null;

  // Build a docEntry+company → city/customer map so each picked line can show
  // exactly which customer/city it goes to (the picker needs this when one
  // wave covers multiple stops).
  const stopsInRun = (s.stops || []).filter((st) => st.RunId === run.RunId);
  const stopById = new Map(stopsInRun.map((st) => [st.StopId, st]));
  const docToCustomer = new Map(); // 'A:42150' -> { city, branchName, cardName }
  for (const ord of (s.runOrders || [])) {
    const stop = stopById.get(ord.StopId);
    if (!stop) continue;
    const key = `${ord.CompanyCode}:${ord.SapDocEntry}`;
    docToCustomer.set(key, {
      city: stop.City || '',
      branchName: stop.BranchName || ord.SapCardName || '',
      cardName: ord.SapCardName || '',
    });
  }

  // Cancel any existing active wave for this run
  for (const w of s.waves) {
    if (w.RunId === run.RunId && w.Status !== 'CANCELLED' && w.Status !== 'COMPLETED') {
      w.Status = 'CANCELLED';
    }
  }

  const waveNumber = `WAVE-${run.RunNumber}-${String(s.waves.filter((w) => w.RunId === run.RunId).length + 1).padStart(2, '0')}`;
  const newWave = {
    WaveId: s.nextWaveId++,
    WaveNumber: waveNumber,
    RunId: run.RunId,
    RunNumber: run.RunNumber,
    RunDate: run.RunDate,
    Status: 'PENDING',
    PickedBy: null,
    PickedByName: null,
    StartedAt: null,
    CompletedAt: null,
    CreatedAt: new Date().toISOString(),
    TotalLines: 0,
    CompletedLines: 0,
  };
  s.waves.push(newWave);

  // Aggregate lines by ItemCode
  const byItem = new Map();
  for (const line of orderLines) {
    const key = line.ItemCode;
    if (!byItem.has(key)) {
      byItem.set(key, {
        ItemCode: line.ItemCode,
        ItemName: line.ItemName,
        Barcode: line.Barcode || null,
        WarehouseCode: line.WarehouseCode,
        UomCode: line.UomCode,
        TotalQuantity: 0,
        Allocations: [],
      });
    }
    const agg = byItem.get(key);
    agg.TotalQuantity += Number(line.OpenQty || line.Quantity || 0);
    const cust = docToCustomer.get(`${line.CompanyCode}:${line.DocEntry}`) || {};
    agg.Allocations.push({
      CompanyCode: line.CompanyCode,
      DocEntry: line.DocEntry,
      DocNum: line.DocNum,
      LineNum: line.LineNum,
      CardName: line.CardName,
      // City + branch enrich the allocation so the picker sees who/where
      City: cust.city || '',
      BranchName: cust.branchName || '',
      Quantity: Number(line.OpenQty || line.Quantity || 0),
    });
  }

  // City drive order for the run's zone (e.g. NORTH = south→north sequence)
  const driveOrder = CITY_DRIVE_ORDER[run.ZoneCode] || [];
  const cityRank = (city) => {
    if (!city) return 9999;
    const norm = String(city).trim();
    const idx = driveOrder.findIndex(
      (c) => c === norm || norm.includes(c) || c.includes(norm)
    );
    return idx >= 0 ? idx : 9999;
  };

  // Sort allocations inside each item by city drive order so the picker
  // sees them in the order the truck will visit them.
  for (const agg of byItem.values()) {
    agg.Allocations.sort((a, b) => {
      const ra = cityRank(a.City);
      const rb = cityRank(b.City);
      if (ra !== rb) return ra - rb;
      return String(a.City || '').localeCompare(String(b.City || ''), 'he');
    });
  }

  // Sort wave lines: primary key = first allocation's city in drive order,
  // secondary = warehouse location, tertiary = item code (stable).
  const sorted = Array.from(byItem.values()).sort((a, b) => {
    const ca = a.Allocations[0]?.City || '';
    const cb = b.Allocations[0]?.City || '';
    const ra = cityRank(ca);
    const rb = cityRank(cb);
    if (ra !== rb) return ra - rb;
    if (ca !== cb) return ca.localeCompare(cb, 'he');
    const whA = a.WarehouseCode || 'ZZZ';
    const whB = b.WarehouseCode || 'ZZZ';
    return whA.localeCompare(whB) || a.ItemCode.localeCompare(b.ItemCode);
  });

  // Create wave lines
  for (const agg of sorted) {
    const waveLine = {
      WaveLineId: s.nextWaveLineId++,
      WaveId: newWave.WaveId,
      SapItemCode: agg.ItemCode,
      SapItemName: agg.ItemName || '',
      Barcode: agg.Barcode,
      UomCode: agg.UomCode || '',
      BinLocation: agg.WarehouseCode || '',
      TotalQuantity: agg.TotalQuantity,
      PickedQuantity: 0,
      Status: 'PENDING',
      AllocationCount: agg.Allocations.length,
      Notes: null,
    };
    s.waveLines.push(waveLine);

    // Save allocations (link back to specific orders)
    for (const alloc of agg.Allocations) {
      s.waveAllocations.push({
        AllocationId: s.nextWaveAllocationId++,
        WaveLineId: waveLine.WaveLineId,
        CompanyCode: alloc.CompanyCode,
        SapDocEntry: alloc.DocEntry,
        SapDocNum: alloc.DocNum,
        SapOrderLineNum: alloc.LineNum,
        SapCardName: alloc.CardName,
        City: alloc.City || '',
        BranchName: alloc.BranchName || '',
        Quantity: alloc.Quantity,
      });
    }
  }

  newWave.TotalLines = sorted.length;
  save();
  return newWave;
}

export function getWave(waveId) {
  const s = ensureWavesStore();
  const wave = s.waves.find((w) => w.WaveId === Number(waveId));
  if (!wave) return null;

  // Build a lookup so we can backfill City + BranchName on allocations that
  // were saved before those fields were added.
  const stopsInRun = (s.stops || []).filter((st) => st.RunId === wave.RunId);
  const stopById = new Map(stopsInRun.map((st) => [st.StopId, st]));
  const docToCustomer = new Map();
  for (const ord of (s.runOrders || [])) {
    const stop = stopById.get(ord.StopId);
    if (!stop) continue;
    docToCustomer.set(`${ord.CompanyCode}:${ord.SapDocEntry}`, {
      city: stop.City || '',
      branchName: stop.BranchName || ord.SapCardName || '',
    });
  }
  const enrich = (a) => {
    if (a.City && a.BranchName) return a;
    const cust = docToCustomer.get(`${a.CompanyCode}:${a.SapDocEntry}`) || {};
    return {
      ...a,
      City: a.City || cust.city || '',
      BranchName: a.BranchName || cust.branchName || a.SapCardName || '',
    };
  };

  // Drive order for the wave's zone (so legacy waves get the same sort order)
  const run = s.runs.find((r) => r.RunId === wave.RunId);
  const driveOrder = (run && CITY_DRIVE_ORDER[run.ZoneCode]) || [];
  const cityRank = (city) => {
    if (!city) return 9999;
    const norm = String(city).trim();
    const idx = driveOrder.findIndex(
      (c) => c === norm || norm.includes(c) || c.includes(norm)
    );
    return idx >= 0 ? idx : 9999;
  };

  const lines = s.waveLines
    .filter((l) => l.WaveId === wave.WaveId)
    .map((l) => {
      const allocations = s.waveAllocations
        .filter((a) => a.WaveLineId === l.WaveLineId)
        .map(enrich)
        .sort((a, b) => {
          const ra = cityRank(a.City);
          const rb = cityRank(b.City);
          if (ra !== rb) return ra - rb;
          return String(a.City || '').localeCompare(String(b.City || ''), 'he');
        });
      const primaryCity = allocations[0]?.City || '';
      return { ...l, allocations, PrimaryCity: primaryCity };
    })
    .sort((a, b) => {
      // Pending lines first (so picker sees what's left), then by city drive order
      const aDone = a.Status === 'COMPLETED' || a.Status === 'SHORTAGE';
      const bDone = b.Status === 'COMPLETED' || b.Status === 'SHORTAGE';
      if (aDone !== bDone) return aDone ? 1 : -1;
      const ra = cityRank(a.PrimaryCity);
      const rb = cityRank(b.PrimaryCity);
      if (ra !== rb) return ra - rb;
      const cityCmp = String(a.PrimaryCity || '').localeCompare(String(b.PrimaryCity || ''), 'he');
      if (cityCmp !== 0) return cityCmp;
      return (a.BinLocation || 'ZZZ').localeCompare(b.BinLocation || 'ZZZ');
    });
  const completed = lines.filter((l) => l.Status === 'COMPLETED').length;
  const picked = lines.reduce((sum, l) => sum + Number(l.PickedQuantity || 0), 0);
  const needed = lines.reduce((sum, l) => sum + Number(l.TotalQuantity || 0), 0);
  return { ...wave, lines, CompletedLines: completed, TotalPicked: picked, TotalNeeded: needed };
}

export function getWaveForRun(runId) {
  const s = ensureWavesStore();
  const wave = s.waves.find((w) => w.RunId === Number(runId) && w.Status !== 'CANCELLED');
  return wave ? getWave(wave.WaveId) : null;
}

/**
 * Approve a wave's QC and trigger document generation + run advancement.
 * Caller can also pass `notes` (saved on the wave) and `approvedBy` (audit).
 */
export function approveWaveQc(waveId, opts = {}) {
  const s = ensureWavesStore();
  const wave = s.waves.find((w) => w.WaveId === Number(waveId));
  if (!wave) return null;
  if (wave.Status !== 'PENDING_QC') {
    return { ok: false, error: `Wave is in status ${wave.Status}, not PENDING_QC` };
  }
  wave.Status = 'COMPLETED';
  wave.QcApprovedAt = new Date().toISOString();
  wave.QcApprovedBy = opts.approvedBy || null;
  if (opts.notes) wave.QcNotes = opts.notes;

  const run = s.runs.find((r) => r.RunId === wave.RunId);
  if (run && ['PLANNED', 'OPEN', 'PICKING', 'PENDING_QC'].includes(run.Status)) {
    run.Status = 'LOADED';
  }
  // Now generate documents per customer policy
  if (run) {
    try {
      const stopsInRun = s.stops.filter((st) => st.RunId === run.RunId);
      for (const stop of stopsInRun) {
        const dns = generateDeliveryNotesForStop(stop.StopId, { method: 'QC_APPROVED' }) || [];
        for (const dn of dns) {
          const docType = resolveDocTypeForCardName(dn.SapCardName);
          if (docType === 'INVOICE') {
            try { generateInvoiceFromDeliveryNote(dn.DeliveryNoteId); }
            catch (e) { console.warn('[qc-approve] invoice gen failed:', e.message); }
          }
        }
      }
    } catch (e) {
      console.warn('[qc-approve] doc gen failed:', e.message);
    }
  }
  save();
  return { ok: true, wave };
}

/**
 * Reject the wave's QC - sends one or more lines back for re-pick or shortage.
 * Used when QC found a quantity mismatch or wrong item picked.
 */
export function rejectWaveQc(waveId, opts = {}) {
  const s = ensureWavesStore();
  const wave = s.waves.find((w) => w.WaveId === Number(waveId));
  if (!wave) return null;
  // Reset specific lines if provided, otherwise just send wave back to IN_PROGRESS
  if (Array.isArray(opts.resetLineIds)) {
    for (const id of opts.resetLineIds) {
      const ln = s.waveLines.find((l) => l.WaveLineId === Number(id));
      if (ln) {
        ln.PickedQuantity = 0;
        ln.Status = 'PENDING';
      }
      const allocs = s.waveAllocations.filter((a) => a.WaveLineId === Number(id));
      for (const a of allocs) {
        a.PickedQuantity = 0;
        a.Status = 'PENDING';
      }
    }
  }
  wave.Status = 'IN_PROGRESS';
  wave.QcRejectedAt = new Date().toISOString();
  wave.QcRejectedBy = opts.rejectedBy || null;
  if (opts.notes) wave.QcNotes = opts.notes;
  save();
  return { ok: true, wave };
}

/**
 * Record a pick action for a SPECIFIC allocation row (sub-line of a wave line).
 * This allows the picker to mark "picked X units for customer A" separately from
 * "picked Y units for customer B" - each allocation is its own row in the UI.
 *
 * The parent WaveLine's PickedQuantity is recomputed as the sum of all allocations.
 */
export function pickAllocation(allocationId, qty, userId = null, userName = null) {
  const s = ensureWavesStore();
  const alloc = (s.waveAllocations || []).find((a) => a.AllocationId === Number(allocationId));
  if (!alloc) return null;

  const allocPicked = Number(alloc.PickedQuantity || 0) + Number(qty);
  // Cap at the allocation's required quantity
  alloc.PickedQuantity = Math.min(allocPicked, Number(alloc.Quantity));
  alloc.Status = alloc.PickedQuantity >= Number(alloc.Quantity) ? 'COMPLETED' : 'PARTIAL';
  alloc.LastPickedAt = new Date().toISOString();
  if (userName) alloc.LastPickedBy = userName;

  // Recompute the parent line's PickedQuantity as sum of all allocations
  const line = s.waveLines.find((l) => l.WaveLineId === alloc.WaveLineId);
  if (line) {
    const allAllocs = s.waveAllocations.filter((a) => a.WaveLineId === line.WaveLineId);
    const total = allAllocs.reduce((sum, a) => sum + Number(a.PickedQuantity || 0), 0);
    line.PickedQuantity = total;
    if (total >= Number(line.TotalQuantity)) line.Status = 'COMPLETED';
    else if (total > 0) line.Status = 'PARTIAL';

    // Wave / run state propagation (same as recordPick)
    const wave = s.waves.find((w) => w.WaveId === line.WaveId);
    if (wave && wave.Status === 'PENDING') {
      wave.Status = 'IN_PROGRESS';
      wave.StartedAt = new Date().toISOString();
      wave.PickedBy = userId;
      wave.PickedByName = userName;
    }
    const allLines = s.waveLines.filter((l) => l.WaveId === line.WaveId);
    const allDone = allLines.every((l) => l.Status === 'COMPLETED' || l.Status === 'SHORTAGE');
    if (allDone && wave && wave.Status !== 'COMPLETED') {
      wave.Status = 'COMPLETED';
      wave.CompletedAt = new Date().toISOString();
      const run = s.runs.find((r) => r.RunId === wave.RunId);
      if (run && ['PLANNED', 'OPEN', 'PICKING'].includes(run.Status)) {
        run.Status = 'LOADED';
      }
    }
  }

  save();
  return { alloc, line };
}

/**
 * Reset a specific allocation back to 0 picked.
 */
export function resetAllocation(allocationId) {
  const s = ensureWavesStore();
  const alloc = (s.waveAllocations || []).find((a) => a.AllocationId === Number(allocationId));
  if (!alloc) return null;
  alloc.PickedQuantity = 0;
  alloc.Status = 'PENDING';
  alloc.LastPickedAt = null;
  // Recompute parent line
  const line = s.waveLines.find((l) => l.WaveLineId === alloc.WaveLineId);
  if (line) {
    const allAllocs = s.waveAllocations.filter((a) => a.WaveLineId === line.WaveLineId);
    line.PickedQuantity = allAllocs.reduce((sum, a) => sum + Number(a.PickedQuantity || 0), 0);
    line.Status = line.PickedQuantity > 0 ? 'PARTIAL' : 'PENDING';
  }
  save();
  return { alloc, line };
}

/**
 * Record a pick action - user scanned/entered quantity for a line.
 */
export function recordPick(waveLineId, pickedQty, userId = null, userName = null) {
  const s = ensureWavesStore();
  const line = s.waveLines.find((l) => l.WaveLineId === Number(waveLineId));
  if (!line) return null;

  const newPicked = Number(line.PickedQuantity) + Number(pickedQty);
  line.PickedQuantity = newPicked;
  if (newPicked >= Number(line.TotalQuantity)) {
    line.Status = 'COMPLETED';
  } else if (newPicked > 0) {
    line.Status = 'PARTIAL';
  }

  // Mark wave as in-progress on first pick
  const wave = s.waves.find((w) => w.WaveId === line.WaveId);
  if (wave && wave.Status === 'PENDING') {
    wave.Status = 'IN_PROGRESS';
    wave.StartedAt = new Date().toISOString();
    wave.PickedBy = userId;
    wave.PickedByName = userName;
  }

  // Check if all lines complete
  const allLines = s.waveLines.filter((l) => l.WaveId === line.WaveId);
  const allDone = allLines.every((l) => l.Status === 'COMPLETED' || l.Status === 'SHORTAGE');
  if (allDone && wave) {
    // Picking is done - move to QC review (manual approval gate before docs are generated).
    // The user can either approve (→ generates docs and advances run) or reject specific lines.
    wave.Status = 'PENDING_QC';
    wave.CompletedAt = new Date().toISOString();
  }

  save();
  return line;
}

export function markShortage(waveLineId, notes = null) {
  const s = ensureWavesStore();
  const line = s.waveLines.find((l) => l.WaveLineId === Number(waveLineId));
  if (!line) return null;
  line.Status = 'SHORTAGE';
  line.Notes = notes;
  save();
  return line;
}

export function resetWaveLine(waveLineId) {
  const s = ensureWavesStore();
  const line = s.waveLines.find((l) => l.WaveLineId === Number(waveLineId));
  if (!line) return null;
  line.PickedQuantity = 0;
  line.Status = 'PENDING';
  line.Notes = null;
  save();
  return line;
}

export function listWaves({ status = null, runDate = null } = {}) {
  const s = ensureWavesStore();
  let waves = [...s.waves];
  if (status) waves = waves.filter((w) => w.Status === status);
  if (runDate) waves = waves.filter((w) => w.RunDate === runDate);
  return waves.sort((a, b) => b.WaveId - a.WaveId);
}

/**
 * Duplicate a run - creates a new run with the same stops + addresses
 * on a new date. Does NOT copy the SAP orders (those are one-time per order).
 *
 * Useful for regular customers that get a delivery every Tuesday, for example.
 */
export function duplicateRun(sourceRunId, newRunDate) {
  const s = ensureRunsStore();
  const source = s.runs.find((r) => r.RunId === Number(sourceRunId));
  if (!source) return null;

  const newRun = addRun({
    runDate: newRunDate,
    zoneId: source.ZoneId,
    driverId: source.DriverId,
    notes: source.Notes ? `${source.Notes} (שכפול)` : 'שכפול',
  });

  const sourceStops = s.stops
    .filter((st) => st.RunId === source.RunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));

  for (const ss of sourceStops) {
    addStop(newRun.RunId, {
      addressId: ss.AddressId, street: ss.Street,
      buildingNumber: ss.BuildingNumber, city: ss.City, branchName: ss.BranchName,
      latitude: ss.Latitude, longitude: ss.Longitude,
      deliveryWindowStart: ss.DeliveryWindowStart, deliveryWindowEnd: ss.DeliveryWindowEnd,
      deliveryDays: ss.DeliveryDays,
      contactPhone: ss.ContactPhone, contactName: ss.ContactName,
      deliveryNotes: ss.DeliveryNotes,
    });
  }

  return newRun;
}

// ============================================================================
// Documents - Delivery Notes + Invoices (separated per company)
// ============================================================================

function ensureDocsStore() {
  const s = ensureWavesStore();
  if (!s.deliveryNotes) { s.deliveryNotes = []; s.nextDeliveryNoteId = 1; }
  if (!s.invoices) { s.invoices = []; s.nextInvoiceId = 1; }
  return s;
}

/**
 * Generate Delivery Notes for a stop - one per (Company, Customer).
 * Critical: groups orders properly so each company gets its own DN.
 */
export function generateDeliveryNotesForStop(stopId, options = {}) {
  const s = ensureDocsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return null;

  const stopOrders = s.runOrders.filter((o) => o.StopId === stop.StopId);
  if (stopOrders.length === 0) return [];

  const groups = new Map();
  for (const order of stopOrders) {
    if (order.Status === 'CANCELLED') continue;
    const key = `${order.CompanyCode}|${order.SapCardCode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        CompanyCode: order.CompanyCode,
        CompanyName: order.CompanyName,
        SapCardCode: order.SapCardCode,
        SapCardName: order.SapCardName,
        orders: [],
      });
    }
    groups.get(key).orders.push(order);
  }

  const generated = [];
  for (const group of groups.values()) {
    const existing = s.deliveryNotes.find((dn) =>
      dn.StopId === stop.StopId &&
      dn.CompanyCode === group.CompanyCode &&
      dn.SapCardCode === group.SapCardCode &&
      dn.Status !== 'CANCELLED'
    );
    if (existing && !options.regenerate) {
      generated.push(existing);
      continue;
    }

    const dn = {
      DeliveryNoteId: s.nextDeliveryNoteId++,
      DocNumber: `DN-${stop.StopId}-${group.CompanyCode}-${String(s.nextDeliveryNoteId).padStart(4, '0')}`,
      StopId: stop.StopId,
      RunId: stop.RunId,
      CompanyCode: group.CompanyCode,
      CompanyName: group.CompanyName,
      SapCardCode: group.SapCardCode,
      SapCardName: group.SapCardName,
      SourceOrders: group.orders.map((o) => ({
        RunOrderId: o.RunOrderId,
        SapDocEntry: o.SapDocEntry,
        SapDocNum: o.SapDocNum,
        OrderTotal: o.OrderTotal,
        LinesCount: o.LinesCount,
      })),
      TotalAmount: group.orders.reduce((sum, o) => sum + Number(o.OrderTotal || 0), 0),
      LineCount: group.orders.reduce((sum, o) => sum + Number(o.LinesCount || 0), 0),
      Status: 'PENDING_EXPORT',
      SapDeliveryDocEntry: null,
      SapDeliveryDocNum: null,
      ExportedAt: null,
      SentToSapAt: null,
      ConfirmedAt: null,
      ErrorMessage: null,
      Notes: stop.Notes || null,
      Address: {
        Street: stop.Street, BuildingNumber: stop.BuildingNumber, City: stop.City,
        BranchName: stop.BranchName,
      },
      DeliveryDate: new Date().toISOString().slice(0, 10),
      CreatedAt: new Date().toISOString(),
      Method: options.method || 'AUTO',
    };
    s.deliveryNotes.push(dn);
    generated.push(dn);
  }
  save();
  return generated;
}

export function generateInvoiceFromDeliveryNote(deliveryNoteId, options = {}) {
  const s = ensureDocsStore();
  const dn = s.deliveryNotes.find((d) => d.DeliveryNoteId === Number(deliveryNoteId));
  if (!dn) return null;
  const existing = s.invoices.find((inv) =>
    inv.DeliveryNoteId === dn.DeliveryNoteId && inv.Status !== 'CANCELLED'
  );
  if (existing && !options.regenerate) return existing;

  const invoice = {
    InvoiceId: s.nextInvoiceId++,
    DocNumber: `INV-${dn.StopId}-${dn.CompanyCode}-${String(s.nextInvoiceId).padStart(4, '0')}`,
    DeliveryNoteId: dn.DeliveryNoteId,
    RunId: dn.RunId,
    StopId: dn.StopId,
    CompanyCode: dn.CompanyCode,
    CompanyName: dn.CompanyName,
    SapCardCode: dn.SapCardCode,
    SapCardName: dn.SapCardName,
    TotalAmount: dn.TotalAmount,
    VatAmount: Number((dn.TotalAmount * 0.17).toFixed(2)),
    GrossAmount: Number((dn.TotalAmount * 1.17).toFixed(2)),
    LineCount: dn.LineCount,
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapInvoiceDocNum: null,
    ExportedAt: null,
    SentToSapAt: null,
    ConfirmedAt: null,
    ErrorMessage: null,
    InvoiceDate: new Date().toISOString().slice(0, 10),
    CreatedAt: new Date().toISOString(),
    Method: options.method || 'AUTO',
  };
  s.invoices.push(invoice);
  save();
  return invoice;
}

export function generateInvoicesForRun(runId) {
  const s = ensureDocsStore();
  const dns = s.deliveryNotes.filter((d) => d.RunId === Number(runId) && d.Status !== 'CANCELLED');
  const invoices = [];
  for (const dn of dns) {
    const inv = generateInvoiceFromDeliveryNote(dn.DeliveryNoteId);
    if (inv) invoices.push(inv);
  }
  return invoices;
}

export function markDocsExported(docIds, type = 'deliveryNote') {
  const s = ensureDocsStore();
  const collection = type === 'invoice' ? s.invoices : s.deliveryNotes;
  const ids = docIds.map(Number);
  for (const doc of collection) {
    if (ids.includes(doc[type === 'invoice' ? 'InvoiceId' : 'DeliveryNoteId'])) {
      doc.Status = 'EXPORTED';
      doc.ExportedAt = new Date().toISOString();
    }
  }
  save();
}

export function confirmSapDocument(docId, type, sapDocEntry, sapDocNum) {
  const s = ensureDocsStore();
  if (type === 'deliveryNote') {
    const dn = s.deliveryNotes.find((d) => d.DeliveryNoteId === Number(docId));
    if (!dn) return null;
    dn.Status = 'SAP_CONFIRMED';
    dn.SapDeliveryDocEntry = sapDocEntry;
    dn.SapDeliveryDocNum = sapDocNum;
    dn.ConfirmedAt = new Date().toISOString();
    save();
    return dn;
  } else {
    const inv = s.invoices.find((d) => d.InvoiceId === Number(docId));
    if (!inv) return null;
    inv.Status = 'SAP_CONFIRMED';
    inv.SapInvoiceDocEntry = sapDocEntry;
    inv.SapInvoiceDocNum = sapDocNum;
    inv.ConfirmedAt = new Date().toISOString();
    save();
    return inv;
  }
}

export function listDeliveryNotes({ runId, stopId, companyCode, status, runDate } = {}) {
  const s = ensureDocsStore();
  let result = [...s.deliveryNotes];
  if (runId) result = result.filter((d) => d.RunId === Number(runId));
  if (stopId) result = result.filter((d) => d.StopId === Number(stopId));
  if (companyCode) result = result.filter((d) => d.CompanyCode === companyCode);
  if (status) result = result.filter((d) => d.Status === status);
  if (runDate) {
    const runIds = s.runs.filter((r) => r.RunDate === runDate).map((r) => r.RunId);
    result = result.filter((d) => runIds.includes(d.RunId));
  }
  return result.sort((a, b) => b.DeliveryNoteId - a.DeliveryNoteId);
}

export function listInvoices({ runId, stopId, companyCode, status, runDate } = {}) {
  const s = ensureDocsStore();
  let result = [...s.invoices];
  if (runId) result = result.filter((d) => d.RunId === Number(runId));
  if (stopId) result = result.filter((d) => d.StopId === Number(stopId));
  if (companyCode) result = result.filter((d) => d.CompanyCode === companyCode);
  if (status) result = result.filter((d) => d.Status === status);
  if (runDate) {
    const runIds = s.runs.filter((r) => r.RunDate === runDate).map((r) => r.RunId);
    result = result.filter((d) => runIds.includes(d.RunId));
  }
  return result.sort((a, b) => b.InvoiceId - a.InvoiceId);
}

export function getDocumentStats({ runDate } = {}) {
  const s = ensureDocsStore();
  const filterByDate = (docs) => {
    if (!runDate) return docs;
    const runIds = s.runs.filter((r) => r.RunDate === runDate).map((r) => r.RunId);
    return docs.filter((d) => runIds.includes(d.RunId));
  };

  const dns = filterByDate(s.deliveryNotes);
  const invs = filterByDate(s.invoices);

  return {
    deliveryNotes: {
      total: dns.length,
      byCompany: {
        A: dns.filter((d) => d.CompanyCode === 'A').length,
        B: dns.filter((d) => d.CompanyCode === 'B').length,
      },
      byStatus: {
        pendingExport: dns.filter((d) => d.Status === 'PENDING_EXPORT').length,
        exported: dns.filter((d) => d.Status === 'EXPORTED').length,
        confirmed: dns.filter((d) => d.Status === 'SAP_CONFIRMED').length,
        failed: dns.filter((d) => d.Status === 'FAILED').length,
      },
      totalAmount: dns.reduce((sum, d) => sum + Number(d.TotalAmount || 0), 0),
    },
    invoices: {
      total: invs.length,
      byCompany: {
        A: invs.filter((d) => d.CompanyCode === 'A').length,
        B: invs.filter((d) => d.CompanyCode === 'B').length,
      },
      byStatus: {
        pendingExport: invs.filter((d) => d.Status === 'PENDING_EXPORT').length,
        exported: invs.filter((d) => d.Status === 'EXPORTED').length,
        confirmed: invs.filter((d) => d.Status === 'SAP_CONFIRMED').length,
      },
      totalAmount: invs.reduce((sum, d) => sum + Number(d.TotalAmount || 0), 0),
      vatAmount: invs.reduce((sum, d) => sum + Number(d.VatAmount || 0), 0),
      grossAmount: invs.reduce((sum, d) => sum + Number(d.GrossAmount || 0), 0),
    },
  };
}

// =====================================================================
// Customer Delivery Profiles — loaded from OIG + UNICO master xlsx via
// scripts/load_customer_profiles.py. Each profile carries the canonical
// zone, optional sub-zone, and the customer's weekly delivery days.
// =====================================================================
function _profiles() {
  return load().customerDeliveryProfiles || [];
}

/** Return all profiles, optionally filtered. */
export function getCustomerProfiles({ zone, day, company, issue } = {}) {
  let rows = _profiles();
  if (zone)    rows = rows.filter((p) => p.Zone === zone);
  if (company) rows = rows.filter((p) => p.Company === company);
  if (day)     rows = rows.filter((p) => Array.isArray(p.DeliveryDays) && p.DeliveryDays.includes(day));
  if (issue === 'true')  rows = rows.filter((p) => !!p.Issue);
  if (issue === 'false') rows = rows.filter((p) => !p.Issue);
  return rows;
}

/** Find a single profile by CardCode (+ optional Company disambiguation). */
export function getCustomerProfile(cardCode, company) {
  const key = String(cardCode || '').trim();
  if (!key) return null;
  const rows = _profiles().filter((p) => String(p.CardCode) === key);
  if (rows.length === 0) return null;
  if (company) {
    const exact = rows.find((p) => p.Company === company);
    if (exact) return exact;
  }
  return rows[0];
}

/** Update the DocPolicy of a single profile. Returns the updated profile or null. */
const ALLOWED_POLICY_VALUES = new Set(['yes', 'no', 'na', '']);
const POLICY_KEYS = ['perOrderDeliveryNote', 'perOrderInvoice', 'aggregateDeliveryNote', 'aggregateInvoice'];

export function setCustomerProfilePolicy(cardCode, company, patch) {
  const key = String(cardCode || '').trim();
  if (!key) return null;
  const data = load();
  const rows = (data.customerDeliveryProfiles || []).filter((p) => String(p.CardCode) === key);
  if (rows.length === 0) return null;
  const target = (company && rows.find((p) => p.Company === company)) || rows[0];

  if (!target.DocPolicy) {
    target.DocPolicy = { perOrderDeliveryNote: '', perOrderInvoice: '', aggregateDeliveryNote: '', aggregateInvoice: '', notes: '' };
  }
  for (const k of POLICY_KEYS) {
    if (k in (patch || {})) {
      const v = String(patch[k] || '').toLowerCase();
      if (!ALLOWED_POLICY_VALUES.has(v)) {
        const err = new Error(`Invalid value for ${k}: ${patch[k]}. Allowed: yes/no/na/empty`);
        err.status = 400;
        throw err;
      }
      target.DocPolicy[k] = v;
    }
  }
  if (typeof patch?.notes === 'string') {
    target.DocPolicy.notes = patch.notes.slice(0, 500);
  }
  target.DocPolicy.updatedAt = new Date().toISOString();
  save();
  return target;
}

/** Summary counts by zone / day / issue rate, for the planning dashboard. */
export function getCustomerProfileStats() {
  const rows = _profiles();
  const byZone = {};
  const byDay  = {};
  const byCompany = {};
  let issues = 0;
  for (const p of rows) {
    if (p.Issue) { issues++; continue; }
    byZone[p.Zone] = (byZone[p.Zone] || 0) + 1;
    byCompany[p.Company] = (byCompany[p.Company] || 0) + 1;
    for (const d of (p.DeliveryDays || [])) {
      byDay[d] = (byDay[d] || 0) + 1;
    }
  }
  return { total: rows.length, withIssues: issues, byZone, byDay, byCompany };
}
