import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import type { AppRoleAssignment, NewAppRoleAssignment } from '../types.js';
import type { Clock, Row } from '../util.js';
import { optStr, reqNum, reqStr } from '../util.js';

function mapAssignment(row: Row): AppRoleAssignment {
  const userId = optStr(row, 'user_id');
  return {
    id: reqStr(row, 'id'),
    appId: reqStr(row, 'app_id'),
    roleId: reqStr(row, 'role_id'),
    principalType: userId !== null ? 'User' : 'Group',
    principalId: userId ?? reqStr(row, 'group_id'),
    createdAt: reqNum(row, 'created_at'),
  };
}

/**
 * App role assignments: which users and groups hold which app roles. The claim query
 * (`rolesForUser`) and the sign-in gate (`hasAssignment`) both resolve group membership, so a role
 * assigned to a group is held by every member.
 */
export interface AppRoleAssignmentsRepository {
  getById(id: string): AppRoleAssignment | undefined;
  /** Every assignment on the role-defining app, newest first. */
  listForApp(appId: string): AppRoleAssignment[];
  /** The user's **direct** assignments only (group-inherited ones are not listed, as in Graph). */
  listForUser(userId: string): AppRoleAssignment[];
  listForGroup(groupId: string): AppRoleAssignment[];
  create(input: NewAppRoleAssignment): AppRoleAssignment;
  /** Remove one assignment of the given app. Returns false when it did not exist. */
  remove(appId: string, id: string): boolean;
  /**
   * Enabled `User`-type role values of `appId` held by the user, directly or through a group the
   * user is a member of. Distinct, ordered by value. Empty when the user holds none.
   */
  rolesForUser(appId: string, userId: string): string[];
  /** Whether the user holds any assignment on `appId` — any role, enabled or not, direct or via group. */
  hasAssignment(appId: string, userId: string): boolean;
}

export function createAppRoleAssignmentsRepository(
  db: Database,
  clock: Clock,
): AppRoleAssignmentsRepository {
  const selectById = db.prepare('SELECT * FROM app_role_assignments WHERE id = ?');
  const listForAppStmt = db.prepare(
    'SELECT * FROM app_role_assignments WHERE app_id = ? ORDER BY created_at DESC, id',
  );
  const listForUserStmt = db.prepare(
    'SELECT * FROM app_role_assignments WHERE user_id = ? ORDER BY created_at DESC, id',
  );
  const listForGroupStmt = db.prepare(
    'SELECT * FROM app_role_assignments WHERE group_id = ? ORDER BY created_at DESC, id',
  );
  const insertStmt = db.prepare(
    `INSERT INTO app_role_assignments (id, app_id, role_id, user_id, group_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deleteStmt = db.prepare('DELETE FROM app_role_assignments WHERE id = ? AND app_id = ?');
  // `allowed_member_types` is a comma-separated column ('User', 'Application', 'User,Application',
  // with optional spaces); the LIKE over a normalised ',a,b,' form matches a whole token only.
  const rolesForUserStmt = db.prepare(
    `SELECT DISTINCT r.value AS value
       FROM app_role_assignments a
       JOIN app_roles r ON r.id = a.role_id
      WHERE a.app_id = ?
        AND r.is_enabled = 1
        AND (',' || REPLACE(r.allowed_member_types, ' ', '') || ',') LIKE '%,User,%'
        AND (a.user_id = ?
             OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
      ORDER BY r.value`,
  );
  const hasAssignmentStmt = db.prepare(
    `SELECT 1 AS hit
       FROM app_role_assignments a
      WHERE a.app_id = ?
        AND (a.user_id = ?
             OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
      LIMIT 1`,
  );

  return {
    getById(id) {
      const row = selectById.get(id) as Row | undefined;
      return row ? mapAssignment(row) : undefined;
    },
    listForApp(appId) {
      return (listForAppStmt.all(appId) as Row[]).map(mapAssignment);
    },
    listForUser(userId) {
      return (listForUserStmt.all(userId) as Row[]).map(mapAssignment);
    },
    listForGroup(groupId) {
      return (listForGroupStmt.all(groupId) as Row[]).map(mapAssignment);
    },
    create(input) {
      const id = input.id ?? randomUUID();
      insertStmt.run(
        id,
        input.appId,
        input.roleId,
        input.principalType === 'User' ? input.principalId : null,
        input.principalType === 'Group' ? input.principalId : null,
        clock(),
      );
      return mapAssignment(selectById.get(id) as Row);
    },
    remove(appId, id) {
      return Number(deleteStmt.run(id, appId).changes) > 0;
    },
    rolesForUser(appId, userId) {
      return (rolesForUserStmt.all(appId, userId, userId) as Row[]).map((row) =>
        reqStr(row, 'value'),
      );
    },
    hasAssignment(appId, userId) {
      return hasAssignmentStmt.get(appId, userId, userId) !== undefined;
    },
  };
}
