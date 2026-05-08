/**
 * Tests for address normalizer - the single most critical piece of logic.
 * If this fails, orders from A/B won't merge and the entire system breaks.
 *
 * Run with: node --test src/services/addressNormalizer.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeAddress, addressSimilarity } from './addressNormalizer.js';

describe('normalizeAddress', () => {
  test('normalizes simple Hebrew street', () => {
    const result = normalizeAddress({
      street: 'הרצל',
      buildingNumber: '45',
      city: 'תל אביב',
    });
    assert.equal(result.street, 'הרצל');
    assert.equal(result.buildingNumber, '45');
    assert.equal(result.city, 'תל אביב');
    assert.ok(result.normalizedKey);
  });

  test('extracts building number from street', () => {
    const result = normalizeAddress({
      street: 'הרצל 45',
      city: 'תל אביב',
    });
    assert.equal(result.street, 'הרצל');
    assert.equal(result.buildingNumber, '45');
  });

  test('normalizes street type abbreviations', () => {
    const a = normalizeAddress({ street: "רחוב הרצל 10", city: 'חיפה' });
    const b = normalizeAddress({ street: "רח' הרצל 10", city: 'חיפה' });
    const c = normalizeAddress({ street: 'רח הרצל 10', city: 'חיפה' });

    assert.equal(a.normalizedKey, b.normalizedKey, 'full and abbreviated "רחוב" should match');
    assert.equal(b.normalizedKey, c.normalizedKey, 'variations of רח should all match');
  });

  test('normalizes city name variants', () => {
    const a = normalizeAddress({ street: 'הרצל 10', city: 'תל אביב' });
    const b = normalizeAddress({ street: 'הרצל 10', city: 'תל-אביב' });
    const c = normalizeAddress({ street: 'הרצל 10', city: 'ת"א' });
    const d = normalizeAddress({ street: 'הרצל 10', city: 'תא' });

    assert.equal(a.normalizedKey, b.normalizedKey, 'spaces vs hyphen');
    assert.equal(a.normalizedKey, c.normalizedKey, 'quotes abbreviation');
    assert.equal(a.normalizedKey, d.normalizedKey, 'short abbreviation');
  });

  test('normalizes באר שבע variants', () => {
    const a = normalizeAddress({ street: 'בן גוריון 5', city: 'באר שבע' });
    const b = normalizeAddress({ street: 'בן גוריון 5', city: 'באר-שבע' });
    const c = normalizeAddress({ street: 'בן גוריון 5', city: 'ב"ש' });
    assert.equal(a.normalizedKey, b.normalizedKey);
    assert.equal(a.normalizedKey, c.normalizedKey);
  });

  test('different addresses produce different keys', () => {
    const a = normalizeAddress({ street: 'הרצל 10', city: 'תל אביב' });
    const b = normalizeAddress({ street: 'הרצל 20', city: 'תל אביב' });
    const c = normalizeAddress({ street: 'דיזנגוף 10', city: 'תל אביב' });
    const d = normalizeAddress({ street: 'הרצל 10', city: 'חיפה' });

    assert.notEqual(a.normalizedKey, b.normalizedKey, 'different numbers');
    assert.notEqual(a.normalizedKey, c.normalizedKey, 'different streets');
    assert.notEqual(a.normalizedKey, d.normalizedKey, 'different cities');
  });

  test('handles empty / null input gracefully', () => {
    const a = normalizeAddress({});
    assert.equal(a.normalizedKey, '');

    const b = normalizeAddress({ street: null, city: null });
    assert.equal(b.normalizedKey, '');
  });

  test('zip code provides strong match signal', () => {
    const a = normalizeAddress({ street: 'הרצל', buildingNumber: '10', city: 'ת"א', zipCode: '6100000' });
    const b = normalizeAddress({ street: 'הרצל', buildingNumber: '10', city: 'תל אביב', zipCode: '6100000' });
    assert.equal(a.normalizedKey, b.normalizedKey);
  });

  test('strips quotes and special punctuation', () => {
    const a = normalizeAddress({ street: 'ד"ר הרצל', buildingNumber: '10', city: 'ת"א' });
    const b = normalizeAddress({ street: 'דר הרצל', buildingNumber: '10', city: 'תא' });
    assert.equal(a.normalizedKey, b.normalizedKey);
  });
});

describe('addressSimilarity', () => {
  test('identical addresses score 1.0', () => {
    const a = { street: 'הרצל', buildingNumber: '10', city: 'תל אביב' };
    assert.equal(addressSimilarity(a, a), 1);
  });

  test('different cities score 0', () => {
    const a = { street: 'הרצל', buildingNumber: '10', city: 'תל אביב' };
    const b = { street: 'הרצל', buildingNumber: '10', city: 'חיפה' };
    assert.equal(addressSimilarity(a, b), 0);
  });

  test('same street different number has partial score', () => {
    const a = { street: 'הרצל', buildingNumber: '10', city: 'תל אביב' };
    const b = { street: 'הרצל', buildingNumber: '15', city: 'תל אביב' };
    const score = addressSimilarity(a, b);
    assert.ok(score > 0 && score < 1, `expected partial score, got ${score}`);
  });

  test('substring street names match partially', () => {
    const a = { street: 'הרצל הנשיא', buildingNumber: '10', city: 'תל אביב' };
    const b = { street: 'הרצל', buildingNumber: '10', city: 'תל אביב' };
    const score = addressSimilarity(a, b);
    assert.ok(score > 0.5, `expected high similarity, got ${score}`);
  });
});
