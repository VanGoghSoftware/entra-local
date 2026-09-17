# Feature #xx — App role assignments for **application** identities (opt-in), app-only `roles` from assignments

- **Roadmap ref:** `specs/roadmap.md`, Iteration 2. Makes the app-only `roles` claim of [#8](2026-06-22_08-client-credentials.md) assignment-based when a resource app opts in; leaves #8's auto-grant as the default.
- **Dependencies:** [#8](2026-06-22_08-client-credentials.md) (`.default` resolution, auto-grant model), app role assignments (`app_role_assignments`, migration 003 — spec `2026-09-13_xx-app-role-assignments.md`), [#11](2026-06-22_11-admin-rest-api.md) (admin error convention), [#12](2026-06-22_12-web-portal.md) (app detail sections).
- **Status:** 🚧 In progress (fork `VanGoghSoftware/entra-local`). The `xx` is the upstream issue number, assigned when the issue is opened.

> **Canonical-reference notice.** This spec owns the **`Application` principal type** on app role assignments and the **opt-in switch** that makes app-only `roles` come from assignments. It does not change the `User`/`Group` behaviour owned by the app-role-assignments spec, and it does not remove #8's auto-grant — it makes it the default of a per-app choice.

---

## Goal / outcome

A developer can express **"this daemon may call my API, that one may not"** and test both outcomes against their own API.

Measured on the current image (2026-09-17): `Sample Daemon` — a client with no relationship to `api://printapi-local` — requests `client_credentials` for that resource and receives `roles: ["PrintApi.Invoke"]`. Every client that names the right audience gets every enabled `Application` role of the resource, because `autoGrantedRoles` derives the claim from the resource's role list alone. The positive path of an app-only API is therefore testable today; **the refusal is not** — there is no way to produce a caller that should be rejected, so a `RequireRole`-style 403 can only be exercised with a hand-minted token from a stub authority.

After this change, a resource app can be switched to assignment-based app-only roles. A client with an assignment gets exactly the roles it holds; a client without one gets **no `roles` claim** and is refused by the API it calls.

---

## Scope

### In scope
- **Store:** `app_role_assignments.client_app_id` (third principal column); `app_registrations.app_only_role_assignment_required`; forward-only migration 005; repository (`rolesForClient`, `Application` principals); reset/seed unchanged.
- **Claims:** app-only `roles` resolved from assignments when the resource app has the switch on; the auto-grant unchanged when it is off.
- **Admin REST API:** `principalType: "Application"` on assignment create; the switch on app create/patch; the switch in the app DTO.
- **Portal:** an **Applications** section on the app detail page — the switch, the assignment list, and an add row.
- Docs: README "what it emulates", `docs/token-configuration.md`, `specs/roadmap.md` row, `memory/decisions.md` entry.

### Out of scope
- **Service principals.** This emulator has no service-principal objects; a client application *is* its app registration, and an assignment names its `app_id`. Unchanged from the user-side spec's documented divergence.
- **Admin consent / a consent screen.** Deferred by the roadmap ("Local dev tool auto-consents"); this feature is the per-app opt-in, not a consent model.
- **Graph.** `appRoleAssignedTo` is not extended to application principals (roadmap defers "Broader Graph … app roles").
- **Seed data.** No seeded application assignment and no seeded switch: turning the switch on for a seeded app would change the behaviour of the existing samples and the e2e suite. The portal demonstrates the feature in two clicks.
- **Delegated tokens.** Untouched; the `User`/`Group` rules own those.

---

## Behaviour

| Resource app's `appOnlyRoleAssignmentRequired` | Client has an assignment | `roles` in the app-only token |
|---|---|---|
| `false` (default) | — | every enabled `Application` role of the resource (#8, unchanged) |
| `true` | yes | exactly the enabled `Application` roles it is assigned |
| `true` | no | **empty** (`roles: []`) |

The token is still issued in the last row, carrying an empty `roles` array — the same shape #8 already produces for a resource that defines no `Application` role, rather than a third variant. `RequireRole`-style authorization on the API side fails on it, which is the point.

**Documented divergence:** real Entra refuses a `.default` request for a resource the client has no granted permissions on, so the client never reaches the API at all. Issuing a role-less token instead is deliberate — the developer's reason for wanting this is to exercise **their own API's** authorization failure, which an error at the token endpoint would replace with an MSAL error.

Group assignments do not apply: an application is not a member of a group.

---

## Data changes

Migration 005 rebuilds `app_role_assignments` (SQLite cannot widen a `CHECK` in place):

```sql
client_app_id TEXT REFERENCES app_registrations(app_id) ON DELETE CASCADE
CHECK ((user_id IS NOT NULL) + (group_id IS NOT NULL) + (client_app_id IS NOT NULL) = 1)
UNIQUE (role_id, client_app_id)
```

and adds `app_registrations.app_only_role_assignment_required INTEGER NOT NULL DEFAULT 0`. Both are additive and defaulted: an existing installation keeps today's behaviour with no data migration, and every existing assignment row survives the rebuild.

---

## Contracts

- `POST /admin/api/apps/{id}/roleAssignments` — `principalType` accepts `"Application"`; `principalId` is the **client app's `app_id`**. Validation mirrors the user path: the role must exist on this app, its `allowedMemberTypes` must include `Application`, the client app must exist, and the pair must not already be assigned (`409`).
- `GET /admin/api/apps/{id}/roleAssignments` — application assignments are listed alongside the others, `principalDisplayName` resolved from the client app's `displayName`.
- `POST|PATCH /admin/api/apps/{id}` — `appOnlyRoleAssignmentRequired` (boolean, default `false`); present on the app DTO.
- `GET /admin/api/users/{id}/appRoleAssignments`, `…/groups/{id}/…` — unchanged; they list their own principal kind only.

---

## Acceptance criteria

1. With the switch **off**, an app-only token for a resource carries every enabled `Application` role of that resource — byte-identical to today (#8 regression).
2. With the switch **on** and one role assigned to the calling client, the token carries exactly that role, and not the resource's other enabled `Application` roles.
3. With the switch **on** and no assignment for the calling client, the token is still issued (`200`) and carries an **empty** `roles` claim.
4. With the switch **on**, a role assigned to a *different* client does not appear in this client's token.
5. A role whose `allowedMemberTypes` excludes `Application` cannot be assigned to an application (`400 validation_error`), and never appears in an app-only token.
6. A disabled role never appears, assigned or not.
7. Assigning the same role to the same client twice is `409 conflict`.
8. Deleting the client app, the resource app or the role removes the assignment (cascade).
9. A version-4 database migrates with every existing assignment intact, and the new column defaults to `0`.
10. The portal's **Applications** section lists application assignments, adds one, removes one, and toggles the switch.
