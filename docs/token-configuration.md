# Token configuration — optional claims & group claims

Entra Local emulates Microsoft Entra ID's **token configuration**: the ability to add **optional
claims** to issued tokens and to emit **group membership claims**. This lets MSAL-based apps test
realistic authorization flows locally — including the **group overage** behaviour — without a cloud
tenant.

This document covers what is supported, how ID-token vs access-token configuration differ, the
group overage payload, the seeded demo apps, and the exact portal steps.

> Scope: this feature implements **optional claims** and **group claims** only. Claims-mapping
> policies, custom claims providers, and SAML tokens are out of scope. `roles` on user tokens is a
> separate mechanism, covered below under **App roles on user tokens — assignments**.

---

## ID token vs access token — who owns the configuration

This is the single most important concept, and it mirrors Microsoft Entra ID:

| Token          | Configuration comes from…                     | Why |
| -------------- | --------------------------------------------- | --- |
| **ID token**   | the **client** app registration               | The ID token describes the user to the app that signed them in. |
| **Access token** | the **resource / API** app registration      | The access token is consumed by the API, so the API decides what it needs. Entra Local resolves the resource app from the requested `api://…` scope (the token's `aud`) and applies **that** app's access-token configuration — never the calling client's. |

The portal **Token configuration** card and the token-preview endpoint both make this explicit.

---

## Supported optional claims

Unsupported optional claims are **preserved** in the app configuration (so nothing is lost) but are
**never emitted**, and the token endpoint logs a warning. The portal flags them as `unsupported`.

**ID token**

```
email  upn  given_name  family_name  preferred_username  auth_time  ipaddr  groups
```

**Access token**

```
email  upn  given_name  family_name  preferred_username  ipaddr  groups
```

Claim value sources:

| Claim                | Source |
| -------------------- | ------ |
| `email`              | Local user email (`mail`) |
| `upn`                | Local user `userPrincipalName`, falling back to email |
| `given_name`         | Local user given name |
| `family_name`        | Local user surname |
| `preferred_username` | Local user UPN, falling back to email |
| `auth_time`          | Authentication/session timestamp (ID token only) |
| `ipaddr`             | Request IP address, or the deterministic local value `127.0.0.1` |
| `groups`             | Local group memberships, when group claims are enabled |

Claims are only emitted when a value is available (no empty claims).

---

## Group claims

Set the app's **group claims** mode to emit the user's memberships. Supported values:

```
None  SecurityGroup  DirectoryRole  ApplicationGroup  All
```

`SecurityGroup` and `All` currently behave the same (Entra Local does not yet distinguish group
types), but the explicit values are preserved so configuration is forward-compatible.

When enabled, `groups` is emitted as an array of **stable local group IDs** (not display names):

```json
{
  "groups": ["bbbbbbbb-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002"]
}
```

Group display names are resolved separately via the local Graph endpoints (below).

### Group overage

Entra ID caps how many groups it will inline in a JWT; beyond that it emits an **overage** pointer
instead of the array, and the app must call Microsoft Graph to get the full list. Entra Local
reproduces this.

The limit is per-app (`groupOverageLimit`), falling back to the server default (`200`, configurable
via `GROUP_OVERAGE_LIMIT`). When a user's membership **exceeds** the limit, the token carries:

```json
{
  "_claim_names": { "groups": "src1" },
  "_claim_sources": {
    "src1": { "endpoint": "https://localhost:8443/graph/v1.0/me/memberOf" }
  }
}
```

The app resolves the full membership by calling that endpoint (see **Graph endpoints**). The seeded
demo apps set `groupOverageLimit` to **3** so a 4-group user triggers overage without you having to
create hundreds of groups.

---

## Graph endpoints for group resolution

The local Graph endpoint supports enough for the overage flow:

```http
GET /graph/v1.0/me
GET /graph/v1.0/users/{id}
GET /graph/v1.0/me/memberOf
GET /graph/v1.0/users/{id}/memberOf
GET /graph/v1.0/groups
GET /graph/v1.0/groups/{id}
GET /graph/v1.0/groups/{id}/members
```

`memberOf` returns a collection of the user's groups:

```json
{
  "value": [
    { "id": "bbbbbbbb-0000-0000-0000-000000000002", "displayName": "Developers", "description": "Local developers group" }
  ]
}
```

---

## App roles on user tokens — assignments

`roles` on a **user** token is not an optional claim: it is derived from **app role assignments**.
Assign an enabled app role whose `allowedMemberTypes` include `User` to a user or to a group (members
inherit), and the value lands in:

- the **ID token** — roles of the **client** app the user signs in to;
- the **delegated access token** — roles of the **resource/API** app resolved from the audience.

A user with no assignment gets **no `roles` claim** (Entra emits none, never `[]`, on a user token).
Listing `roles` under `optionalClaims` does nothing and is logged as unsupported with a pointer here.
App-only (client-credentials) tokens follow their own rule, below.

**Assignment required.** Turn on `appRoleAssignmentRequired` on the client app (portal: *Users and
groups* → *Assignment required*) and a user without an assignment is refused at sign-in with
Entra's `AADSTS50105` shape: `/authorize` redirects with `error=access_denied` (also for
`prompt=none`), the `authorization_code` and `refresh_token` grants answer `400 invalid_grant` with
`error_codes: [50105]`, and device-code approval denies the code. Default off.

