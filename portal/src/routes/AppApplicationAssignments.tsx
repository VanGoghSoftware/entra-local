import { useCallback, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { App, AppRoleAssignment, Paged } from '../api/types';
import { useAsync } from '../hooks/useAsync';
import { useShell } from '../hooks/useToast';
import { Button } from '../components/Button';
import { Select, Toggle } from '../components/Fields';
import { IdChip } from '../components/IdChip';
import { SkeletonRows } from '../components/States';

/**
 * "Applications": which client applications hold which app role on this app, plus the switch that
 * makes app-only tokens carry the assigned roles instead of every enabled `Application` role. Only
 * enabled roles whose `allowedMemberTypes` include `Application` can be assigned; the API refuses
 * anything else, and the picker never offers it.
 */
export function AppApplicationAssignmentList({
  app,
  onChange,
}: {
  app: App;
  onChange: () => void;
}): JSX.Element {
  const { toast } = useShell();
  const load = useCallback(() => api.listRoleAssignments(app.id), [app.id]);
  const { data: assignments, loading, reload } = useAsync<AppRoleAssignment[]>(load, [app.id]);

  const loadClients = useCallback(() => api.listApps({ top: 200 }), []);
  const { data: clients } = useAsync<Paged<App>>(loadClients, []);

  const [adding, setAdding] = useState(false);
  const [clientId, setClientId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const assignableRoles = app.appRoles.filter(
    (role) => role.isEnabled && role.allowedMemberTypes.includes('Application'),
  );
  const applicationAssignments = assignments?.filter(
    (assignment) => assignment.principalType === 'Application',
  );
  // Only a confidential client can use the client-credentials grant, so only one can hold an
  // app-only role in a way that is ever observable.
  const assignableClients = (clients?.value ?? []).filter((candidate) => candidate.isConfidential);

  async function add(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await api.addRoleAssignment(app.id, {
        roleId,
        principalType: 'Application',
        principalId: clientId,
      });
      toast('Role assigned.');
      setClientId('');
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
      await api.updateApp(app.id, { appOnlyRoleAssignmentRequired: next });
      toast(
        next
          ? 'App-only roles now come from assignments.'
          : 'App-only roles are auto-granted again.',
      );
      onChange();
    } catch {
      toast("Couldn't update the setting.", 'bad');
    }
  }

  return (
    <section className="card flush">
      <div className="card-head">
        <h2 className="h-md">Applications</h2>
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
          checked={app.appOnlyRoleAssignmentRequired}
          onChange={(next) => void toggleRequired(next)}
          label={<span>Assignment required</span>}
        />
        <span className="muted">
          When enabled, an app-only token carries the roles its client is assigned here. When
          disabled, every client calling this API gets every enabled <code>Application</code> role.
        </span>
        {assignableRoles.length === 0 && (
          <span className="muted">
            <strong>Add assignment</strong> is disabled because this app defines no enabled app role
            whose member types include <code>Application</code>. Create one under{' '}
            <strong>App roles</strong>.
          </span>
        )}
      </div>
      <div className="dt-scroll">
        <table className="dt">
          <thead>
            <tr>
              <th>Application</th>
              <th>Role</th>
              <th>Assigned</th>
              <th className="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {loading && !assignments && <SkeletonRows rows={2} cols={4} />}
            {applicationAssignments && applicationAssignments.length === 0 && (
              <tr>
                <td colSpan={4} className="muted b-sm">
                  No applications are assigned.
                </td>
              </tr>
            )}
            {applicationAssignments?.map((assignment) => (
              <tr key={assignment.id}>
                <td>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {assignment.principalDisplayName}
                    <IdChip value={assignment.principalId} title="Client id" />
                  </span>
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
      </div>
      {adding && (
        <div className="add-row">
          <Select
            aria-label="Application"
            style={{ flex: '1 1 180px', minWidth: 160 }}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">Choose…</option>
            {assignableClients.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Role"
            style={{ flex: '1 1 180px', minWidth: 160 }}
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
          >
            <option value="">Choose a role…</option>
            {assignableRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.value}
              </option>
            ))}
          </Select>
          <Button onClick={() => void add()} busy={busy} disabled={!clientId || !roleId}>
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
