/**
 * Migration 004 — sign-in artefacts follow their app and user.
 *
 * `authorization_codes`, `refresh_tokens` and `device_codes` referenced `app_registrations` (and,
 * for the first two, `users`) without an `ON DELETE` action. With `PRAGMA foreign_keys = ON` that is
 * `NO ACTION`: once an app had issued a single code, `DELETE FROM app_registrations` failed with
 * "FOREIGN KEY constraint failed", which the admin API surfaces as `400 invalid_reference` — for an
 * app that appears to have nothing left attached to it. Deleting a user who had signed in failed the
 * same way. Every other child table already cascades.
 *
 * SQLite cannot alter a foreign key in place, so each table is rebuilt: create the new shape, copy
 * every row, drop the old table, rename, recreate the indexes. The rebuilt tables are children only —
 * nothing references them — so the drop and rename are safe with foreign keys enforced, and the
 * runner's transaction makes the rebuild all-or-nothing.
 */
export const MIGRATION_004_CASCADE_SIGN_IN_ARTEFACTS = `
CREATE TABLE authorization_codes_v4 (
  code                  TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  scopes                TEXT NOT NULL,
  resource              TEXT,
  code_challenge        TEXT,
  code_challenge_method TEXT,
  nonce                 TEXT,
  expires_at            INTEGER NOT NULL,
  consumed              INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL
);
INSERT INTO authorization_codes_v4
  (code, app_id, user_id, redirect_uri, scopes, resource, code_challenge, code_challenge_method,
   nonce, expires_at, consumed, created_at)
  SELECT code, app_id, user_id, redirect_uri, scopes, resource, code_challenge, code_challenge_method,
         nonce, expires_at, consumed, created_at
  FROM authorization_codes;
DROP TABLE authorization_codes;
ALTER TABLE authorization_codes_v4 RENAME TO authorization_codes;
CREATE INDEX idx_authorization_codes_expires ON authorization_codes(expires_at);

CREATE TABLE refresh_tokens_v4 (
  token        TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes       TEXT NOT NULL,
  resource     TEXT,
  expires_at   INTEGER NOT NULL,
  rotated_from TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
INSERT INTO refresh_tokens_v4
  (token, app_id, user_id, scopes, resource, expires_at, rotated_from, revoked, created_at)
  SELECT token, app_id, user_id, scopes, resource, expires_at, rotated_from, revoked, created_at
  FROM refresh_tokens;
DROP TABLE refresh_tokens;
ALTER TABLE refresh_tokens_v4 RENAME TO refresh_tokens;
CREATE INDEX idx_refresh_tokens_app_user ON refresh_tokens(app_id, user_id);

CREATE TABLE device_codes_v4 (
  device_code TEXT PRIMARY KEY,
  user_code   TEXT NOT NULL UNIQUE,
  app_id      TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  user_id     TEXT,
  scopes      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  interval    INTEGER NOT NULL DEFAULT 5,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
INSERT INTO device_codes_v4
  (device_code, user_code, app_id, user_id, scopes, status, interval, expires_at, created_at)
  SELECT device_code, user_code, app_id, user_id, scopes, status, interval, expires_at, created_at
  FROM device_codes;
DROP TABLE device_codes;
ALTER TABLE device_codes_v4 RENAME TO device_codes;
`;
