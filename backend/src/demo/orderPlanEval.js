// Pure helpers for evaluating each open order against the daily-planning
// criteria, surfaced per-criterion so the UI can show "passed/failed by X".
// No SAP, no store, no I/O — wrappers in demoServer.js handle data fetching.
'use strict';

const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// Parses YYYY-MM-DD as UTC noon (avoids the midnight DST/TZ edge cases that
// flip the JS Date day back and forth across IL ↔ UTC).
export function hebrewDayFromDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d.getTime())) return null;
  return HEBREW_DAYS[d.getDay()];
}

// Per-order eval combining the existing computePlanExclusions reasons with
// a delivery-day check from customerDeliveryProfiles.DeliveryDays.
//
// deliveryDayOK semantics: when applyDeliveryDay=true,
//   - profile exists + today is in DeliveryDays → OK
//   - profile missing OR DeliveryDays empty/missing → FAIL (deny-by-default)
//   - operator can disable the day check by passing applyDeliveryDay=false
export function evaluatePlanForOrder({
  order,
  exclusionReasons = [],
  customerTotal = null,
  profile = null,
  todayHebrew,
  filters = {},
}) {
  const applyDeliveryDay = filters.applyDeliveryDay !== false;

  const failsCustomerTotal = exclusionReasons.find((r) => r && r.type === 'low_total');
  const failsNoOpenLines   = exclusionReasons.find((r) => r && r.type === 'no_open_lines');
  const failsStock         = exclusionReasons.find((r) => r && r.type === 'missing_stock');

  const customerTotalOK = !failsCustomerTotal;
  const hasOpenLines    = !failsNoOpenLines;
  const stockOK         = !failsStock;

  // (2026-05-27) Always surface the customer's aggregate total so the UI
  // can tooltip "סך לקוח: ₪X,XXX" on every row — passing or failing.
  // Previously the field was only populated on failure, which made
  // passing rows look opaque (why is ₪525 "עובר" with sף ₪3,000? because
  // the *customer's* total is ₪4,500). The wrapper computes it.
  const effectiveCustomerTotal =
    customerTotal != null ? customerTotal : (failsCustomerTotal?.total ?? null);

  let deliveryDayOK = true;
  let deliveryDayExpected = null;
  let deliveryDayProfileMissing = false;
  if (applyDeliveryDay) {
    if (profile && Array.isArray(profile.DeliveryDays) && profile.DeliveryDays.length > 0) {
      deliveryDayExpected = profile.DeliveryDays.slice();
      deliveryDayOK = profile.DeliveryDays.includes(todayHebrew);
    } else {
      deliveryDayOK = false;
      deliveryDayProfileMissing = !profile;
      deliveryDayExpected = profile?.DeliveryDays || [];
    }
  }

  const passes = customerTotalOK && hasOpenLines && stockOK && deliveryDayOK;

  return {
    passes,
    customerTotalOK,
    customerTotalCurrent: effectiveCustomerTotal,
    customerTotalThreshold: filters.minCustomerTotal ?? null,
    hasOpenLines,
    noOpenLines: !!failsNoOpenLines,
    stockOK,
    stockMissing: failsStock?.items || null,
    deliveryDayOK,
    deliveryDayApplied: applyDeliveryDay,
    deliveryDayToday: todayHebrew || null,
    deliveryDayExpected,
    deliveryDayProfileMissing,
    customerProfileExists: !!profile,
    customerZone: profile?.Zone || null,
  };
}

export const _HEBREW_DAYS = HEBREW_DAYS;
