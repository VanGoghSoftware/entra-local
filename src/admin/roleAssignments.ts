import type { Store } from '../store/store.js';
import type { AppRoleAssignment } from '../store/types.js';
import { toAppRoleAssignmentDto, type AppRoleAssignmentDto } from './dto.js';

/**
 * Resolve the display data an assignment DTO carries beside the ids: the role's `value` and the
 * principal's display name. A dangling reference (never expected — the schema cascades) falls back
 * to the id so a listing never fails because of one row.
 */
export function describeAssignment(
  store: Store,
  assignment: AppRoleAssignment,
): AppRoleAssignmentDto {
  const role = store.apps.listRoles(assignment.appId).find((r) => r.id === assignment.roleId);
  const principalDisplayName =
    assignment.principalType === 'User'
      ? store.users.getById(assignment.principalId)?.displayName
      : assignment.principalType === 'Group'
        ? store.groups.getById(assignment.principalId)?.displayName
        : store.apps.getByAppId(assignment.principalId)?.displayName;
  return toAppRoleAssignmentDto(
    assignment,
    role?.value ?? assignment.roleId,
    principalDisplayName ?? assignment.principalId,
  );
}
