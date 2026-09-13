import type { Store } from '../store/store.js';
import type { AppRegistration, User } from '../store/types.js';

/** Entra's numeric code for "the signed in user is not assigned to a role for the application". */
export const ASSIGNMENT_REQUIRED_ERROR_CODE = 50105;

/**
 * Whether sign-in for `user` to `app` must be refused: the app requires assignment (Entra's "User
 * assignment required?") and the user holds no app role assignment on it, directly or through a
 * group. Always evaluated against the **client** app the user signs in to, never the resource.
 */
export function isAssignmentRequiredAndMissing(
  app: AppRegistration,
  user: User,
  store: Store,
): boolean {
  return (
    app.appRoleAssignmentRequired && !store.appRoleAssignments.hasAssignment(app.appId, user.id)
  );
}

/** The AADSTS50105-shaped `error_description` for a refused sign-in. */
export function assignmentRequiredDescription(app: AppRegistration): string {
  return (
    `AADSTS50105: Your administrator has configured the application ${app.displayName} ` +
    `('${app.appId}') to block users unless they are specifically granted ('assigned') access ` +
    'to the application. The signed in user is blocked because they are not a direct member of ' +
    'a group with access, nor had access directly assigned by an administrator.'
  );
}
