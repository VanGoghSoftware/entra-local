# Issue #28 — Client Credentials: OIDC Companion Scopes

- **Issue:** [#28 — Client credentials additional scopes](https://github.com/cmaneu/entra-local/issues/28).
- **Roadmap ref:** Compatibility follow-up to Iteration 1 feature #8 (Client Credentials) and Iteration 3 samples.
- **Dependencies:** [#8](2026-06-22_08-client-credentials.md) (client credentials), [#13](2026-06-22_13-msal-compat-validation.md) (real-library compatibility harness), and the shared samples conventions in [#18](2026-06-25_18-js-react-spa-samples.md).
- **Status:** ⬜ Not started.

---

## Goal / outcome

Make Entra Local interoperable with client-credentials clients that send the standard OIDC companion scopes `openid`, `profile`, and/or `offline_access` alongside the single required `<resource>/.default` scope.

The immediate compatibility case is the official Java Azure Identity library, which may add `openid profile offline_access` to a client-credentials token request even when the application asks only for `<resource>/.default`. The emulator must accept that request, issue the same app-only token it would issue for the resource scope alone, and **not** accidentally turn a client-credentials response into an interactive/OIDC response.

Add a runnable Java Azure Identity daemon sample and CI smoke coverage so this exact request shape remains a regression-tested compatibility contract.

---

## Scope

### In scope

- Relax client-credentials scope validation so a request may contain:
  - exactly one resolvable `<resource>/.default` scope; and
  - zero or more distinct OIDC companion scopes: `openid`, `profile`, and `offline_access`.
- Preserve existing resource resolution and app-role auto-grant behavior from feature #8:
  - Graph `.default` resolves to the configured Graph resource and produces `roles: []`;
  - a registered API URI or app ID `.default` resolves to that API and receives its enabled `Application` roles.
- Continue issuing an app-only token and response:
  - access token only;
  - no `id_token`, `refresh_token`, `client_info`, delegated `scp`, or user claims;
  - app-only `appid`, `azp`, and `roles` semantics unchanged.
- Add focused unit/integration coverage for accepted OIDC companion scopes and rejected non-OIDC extras.
- Extend the real-client compatibility coverage with the official Java Azure Identity library.
- Add `samples/java-client-credentials/`, a standalone Java daemon sample using Azure Identity's `ClientSecretCredential` and a Graph `.default` request.
- Add the sample to `samples/README.md`, its own README, optional emulator compose configuration, and the samples CI job.
- Update the relevant feature #8 and sample documentation to state the compatibility rule and its app-only semantics.

### Out of scope

- Treating client credentials as an interactive OIDC flow.
- Issuing an ID token or refresh token because `openid`, `profile`, or `offline_access` was accepted.
- Accepting arbitrary additional delegated/resource scopes.
- Supporting multiple `.default` resources in one request.
- Changing app-role assignment/auto-grant behavior, consent, client authentication methods, token claims, discovery metadata, schema, or seed data.
- A general Java sample suite for authorization-code, device-code, or other flows.

---

## Contract

### Accepted scope grammar

For `grant_type=client_credentials`, parse `scope` as whitespace-separated tokens. A request is valid when all of the following are true:

1. It contains **exactly one** token ending in `/.default`.
2. That `.default` token resolves under feature #8's existing resolution rules.
3. Every other token is one of `openid`, `profile`, or `offline_access`.
4. Each OIDC companion token occurs at most once.

Token order is not significant. Therefore all of these requests are equivalent for token issuance:

```text
https://graph.microsoft.com/.default
openid profile offline_access https://graph.microsoft.com/.default
https://graph.microsoft.com/.default offline_access openid profile
```

### Effective scope and response

The `.default` token is the **effective resource scope**. OIDC companion scopes are accepted only for client-library interoperability and do not affect audience, roles, claims, token type, or token lifetime.

On success, return the existing token-response envelope, with `scope` set to the effective `<resource>/.default` token only (for example, `https://graph.microsoft.com/.default`). Do not echo OIDC companion scopes in the response, because they were not granted as delegated/OIDC permissions in this app-only flow.

```jsonc
{
  "token_type": "Bearer",
  "expires_in": 3600,
  "ext_expires_in": 3600,
  "scope": "https://graph.microsoft.com/.default",
  "access_token": "<app-only JWT>"
  // no id_token, refresh_token, or client_info
}
```

The access token remains app-only:

- `aud` is the resolved resource.
- `appid` and `azp` are the confidential client ID.
- `roles` contains the existing auto-granted application roles (or `[]` for Graph).
- `scp`, `oid`, user identity claims, and refresh-token behavior are absent.

### Invalid requests

Return the existing AADSTS-style `invalid_scope` / HTTP 400 response for any of the following:

| Request shape | Example | Expected outcome |
|---|---|---|
| No resource `.default` scope | `openid profile` | `invalid_scope` |
| More than one `.default` scope | `https://graph.microsoft.com/.default api://example/.default` | `invalid_scope` |
| Duplicate OIDC companion scope | `openid openid https://graph.microsoft.com/.default` | `invalid_scope` |
| Extra non-OIDC/delegated scope | `User.Read https://graph.microsoft.com/.default` | `invalid_scope` |
| Unknown OIDC-like scope | `email https://graph.microsoft.com/.default` | `invalid_scope` |
| Invalid/unresolvable `.default` resource | `api://unknown/.default openid` | `invalid_scope` |

A missing or blank `scope` remains `invalid_request` / HTTP 400.

---

## Implementation approach

### Scope resolver

Refactor `resolveClientCredentialScope` in `src/identity/clientCredentials.ts` so it:

1. tokenizes and validates the supplied scope string;
2. identifies the single `.default` token;
3. permits only the three named OIDC companion tokens outside that token;
4. rejects duplicates and all other extra tokens with a clear `invalid_scope` description; and
5. resolves and returns the effective `.default` token together with the existing `{ aud, resourceApp }` result.

Extend the successful resolver result with the normalized/effective resource scope. `handleClientCredentials` in `src/identity/token.ts` must use that value for the successful response's `scope` field rather than copying the raw request string.

Do not change the resource-resolution order, `autoGrantedRoles`, client authentication, or token service API unless a small type change is required to expose the effective resource scope.

### Tests

Locate the existing feature #8 resolver, token-route, and real-MSAL client-credentials tests and add coverage for:

1. Bare Graph `.default` remains accepted and unchanged.
2. Graph `.default` plus `openid profile offline_access` is accepted in at least two token orders.
3. A registered API `.default` plus all three companion scopes yields the existing API audience and application role(s).
4. Successful responses normalize `scope` to the effective `.default` resource only.
5. Accepted companion scopes do not add `id_token`, `refresh_token`, `client_info`, `scp`, `oid`, or user claims.
6. Each invalid shape in the contract table fails with `invalid_scope` (except missing/blank scope, which stays `invalid_request`).
7. Existing client-credentials test cases and real MSAL Node compatibility coverage remain green.

Where practical, assert the request/response at the HTTP route level, then decode and verify the returned JWT through the existing JWKS/token-conformance helpers.

---

## Java Azure Identity sample

### New sample: `samples/java-client-credentials/`

Add a standalone Maven-based Java sample targeting a supported LTS Java runtime (Java 17 unless the repository's CI image establishes another supported baseline). Use the official Azure Identity library's `ClientSecretCredential` and `TokenRequestContext`.

The sample must:

- default to the seeded confidential daemon registration:
  - `CLIENT_ID=cccccccc-0000-0000-0000-000000000002`
  - `CLIENT_SECRET=daemon-app-secret`
  - `TENANT_ID=11111111-1111-1111-1111-111111111111`
- default `EMULATOR_ORIGIN` to `https://localhost:8443` and construct the tenant authority from it;
- configure the Azure Identity authority host for Entra Local and trust the emulator development certificate using an explicit, narrowly scoped development-only HTTP client/SSL configuration;
- request `https://graph.microsoft.com/.default` through Azure Identity, without manually appending the OIDC companion scopes;
- print the actual outgoing/effective request scope information when the library exposes it, plus decoded token claims (`iss`, `aud`, `appid`, `azp`, `roles`);
- call `GET {EMULATOR_ORIGIN}/graph/v1.0/users` with the returned token and print the result;
- include a non-interactive `--smoke` mode that obtains a real client-credentials token and performs the Graph request (no browser or external cloud request);
- fail with actionable diagnostics for an untrusted/missing emulator certificate, incorrect seeded secret, unavailable emulator, or an unexpected token/Graph response.

Use a real local request in smoke mode—rather than a mocked credential transport—so CI proves the Azure Identity library's actual token request is accepted. If a version-specific Azure Identity behavior is being pinned, record the version and why in the sample README and lockfile/build configuration.

### Sample documentation and compose

Add:

- `samples/java-client-credentials/README.md` covering prerequisites, setup, one-command run, `--smoke`, full environment-variable table and defaults, seeded app/secret, effective Graph scope, expected app-only claims, endpoint path, cert handling, non-default emulator configuration, troubleshooting, and optional compose;
- `docker-compose.yml` following the shared samples convention, launching only the emulator; and
- an index entry in `samples/README.md` that explicitly identifies this as the Azure Identity client-credentials/OIDC-companion-scope compatibility sample.

The README must explicitly say that accepting `openid profile offline_access` in this flow does **not** return an ID token or refresh token. It must also document that the emulator should be started with `PUBLIC_ORIGIN=https://localhost:8443` for the default localhost sample configuration.

---

## CI and verification

Extend the existing samples CI workflow with a `java-client-credentials-sample` job or equivalent step that:

1. provisions the required Java runtime and Maven (or uses the Maven wrapper committed with the sample);
2. builds the server and starts the emulator with its deterministic seed and localhost-compatible public origin;
3. exports/provides the emulator certificate to the sample's development-only TLS configuration;
4. runs the Java sample's smoke mode against the live emulator; and
5. asserts success only after a token is acquired and `GET /graph/v1.0/users` returns 200.

CI must run without access to Microsoft Entra endpoints. The sample's authority configuration must therefore not permit cloud instance discovery or token requests to external hosts.

---

## Testable acceptance criteria

1. **Azure Identity compatibility:** a live `ClientSecretCredential` request generated by the Java sample succeeds when Azure Identity submits `openid profile offline_access` together with `https://graph.microsoft.com/.default`.
2. **Single effective resource:** the same request returns an access token with `aud=https://graph.microsoft.com`, an app-only identity (`appid`/`azp` equal the daemon client), and `roles=[]`.
3. **No interactive artifacts:** the successful client-credentials response contains no `id_token`, `refresh_token`, or `client_info`; its access token has no `scp`, `oid`, or user identity claims.
4. **Normalized response scope:** successful decorated requests return `scope=https://graph.microsoft.com/.default`, not a response value containing `openid`, `profile`, or `offline_access`.
5. **Custom API parity:** `openid profile offline_access api://<seeded-daemon-app>/.default` succeeds and preserves the existing app-role behavior, including `Tasks.Read.All` in `roles`.
6. **Strict extras:** multiple resources, duplicate companion scopes, delegated scopes such as `User.Read`, and unknown extras remain rejected as `invalid_scope` / 400.
7. **Existing behavior preserved:** a bare valid `.default` request, client authentication failures, tenant handling, JWKS verification, and existing Node/MSAL client-credentials tests continue to behave as before.
8. **Runnable sample:** from `samples/java-client-credentials/`, the documented command obtains a token and successfully calls `GET /graph/v1.0/users` against a locally running emulator.
9. **Documented sample:** the sample README and `samples/README.md` document the Java compatibility scenario, app-only limitations, certificate setup, configuration, and troubleshooting.
10. **CI regression coverage:** CI builds and runs the real Java Azure Identity smoke against the live emulator; no browser, cloud tenant, or external identity endpoint is required.
11. **Isolation:** the Java sample remains self-contained beneath `samples/java-client-credentials/` and does not alter root TypeScript lint/typecheck/build behavior.

---

## Decisions / assumptions

- The compatibility allowlist is deliberately limited to `openid`, `profile`, and `offline_access`, matching the reported Azure Identity request shape. It is not a general relaxation of client-credentials scope validation.
- `profile` is included alongside `openid` and `offline_access`; the current implementation's error message names only two OIDC scopes, but the reported Java request contains all three.
- The accepted OIDC tokens are syntactic companions only. They confer no OIDC or refresh-token behavior in an app-only grant.
- The Java sample is the required regression surface because it exercises the library named in the issue. The planned Node daemon sample remains useful but cannot prove this Azure Identity request shape.
- No new app registration is necessary: the existing seeded daemon app (`…0002`) already has a known development secret and supports client credentials.
