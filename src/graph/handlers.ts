import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { Config } from '../config/schema.js';
import { extractBearer } from '../identity/bearer.js';
import { graphMetadataContextUrl, graphPublicUrl } from '../http/pathmap.js';
import type { AppRoleAssignment, Group, User } from '../store/types.js';
import type { Store } from '../store/store.js';
import type { AccessTokenClaims } from '../tokens/claims.js';
import type { TokenService } from '../tokens/service.js';

/**
 * Minimal read-only Microsoft Graph (feature #10): `GET /graph/v1.0/{me,users,users/{id},groups,
 * groups/{id},groups/{id}/members}`. Replaces the reserved `501` stubs. Every endpoint validates the
 * caller's Bearer access token via the #5 token service against the live JWKS/issuer, requiring the
 * Graph audience (`GRAPH_RESOURCE_ID`) and accepting the emulator's `ver:"2.0"` tokens. This is where
 * the mint→consume loop closes: a token minted by #5/#6/#8 is consumed here.
 *
 * Also read-only, app role assignments: `GET /graph/v1.0/{me,users/{id},groups/{id}}
 * /appRoleAssignments` and `/servicePrincipals/{id}/appRoleAssignedTo`. Divergence: Entra Local has
 * no service principals, so `resourceId` on an assignment is the resource app's `appId`, and
 * `/servicePrincipals/{id}` takes that same `appId`.
 *
 * Authorization model (owned by this feature's spec): possession of a valid Graph-audience token is
 * sufficient — no fine-grained Graph scope/role enforcement in MVP. `/me` additionally requires a
 * delegated (user) token carrying `oid`; an app-only token → 403. Responses are Graph-shaped
 * (`@odata.context` derived from the Graph origin, collections in `value[]`, OData offset paging via
 * `@odata.nextLink`). Errors use the Graph error body `{ error: { code, message } }` (distinct from
 * the OAuth surface), never SPA HTML.
 */

export interface GraphDeps {
  store: Store;
  tokenService: TokenService;
  config: Config;
}

/** Graph-shaped error body (`microsoft.graph` style). */
interface GraphErrorBody {
  error: { code: string; message: string };
}

/** Graph `microsoft.graph.user` subset returned by this emulator. */
interface GraphUser {
  '@odata.context'?: string;
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail: string | null;
  givenName: string | null;
  surname: string | null;
  accountEnabled: boolean;
}

/** Graph `microsoft.graph.group` subset returned by this emulator. */
interface GraphGroup {
  '@odata.context'?: string;
  id: string;
  displayName: string;
  description: string | null;
  mailEnabled: boolean;
  securityEnabled: boolean;
}

/**
 * Graph `microsoft.graph.appRoleAssignment` subset. Divergence: Entra Local has no service
 * principals, so `resourceId` is the resource app's `appId` (and `/servicePrincipals/{id}` takes it).
 */
interface GraphAppRoleAssignment {
  id: string;
  appRoleId: string;
  createdDateTime: string;
  deletedDateTime: null;
  principalDisplayName: string;
  principalId: string;
  principalType: 'User' | 'Group';
  resourceDisplayName: string;
  resourceId: string;
}

/** Default page size and hard cap for `$top` (mirrors real Graph defaults). */
const DEFAULT_TOP = 100;
const MAX_TOP = 999;

/** Build a `@odata.context` URL on the Graph base for the given `$metadata#<suffix>`. */
function odataContext(config: Config, suffix: string): string {
  return graphMetadataContextUrl(config, suffix);
}

/** Send a Graph-shaped error. `401` additionally emits the RFC 6750 `WWW-Authenticate` header. */
function sendGraphError(
  reply: FastifyReply,
  status: 401 | 403 | 404,
  code: string,
  message: string,
): void {
  if (status === 401) {
    void reply.header('www-authenticate', 'Bearer error="invalid_token"');
  }
  void reply
    .code(status)
    .type('application/json')
    .send({ error: { code, message } } satisfies GraphErrorBody);
}