---

## App roles on app-only tokens — auto-grant, or assignments

By default a client-credentials token carries **every enabled `Application`-type role of the
resource**, for any client that names the right audience. That is deliberate — the roadmap defers
consent modelling for a local dev tool — and it means the happy path of an app-only API is testable
out of the box, while the refusal is not: no caller can be made to lack a role.

Turn on `appOnlyRoleAssignmentRequired` on the **resource** app (portal: *Applications* →
*Assignment required*) and the claim comes from that resource's app role assignments instead:

- a client that is assigned a role gets exactly the enabled `Application` roles it holds;
- a client with no assignment gets an **empty** `roles` claim — the token is still issued, so the
  API it calls is what refuses it, which is usually the thing being tested.

Assign with `principalType: "Application"` and the client's app id. Default off, so an existing
installation keeps the auto-grant.

**Divergence:** real Entra refuses the `.default` request outright when nothing is consented, so
there the client never reaches the API at all.

---

## Seeded demo apps and users

Seeded into the emulator (see [`src/store/seed.ts`](../src/store/seed.ts)) with fixed GUIDs:

| App              | `appId`                                 | Token config |
| ---------------- | --------------------------------------- | ------------ |
| `local-web-client` | `cccccccc-0000-0000-0000-000000000006`  | **ID token** optional claims: `email`, `upn`, `given_name`, `family_name`, `groups`; group claims `SecurityGroup`; overage limit `3`. Redirect URI `http://localhost:3000`. App roles `Tasks.Read`, `Tasks.Approve` (User); assignments: Alice → `Tasks.Approve`, group Developers → `Tasks.Read`. |
| `local-api`        | `cccccccc-0000-0000-0000-000000000007`  | **Access token** optional claims: `email`, `upn`, `groups`; group claims `SecurityGroup`; overage limit `3`. Exposes scope `access_as_user`. |

Seeded users (dev-only credentials, password `Password1!`):

| User                    | Groups                                             | Group claim result | Roles on `local-web-client` |
| ----------------------- | -------------------------------------------------- | ------------------ | ---------------------------- |
| `alice@entralocal.dev`  | Engineering, Developers, Data Team, Local Admins (4) | **overage** (> limit 3) — token carries `_claim_names`/`_claim_sources` | `Tasks.Approve`, `Tasks.Read` |
| `bob@entralocal.dev`    | Engineering, Developers (2)                          | inline `groups` array | `Tasks.Read` (via Developers) |

---

## Expected decoded tokens

