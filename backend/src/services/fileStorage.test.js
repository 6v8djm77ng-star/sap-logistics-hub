/**
 * Security tests for fileStorage.saveDataUrl.
 *
 * The function is the only path by which untrusted base64 data URLs (signatures
 * and delivery photos uploaded from drivers' mobile devices) reach disk. The
 * tests below pin down the security guarantees:
 *  - SVG and other XML-payload formats are rejected (would execute as JS when
 *    the file is later served back to the dashboard).
 *  - Files larger than 10MB are rejected.
 *  - Non-data: URLs are rejected.
 *  - Path-traversal categories are rejected.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// fileStorage logs via the apiLogger which depends on env.js loading. Make
// sure it loads from the project's .env (which is already valid in dev).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(__dirname, '../..'));

const { saveDataUrl } = await import('./fileStorage.js');

// 1×1 PNG (89 bytes) base64-encoded.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('fileStorage.saveDataUrl - security', () => {
  test('rejects non-data URL', async () => {
    await assert.rejects(
      () => saveDataUrl('https://attacker.com/image.png', { category: 'photos' }),
      /Invalid data URL/,
    );
  });

  test('rejects SVG (XML can carry inline JS)', async () => {
    const svgPayload =
      'data:image/svg+xml;base64,' +
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    await assert.rejects(
      () => saveDataUrl(svgPayload, { category: 'photos' }),
      /Unsupported file type/,
    );
  });

  test('rejects HTML mime', async () => {
    const htmlPayload = 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
    await assert.rejects(
      () => saveDataUrl(htmlPayload, { category: 'photos' }),
      /Unsupported file type/,
    );
  });

  test('rejects gif (not in whitelist)', async () => {
    const gifPayload = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    await assert.rejects(
      () => saveDataUrl(gifPayload, { category: 'photos' }),
      /Unsupported file type/,
    );
  });

  test('accepts whitelisted PNG', async () => {
    const url = await saveDataUrl(TINY_PNG, { prefix: 'test', category: 'photos' });
    assert.match(url, /^\/uploads\/photos\/\d{4}\/\d{2}\/\d{2}\/test-[\w-]+\.png$/);
  });

  test('rejects files larger than 10MB', async () => {
    // Build an 11MB JPEG payload (zeros — content doesn't matter, size does).
    const eleven_mb = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    const big = `data:image/jpeg;base64,${eleven_mb}`;
    await assert.rejects(
      () => saveDataUrl(big, { category: 'photos' }),
      /File too large/,
    );
  });

  test('rejects path-traversal in category', async () => {
    await assert.rejects(
      () => saveDataUrl(TINY_PNG, { category: '../../etc' }),
      /Invalid category/,
    );
    await assert.rejects(
      () => saveDataUrl(TINY_PNG, { category: 'a/b' }),
      /Invalid category/,
    );
  });
});
