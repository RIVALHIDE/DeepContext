import { createElement, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Building2, Check, ChevronDown, Copy, Crown, Eye, EyeOff,
  FileSearch, Link2, LoaderCircle, LockKeyhole, LogIn, LogOut, Mail,
  MessageSquareText, Plus, Settings, ShieldCheck, Sparkles, Trash2,
  User, Users, X,
} from 'lucide-react';
import api from '../utils/api.util';
import App from '../App';
import LogoLockup from './brand/LogoLockup';
import '../styles/auth.css';

const roles = ['viewer', 'member', 'editor', 'admin'];
const roleHelp = {
  viewer: 'Read permitted documents and chat',
  member: 'Upload documents, read and chat',
  editor: 'Approve, organize and manage workspace documents',
  admin: 'Manage members and invitations; includes editor permissions',
  owner: 'Manage the workspace and all access',
};
const landingFeatures = [
  { icon: FileSearch, title: 'Grounded answers', description: 'Search approved workspace knowledge with source citations.' },
  { icon: ShieldCheck, title: 'Role-aware access', description: 'Keep sensitive documents visible only to the right people.' },
  { icon: MessageSquareText, title: 'One place to collaborate', description: 'Use DeepContext AI and your Nexconn channel side by side.' },
];

function errorMessage(error) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((entry) => entry.msg).join('. ');
  return error?.response ? 'The request failed. Please try again.' : 'Cannot connect to the API. Check that the backend is running.';
}

function Field({ icon, label, hint, children }) {
  return <label className="dc-field">
    <span className="dc-field-label">{createElement(icon, { size: 14, 'aria-hidden': true })}{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>;
}

function AccountForm({ onAuthenticated }) {
  const invitation = new URLSearchParams(window.location.search).get('invite');
  const [mode, setMode] = useState(invitation ? 'invite' : 'register');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
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

  const heading = mode === 'register' ? 'Create your workspace' : mode === 'invite' ? 'Join your team' : 'Welcome back';
  const description = mode === 'register'
    ? 'Start a private knowledge workspace. You will become its owner and can invite your team next.'
    : mode === 'invite'
      ? 'Complete your profile with the email address that received this invitation.'
      : 'Sign in to continue to your documents, conversations, and workspace.';

  return <main className="dc-auth-page">
    <section className="dc-auth-landing" aria-label="DeepContext introduction">
      <div className="dc-auth-brand"><LogoLockup size={38} /></div>
      <div className="dc-auth-hero-copy">
        <span className="dc-auth-kicker"><Sparkles size={13} />AI knowledge workspace</span>
        <h1>Turn team knowledge into clear, trusted answers.</h1>
        <p>Upload documents, control who can see them, and ask questions with every answer grounded in your approved sources.</p>
      </div>
      <div className="dc-auth-feature-list">
        {landingFeatures.map((feature) => <div className="dc-auth-feature" key={feature.title}>
          <span>{createElement(feature.icon, { size: 18, 'aria-hidden': true })}</span>
          <div><strong>{feature.title}</strong><p>{feature.description}</p></div>
        </div>)}
      </div>
      <p className="dc-auth-trust"><ShieldCheck size={14} />JWT authentication · Workspace RBAC · Approval-based ingestion</p>
    </section>

    <section className="dc-auth-card" aria-labelledby="account-form-title">
      <div className="dc-auth-mobile-brand"><LogoLockup size={34} /></div>
      {!invitation && <div className="dc-auth-mode-switch" aria-label="Choose account action">
        <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}><Plus size={13} />Create workspace</button>
        <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}><LogIn size={13} />Sign in</button>
      </div>}
      <div className="dc-auth-heading">
        <span className="dc-auth-heading-icon">{mode === 'login' ? <LogIn size={20} /> : mode === 'invite' ? <Users size={20} /> : <Building2 size={20} />}</span>
        <div><h2 id="account-form-title">{heading}</h2><p>{description}</p></div>
      </div>
      <form onSubmit={submit} className="dc-auth-form">
        {mode !== 'login' && <Field icon={User} label="Your name"><input name="name" required maxLength={100} autoComplete="name" placeholder="Alex Morgan" value={fields.name} onChange={update} /></Field>}
        {mode === 'register' && <Field icon={Building2} label="Workspace name" hint="You can invite teammates after setup."><input name="workspace_name" required maxLength={100} placeholder="e.g. Product & Engineering" value={fields.workspace_name} onChange={update} /></Field>}
        <Field icon={Mail} label="Work email"><input name="email" type="email" required autoComplete="email" placeholder="you@company.com" value={fields.email} onChange={update} /></Field>
        <Field icon={LockKeyhole} label="Password" hint="Use at least 12 characters.">
          <span className="dc-password-field">
            <input name="password" type={showPassword ? 'text' : 'password'} required minLength={12} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder="Enter your password" value={fields.password} onChange={update} />
            <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </span>
        </Field>
        {error && <p className="dc-auth-error" role="alert">{error}</p>}
        <button type="submit" className="dc-auth-primary" disabled={busy}>
          {busy ? <><LoaderCircle size={16} className="animate-spin" />Please wait…</> : <>{mode === 'register' ? 'Create workspace' : mode === 'invite' ? 'Join workspace' : 'Sign in'}<ArrowRight size={16} /></>}
        </button>
      </form>
      <p className="dc-auth-form-note"><ShieldCheck size={13} />Your workspace data is isolated from other teams.</p>
    </section>
  </main>;
}

