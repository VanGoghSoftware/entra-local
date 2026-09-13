/**
 * Migration 003 — app role assignments + "assignment required".
 *
 * - `app_role_assignments`: who holds which app role. Exactly one of `user_id` / `group_id` is set
 *   (CHECK) so SQLite can cascade the delete of a user or a group; `app_id` denormalises the
 *   role-defining (resource) app so per-app queries need no join and the cascade is explicit.
 *   SQLite treats NULLs as distinct in UNIQUE constraints, so `(role_id, user_id)` and
 *   `(role_id, group_id)` each dedupe their own principal kind.
 * - `app_registrations.app_role_assignment_required`: Entra's "User assignment required?" switch.
 *   Defaulted to 0 so existing registrations keep today's behaviour with no data migration.
 */
export const MIGRATION_003_APP_ROLE_ASSIGNMENTS = `
CREATE TABLE app_role_assignments (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  group_id   TEXT REFERENCES groups(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK ((user_id IS NULL) <> (group_id IS NULL)),
  UNIQUE (role_id, user_id),
  UNIQUE (role_id, group_id)
);
CREATE INDEX idx_app_role_assignments_app   ON app_role_assignments(app_id);
CREATE INDEX idx_app_role_assignments_user  ON app_role_assignments(user_id);
CREATE INDEX idx_app_role_assignments_group ON app_role_assignments(group_id);

ALTER TABLE app_registrations ADD COLUMN app_role_assignment_required INTEGER NOT NULL DEFAULT 0;
`;
