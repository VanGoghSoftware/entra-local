import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED } from '../../src/store/seed.js';
import { buildTestApp, type TestApp } from '../helpers/buildTestApp.js';
import { TEST_TENANT_ID } from '../helpers/constants.js';

/**
 * Integration tests for app role assignments held by **client applications**: the opt-in that makes
 * the app-only `roles` claim come from assignments instead of feature #8's auto-grant, and the
 * `Application` principal type on the admin assignment API.
 */

const T = TEST_TENANT_ID;
const TOKEN_PATH = `/${T}/oauth2/v2.0/token`;
const DAEMON = SEED.appDaemonId;
const DAEMON_SECRET = SEED.daemonSecret;

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS = { 'content-type': 'application/json' };

let ctx: TestApp;
afterEach(async () => {
  await ctx?.close();
});

/** A confidential resource app with one `Application` role, plus the switch in the given state. */
async function createResource(
  app: TestApp,
  opts: { required: boolean; memberTypes?: string[]; enabled?: boolean } = { required: true },
): Promise<{ appId: string; roleId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/admin/api/apps',
    headers: JSON_HEADERS,
    payload: {
      displayName: 'Resource API',
      isConfidential: true,
      appIdUri: `api://resource-${Math.random().toString(36).slice(2, 10)}`,
      appOnlyRoleAssignmentRequired: opts.required,
    },
  });
  expect(created.statusCode).toBe(201);
  const appId = (created.json() as { id: string }).id;

  const role = await app.inject({
    method: 'POST',
    url: `/admin/api/apps/${appId}/roles`,
    headers: JSON_HEADERS,
    payload: {
      value: 'Tasks.Invoke',
      allowedMemberTypes: opts.memberTypes ?? ['Application'],
    },
  });
  expect(role.statusCode).toBe(201);
  const roleId = (role.json() as { id: string }).id;

  if (opts.enabled === false) {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/api/apps/${appId}/roles/${roleId}`,
      headers: JSON_HEADERS,
      payload: { isEnabled: false },
    });
    expect(patched.statusCode).toBe(200);
  }
  return { appId, roleId };
}

/** Assign a role on `appId` to a principal. */
async function assign(
  app: TestApp,
  appId: string,
  body: { roleId: string; principalType: string; principalId: string },
) {
  return await app.inject({
    method: 'POST',
    url: `/admin/api/apps/${appId}/roleAssignments`,
    headers: JSON_HEADERS,
    payload: body,
  });
}

/** The `roles` claim of an app-only token the daemon gets for `resourceUri`. */
async function appOnlyRolesFor(app: TestApp, resourceUri: string): Promise<unknown> {
  const res = await app.inject({
    method: 'POST',
    url: TOKEN_PATH,
    headers: FORM_HEADERS,
    payload: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: DAEMON,
      client_secret: DAEMON_SECRET,
      scope: `${resourceUri}/.default`,
    }).toString(),
  });
  expect(res.statusCode).toBe(200);
  const accessToken = (res.json() as { access_token: string }).access_token;
  return decodeJwt(accessToken).roles;
}

/** An app-only Graph-audience token, for the read-only Graph assertions. */
async function appOnlyGraphToken(app: TestApp): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: TOKEN_PATH,
    headers: FORM_HEADERS,
    payload: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: DAEMON,
      client_secret: DAEMON_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { access_token: string }).access_token;
}

/** The `appIdUri` of a created resource, read back from the admin API. */
async function uriOf(app: TestApp, appId: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/admin/api/apps/${appId}` });
  return (res.json() as { appIdUri: string }).appIdUri;
}

describe('app-only roles: the auto-grant is still the default', () => {
  it('a client with no assignment gets every enabled Application role of the resource', async () => {
    ctx = await buildTestApp();
    const { appId } = await createResource(ctx, { required: false });
    expect(await appOnlyRolesFor(ctx, await uriOf(ctx, appId))).toEqual(['Tasks.Invoke']);
  });
});

