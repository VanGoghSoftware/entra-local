import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.js';
import { MIGRATIONS, runMigrations } from '../../src/store/migrations/index.js';
import { createStore } from '../../src/store/store.js';
import { buildTestApp } from '../helpers/buildTestApp.js';
import { TEST_TENANT_ID, TMP_DIR } from '../helpers/constants.js';

const EXPECTED_TABLES = [
  'schema_migrations',
  'tenants',
  'users',
  'groups',
  'group_members',
  'app_registrations',
  'app_redirect_uris',
  'app_secrets',
  'app_scopes',
  'app_roles',
  'signing_keys',
  'authorization_codes',
  'refresh_tokens',
  'sessions',
  'device_codes',
];

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function count(db: ReturnType<typeof openDatabase>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('store plugin: migrations (criterion 1)', () => {
  it('booting an empty DB creates all tables and records migration version 1', async () => {
    const ctx = await buildTestApp();
    try {
      const db = ctx.app.store.db;
      const names = tableNames(db);
      for (const t of EXPECTED_TABLES) expect(names).toContain(t);
      const versions = (
        db.prepare('SELECT version FROM schema_migrations').all() as {
          version: number;
        }[]
      ).map((r) => r.version);
      expect(versions).toEqual([1, 2, 3]);
    } finally {
      await ctx.close();
    }
  });

  it('a second boot against the same file is a no-op (idempotent)', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, `${randomUUID()}.db`);
    try {
      const db1 = openDatabase(dbPath);
      expect(runMigrations(db1, () => 1)).toEqual([1, 2, 3]);
      db1.close();

      const db2 = openDatabase(dbPath);
      expect(runMigrations(db2, () => 1)).toEqual([]); // already applied
      expect(tableNames(db2)).toContain('device_codes');
      db2.close();
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  it('migration 003 keeps the sign-in artefacts of a version-2 database and makes them follow their app and user', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, `${randomUUID()}.db`);
    try {
      const db = openDatabase(dbPath);
      // A database as an installation that has been signed in to left it: an app, a user, and the
      // code, refresh token and device code that sign-in produced.
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);`);
      for (const migration of MIGRATIONS.filter((m) => m.version <= 2)) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          migration.version,
          1,
        );
      }
      db.prepare(
        `INSERT INTO tenants (id, display_name, issuer, created_at) VALUES (?, 'T', 'iss', 1)`,
      ).run(TEST_TENANT_ID);
      db.prepare(
        `INSERT INTO users (id, tenant_id, user_principal_name, display_name, created_at)
         VALUES ('legacy-user', ?, 'legacy@example.test', 'Legacy User', 1)`,
      ).run(TEST_TENANT_ID);
      db.prepare(
        `INSERT INTO app_registrations (app_id, tenant_id, display_name, is_confidential, created_at)
         VALUES ('legacy-app', ?, 'Legacy', 0, 1)`,
      ).run(TEST_TENANT_ID);
      db.exec(`
        INSERT INTO authorization_codes (code, app_id, user_id, redirect_uri, scopes, expires_at, created_at)
          VALUES ('code-1', 'legacy-app', 'legacy-user', 'http://localhost/cb', 'openid', 9000000000000, 1);
        INSERT INTO refresh_tokens (token, app_id, user_id, scopes, expires_at, created_at)
          VALUES ('rt-1', 'legacy-app', 'legacy-user', 'openid', 9000000000000, 1);
        INSERT INTO device_codes (device_code, user_code, app_id, scopes, expires_at, created_at)
          VALUES ('dc-1', 'ABCD-EFGH', 'legacy-app', 'openid', 9000000000000, 1);
      `);

      expect(runMigrations(db, () => 2)).toEqual([3]);

      // Nothing was lost in the rebuild.
      expect(count(db, 'authorization_codes')).toBe(1);
      expect(count(db, 'refresh_tokens')).toBe(1);
      expect(count(db, 'device_codes')).toBe(1);

      // Every reference from a sign-in artefact to an app or a user now cascades.
      const cascades = (table: string) =>
        (
          db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
            from: string;
            on_delete: string;
          }[]
        )
          .filter((fk) => fk.from === 'app_id' || fk.from === 'user_id')
          .map((fk) => `${fk.from}:${fk.on_delete}`)
          .sort();
      expect(cascades('authorization_codes')).toEqual(['app_id:CASCADE', 'user_id:CASCADE']);
      expect(cascades('refresh_tokens')).toEqual(['app_id:CASCADE', 'user_id:CASCADE']);
      expect(cascades('device_codes')).toEqual(['app_id:CASCADE']);

      // And the deletes that used to fail with FOREIGN KEY constraint failed now take the rows along.
      db.prepare('DELETE FROM app_registrations WHERE app_id = ?').run('legacy-app');
      expect(count(db, 'authorization_codes')).toBe(0);
      expect(count(db, 'refresh_tokens')).toBe(0);
      expect(count(db, 'device_codes')).toBe(0);
      db.prepare('DELETE FROM users WHERE id = ?').run('legacy-user');
      db.close();
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});

describe('store plugin: pragmas (criterion 10)', () => {
  it('WAL journaling and foreign keys are active on the connection', async () => {
    const ctx = await buildTestApp();
    try {
      const db = ctx.app.store.db;
      const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(journal.journal_mode).toBe('wal');
      expect(fk.foreign_keys).toBe(1);
    } finally {
      await ctx.close();
    }
  });
});

describe('store plugin: seed determinism (criterion 3)', () => {
  it('seeds the exact fixed GUIDs and row counts on an empty DB', async () => {
    const ctx = await buildTestApp();
    try {
      const db = ctx.app.store.db;
      expect(count(db, 'tenants')).toBe(1);
      expect(count(db, 'users')).toBe(2);
      expect(count(db, 'groups')).toBe(4);
      expect(count(db, 'group_members')).toBe(6);
      expect(count(db, 'app_registrations')).toBe(6);
      expect(count(db, 'app_redirect_uris')).toBe(3);
      expect(count(db, 'app_scopes')).toBe(4);
      expect(count(db, 'app_secrets')).toBe(1);
      expect(count(db, 'app_roles')).toBe(1);
      expect(count(db, 'signing_keys')).toBe(1); // #3 bootstrap seeds/generates the active key

      expect(ctx.app.store.tenants.getDefault()?.id).toBe(TEST_TENANT_ID);
      expect(ctx.app.store.users.getById('aaaaaaaa-0000-0000-0000-000000000001')?.mail).toBe(
        'alice@entralocal.dev',
      );
      expect(ctx.app.store.users.getById('aaaaaaaa-0000-0000-0000-000000000002')).toBeDefined();
      expect(
        ctx.app.store.groups.getById('bbbbbbbb-0000-0000-0000-000000000001')?.displayName,
      ).toBe('Engineering');
      const spa = ctx.app.store.apps.getByAppId('cccccccc-0000-0000-0000-000000000001');
      expect(spa?.isConfidential).toBe(false);
      expect(ctx.app.store.apps.listScopes(spa!.appId).map((s) => s.value)).toEqual([
        'access_as_user',
      ]);
      const daemon = ctx.app.store.apps.getByAppId('cccccccc-0000-0000-0000-000000000002');
      expect(daemon?.isConfidential).toBe(true);
      expect(ctx.app.store.apps.verifySecret(daemon!.appId, 'daemon-app-secret')).toBe(true);
      expect(ctx.app.store.apps.listRoles(daemon!.appId).map((r) => r.value)).toEqual([
        'Tasks.Read.All',
      ]);

      // Full-stack sample (#24): dedicated front SPA app + back API resource app.
      const spaFront = ctx.app.store.apps.getByAppId('cccccccc-0000-0000-0000-000000000004');
      expect(spaFront?.isConfidential).toBe(false);
      expect(ctx.app.store.apps.listRedirectUris(spaFront!.appId).map((r) => r.uri)).toContain(
        'http://localhost:5173',
      );
      const api = ctx.app.store.apps.getByAppId('cccccccc-0000-0000-0000-000000000005');
      expect(api?.isConfidential).toBe(false);
      expect(api?.appIdUri).toBe('api://cccccccc-0000-0000-0000-000000000005');
      expect(ctx.app.store.apps.listScopes(api!.appId).map((s) => s.value)).toEqual([
        'access_as_admin',
        'access_as_user',
      ]);
    } finally {
      await ctx.close();
    }
  });

  it('does not seed when SEED_ON_START is false', async () => {
    const ctx = await buildTestApp({ seedOnStart: false });
    try {
      expect(count(ctx.app.store.db, 'tenants')).toBe(0);
      expect(count(ctx.app.store.db, 'users')).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('skips seeding when a tenant already exists (no duplication)', async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, `${randomUUID()}.db`);
    // Pre-seed a DB at this path, then boot the app against it.
    const pre = openDatabase(dbPath);
    runMigrations(pre, () => 1);
    createStore(pre, {
      tenantId: TEST_TENANT_ID,
      issuer: `http://localhost/${TEST_TENANT_ID}/v2.0`,
      clock: () => 1,
    }).seed();
    pre.close();

    const ctx = await buildTestApp({ dbPath });
    try {
      // Still exactly two users — the boot seed was skipped, not re-applied.
      expect(count(ctx.app.store.db, 'users')).toBe(2);
    } finally {
      await ctx.close();
    }
  });
});

