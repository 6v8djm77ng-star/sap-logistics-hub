// Unit tests for orderPlanEval — pure helpers, no store/SAP/IO dependencies.
//
// Run:
//   cd backend && node --test src/demo/orderPlanEval.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePlanForOrder, hebrewDayFromDate, _HEBREW_DAYS } from './orderPlanEval.js';

test('hebrewDayFromDate: known dates map to correct Hebrew day', () => {
  // 2026-05-17 is Sunday → ראשון
  assert.equal(hebrewDayFromDate('2026-05-17'), 'ראשון');
  // 2026-05-18 is Monday → שני
  assert.equal(hebrewDayFromDate('2026-05-18'), 'שני');
  // 2026-05-22 is Friday → שישי
  assert.equal(hebrewDayFromDate('2026-05-22'), 'שישי');
});

test('hebrewDayFromDate: null/invalid → null', () => {
  assert.equal(hebrewDayFromDate(null), null);
  assert.equal(hebrewDayFromDate(''), null);
  assert.equal(hebrewDayFromDate('not-a-date'), null);
});

test('evaluatePlanForOrder: all criteria pass + delivery day matches → passes=true', () => {
  const r = evaluatePlanForOrder({
    order: { CompanyCode: 'A', DocEntry: 100, CardCode: '155', LinesCount: 5 },
    exclusionReasons: [],
    profile: { CardCode: '155', Company: 'OIG', DeliveryDays: ['ראשון', 'רביעי'], Zone: 'EILAT' },
    todayHebrew: 'ראשון',
    filters: { minCustomerTotal: 2000, minLinesPerOrder: 2, requireStock: true, applyDeliveryDay: true },
  });
  assert.equal(r.passes, true);
  assert.equal(r.customerTotalOK, true);
  assert.equal(r.linesCountOK, true);
  assert.equal(r.stockOK, true);
  assert.equal(r.deliveryDayOK, true);
  assert.deepEqual(r.deliveryDayExpected, ['ראשון', 'רביעי']);
  assert.equal(r.customerZone, 'EILAT');
  assert.equal(r.customerProfileExists, true);
});

test('evaluatePlanForOrder: delivery day mismatch → fails day only', () => {
  const r = evaluatePlanForOrder({
    order: { CompanyCode: 'A', DocEntry: 100, CardCode: '155', LinesCount: 5 },
    exclusionReasons: [],
    profile: { CardCode: '155', DeliveryDays: ['שני', 'חמישי'] },
    todayHebrew: 'ראשון',
    filters: { minCustomerTotal: 2000, minLinesPerOrder: 2, requireStock: true, applyDeliveryDay: true },
  });
  assert.equal(r.passes, false);
  assert.equal(r.customerTotalOK, true);
  assert.equal(r.linesCountOK, true);
  assert.equal(r.stockOK, true);
  assert.equal(r.deliveryDayOK, false);
  assert.equal(r.deliveryDayProfileMissing, false);
});

test('evaluatePlanForOrder: no customer profile → fails day check (deny-by-default)', () => {
  const r = evaluatePlanForOrder({
    order: { CompanyCode: 'A', DocEntry: 100, CardCode: '999', LinesCount: 5 },
    exclusionReasons: [],
    profile: null,
    todayHebrew: 'ראשון',
    filters: { minCustomerTotal: 2000, minLinesPerOrder: 2, requireStock: true, applyDeliveryDay: true },
  });
  assert.equal(r.passes, false);
  assert.equal(r.deliveryDayOK, false);
  assert.equal(r.deliveryDayProfileMissing, true);
  assert.equal(r.customerProfileExists, false);
});

test('evaluatePlanForOrder: applyDeliveryDay=false → day check skipped even without profile', () => {
  const r = evaluatePlanForOrder({
    order: { CompanyCode: 'A', DocEntry: 100, CardCode: '155', LinesCount: 5 },
    exclusionReasons: [],
    profile: null,
    todayHebrew: 'ראשון',
    filters: { minCustomerTotal: 2000, minLinesPerOrder: 2, requireStock: true, applyDeliveryDay: false },
  });
  assert.equal(r.passes, true);
  assert.equal(r.deliveryDayOK, true);
  assert.equal(r.deliveryDayApplied, false);
});

test('evaluatePlanForOrder: multiple criteria fail → all surface in flags', () => {
  const r = evaluatePlanForOrder({
    order: { CompanyCode: 'A', DocEntry: 100, CardCode: '155', LinesCount: 1 },
    exclusionReasons: [
      { type: 'low_total', total: 500, threshold: 2000, items: [] },
      { type: 'too_few_lines', linesCount: 1, threshold: 2, items: [] },
      { type: 'missing_stock', items: [{ itemCode: 'X', needed: 5, available: 0 }] },
    ],
    profile: { CardCode: '155', DeliveryDays: ['שני'] },
    todayHebrew: 'ראשון',
    filters: { minCustomerTotal: 2000, minLinesPerOrder: 2, requireStock: true, applyDeliveryDay: true },
  });
  assert.equal(r.passes, false);
  assert.equal(r.customerTotalOK, false);
  assert.equal(r.linesCountOK, false);
  assert.equal(r.stockOK, false);
  assert.equal(r.deliveryDayOK, false);
  assert.equal(r.customerTotalCurrent, 500);
  assert.equal(r.linesCountCurrent, 1);
  assert.equal(r.stockMissing.length, 1);
});

test('evaluatePlanForOrder: no_open_lines reason → linesCountOK=false, noOpenLines=true', () => {
  const r = evaluatePlanForOrder({
    order: { CompanyCode: 'A', DocEntry: 100, CardCode: '155', LinesCount: 3 },
    exclusionReasons: [{ type: 'no_open_lines', linesCount: 3, items: [] }],
    profile: { CardCode: '155', DeliveryDays: ['ראשון'] },
    todayHebrew: 'ראשון',
    filters: { minCustomerTotal: 2000, minLinesPerOrder: 2, requireStock: false, applyDeliveryDay: true },
  });
  assert.equal(r.passes, false);
  assert.equal(r.linesCountOK, false);
  assert.equal(r.noOpenLines, true);
  assert.equal(r.deliveryDayOK, true); // day matches; only lines fails
});

test('_HEBREW_DAYS: 7 days in correct order', () => {
  assert.equal(_HEBREW_DAYS.length, 7);
  assert.equal(_HEBREW_DAYS[0], 'ראשון');
  assert.equal(_HEBREW_DAYS[6], 'שבת');
});
