import { useCallback, useEffect, useState } from 'react';
import api from '../utils/api.util';
import App from '../App';
import '../styles/auth.css';

const roles = ['viewer', 'member', 'admin'];
const roleHelp = {
  viewer: 'Read permitted documents and chat',
  member: 'Upload documents, read and chat',
  admin: 'Approve and delete documents; invite viewers and members',
  owner: 'Manage all workspace access and grant admin roles',
};

function errorMessage(error) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((entry) => entry.msg).join('. ');
  return error?.response ? 'The request failed. Please try again.' : 'Cannot connect to the API. Check that the backend is running.';
}

function AccountForm({ onAuthenticated }) {
  const invitation = new URLSearchParams(window.location.search).get('invite');
  const [mode, setMode] = useState(invitation ? 'invite' : 'register');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({ name: '', email: '', password: '', workspace_name: '' });
  const update = (event) => setFields((previous) => ({ ...previous, [event.target.name]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const endpoint = mode === 'invite' ? 'accept-invite' : mode;
      await api.post(`/auth/${endpoint}`, { ...fields, token: invitation });
      window.history.replaceState({}, '', '/');
      await onAuthenticated();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="dc-auth-page">
      <section className="dc-auth-card">
        <p className="dc-auth-eyebrow">DEEPCONTEXT · KNOWLEDGE ENGINE</p>
        <h1>{mode === 'register' ? 'Create your workspace' : mode === 'invite' ? 'Join your workspace' : 'Welcome back'}</h1>
        <p className="dc-auth-description">{mode === 'register'
          ? 'Create your account and a private home for your team’s knowledge. You’ll be the workspace owner.'
          : mode === 'invite' ? 'Use the invited email address. If you already have an account, enter your existing password.'
            : 'Sign in to access your workspace and its documents.'}</p>
        <form onSubmit={submit} className="dc-auth-form">
          {mode !== 'login' && <label>Your name<input name="name" required maxLength={100} autoComplete="name" value={fields.name} onChange={update} /></label>}
          {mode === 'register' && <label>Workspace name<input name="workspace_name" required maxLength={100} placeholder="e.g. Product team" value={fields.workspace_name} onChange={update} /></label>}
          <label>Email<input name="email" type="email" required autoComplete="email" value={fields.email} onChange={update} /></label>
          <label>Password<input name="password" type="password" required minLength={12} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={fields.password} onChange={update} /><small>At least 12 characters</small></label>
          {error && <p className="dc-auth-error" role="alert">{error}</p>}
          <button className="dc-auth-primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'register' ? 'Create workspace' : mode === 'invite' ? 'Join workspace' : 'Sign in'}</button>
        </form>
        {mode !== 'invite' && <button className="dc-auth-link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? 'New here? Create a workspace' : 'Already have an account? Sign in'}
        </button>}
      </section>
    </main>
  );
}

function WorkspaceSettings({ account, refresh, onClose }) {
  const user = account.user;
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [workspaceName, setWorkspaceName] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = ['admin', 'owner'].includes(user.role);
  const loadMembers = useCallback(async () => {
    if (canManage) setMembers((await api.get('/auth/members')).data.members);
  }, [canManage]);
  useEffect(() => { loadMembers().catch((failure) => setError(errorMessage(failure))); }, [loadMembers]);
  useEffect(() => {
    const escape = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);

  const act = async (operation) => {
    setBusy(true);
    setError('');
    try { await operation(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };

  return <div className="dc-auth-overlay">
    <section className="dc-auth-card dc-workspace-settings" role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title">
      <div className="dc-auth-row"><h2 id="workspace-settings-title">{user.workspace_name}</h2><button onClick={onClose} aria-label="Close workspace settings">Close</button></div>
      <p className="dc-auth-description">Your role: <strong>{user.role}</strong> · {roleHelp[user.role]}</p>
      {error && <p className="dc-auth-error" role="alert">{error}</p>}
      {canManage && <>
        <h3>Invite someone</h3>
        <form className="dc-auth-form" onSubmit={(event) => { event.preventDefault(); act(async () => {
          const { data } = await api.post('/auth/invitations', { email, role });
          setInviteLink(`${window.location.origin}/?invite=${encodeURIComponent(data.invite_token)}`);
        }); }}>
          <label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Access level<select value={role} onChange={(event) => setRole(event.target.value)}>{roles.filter((value) => value !== 'admin' || user.role === 'owner').map((value) => <option key={value} value={value}>{value} — {roleHelp[value]}</option>)}</select></label>
          <button className="dc-auth-primary" disabled={busy}>Create invitation link</button>
        </form>
        {inviteLink && <label className="dc-invite-result">Share this link with {email}. It expires in 7 days.<input readOnly value={inviteLink} onFocus={(event) => event.target.select()} aria-label="Invitation link" /><small>The link is shown here; no email is sent automatically.</small></label>}
        <h3>Workspace members</h3>
        <div className="dc-member-list">{members.map((member) => <div key={member.id} className="dc-member-row">
          <div><strong>{member.name}</strong><small>{member.email}</small></div>
          {user.role === 'owner' && member.role !== 'owner' ? <>
            <select aria-label={`Role for ${member.name}`} value={member.role} disabled={busy} onChange={(event) => act(async () => {
              await api.patch(`/auth/members/${member.id}`, { role: event.target.value }); await loadMembers();
            })}>{roles.map((value) => <option key={value}>{value}</option>)}</select>
            <button disabled={busy} onClick={() => act(async () => { await api.delete(`/auth/members/${member.id}`); await loadMembers(); })}>Revoke access</button>
          </> : <span>{member.role}</span>}
        </div>)}</div>
      </>}
      <h3>Create another workspace</h3>
      <form className="dc-auth-form" onSubmit={(event) => { event.preventDefault(); act(async () => {
        await api.post('/auth/workspaces', { name: workspaceName }); await refresh(); onClose();
      }); }}>
        <label>Workspace name<input required maxLength={100} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
        <button disabled={busy}>Create workspace</button>
      </form>
    </section>
  </div>;
}

export default function AuthShell() {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      setAccount(data);
      setError('');
    } catch (failure) {
      setAccount(null);
      if (failure?.response?.status !== 401) setError(errorMessage(failure));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    refresh();
    const expired = () => { setAccount(null); setSettings(false); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('auth-expired', expired);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('auth-expired', expired); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  if (loading) return <main className="dc-auth-page">Loading your workspace…</main>;
  if (!account || new URLSearchParams(window.location.search).has('invite')) return <>{error && <p role="alert" className="dc-auth-error">{error}</p>}<AccountForm onAuthenticated={refresh} /></>;
  const user = { ...account.user, username: `${account.user.workspace_id}:${account.user.id}:${account.user.role}` };
  return <div className="dc-authenticated-app">
    <header className="dc-workspace-bar">
      <select aria-label="Active workspace" value={user.workspace_id} onChange={async (event) => {
        try { await api.post('/auth/switch-workspace', { workspace_id: event.target.value }); await refresh(); } catch (failure) { setError(errorMessage(failure)); }
      }}>{account.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>
      <span>{user.name} · {user.role}</span>
      <button onClick={() => setSettings(true)}>Workspace settings</button>
      <button onClick={async () => {
        try { await api.post('/auth/logout'); setAccount(null); setSettings(false); } catch (failure) { setError(errorMessage(failure)); }
      }}>Sign out</button>
    </header>
    {error && <p className="dc-auth-error" role="alert">{error}</p>}
    <div className="dc-workspace-body"><App key={user.username} user={user} /></div>
    {settings && <WorkspaceSettings account={account} refresh={refresh} onClose={() => setSettings(false)} />}
  </div>;
}