describe('store plugin: reset (criterion 8)', () => {
  it('reset({reseed:true}) empties data, restores seed, preserves active kid', async () => {
    const ctx = await buildTestApp();
    try {
      const { store } = ctx.app;
      store.signingKeys.insert({
        kid: 'boot-kid',
        tenantId: TEST_TENANT_ID,
        publicJwk: '{"kty":"RSA"}',
        privatePkcs8: 'PRIVATE',
      });
      store.users.create({
        tenantId: TEST_TENANT_ID,
        userPrincipalName: 'stray@entralocal.dev',
        displayName: 'Stray',
      });
      expect(store.users.count()).toBe(3);

      store.reset({ reseed: true });

      expect(store.users.count()).toBe(2);
      expect(store.users.getByUpn('stray@entralocal.dev')).toBeUndefined();
      expect(store.signingKeys.getActive(TEST_TENANT_ID)?.kid).toBe('boot-kid');
    } finally {
      await ctx.close();
    }
  });
});

describe('store harness isolation (criterion 9)', () => {
  let cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.map((c) => c()));
    cleanup = [];
  });

  it('two buildTestApp() instances use independent DBs with no cross-talk', async () => {
    const a = await buildTestApp();
    const b = await buildTestApp();
    cleanup = [a.close, b.close];

    expect(a.dbPath).not.toBe(b.dbPath);
    a.app.store.users.create({
      tenantId: TEST_TENANT_ID,
      userPrincipalName: 'onlyA@entralocal.dev',
      displayName: 'Only A',
    });

    expect(a.app.store.users.getByUpn('onlyA@entralocal.dev')).toBeDefined();
    expect(b.app.store.users.getByUpn('onlyA@entralocal.dev')).toBeUndefined();
    expect(a.app.store.users.count()).toBe(3);
    expect(b.app.store.users.count()).toBe(2);
  });
});