**ID token** from `local-web-client` for **Bob** (under the overage limit):

```json
{
  "aud": "cccccccc-0000-0000-0000-000000000006",
  "iss": "https://localhost:8443/11111111-1111-1111-1111-111111111111/v2.0",
  "tid": "11111111-1111-1111-1111-111111111111",
  "name": "Bob Example",
  "preferred_username": "bob@entralocal.dev",
  "email": "bob@entralocal.dev",
  "upn": "bob@entralocal.dev",
  "given_name": "Bob",
  "family_name": "Example",
  "groups": ["bbbbbbbb-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002"],
  "roles": ["Tasks.Read"]
}
```

**Access token** from `local-api` (audience = the API), acquired by `local-web-client` for **Alice**
(over the overage limit):

```json
{
  "aud": "cccccccc-0000-0000-0000-000000000007",
  "iss": "https://localhost:8443/11111111-1111-1111-1111-111111111111/v2.0",
  "tid": "11111111-1111-1111-1111-111111111111",
  "scp": "access_as_user",
  "azp": "cccccccc-0000-0000-0000-000000000006",
  "email": "alice@entralocal.dev",
  "upn": "alice@entralocal.dev",
  "_claim_names": { "groups": "src1" },
  "_claim_sources": { "src1": { "endpoint": "https://localhost:8443/graph/v1.0/me/memberOf" } }
}
```

Note the access token's claims (`email`, `upn`, groups) come from **`local-api`**, not from the
`local-web-client` that requested it.

---

## Configuring from the portal

1. Open the **Entra Local portal**.
2. Go to **App registrations** and select an app (e.g. `local-web-client`).
3. Scroll to **Token configuration**.
4. Under **ID token — optional claims**, add supported claims (e.g. `email`, `upn`, `groups`).
   Add **access token** claims on the **resource/API** app (e.g. `local-api`) instead.
5. Set **Group claims** (e.g. *Security groups*) and, optionally, a **Group overage limit**.
6. Click **Save**.
7. Use **Token preview**: pick a **user** and **token type**, then **Preview** to see the exact
   decoded claim payload (including overage) the app would issue.
8. Sign in again from your app and decode the issued token — it will match the preview.

---

## Admin API

The same configuration is available over the Admin REST API (`/admin/api`):

- `GET  /admin/api/token-configuration/supported-claims` — supported claims + group modes + default overage limit.
- `PATCH /admin/api/apps/{id}` — set `optionalClaims`, `groupMembershipClaims`, `groupOverageLimit`.
- `POST /admin/api/apps/{id}/token-preview` — body `{ "userId": "...", "tokenType": "idToken" | "accessToken" }`.
- `POST /admin/api/apps/{id}/token-generate` — body `{ "userId": "...", "tokenType": "idToken" | "accessToken", "tokenVariant": "valid" | "expired" | "invalidSignature" }`; returns the local-development token and its decoded claims. `tokenVariant` defaults to `valid`.
- `GET|POST /admin/api/apps/{id}/roleAssignments`, `DELETE /admin/api/apps/{id}/roleAssignments/{assignmentId}` — body `{ "roleId", "principalType": "User" | "Group" | "Application", "principalId" }`. For `Application` the `principalId` is the client app's id.
- `GET /admin/api/users/{id}/appRoleAssignments` (direct only), `GET /admin/api/groups/{id}/appRoleAssignments`.
- `appRoleAssignmentRequired` and `appOnlyRoleAssignmentRequired` on `POST`/`PATCH /admin/api/apps/{id}`.
- Graph (read-only): `GET /graph/v1.0/me/appRoleAssignments`, `/users/{id}/appRoleAssignments`, `/groups/{id}/appRoleAssignments`, `/servicePrincipals/{appId}/appRoleAssignedTo` — `resourceId` is the resource app's `appId` (the emulator has no service principals). Application assignments are not listed here: Graph carries directory principals, and broader Graph app-role surfaces are deferred by the roadmap.
