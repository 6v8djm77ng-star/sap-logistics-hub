/**
 * Tests for the numeric-integrity scanners shared by verified-data agents.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  normalizeNumberLiteral,
  collectVerifiedValueSet,
  findUnverifiedNumbers,
} from './verifiedNumbers.js';

describe('normalizeNumberLiteral', () => {
  test('thousands-grouped', () => {
    assert.equal(normalizeNumberLiteral('1,283,000'), 1283000);
    assert.equal(normalizeNumberLiteral('5,000'), 5000);
  });

  test('K/M/B suffixes', () => {
    assert.equal(normalizeNumberLiteral('1.28M'), 1280000);
    assert.equal(normalizeNumberLiteral('5K'), 5000);
    assert.equal(normalizeNumberLiteral('2B'), 2_000_000_000);
  });

  test('percent', () => {
    assert.equal(normalizeNumberLiteral('21%'), 21);
    assert.equal(normalizeNumberLiteral('25.6%'), 25.6);
  });
});

describe('collectVerifiedValueSet', () => {
  const verified = {
    metrics: [
      { id: 'revenue_last7_ils', value: 10500 },
      { id: 'top_customer_name', value: 'לקוח בדיקה' },
    ],
    anomalies: [
      {
        id: 'rev_drop_wow',
        description: 'Weekly revenue dropped 25%: 10500 ILS vs 14000 ILS',
        threshold_used: { drop_pct_threshold: 15, observed_pct: -25 },
      },
    ],
  };

  test('harvests metric values, description literals, and thresholds', () => {
    const { numbers, strings } = collectVerifiedValueSet(verified);
    assert.ok(numbers.has(10500));
    assert.ok(numbers.has(14000)); // from deterministic description
    assert.ok(numbers.has(25));    // percent literal in description
    assert.ok(numbers.has(15));    // threshold value
    assert.ok(strings.has('revenue_last7_ils'));
    assert.ok(strings.has('rev_drop_wow'));
    assert.ok(strings.has('לקוח בדיקה'));
  });
});

describe('findUnverifiedNumbers', () => {
  const numbers = new Set([10500, 25]);
  const strings = new Set(['rev_drop_2026-05-09']);

  test('verified numbers pass', () => {
    assert.deepEqual(findUnverifiedNumbers('ההכנסות היו 10,500 ש"ח', numbers, strings), []);
  });

  test('fabricated number is flagged', () => {
    const hits = findUnverifiedNumbers('ההכנסות היו 99,999 ש"ח', numbers, strings);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].normalized, 99999);
  });

  test('percent followed by Hebrew is scanned (boundary regression)', () => {
    const hits = findUnverifiedNumbers('ירידה של 37% בשבוע', numbers, strings);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].normalized, 37);
    assert.deepEqual(findUnverifiedNumbers('ירידה של 25% בשבוע', numbers, strings), []);
  });

  test('year-like 4-digit numbers are suppressed', () => {
    assert.deepEqual(findUnverifiedNumbers('בשנת 2026 נמשכה המגמה', numbers, strings), []);
  });

  test('numbers inside verified identifiers are suppressed', () => {
    assert.deepEqual(
      findUnverifiedNumbers('החריגה rev_drop_2026-05-09 חמורה', numbers, strings),
      []
    );
  });
});