describe('app-only roles: from assignments when the resource opts in', () => {
  it('carries exactly the role the calling client is assigned', async () => {
    ctx = await buildTestApp();
    const { appId, roleId } = await createResource(ctx);
    // A second Application role the client is NOT assigned: the auto-grant would include it.
    const other = await ctx.inject({
      method: 'POST',
      url: `/admin/api/apps/${appId}/roles`,
      headers: JSON_HEADERS,
      payload: { value: 'Tasks.Admin', allowedMemberTypes: ['Application'] },
    });
    expect(other.statusCode).toBe(201);

    const created = await assign(ctx, appId, {
      roleId,
      principalType: 'Application',
      principalId: DAEMON,
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { principalDisplayName: string }).principalDisplayName).toBe(
      'Sample Daemon',
    );

    expect(await appOnlyRolesFor(ctx, await uriOf(ctx, appId))).toEqual(['Tasks.Invoke']);
  });

  it('issues the token with an empty roles claim when the client holds no assignment', async () => {
    ctx = await buildTestApp();
    const { appId } = await createResource(ctx);
    expect(await appOnlyRolesFor(ctx, await uriOf(ctx, appId))).toEqual([]);
  });

  it('does not leak a role assigned to a different client', async () => {
    ctx = await buildTestApp();
    const { appId, roleId } = await createResource(ctx);
    const otherClient = await ctx.inject({
      method: 'POST',
      url: '/admin/api/apps',
      headers: JSON_HEADERS,
      payload: { displayName: 'Another Daemon', isConfidential: true },
    });
    const otherClientId = (otherClient.json() as { id: string }).id;
    expect(
      (
        await assign(ctx, appId, {
          roleId,
          principalType: 'Application',
          principalId: otherClientId,
        })
      ).statusCode,
    ).toBe(201);

    expect(await appOnlyRolesFor(ctx, await uriOf(ctx, appId))).toEqual([]);
  });

  it('omits a disabled role the client is assigned', async () => {
    ctx = await buildTestApp();
    const { appId, roleId } = await createResource(ctx, { required: true, enabled: false });
    expect(
      (await assign(ctx, appId, { roleId, principalType: 'Application', principalId: DAEMON }))
        .statusCode,
    ).toBe(201);
    expect(await appOnlyRolesFor(ctx, await uriOf(ctx, appId))).toEqual([]);
  });
});

describe('assigning a role to an application', () => {
  it('refuses a role whose member types exclude Application', async () => {
    ctx = await buildTestApp();
    const { appId, roleId } = await createResource(ctx, { required: true, memberTypes: ['User'] });
    const res = await assign(ctx, appId, {
      roleId,
      principalType: 'Application',
      principalId: DAEMON,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toContain('applications');
  });

  it('refuses an unknown client app, and the same assignment twice', async () => {
    ctx = await buildTestApp();
    const { appId, roleId } = await createResource(ctx);
    const unknown = await assign(ctx, appId, {
      roleId,
      principalType: 'Application',
      principalId: 'cccccccc-0000-0000-0000-00000000dead',
    });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('invalid_reference');

    const first = await assign(ctx, appId, {
      roleId,
      principalType: 'Application',
      principalId: DAEMON,
    });
    expect(first.statusCode).toBe(201);
    const second = await assign(ctx, appId, {
      roleId,
      principalType: 'Application',
      principalId: DAEMON,
    });
    expect(second.statusCode).toBe(409);
  });

  it('lists the assignment on the resource and removes it again', async () => {
    ctx = await buildTestApp();
    const { appId, roleId } = await createResource(ctx);
    const created = await assign(ctx, appId, {
      roleId,
      principalType: 'Application',
      principalId: DAEMON,
    });
    const assignmentId = (created.json() as { id: string }).id;

    const listed = await ctx.inject({
      method: 'GET',
      url: `/admin/api/apps/${appId}/roleAssignments`,
    });
    expect(listed.json()).toMatchObject([
      { id: assignmentId, principalType: 'Application', principalId: DAEMON },
    ]);

    const removed = await ctx.inject({
      method: 'DELETE',
      url: `/admin/api/apps/${appId}/roleAssignments/${assignmentId}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(await appOnlyRolesFor(ctx, await uriOf(ctx, appId))).toEqual([]);
  });

  it('is not listed by the Graph appRoleAssignedTo surface, which carries directory principals only', async () => {
    ctx = await buildTestApp();
    const { appId, roleId } = await createResource(ctx);
    expect(
      (await assign(ctx, appId, { roleId, principalType: 'Application', principalId: DAEMON }))
        .statusCode,
    ).toBe(201);
    // The admin API does list it, so the two surfaces are being compared on the same row.
    expect(
      (await ctx.inject({ method: 'GET', url: `/admin/api/apps/${appId}/roleAssignments` })).json(),
    ).toHaveLength(1);

    const bearer = await appOnlyGraphToken(ctx);
    const res = await ctx.inject({
      method: 'GET',
      url: `/graph/v1.0/servicePrincipals/${appId}/appRoleAssignedTo`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { value: unknown[] }).value).toEqual([]);
  });
});
