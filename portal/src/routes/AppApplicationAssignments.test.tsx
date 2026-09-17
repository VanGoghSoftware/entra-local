import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppDetail } from './AppDetail';
import type { App, AppRoleAssignment } from '../api/types';
import { installFetch, paged } from '../test/server';
import { renderWithProviders } from '../test/utils';

const APP_ID = 'cccccccc-0000-0000-0000-000000000007';
const INVOKE_ROLE = 'eeeeeeee-0000-0000-0000-000000000010';
const USER_ROLE = 'eeeeeeee-0000-0000-0000-000000000011';
const DAEMON_ID = 'cccccccc-0000-0000-0000-000000000002';

function app(over: Partial<App> = {}): App {
  return {
    id: APP_ID,
    displayName: 'local-api',
    isConfidential: true,
    appIdUri: `api://${APP_ID}`,
    redirectUris: [],
    exposedScopes: [],
    appRoles: [
      {
        id: INVOKE_ROLE,
        value: 'Tasks.Invoke',
        displayName: 'Invoke tasks',
        allowedMemberTypes: ['Application'],
        isEnabled: true,
      },
      {
        id: USER_ROLE,
        value: 'Tasks.Read',
        displayName: null,
        allowedMemberTypes: ['User'],
        isEnabled: true,
      },
    ],
    secrets: [],
    optionalClaims: { idToken: [], accessToken: [] },
    groupMembershipClaims: 'None',
    groupOverageLimit: null,
    appRoleAssignmentRequired: false,
    appOnlyRoleAssignmentRequired: false,
    createdAt: '2026-06-22T00:00:00.000Z',
    ...over,
  };
}

const DAEMON = app({
  id: DAEMON_ID,
  displayName: 'Sample Daemon',
  appIdUri: `api://${DAEMON_ID}`,
  appRoles: [],
});
const PUBLIC_SPA = app({
  id: 'cccccccc-0000-0000-0000-000000000001',
  displayName: 'Sample SPA',
  isConfidential: false,
  appRoles: [],
});

const SEEDED: AppRoleAssignment = {
  id: 'abababab-0000-0000-0000-000000000009',
  appId: APP_ID,
  roleId: INVOKE_ROLE,
  roleValue: 'Tasks.Invoke',
  principalType: 'Application',
  principalId: DAEMON_ID,
  principalDisplayName: 'Sample Daemon',
  createdAt: '2026-09-17T10:00:00.000Z',
};

function renderDetail(): void {
  renderWithProviders(<AppDetail />, { path: 'apps/:id', initialEntries: [`/apps/${APP_ID}`] });
}

describe('AppDetail — Applications (app-only role assignments)', () => {
  it('lists application assignments, adds one for a confidential client, and removes one', async () => {
    const posted: unknown[] = [];
    const deleted: string[] = [];
    let assignments: AppRoleAssignment[] = [SEEDED];
    installFetch(({ method, path, body }) => {
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}`) return { body: app() };
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}/roleAssignments`) {
        return { body: assignments };
      }
      if (method === 'GET' && path.startsWith('/admin/api/apps')) {
        return paged([app(), DAEMON, PUBLIC_SPA]);
      }
      if (method === 'POST' && path === `/admin/api/apps/${APP_ID}/roleAssignments`) {
        posted.push(body);
        const created: AppRoleAssignment = { ...SEEDED, id: 'new-assignment' };
        assignments = [created, ...assignments];
        return { status: 201, body: created };
      }
      if (method === 'DELETE' && path.startsWith(`/admin/api/apps/${APP_ID}/roleAssignments/`)) {
        deleted.push(path.split('/').pop()!);
        assignments = assignments.filter((a) => !path.endsWith(a.id));
        return { status: 204 };
      }
      return undefined;
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: 'Applications' }));
    await screen.findByRole('heading', { name: 'Applications' });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Sample Daemon')).toBeInTheDocument();
    expect(within(table).getByText('Tasks.Invoke')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '＋ Add assignment' }));

    // Only Application-type roles are offered, and only confidential clients can hold one.
    const roleSelect = await screen.findByLabelText('Role');
    expect(within(roleSelect).queryByRole('option', { name: 'Tasks.Read' })).toBeNull();
    const clientSelect = await screen.findByLabelText('Application');
    expect(within(clientSelect).queryByRole('option', { name: 'Sample SPA' })).toBeNull();

    await userEvent.selectOptions(clientSelect, DAEMON_ID);
    await userEvent.selectOptions(roleSelect, INVOKE_ROLE);
    await userEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(posted).toEqual([
      { roleId: INVOKE_ROLE, principalType: 'Application', principalId: DAEMON_ID },
    ]);

    const rows = screen.getAllByRole('row');
    const seededRow = rows.find((r) => within(r).queryByText('Sample Daemon'))!;
    await userEvent.click(within(seededRow).getByRole('button', { name: 'Remove' }));
    expect(deleted).toHaveLength(1);
  });

  it('toggles the switch that makes app-only roles come from assignments', async () => {
    const patched: unknown[] = [];
    installFetch(({ method, path, body }) => {
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}`) return { body: app() };
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}/roleAssignments`)
        return { body: [] };
      if (method === 'GET' && path.startsWith('/admin/api/apps')) return paged([app()]);
      if (method === 'PATCH' && path === `/admin/api/apps/${APP_ID}`) {
        patched.push(body);
        return { body: app({ appOnlyRoleAssignmentRequired: true }) };
      }
      return undefined;
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: 'Applications' }));
    expect(await screen.findByText(/No applications are assigned/)).toBeInTheDocument();

    const toggle = screen.getByRole('switch', { name: 'Assignment required' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    expect(patched).toEqual([{ appOnlyRoleAssignmentRequired: true }]);
  });

  it('disables adding when no role can be held by an application, and says why', async () => {
    installFetch(({ method, path }) => {
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}`) {
        return { body: app({ appRoles: app().appRoles.filter((r) => r.id === USER_ROLE) }) };
      }
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}/roleAssignments`)
        return { body: [] };
      if (method === 'GET' && path.startsWith('/admin/api/apps')) return paged([app()]);
      return undefined;
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: 'Applications' }));
    expect(await screen.findByRole('button', { name: '＋ Add assignment' })).toBeDisabled();
    expect(
      screen.getByText(/is disabled because this app defines no enabled app role/),
    ).toBeInTheDocument();
  });

  it('keeps an application assignment out of the Users and groups section', async () => {
    installFetch(({ method, path }) => {
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}`) return { body: app() };
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}/roleAssignments`) {
        return { body: [SEEDED] };
      }
      if (method === 'GET' && path.startsWith('/admin/api/users')) return paged([]);
      if (method === 'GET' && path.startsWith('/admin/api/apps')) return paged([app(), DAEMON]);
      return undefined;
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: 'Users and groups' }));
    expect(await screen.findByText(/No users or groups are assigned/)).toBeInTheDocument();
    expect(screen.queryByText('Sample Daemon')).not.toBeInTheDocument();
  });
});
