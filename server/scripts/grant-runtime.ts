import { readFile } from 'node:fs/promises';
import pg from 'pg';

// Explicit setup command for the fixed reference role. It is never called by
// normal startup or migrations and does not create roles or change passwords.
const connectionString = process.env.PAPERQUAY_MIGRATION_DATABASE_URL;
if (!connectionString) {
  process.stderr.write('MIGRATION_CONFIGURATION_REQUIRED\n');
  process.exitCode = 1;
} else {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(await readFile(new URL('../deploy/runtime-role.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
    process.stdout.write('Runtime grants applied to paperquay_runtime.\n');
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    process.stderr.write('RUNTIME_GRANT_FAILED\n');
    process.exitCode = 1;
  } finally { await client.end(); }
}