/** Map a store user to the curated Graph user shape (optionally with the `$entity` context). */
function toGraphUser(user: User, context?: string): GraphUser {
  return {
    ...(context !== undefined ? { '@odata.context': context } : {}),
    id: user.id,
    displayName: user.displayName,
    userPrincipalName: user.userPrincipalName,
    mail: user.mail,
    givenName: user.givenName,
    surname: user.surname,
    accountEnabled: user.accountEnabled,
  };
}

/** Map a store group to the curated Graph group shape (optionally with the `$entity` context). */
function toGraphGroup(group: Group, context?: string): GraphGroup {
  return {
    ...(context !== undefined ? { '@odata.context': context } : {}),
    id: group.id,
    displayName: group.displayName,
    description: group.description,
    mailEnabled: false,
    securityEnabled: true,
  };
}

/** An assignment held by a directory principal — the only kind Graph lists (see below). */
type DirectoryAppRoleAssignment = AppRoleAssignment & { principalType: 'User' | 'Group' };

/**
 * Graph lists assignments held by **directory** principals. An assignment held by a client
 * application is an admin-API and portal surface only: the roadmap defers broader Graph app-role
 * surfaces, and this emulator has no service-principal objects to name such a principal with.
 */
function isDirectoryAssignment(a: AppRoleAssignment): a is DirectoryAppRoleAssignment {
  return a.principalType !== 'Application';
}

/** Map a store assignment to the Graph shape, resolving the display names it carries. */
function toGraphAppRoleAssignment(
  store: Store,
  a: DirectoryAppRoleAssignment,
): GraphAppRoleAssignment {
  const principalDisplayName =
    a.principalType === 'User'
      ? store.users.getById(a.principalId)?.displayName
      : store.groups.getById(a.principalId)?.displayName;
  return {
    id: a.id,
    appRoleId: a.roleId,
    createdDateTime: new Date(a.createdAt * 1000).toISOString(),
    deletedDateTime: null,
    principalDisplayName: principalDisplayName ?? a.principalId,
    principalId: a.principalId,
    principalType: a.principalType,
    resourceDisplayName: store.apps.getByAppId(a.appId)?.displayName ?? a.appId,
    resourceId: a.appId,
  };
}

/** Read a single query value (first element when Fastify parsed a repeated key as an array). */
function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Parse `$top`: a positive integer clamped to `[1, MAX_TOP]`; invalid/absent → `DEFAULT_TOP`. */
function parseTop(raw: string | string[] | undefined): number {
  const n = Number(firstValue(raw));
  if (!Number.isInteger(n) || n < 1) return DEFAULT_TOP;
  return Math.min(n, MAX_TOP);
}

/** Parse `$skiptoken` (opaque emulator integer offset): a non-negative integer; invalid → `0`. */
function parseSkip(raw: string | string[] | undefined): number {
  const n = Number(firstValue(raw));
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * Build the `@odata.nextLink` for the next page. Preserves *all* of the caller's original query
 * parameters (notably `$top`, so the page size is stable across continuations) and overrides only
 * `$skiptoken`. `$`-prefixed OData keys are kept literal (only values are percent-encoded).
 */
function buildNextLink(request: FastifyRequest, config: Config, nextSkip: number): string {
  const path = request.url.split('?')[0] ?? request.url;
  const query = request.query as Record<string, string | string[] | undefined>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (key === '$skiptoken' || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) parts.push(`${key}=${encodeURIComponent(String(v))}`);
  }
  parts.push(`$skiptoken=${nextSkip}`);
  return `${graphPublicUrl(config, path)}?${parts.join('&')}`;
}

/** Emit an OData collection envelope with `value[]` and a `@odata.nextLink` only when more remain. */
function sendCollection<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  contextSuffix: string,
  total: number,
  getPage: (skip: number, top: number) => T[],
): void {
  const top = parseTop((request.query as Record<string, string | string[] | undefined>)['$top']);
  const skip = parseSkip(
    (request.query as Record<string, string | string[] | undefined>)['$skiptoken'],
  );
  const value = getPage(skip, top);
  const body: { '@odata.context': string; value: T[]; '@odata.nextLink'?: string } = {
    '@odata.context': odataContext(config, contextSuffix),
    value,
  };
  if (skip + top < total) {
    body['@odata.nextLink'] = buildNextLink(request, config, skip + top);
  }
  void reply.code(200).type('application/json').send(body);
}

