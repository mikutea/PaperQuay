import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';

/** Additive migrations only. No schema/database creation outside paperquay, no role management. */
export async function migrate(connectionString: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 });
  pool.on('error', () => undefined);
  let client: pg.PoolClient | undefined;
  const applied: string[] = [];
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query('SELECT pg_advisory_xact_lock(742715923, 1)');
    await client.query('CREATE SCHEMA IF NOT EXISTS paperquay');
    await client.query(`CREATE TABLE IF NOT EXISTS paperquay.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const files = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    const known = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM paperquay.schema_migrations ORDER BY version');
    const existing = new Map(known.rows.map((row) => [row.version, row.checksum]));
    if ([...existing.keys()].some((version) => !files.includes(version))) throw new Error('MIGRATION_VERSION_UNSUPPORTED');
    for (const version of files) {
      const source = (await readFile(resolve(directory, version), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(source).digest('hex');
      if (existing.has(version)) {
        if (existing.get(version) !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
        continue;
      }
      await client.query(source);
      await client.query('INSERT INTO paperquay.schema_migrations(version, checksum) VALUES ($1,$2)', [version, checksum]);
      applied.push(version);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.PAPERQUAY_MIGRATION_DATABASE_URL || process.env.PAPERQUAY_DATABASE_URL;
  if (!connectionString) {
    process.stderr.write('MIGRATION_CONFIGURATION_REQUIRED\n');
    process.exitCode = 1;
  } else {
    try {
      const applied = await migrate(connectionString);
      process.stdout.write(JSON.stringify({ status: 'ready', applied }) + '\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = ['MIGRATION_VERSION_UNSUPPORTED', 'MIGRATION_CHECKSUM_MISMATCH'].includes(message) ? message : 'MIGRATION_FAILED';
      process.stderr.write(code + '\n');
      process.exitCode = 1;
    }
  }
}
