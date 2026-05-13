/**
 * Update drivers master data per Izik (2026-05-13):
 *   Driver 1: דניאל → קבלן     | plate: 12-345-67 → מתחלף
 *   Driver 2: אוסובאלו → אסובלו | plate: 89-876-54 → 621-76-704
 *   Driver 3: נתנאל (unchanged) | plate: (empty)   → 492-95-304
 *
 * DriverId preserved so existing run/stop foreign keys remain valid.
 */
const fs = require('fs');
const path = './backend/data/store.json';
const s = JSON.parse(fs.readFileSync(path, 'utf8'));

const updates = {
  1: { FullName: 'קבלן',   VehiclePlate: 'מתחלף'      },
  2: { FullName: 'אסובלו', VehiclePlate: '621-76-704' },
  3: { FullName: 'נתנאל',  VehiclePlate: '492-95-304' },
};

let changed = 0;
for (const d of s.drivers) {
  const u = updates[d.DriverId];
  if (!u) continue;
  const before = { FullName: d.FullName, VehiclePlate: d.VehiclePlate };
  Object.assign(d, u);
  changed++;
  console.log('DriverId=' + d.DriverId + '  BEFORE=' + JSON.stringify(before) + '  AFTER=' + JSON.stringify({ FullName: d.FullName, VehiclePlate: d.VehiclePlate }));
}

fs.writeFileSync(path, JSON.stringify(s, null, 2));
console.log('updated ' + changed + ' drivers');

// Verify
const v = JSON.parse(fs.readFileSync(path, 'utf8'));
console.log('\nVerify:');
for (const d of v.drivers) {
  console.log('  ' + d.DriverId + ' | ' + d.FullName + ' | plate=' + d.VehiclePlate + ' | zones=' + d.Zones);
}