/** The bound Graph route handlers, ready to register under the `/graph` plugin. */
export interface GraphHandlers {
  me: RouteHandlerMethod;
  meMemberOf: RouteHandlerMethod;
  listUsers: RouteHandlerMethod;
  getUser: RouteHandlerMethod;
  getUserMemberOf: RouteHandlerMethod;
  listGroups: RouteHandlerMethod;
  getGroup: RouteHandlerMethod;
  listGroupMembers: RouteHandlerMethod;
  meAppRoleAssignments: RouteHandlerMethod;
  getUserAppRoleAssignments: RouteHandlerMethod;
  getGroupAppRoleAssignments: RouteHandlerMethod;
  getServicePrincipalAppRoleAssignedTo: RouteHandlerMethod;
}

/** Build the Graph handlers bound to the store, token service and config. */
export function createGraphHandlers(deps: GraphDeps): GraphHandlers {
  const { store, tokenService, config } = deps;

  /**
   * Validate the request's Bearer token for the Graph audience. On success returns the decoded
   * claims; on any failure it sends a `401 InvalidAuthenticationToken` and returns `undefined`.
   */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AccessTokenClaims | undefined> {
    const bearer = extractBearer(request.headers.authorization);
    if (!bearer) {
      sendGraphError(reply, 401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.');
      return undefined;
    }
    const result = await tokenService.validateAccessToken(bearer, {
      audience: config.graphResourceId,
    });
    if (!result.valid) {
      sendGraphError(reply, 401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.');
      return undefined;
    }
    return result.claims;
  }

  return {
    async me(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      if (claims.oid == null || claims.oid === '') {
        sendGraphError(
          reply,
          403,
          'Authorization_RequestDenied',
          '/me requires a delegated user token.',
        );
        return;
      }
      const user = store.users.getById(claims.oid);
      if (!user) {
        sendGraphError(reply, 404, 'Request_ResourceNotFound', 'The signed-in user was not found.');
        return;
      }
      void reply
        .code(200)
        .type('application/json')
        .send(toGraphUser(user, odataContext(config, 'users/$entity')));
    },

    async meMemberOf(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      if (claims.oid == null || claims.oid === '') {
        sendGraphError(
          reply,
          403,
          'Authorization_RequestDenied',
          '/me/memberOf requires a delegated user token.',
        );
        return;
      }
      if (!store.users.getById(claims.oid)) {
        sendGraphError(reply, 404, 'Request_ResourceNotFound', 'The signed-in user was not found.');
        return;
      }
      const groups = store.groups.listGroupsForUser(claims.oid);
      sendCollection(request, reply, config, 'directoryObjects', groups.length, (skip, top) =>
        groups.slice(skip, skip + top).map((g) => toGraphGroup(g)),
      );
    },

    async listUsers(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      sendCollection(request, reply, config, 'users', store.users.count(), (skip, top) =>
        store.users.list({ skip, top }).map((u) => toGraphUser(u)),
      );
    },

    async getUser(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      const id = (request.params as { id: string }).id;
      const user = store.users.getById(id) ?? store.users.getByUpn(id);
      if (!user) {
        sendGraphError(
          reply,
          404,
          'Request_ResourceNotFound',
          `No user matches the identifier '${id}'.`,
        );
        return;
      }
      void reply
        .code(200)
        .type('application/json')
        .send(toGraphUser(user, odataContext(config, 'users/$entity')));
    },

    async getUserMemberOf(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      const id = (request.params as { id: string }).id;
      const user = store.users.getById(id) ?? store.users.getByUpn(id);
      if (!user) {
        sendGraphError(
          reply,
          404,
          'Request_ResourceNotFound',
          `No user matches the identifier '${id}'.`,
        );
        return;
      }
      const groups = store.groups.listGroupsForUser(user.id);
      sendCollection(request, reply, config, 'directoryObjects', groups.length, (skip, top) =>
        groups.slice(skip, skip + top).map((g) => toGraphGroup(g)),
      );
    },

    async listGroups(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      sendCollection(request, reply, config, 'groups', store.groups.count(), (skip, top) =>
        store.groups.list({ skip, top }).map((g) => toGraphGroup(g)),
      );
    },

    async getGroup(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      const id = (request.params as { id: string }).id;
      const group = store.groups.getById(id);
      if (!group) {
        sendGraphError(
          reply,
          404,
          'Request_ResourceNotFound',
          `No group matches the identifier '${id}'.`,
        );
        return;
      }
      void reply
        .code(200)
        .type('application/json')
        .send(toGraphGroup(group, odataContext(config, 'groups/$entity')));
    },

    async listGroupMembers(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      const id = (request.params as { id: string }).id;
      if (!store.groups.getById(id)) {
        sendGraphError(
          reply,
          404,
          'Request_ResourceNotFound',
          `No group matches the identifier '${id}'.`,
        );
        return;
      }
      const members = store.groups.listMembers(id);
      sendCollection(request, reply, config, 'directoryObjects', members.length, (skip, top) =>
        members.slice(skip, skip + top).map((u) => toGraphUser(u)),
      );
    },

    async meAppRoleAssignments(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      if (claims.oid == null || claims.oid === '') {
        sendGraphError(
          reply,
          403,
          'Authorization_RequestDenied',
          '/me/appRoleAssignments requires a delegated user token.',
        );
        return;
      }
      if (!store.users.getById(claims.oid)) {
        sendGraphError(reply, 404, 'Request_ResourceNotFound', 'The signed-in user was not found.');
        return;
      }
      const items = store.appRoleAssignments.listForUser(claims.oid).filter(isDirectoryAssignment);
      sendCollection(
        request,
        reply,
        config,
        `users('${claims.oid}')/appRoleAssignments`,
        items.length,
        (skip, top) => items.slice(skip, skip + top).map((a) => toGraphAppRoleAssignment(store, a)),
      );
    },

    async getUserAppRoleAssignments(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      const id = (request.params as { id: string }).id;
      const user = store.users.getById(id) ?? store.users.getByUpn(id);
      if (!user) {
        sendGraphError(
          reply,
          404,
          'Request_ResourceNotFound',
          `No user matches the identifier '${id}'.`,
        );
        return;
      }
      const items = store.appRoleAssignments.listForUser(user.id).filter(isDirectoryAssignment);
      sendCollection(
        request,
        reply,
        config,
        `users('${user.id}')/appRoleAssignments`,
        items.length,
        (skip, top) => items.slice(skip, skip + top).map((a) => toGraphAppRoleAssignment(store, a)),
      );
    },

    async getGroupAppRoleAssignments(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      const id = (request.params as { id: string }).id;
      if (!store.groups.getById(id)) {
        sendGraphError(
          reply,
          404,
          'Request_ResourceNotFound',
          `No group matches the identifier '${id}'.`,
        );
        return;
      }
      const items = store.appRoleAssignments.listForGroup(id).filter(isDirectoryAssignment);
      sendCollection(
        request,
        reply,
        config,
        `groups('${id}')/appRoleAssignments`,
        items.length,
        (skip, top) => items.slice(skip, skip + top).map((a) => toGraphAppRoleAssignment(store, a)),
      );
    },

    async getServicePrincipalAppRoleAssignedTo(request, reply) {
      const claims = await authenticate(request, reply);
      if (!claims) return;
      const id = (request.params as { id: string }).id;
      if (!store.apps.getByAppId(id)) {
        sendGraphError(
          reply,
          404,
          'Request_ResourceNotFound',
          `No service principal matches the identifier '${id}'.`,
        );
        return;
      }
      const items = store.appRoleAssignments.listForApp(id).filter(isDirectoryAssignment);
      sendCollection(
        request,
        reply,
        config,
        `servicePrincipals('${id}')/appRoleAssignedTo`,
        items.length,
        (skip, top) => items.slice(skip, skip + top).map((a) => toGraphAppRoleAssignment(store, a)),
      );
    },
  };
}
