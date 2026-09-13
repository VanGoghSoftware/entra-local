import { useCallback, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { App, AppRoleAssignment, Group, Paged, PrincipalType, User } from '../api/types';
import { useAsync } from '../hooks/useAsync';
import { useShell } from '../hooks/useToast';
import { Button } from '../components/Button';
import { Select, Toggle } from '../components/Fields';
import { IdChip } from '../components/IdChip';
import { SkeletonRows } from '../components/States';

/**
 * "Users and groups": who holds which app role on this app, plus Entra's "assignment required"
 * switch. Only enabled roles whose `allowedMemberTypes` include `User` can be assigned; the API
 * refuses anything else, and the picker never offers it.
 */
export function AppRoleAssignmentList({
  app,
  onChange,
}: {
  app: App;
  onChange: () => void;
}): JSX.Element {
  const { toast } = useShell();
  const load = useCallback(() => api.listRoleAssignments(app.id), [app.id]);
  const { data: assignments, loading, reload } = useAsync<AppRoleAssignment[]>(load, [app.id]);

  const [adding, setAdding] = useState(false);
  const [principalType, setPrincipalType] = useState<PrincipalType>('User');
  const [principalId, setPrincipalId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const loadPrincipals = useCallback(
    (): Promise<Paged<User> | Paged<Group>> =>
      principalType === 'User' ? api.listUsers({ top: 200 }) : api.listGroups({ top: 200 }),
    [principalType],
  );
  const { data: principals } = useAsync<Paged<User> | Paged<Group>>(loadPrincipals, [
    principalType,
  ]);

  const assignableRoles = app.appRoles.filter(
    (role) => role.isEnabled && role.allowedMemberTypes.includes('User'),
  );

  async function add(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await api.addRoleAssignment(app.id, { roleId, principalType, principalId });
      toast('Role assigned.');
      setPrincipalId('');
      setRoleId('');
      setAdding(false);
      reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Unexpected error.';
      setError(message);
      toast(message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function remove(assignment: AppRoleAssignment): Promise<void> {
    try {
      await api.removeRoleAssignment(app.id, assignment.id);
      toast('Assignment removed.');
      reload();
    } catch {
      toast("Couldn't remove the assignment.", 'bad');
    }
  }

  async function toggleRequired(next: boolean): Promise<void> {
    try {
      await api.updateApp(app.id, { appRoleAssignmentRequired: next });
      toast(next ? 'Assignment is now required to sign in.' : 'Assignment is no longer required.');
      onChange();
    } catch {
      toast("Couldn't update the setting.", 'bad');
    }
  }

  return (
    <section className="card flush">
      <div className="card-head">
        <h2 className="h-md">Users and groups</h2>
        <Button
          size="sm"
          onClick={() => setAdding((v) => !v)}
          disabled={assignableRoles.length === 0}
        >
          ＋ Add assignment
        </Button>
      </div>
      <div className="b-sm" style={{ padding: '12px 16px', display: 'grid', gap: 4 }}>
        <Toggle
          checked={app.appRoleAssignmentRequired}
          onChange={(next) => void toggleRequired(next)}
          label={<span>Assignment required</span>}
        />
        <span className="muted">
          When enabled, users without an assignment are refused at sign-in (AADSTS50105).
        </span>
        {/* The reason a disabled control is disabled belongs beside it, not below the table. */}
        {assignableRoles.length === 0 && (
          <span className="muted">
            <strong>Add assignment</strong> is disabled because this app defines no enabled app role
            whose member types include <code>User</code>. Create one under{' '}
            <strong>App roles</strong>.
          </span>
        )}
      </div>
      <table className="dt">
        <thead>
          <tr>
            <th>Principal</th>
            <th>Type</th>
            <th>Role</th>
            <th>Assigned</th>
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          {loading && !assignments && <SkeletonRows rows={2} cols={5} />}
          {assignments && assignments.length === 0 && (
            <tr>
              <td colSpan={5} className="muted b-sm">
                No users or groups are assigned. Sign-ins succeed without a `roles` claim.
              </td>
            </tr>
          )}
          {assignments?.map((assignment) => (
            <tr key={assignment.id}>
              <td>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {assignment.principalDisplayName}
                  <IdChip value={assignment.principalId} title="Principal id" />
                </span>
              </td>
              <td>
                <span className="chip-plain">{assignment.principalType}</span>
              </td>
              <td>
                <span className="chip-plain">{assignment.roleValue}</span>
              </td>
              <td className="muted b-sm">{new Date(assignment.createdAt).toLocaleString()}</td>
              <td className="col-actions">
                <Button size="sm" onClick={() => void remove(assignment)}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {adding && (
        <div className="add-row">
          <Select
            aria-label="Principal type"
            value={principalType}
            onChange={(e) => {
              setPrincipalType(e.target.value as PrincipalType);
              setPrincipalId('');
            }}
          >
            <option value="User">User</option>
            <option value="Group">Group</option>
          </Select>
          <Select
            aria-label="Principal"
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
          >
            <option value="">Choose…</option>
            {(principals?.value ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </Select>
          <Select aria-label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">Choose a role…</option>
            {assignableRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.value}
              </option>
            ))}
          </Select>
          <Button onClick={() => void add()} busy={busy} disabled={!principalId || !roleId}>
            Assign
          </Button>
        </div>
      )}
      {error && (
        <div className="field-error" style={{ padding: '0 16px 12px' }}>
          {error}
        </div>
      )}
    </section>
  );
}
