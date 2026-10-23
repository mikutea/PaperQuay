import { createRequire } from 'node:module';

// Only provisions the fresh loopback PostgreSQL service used by this CI job.
// Refuses existing roles/databases so it cannot silently rewrite another setup.
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client, escapeLiteral } = require('pg');
function connection(name, expectedUser, expectedDatabase) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || decodeURIComponent(url.username) !== expectedUser || url.pathname !== `/${expectedDatabase}`
    || url.search || url.hash) throw new Error('Refusing a non-isolated test database connection.');
  return { value, url, password: decodeURIComponent(url.password) };
}
const admin = connection('PAPERQUAY_TEST_ADMIN_DATABASE_URL', 'postgres', 'postgres');
const migration = connection('PAPERQUAY_MIGRATION_DATABASE_URL', 'paperquay_migrate', 'paperquay_sync_test');
const runtime = connection('PAPERQUAY_DATABASE_URL', 'paperquay_runtime', 'paperquay_sync_test');
if (migration.url.port !== admin.url.port || runtime.url.port !== admin.url.port
  || migration.password.length < 16 || runtime.password.length < 16) {
  throw new Error('The disposable test role settings are invalid.');
}
const client = new Client({ connectionString: admin.value });
await client.connect();
try {
  const roles = await client.query("SELECT 1 FROM pg_roles WHERE rolname IN ('paperquay_migrate', 'paperquay_runtime')");
  const databases = await client.query("SELECT 1 FROM pg_database WHERE datname = 'paperquay_sync_test'");
  if (roles.rowCount || databases.rowCount) throw new Error('Refusing to modify existing test roles or database.');
  for (const [name, password] of [['paperquay_migrate', migration.password], ['paperquay_runtime', runtime.password]]) {
    await client.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
  }
  await client.query('CREATE DATABASE paperquay_sync_test OWNER paperquay_migrate');
  console.log('Created isolated test database and unprivileged application roles.');
} finally {
  await client.end();
}
