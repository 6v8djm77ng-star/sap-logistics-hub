/**
 * Local file storage for signatures and delivery photos.
 *
 * Signature = base64 data URL from mobile canvas -> saved as PNG
 * Photo     = base64 data URL from camera         -> saved as JPG
 *
 * Files live under backend/uploads/YYYY/MM/DD/<uuid>.ext
 * Served statically at /uploads/... (see server.js)
 *
 * For production with multiple servers, swap this out for S3/Azure Blob.
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { apiLogger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');

// Whitelist raster image types only. SVG is excluded — it's an XML format that
// can carry inline <script>/<foreignObject> JS, which would execute when the
// uploaded file is later rendered in a browser context (e.g. signed receipts
// re-displayed inside the dashboard).
const ALLOWED_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
};

// Hard cap on uploaded file size after base64 decode. Mobile photos cap at
// ~6MB; signature canvas data URLs are ~50KB. 10MB is a safe upper bound.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function todayPath() {
  const now = new Date();
  return path.join(
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
}

/**
 * Save a base64 data URL to disk. Returns a URL path like /uploads/...
 */
export async function saveDataUrl(dataUrl, { prefix = 'file', category = 'misc' } = {}) {
  if (!dataUrl?.startsWith('data:')) {
    throw new Error('Invalid data URL');
  }
  // Capture the raw mime type so the whitelist check sees `image/jpeg` not just `jpeg`.
  const match = dataUrl.match(/^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/);
  if (!match) throw new Error('Only base64 data URLs supported');

  const [, mimeType, base64] = match;
  const ext = ALLOWED_MIME_EXT[mimeType.toLowerCase()];
  if (!ext) {
    apiLogger.warn('Rejected upload with disallowed MIME type', { mimeType, prefix, category });
    throw Object.assign(new Error('Unsupported file type'), { status: 400 });
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_FILE_BYTES) {
    apiLogger.warn('Rejected oversized upload', { size: buffer.length, prefix, category });
    throw Object.assign(new Error('File too large (max 10MB)'), { status: 413 });
  }

  // Defense-in-depth: reject if category contains path separators that could
  // escape UPLOADS_ROOT (caller should not pass user-controlled categories,
  // but enforce anyway).
  if (category.includes('/') || category.includes('\\') || category.includes('..')) {
    throw new Error('Invalid category');
  }

  const dateDir = todayPath();
  const dir = path.join(UPLOADS_ROOT, category, dateDir);
  await fs.mkdir(dir, { recursive: true });

  const filename = `${prefix}-${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(dir, filename);
  await fs.writeFile(filepath, buffer);

  const urlPath = `/uploads/${category}/${dateDir.split(path.sep).join('/')}/${filename}`;
  apiLogger.info('File saved', { urlPath, size: buffer.length });
  return urlPath;
}

export { UPLOADS_ROOT };
