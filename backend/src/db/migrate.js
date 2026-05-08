/**
 * Simple migration runner - executes SQL files in /database/migrations in order.
 * Tracks applied migrations in a table to prevent re-running.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import sql from 'mssql';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { dbLogger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../../database/migrations');

// Connect to master first (to create DB if needed), then switch to logistics DB
async function connect(database = 'master') {
  const pool = new sql.ConnectionPool({
    user: env.LOGISTICS_SQL_USER,
    password: env.LOGISTICS_SQL_PASSWORD,
    server: env.LOGISTICS_SQL_HOST,
    port: env.LOGISTICS_SQL_PORT,
    database,
    options: {
      encrypt: env.LOGISTICS_SQL_ENCRYPT,
      trustServerCertificate: env.LOGISTICS_SQL_TRUST_SERVER_CERT,
    },
  });
  await pool.connect();
  return pool;
}

async function ensureMigrationTable(pool) {
  await pool.request().batch(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '_Migrations')
    CREATE TABLE dbo._Migrations (
      MigrationId INT IDENTITY(1,1) PRIMARY KEY,
      Filename    VARCHAR(255) NOT NULL UNIQUE,
      AppliedAt   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
}

async function getApplied(pool) {
  const res = await pool.request().query('SELECT Filename FROM dbo._Migrations');
  return new Set(res.recordset.map((r) => r.Filename));
}

async function runMigration(pool, filename, content) {
  // SQL Server requires GO to be handled by client - split into batches
  const batches = content
    .split(/^\s*GO\s*$/gim)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  for (const batch of batches) {
    await pool.request().batch(batch);
  }

  await pool.request().input('fn', filename).query(`
    INSERT INTO dbo._Migrations (Filename) VALUES (@fn)
  `);
}

async function main() {
  // 1. Connect to master, create DB if needed
  dbLogger.info('Connecting to master to ensure DB exists...');
  const masterPool = await connect('master');
  await masterPool.request().batch(`
    IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = '${env.LOGISTICS_SQL_DB}')
      CREATE DATABASE ${env.LOGISTICS_SQL_DB};
  `);
  await masterPool.close();
  dbLogger.info(`Database ${env.LOGISTICS_SQL_DB} is ready`);

  // 2. Connect to logistics DB
  const pool = await connect(env.LOGISTICS_SQL_DB);
  await ensureMigrationTable(pool);
  const applied = await getApplied(pool);

  // 3. Run pending migrations
  const files = (await fs.readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      dbLogger.info(`⏭  Skipping ${file} (already applied)`);
      continue;
    }
    dbLogger.info(`▶  Running ${file}`);
    const content = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await runMigration(pool, file, content);
    dbLogger.info(`✓  Applied ${file}`);
    ran++;
  }

  // 4. Post-migration: hash admin password properly
  const adminHash = await bcrypt.hash('admin123', 10);
  await pool.request().input('hash', adminHash).query(`
    UPDATE dbo.Users
    SET PasswordHash = @hash
    WHERE Username = 'admin' AND PasswordHash LIKE '$2a$10$YourHash%'
  `);

  await pool.close();
  dbLogger.info(`Done. ${ran} migration(s) applied.`);
}

main().catch((err) => {
  dbLogger.error('Migration failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