function WorkspaceSettings({ account, refresh, onClose }) {
  const user = account.user;
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [workspaceName, setWorkspaceName] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [copied, setCopied] = useState(false);
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
  const copyInvite = async () => {
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteLink);
      } else {
        const copyTarget = document.createElement('textarea');
        copyTarget.value = inviteLink;
        copyTarget.style.position = 'fixed';
        copyTarget.style.opacity = '0';
        document.body.appendChild(copyTarget);
        copyTarget.select();
        document.execCommand('copy');
        copyTarget.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Could not copy automatically. Select the invitation link and copy it manually.');
    }
  };

  return <div className="dc-auth-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dc-workspace-settings" role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title">
      <header className="dc-settings-header">
        <div className="dc-settings-title"><span><Building2 size={19} /></span><div><h2 id="workspace-settings-title">{user.workspace_name}</h2><p>Workspace settings and access</p></div></div>
        <button type="button" className="dc-icon-button" onClick={onClose} aria-label="Close workspace settings" title="Close"><X size={18} /></button>
      </header>
      <div className="dc-settings-body">
        <div className="dc-role-summary"><span className="dc-role-badge"><Crown size={13} />{user.role}</span><p>{roleHelp[user.role]}</p></div>
        {error && <p className="dc-auth-error" role="alert">{error}</p>}
        {canManage && <>
          <section className="dc-settings-section">
            <div className="dc-section-heading"><span><Link2 size={16} /></span><div><h3>Invite a teammate</h3><p>Choose what the person can do before sharing the link.</p></div></div>
            <form className="dc-auth-form dc-settings-form" onSubmit={(event) => { event.preventDefault(); act(async () => {
              const { data } = await api.post('/auth/invitations', { email, role });
              setInviteLink(`${window.location.origin}/?invite=${encodeURIComponent(data.invite_token)}`);
              setCopied(false);
            }); }}>
              <div className="dc-form-grid">
                <Field icon={Mail} label="Email"><input type="email" required placeholder="teammate@company.com" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
                <Field icon={ShieldCheck} label="Access level"><select value={role} onChange={(event) => setRole(event.target.value)}>{roles.filter((value) => value !== 'admin' || user.role === 'owner').map((value) => <option key={value} value={value}>{value} — {roleHelp[value]}</option>)}</select></Field>
              </div>
              <button type="submit" className="dc-auth-primary dc-fit-button" disabled={busy}><Plus size={15} />Create invitation link</button>
            </form>
            {inviteLink && <div className="dc-invite-result"><div><strong>Invitation ready</strong><p>Share with {email}. The link expires in 7 days.</p></div><div className="dc-copy-row"><input readOnly value={inviteLink} onFocus={(event) => event.target.select()} aria-label="Invitation link" /><button type="button" onClick={copyInvite}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy'}</button></div><small>No email is sent automatically.</small></div>}
          </section>
          <section className="dc-settings-section">
            <div className="dc-section-heading"><span><Users size={16} /></span><div><h3>Workspace members</h3><p>{members.length} {members.length === 1 ? 'person' : 'people'} currently have access.</p></div></div>
            <div className="dc-member-list">{members.map((member) => <div key={member.id} className="dc-member-row">
              <span className="dc-member-avatar" aria-hidden="true">{member.name?.charAt(0)?.toUpperCase() || '?'}</span>
              <div className="dc-member-identity"><strong>{member.name}</strong><small>{member.email}</small></div>
              {user.role === 'owner' && member.role !== 'owner' ? <>
                <select aria-label={`Role for ${member.name}`} value={member.role} disabled={busy} onChange={(event) => act(async () => { await api.patch(`/auth/members/${member.id}`, { role: event.target.value }); await loadMembers(); })}>{roles.map((value) => <option key={value}>{value}</option>)}</select>
                <button type="button" className="dc-danger-icon" title={`Revoke ${member.name}'s access`} aria-label={`Revoke ${member.name}'s access`} disabled={busy} onClick={() => act(async () => { await api.delete(`/auth/members/${member.id}`); await loadMembers(); })}><Trash2 size={15} /></button>
              </> : <span className="dc-role-badge">{member.role}</span>}
            </div>)}</div>
          </section>
        </>}
        <section className="dc-settings-section">
          <div className="dc-section-heading"><span><Plus size={16} /></span><div><h3>Create another workspace</h3><p>Start a separate knowledge space with its own members and documents.</p></div></div>
          <form className="dc-auth-form dc-inline-form" onSubmit={(event) => { event.preventDefault(); act(async () => { await api.post('/auth/workspaces', { name: workspaceName }); await refresh(); onClose(); }); }}>
            <input aria-label="New workspace name" required maxLength={100} placeholder="Workspace name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
            <button type="submit" className="dc-auth-primary" disabled={busy}><Plus size={15} />Create workspace</button>
          </form>
        </section>
      </div>
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
  const initials = useMemo(() => account?.user?.name?.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U', [account]);

  if (loading) return <main className="dc-auth-page dc-loading-page"><LogoLockup size={42} /><LoaderCircle size={24} className="animate-spin" /><p>Loading your workspace…</p></main>;
  if (!account || new URLSearchParams(window.location.search).has('invite')) return <>{error && <p role="alert" className="dc-auth-global-error">{error}</p>}<AccountForm onAuthenticated={refresh} /></>;
  const user = { ...account.user, username: `${account.user.workspace_id}:${account.user.id}:${account.user.role}` };
  return <div className="dc-authenticated-app">
    <header className="dc-workspace-bar">
      <div className="dc-workspace-picker"><span className="dc-workspace-picker-icon"><Building2 size={16} /></span><label><small>Active workspace</small><span><select aria-label="Active workspace" value={user.workspace_id} onChange={async (event) => {
        try { await api.post('/auth/switch-workspace', { workspace_id: event.target.value }); await refresh(); } catch (failure) { setError(errorMessage(failure)); }
      }}>{account.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></span></label></div>
      <div className="dc-workspace-actions">
        <div className="dc-user-summary"><span className="dc-user-avatar">{initials}</span><span><strong>{user.name}</strong><small>{user.role}</small></span></div>
        <button type="button" className="dc-header-button" onClick={() => setSettings(true)} title="Workspace settings"><Settings size={15} /><span>Settings</span></button>
        <button type="button" className="dc-header-button dc-signout-button" onClick={async () => {
          try { await api.post('/auth/logout'); setAccount(null); setSettings(false); } catch (failure) { setError(errorMessage(failure)); }
        }} title="Sign out"><LogOut size={15} /><span>Sign out</span></button>
      </div>
    </header>
    {error && <p className="dc-auth-global-error" role="alert">{error}</p>}
    <div className="dc-workspace-body"><App key={user.username} user={user} /></div>
    {settings && <WorkspaceSettings account={account} refresh={refresh} onClose={() => setSettings(false)} />}
  </div>;
}
