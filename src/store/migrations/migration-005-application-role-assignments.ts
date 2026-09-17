/**
 * Migration 005 — an app role can be held by a client application.
 *
 * - `app_role_assignments.client_app_id`: the third principal kind. Exactly one of `user_id`,
 *   `group_id` and `client_app_id` is set, so the `CHECK` widens from a two-way `<>` to a count —
 *   and SQLite cannot alter a `CHECK` in place, so the table is rebuilt: create the new shape, copy
 *   every row, drop, rename, recreate the indexes. Nothing references this table, so the drop and
 *   rename are safe with foreign keys enforced, and the runner's transaction makes it all-or-nothing.
 * - `app_registrations.app_only_role_assignment_required`: the per-resource opt-in that makes
 *   app-only `roles` come from assignments instead of feature #8's auto-grant. Defaulted to 0 so
 *   every existing registration keeps today's behaviour with no data migration.
 */
export const MIGRATION_005_APPLICATION_ROLE_ASSIGNMENTS = `
CREATE TABLE app_role_assignments_v5 (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  role_id       TEXT NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  group_id      TEXT REFERENCES groups(id) ON DELETE CASCADE,
  client_app_id TEXT REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  CHECK ((user_id IS NOT NULL) + (group_id IS NOT NULL) + (client_app_id IS NOT NULL) = 1),
  UNIQUE (role_id, user_id),
  UNIQUE (role_id, group_id),
  UNIQUE (role_id, client_app_id)
);
INSERT INTO app_role_assignments_v5 (id, app_id, role_id, user_id, group_id, created_at)
  SELECT id, app_id, role_id, user_id, group_id, created_at FROM app_role_assignments;
DROP TABLE app_role_assignments;
ALTER TABLE app_role_assignments_v5 RENAME TO app_role_assignments;
CREATE INDEX idx_app_role_assignments_app    ON app_role_assignments(app_id);
CREATE INDEX idx_app_role_assignments_user   ON app_role_assignments(user_id);
CREATE INDEX idx_app_role_assignments_group  ON app_role_assignments(group_id);
CREATE INDEX idx_app_role_assignments_client ON app_role_assignments(client_app_id);

ALTER TABLE app_registrations ADD COLUMN app_only_role_assignment_required INTEGER NOT NULL DEFAULT 0;
`;
