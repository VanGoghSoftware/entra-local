import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppDetail } from './AppDetail';
import type { App, AppRoleAssignment } from '../api/types';
import { installFetch, paged } from '../test/server';
import { renderWithProviders } from '../test/utils';

const APP_ID = 'cccccccc-0000-0000-0000-000000000006';
const READ_ROLE = 'eeeeeeee-0000-0000-0000-000000000002';
const APPROVE_ROLE = 'eeeeeeee-0000-0000-0000-000000000003';

function app(over: Partial<App> = {}): App {
  return {
    id: APP_ID,
    displayName: 'local-web-client',
    isConfidential: false,
    appIdUri: `api://${APP_ID}`,
    redirectUris: [],
    exposedScopes: [],
    appRoles: [
      {
        id: READ_ROLE,
        value: 'Tasks.Read',
        displayName: 'Read tasks',
        allowedMemberTypes: ['User'],
        isEnabled: true,
      },
      {
        id: APPROVE_ROLE,
        value: 'Tasks.Approve',
        displayName: null,
        allowedMemberTypes: ['User'],
        isEnabled: true,
      },
      {
        id: 'r-daemon',
        value: 'Tasks.Sync',
        displayName: null,
        allowedMemberTypes: ['Application'],
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

const ALICE = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  userPrincipalName: 'alice@entralocal.dev',
  displayName: 'Alice Example',
  givenName: 'Alice',
  surname: 'Example',
  mail: 'alice@entralocal.dev',
  accountEnabled: true,
  hasPassword: true,
  createdAt: '2026-06-22T00:00:00.000Z',
};

const SEEDED: AppRoleAssignment = {
  id: 'abababab-0000-0000-0000-000000000001',
  appId: APP_ID,
  roleId: APPROVE_ROLE,
  roleValue: 'Tasks.Approve',
  principalType: 'User',
  principalId: ALICE.id,
  principalDisplayName: 'Alice Example',
  createdAt: '2026-09-13T10:00:00.000Z',
};

function renderDetail(): void {
  renderWithProviders(<AppDetail />, { path: 'apps/:id', initialEntries: [`/apps/${APP_ID}`] });
}

describe('AppDetail — Users and groups (app role assignments)', () => {
  it('lists assignments, adds one for a user, and removes one', async () => {
    const posted: unknown[] = [];
    const deleted: string[] = [];
    let assignments: AppRoleAssignment[] = [SEEDED];
    installFetch(({ method, path, body }) => {
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}`) return { body: app() };
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}/roleAssignments`) {
        return { body: assignments };
      }
      if (method === 'GET' && path.startsWith('/admin/api/users')) return paged([ALICE]);
      if (method === 'POST' && path === `/admin/api/apps/${APP_ID}/roleAssignments`) {
        posted.push(body);
        const created: AppRoleAssignment = {
          ...SEEDED,
          id: 'new-assignment',
          roleId: READ_ROLE,
          roleValue: 'Tasks.Read',
        };
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

    await userEvent.click(await screen.findByRole('tab', { name: 'Users and groups' }));
    await screen.findByRole('heading', { name: 'Users and groups' });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Alice Example')).toBeInTheDocument();
    expect(within(table).getByText('Tasks.Approve')).toBeInTheDocument();

    // Add: only User-type roles are offered.
    await userEvent.click(screen.getByRole('button', { name: '＋ Add assignment' }));
    const roleSelect = await screen.findByLabelText('Role');
    expect(within(roleSelect).queryByRole('option', { name: 'Tasks.Sync' })).toBeNull();
    await userEvent.selectOptions(await screen.findByLabelText('Principal'), ALICE.id);
    await userEvent.selectOptions(roleSelect, READ_ROLE);
    await userEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(posted).toEqual([{ roleId: READ_ROLE, principalType: 'User', principalId: ALICE.id }]);
    expect(await screen.findByText('Tasks.Read')).toBeInTheDocument();

    // Remove the seeded one.
    const rows = screen.getAllByRole('row');
    const aliceApproveRow = rows.find((r) => within(r).queryByText('Tasks.Approve'))!;
    await userEvent.click(within(aliceApproveRow).getByRole('button', { name: 'Remove' }));
    expect(deleted).toEqual([SEEDED.id]);
  });

  it('shows the empty state and toggles "Assignment required"', async () => {
    const patched: unknown[] = [];
    installFetch(({ method, path, body }) => {
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}`) return { body: app() };
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}/roleAssignments`)
        return { body: [] };
      if (method === 'PATCH' && path === `/admin/api/apps/${APP_ID}`) {
        patched.push(body);
        return { body: app({ appRoleAssignmentRequired: true }) };
      }
      return undefined;
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: 'Users and groups' }));
    expect(await screen.findByText(/No users or groups are assigned/)).toBeInTheDocument();

    const toggle = screen.getByRole('switch', { name: 'Assignment required' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    expect(patched).toEqual([{ appRoleAssignmentRequired: true }]);
  });

  it('disables adding when no role can be held by a user, and says why beside the button', async () => {
    installFetch(({ method, path }) => {
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}`) {
        // Only an Application-type role: nothing here can be assigned to a user or a group.
        return {
          body: app({
            appRoles: [
              {
                id: 'r-daemon',
                value: 'Tasks.Sync',
                displayName: null,
                allowedMemberTypes: ['Application'],
                isEnabled: true,
              },
            ],
          }),
        };
      }
      if (method === 'GET' && path === `/admin/api/apps/${APP_ID}/roleAssignments`)
        return { body: [] };
      return undefined;
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('tab', { name: 'Users and groups' }));
    expect(await screen.findByRole('button', { name: '＋ Add assignment' })).toBeDisabled();
    expect(
      screen.getByText(/is disabled because this app defines no enabled app role/),
    ).toBeInTheDocument();
  });
});
