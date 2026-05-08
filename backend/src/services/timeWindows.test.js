/**
 * Tests for time window validation - critical for retail chain deliveries.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isDeliveryAllowed, formatWindow, hasTimeRestrictions } from './timeWindows.js';

describe('isDeliveryAllowed', () => {
  test('no restrictions = always allowed', () => {
    const result = isDeliveryAllowed({});
    assert.equal(result.allowed, true);
  });

  test('within time window = allowed', () => {
    const address = {
      DeliveryWindowStart: '09:00:00',
      DeliveryWindowEnd: '17:00:00',
    };
    const at10am = new Date('2026-04-23T10:00:00');
    const result = isDeliveryAllowed(address, at10am);
    assert.equal(result.allowed, true);
  });

  test('before time window = blocked', () => {
    const address = {
      DeliveryWindowStart: '09:00:00',
      DeliveryWindowEnd: '11:00:00',
    };
    const at8am = new Date('2026-04-23T08:00:00');
    const result = isDeliveryAllowed(address, at8am);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /09:00-11:00/);
  });

  test('after time window = blocked', () => {
    const address = {
      DeliveryWindowStart: '09:00:00',
      DeliveryWindowEnd: '11:00:00',
    };
    const at2pm = new Date('2026-04-23T14:00:00');
    const result = isDeliveryAllowed(address, at2pm);
    assert.equal(result.allowed, false);
  });

  test('wrong day of week = blocked', () => {
    // 2026-04-23 is a Thursday (day 4)
    const address = { DeliveryDays: 'SUN,MON' };
    const onThursday = new Date('2026-04-23T10:00:00');
    const result = isDeliveryAllowed(address, onThursday);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /ימים/);
  });

  test('allowed day = allowed', () => {
    const address = { DeliveryDays: 'SUN,MON,TUE,WED,THU' };
    const onThursday = new Date('2026-04-23T10:00:00');
    const result = isDeliveryAllowed(address, onThursday);
    assert.equal(result.allowed, true);
  });

  test('combined day + time - both must pass', () => {
    const address = {
      DeliveryDays: 'SUN,MON,TUE,WED,THU',
      DeliveryWindowStart: '09:00:00',
      DeliveryWindowEnd: '11:00:00',
    };
    // Thursday 10am - both pass
    assert.equal(isDeliveryAllowed(address, new Date('2026-04-23T10:00:00')).allowed, true);
    // Thursday 8am - wrong time
    assert.equal(isDeliveryAllowed(address, new Date('2026-04-23T08:00:00')).allowed, false);
    // Friday 10am - wrong day (Friday = day 5)
    assert.equal(isDeliveryAllowed(address, new Date('2026-04-24T10:00:00')).allowed, false);
  });
});

describe('formatWindow', () => {
  test('empty → null', () => {
    assert.equal(formatWindow({}), null);
    assert.equal(formatWindow(null), null);
  });

  test('time only', () => {
    const result = formatWindow({
      DeliveryWindowStart: '09:00:00',
      DeliveryWindowEnd: '11:00:00',
    });
    assert.equal(result, '09:00-11:00');
  });

  test('days only', () => {
    const result = formatWindow({ DeliveryDays: 'SUN,MON,TUE' });
    assert.equal(result, 'ראשון, שני, שלישי');
  });

  test('both days and time', () => {
    const result = formatWindow({
      DeliveryDays: 'SUN,MON',
      DeliveryWindowStart: '09:00:00',
      DeliveryWindowEnd: '11:00:00',
    });
    assert.ok(result.includes('ראשון'));
    assert.ok(result.includes('09:00-11:00'));
  });
});

describe('hasTimeRestrictions', () => {
  test('no restrictions', () => {
    assert.equal(hasTimeRestrictions({}), false);
    assert.equal(hasTimeRestrictions(null), false);
  });

  test('has window', () => {
    assert.equal(hasTimeRestrictions({ DeliveryWindowStart: '09:00:00' }), true);
  });

  test('has days', () => {
    assert.equal(hasTimeRestrictions({ DeliveryDays: 'MON,TUE' }), true);
  });
});
