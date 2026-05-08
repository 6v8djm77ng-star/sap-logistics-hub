/**
 * Creates the SAP_Logistics_Hub database on the SAP server.
 * Run: node create-logistics-db.js
 */
import 'dotenv/config';
import sql from 'mssql';

const HOST = process.env.SAP_SQL_HOST;
const USER = process.env.SAP_SQL_USER;
const PASSWORD = process.env.SAP_SQL_PASSWORD;
const DB_NAME = process.env.LOGISTICS_SQL_DB || 'SAP_Logistics_Hub';

async function main() {
  console.log(`\nChecking access to create database on ${HOST}...\n`);

  // Connect to master DB
  const masterPool = new sql.ConnectionPool({
    user: USER,
    password: PASSWORD,
    server: HOST,
    database: 'master',
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 5000,
  });

  try {
    await masterPool.connect();
    console.log(`[OK] Connected to master as '${USER}'`);

    // Check if our user has CREATE DATABASE permission
    const permCheck = await masterPool.request().query(`
      SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE DATABASE') AS CanCreateDb
    `);
    const canCreate = permCheck.recordset[0].CanCreateDb === 1;
    console.log(`  CREATE DATABASE permission: ${canCreate ? '[OK]' : '[NO]'}`);

    // Check if DB already exists
    const existsCheck = await masterPool.request()
      .input('name', DB_NAME)
      .query('SELECT name FROM sys.databases WHERE name = @name');

    if (existsCheck.recordset.length > 0) {
      console.log(`\n[INFO] Database '${DB_NAME}' already exists.`);
      await masterPool.close();
      return { existed: true };
    }

    if (!canCreate) {
      console.log(`\n[WARN] User '${USER}' lacks CREATE DATABASE permission.`);
      console.log(`\nOptions:`);
      console.log(`  1. Ask SQL admin to create DB '${DB_NAME}' manually`);
      console.log(`  2. Or use a different user with dbcreator role`);
      console.log(`\nManual creation SQL (run as admin):`);
      console.log(`  CREATE DATABASE [${DB_NAME}];`);
      console.log(`  ALTER DATABASE [${DB_NAME}] SET COMPATIBILITY_LEVEL = 150;`);
      console.log(`  USE [${DB_NAME}];`);
      console.log(`  EXEC sp_addrolemember 'db_owner', '${USER}';\n`);
      await masterPool.close();
      return { error: 'no-permission' };
    }

    // Try to create
    console.log(`\nCreating database '${DB_NAME}'...`);
    await masterPool.request().batch(`CREATE DATABASE [${DB_NAME}]`);
    console.log(`[OK] Database created!`);

    await masterPool.close();
    return { created: true };
  } catch (err) {
    console.log(`[ERROR] ${err.message}`);
    try { await masterPool.close(); } catch {}
    return { error: err.message };
  }
}

main().then((result) => {
  console.log(`\nResult: ${JSON.stringify(result)}`);
  process.exit(result.error ? 1 : 0);
}).catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
