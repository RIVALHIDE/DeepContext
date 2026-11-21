import { createElement, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Building2, CalendarClock, Check, ChevronDown, Copy, Crown, Eye, EyeOff,
  FileSearch, Link2, LoaderCircle, LockKeyhole, LogIn, LogOut, Mail,
  MessageSquareText, Plus, Send, Settings, ShieldCheck, Sparkles, Trash2,
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
  if (error?.code === 'ECONNABORTED') return 'The API took too long to respond. Wake the Render service at its /health URL, then try again.';
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
  const [previewBusy, setPreviewBusy] = useState(Boolean(invitation));
  const [invitePreview, setInvitePreview] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({ name: '', email: '', password: '', confirm_password: '', workspace_name: '' });
  const update = (event) => setFields((previous) => ({ ...previous, [event.target.name]: event.target.value }));

  useEffect(() => {
    if (!invitation) return;
    let active = true;
    setPreviewBusy(true);
    api.get('/auth/invitation-preview', { params: { token: invitation } })
      .then(({ data }) => {
        if (!active) return;
        setInvitePreview(data);
        setFields((previous) => ({ ...previous, email: data.email || '' }));
        setError('');
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure));
      })
      .finally(() => { if (active) setPreviewBusy(false); });
    return () => { active = false; };
  }, [invitation]);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    const createsAccount = mode === 'register' || (mode === 'invite' && invitePreview && !invitePreview.account_exists);
    if (createsAccount && fields.password !== fields.confirm_password) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const endpoint = mode === 'invite' ? 'accept-invite' : mode;
      const payload = { ...fields };
      delete payload.confirm_password;
      await api.post(`/auth/${endpoint}`, { ...payload, token: invitation });
      window.history.replaceState({}, '', '/');
      await onAuthenticated();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const invitedExistingUser = mode === 'invite' && invitePreview?.account_exists;
  const createsAccount = mode === 'register' || (mode === 'invite' && invitePreview && !invitePreview.account_exists);
  const heading = mode === 'register'
    ? 'Create your account'
    : mode === 'invite'
      ? invitedExistingUser ? 'Sign in to join' : 'Create your account'
      : 'Welcome back';
  const description = mode === 'register'
    ? 'Choose your password and create your first private workspace. You can join other workspaces from invitation links.'
    : mode === 'invite'
      ? invitedExistingUser
        ? 'Use your existing account password to accept this workspace invitation.'
        : 'Create your profile to join the workspace. Your invited email is already verified by the link.'
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
        <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}><Plus size={13} />Create account</button>
        <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}><LogIn size={13} />Sign in</button>
      </div>}
      <div className="dc-auth-heading">
        <span className="dc-auth-heading-icon">{mode === 'login' ? <LogIn size={20} /> : mode === 'invite' ? <Users size={20} /> : <Building2 size={20} />}</span>
        <div><h2 id="account-form-title">{heading}</h2><p>{description}</p></div>
      </div>
      {mode === 'invite' && invitePreview && <div className="dc-invite-context">
        <span className="dc-invite-context-icon"><Building2 size={18} /></span>
        <span className="dc-invite-context-copy">
          <small>Invitation to</small>
          <strong>{invitePreview.workspace_name}</strong>
          <span><ShieldCheck size={12} />{invitePreview.role} access</span>
        </span>
        <span className="dc-invite-account-state">{invitePreview.account_exists ? 'Existing account' : 'New account'}</span>
      </div>}
      {invitedExistingUser && <div className="dc-existing-account-notice" role="status">
        <ShieldCheck size={16} />
        <div><strong>This email is already registered</strong><p>Enter its current password to join. If this is a different person, ask the workspace owner to create a new invitation using that person&apos;s own email address.</p></div>
      </div>}
      <form onSubmit={submit} className="dc-auth-form">
        {mode !== 'login' && !(mode === 'invite' && invitePreview?.account_exists) && <Field icon={User} label="Your name"><input name="name" required maxLength={100} autoComplete="name" placeholder="Alex Morgan" value={fields.name} onChange={update} /></Field>}
        {mode === 'register' && <Field icon={Building2} label="First workspace name" hint="This is your private starting workspace; you can join invited workspaces later."><input name="workspace_name" required maxLength={100} placeholder="e.g. Product & Engineering" value={fields.workspace_name} onChange={update} /></Field>}
        <Field icon={Mail} label="Work email" hint={mode === 'invite' ? 'This invitation is tied to this email address.' : undefined}><input name="email" type="email" required autoComplete="email" readOnly={mode === 'invite'} placeholder={previewBusy ? 'Checking invitation…' : 'you@company.com'} value={fields.email} onChange={update} /></Field>
        <Field icon={LockKeyhole} label={mode === 'invite' && invitePreview?.account_exists ? 'Existing account password' : 'Password'} hint={mode === 'invite' && invitePreview?.account_exists ? 'Use the password already connected to this email.' : 'Use at least 12 characters.'}>
          <span className="dc-password-field">
            <input name="password" type={showPassword ? 'text' : 'password'} required minLength={12} maxLength={128} autoComplete={mode === 'register' || (mode === 'invite' && !invitePreview?.account_exists) ? 'new-password' : 'current-password'} placeholder="Enter your password" value={fields.password} onChange={update} />
            <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </span>
        </Field>
        {createsAccount && <Field icon={LockKeyhole} label="Confirm password" hint="Enter the same password again.">
          <span className="dc-password-field">
            <input name="confirm_password" type={showPassword ? 'text' : 'password'} required minLength={12} maxLength={128} autoComplete="new-password" placeholder="Confirm your password" value={fields.confirm_password} onChange={update} />
          </span>
        </Field>}
        {error && <p className="dc-auth-error" role="alert">{error}</p>}
        <button type="submit" className="dc-auth-primary" disabled={busy || previewBusy || (mode === 'invite' && !invitePreview)}>
          {busy ? <><LoaderCircle size={16} className="animate-spin" />Please wait…</> : <>{mode === 'register' ? 'Create account' : mode === 'invite' ? invitedExistingUser ? 'Sign in & join' : 'Create account & join' : 'Sign in'}<ArrowRight size={16} /></>}
        </button>
      </form>
      <p className="dc-auth-form-note"><ShieldCheck size={13} />Your workspace data is isolated from other teams.</p>
    </section>
  </main>;
}

function WorkspaceSettings({ account, refresh, onClose }) {
  const user = account.user;
  const [members, setMembers] = useState(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [workspaceName, setWorkspaceName] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteMeta, setInviteMeta] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteSlow, setInviteSlow] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const canManage = ['admin', 'owner'].includes(user.role);
  const loadMembers = useCallback(async () => {
    if (!canManage) return;
    setMembersLoading(true);
    try {
      setMembers((await api.get('/auth/members')).data.members || []);
    } finally {
      setMembersLoading(false);
    }
  }, [canManage]);
  useEffect(() => { loadMembers().catch((failure) => setError(errorMessage(failure))); }, [loadMembers]);
  useEffect(() => {
    const escape = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);

  const act = async (operation) => {
    setActionBusy(true);
    setError('');
    try { await operation(); } catch (failure) { setError(errorMessage(failure)); } finally { setActionBusy(false); }
  };
  const createInvitation = async (event) => {
    event.preventDefault();
    setInviteBusy(true);
    setInviteSlow(false);
    setError('');
    const slowTimer = window.setTimeout(() => setInviteSlow(true), 7000);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const { data } = await api.post('/auth/invitations', { email: normalizedEmail, role });
      const invitationUrl = new URL('/', window.location.origin);
      invitationUrl.searchParams.set('invite', data.invite_token);
      setEmail(data.email || normalizedEmail);
      setInviteMeta(data);
      setInviteLink(invitationUrl.toString());
      setCopied(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      window.clearTimeout(slowTimer);
      setInviteBusy(false);
      setInviteSlow(false);
    }
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
  const shareInvite = async () => {
    if (!inviteLink) return;
    const shareData = {
      title: `Join ${user.workspace_name} on DeepContext`,
      text: `You have been invited to ${user.workspace_name} with ${inviteMeta?.role || role} access.`,
      url: inviteLink,
    };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch (failure) {
        if (failure?.name !== 'AbortError') setError('Could not open the share menu. Copy the link instead.');
      }
    } else {
      await copyInvite();
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
            <div className="dc-section-heading"><span><Link2 size={16} /></span><div><h3>Invite a teammate</h3><p>Create a secure, email-bound link. Only the intended address can join.</p></div></div>
            <form className="dc-auth-form dc-settings-form" onSubmit={createInvitation}>
              <div className="dc-form-grid">
                <Field icon={Mail} label="Work email" hint="The recipient cannot change this address when joining."><input type="email" required autoComplete="email" placeholder="teammate@company.com" value={email} onChange={(event) => { setEmail(event.target.value); setInviteLink(''); setInviteMeta(null); }} /></Field>
                <Field icon={ShieldCheck} label="Access level"><select value={role} onChange={(event) => { setRole(event.target.value); setInviteLink(''); setInviteMeta(null); }}>{roles.filter((value) => value !== 'admin' || user.role === 'owner').map((value) => <option key={value} value={value}>{value} — {roleHelp[value]}</option>)}</select></Field>
              </div>
              <div className="dc-invite-form-footer"><span>{inviteSlow ? <><LoaderCircle size={14} className="animate-spin" />Waking the API — free hosting can take about 50 seconds</> : <><CalendarClock size={14} />Link expires after 7 days</>}</span><button type="submit" className="dc-auth-primary dc-fit-button" disabled={inviteBusy}>{inviteBusy ? <><LoaderCircle size={15} className="animate-spin" />Creating link…</> : <><Plus size={15} />{inviteLink ? 'Generate a new link' : 'Create invitation link'}</>}</button></div>
            </form>
            {inviteLink && <div className="dc-invite-result">
              <div className="dc-invite-success"><span><Check size={16} /></span><div><strong>Invitation ready</strong><p><b>{inviteMeta?.email || email}</b> can join {user.workspace_name} as {inviteMeta?.role || role}.</p></div></div>
              <div className="dc-copy-row"><input readOnly value={inviteLink} onClick={(event) => event.target.select()} onFocus={(event) => event.target.select()} aria-label="Invitation link" /><button type="button" onClick={copyInvite}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy'}</button><button type="button" onClick={shareInvite}><Send size={15} />Share</button></div>
              <small>DeepContext does not send email automatically. Copy or share this link with the address shown above.</small>
            </div>}
          </section>
          <section className="dc-settings-section">
            <div className="dc-section-heading dc-member-heading"><span><Users size={16} /></span><div><h3>Workspace members</h3><p>{membersLoading ? 'Loading people with access…' : members ? `${members.length} ${members.length === 1 ? 'person' : 'people'} currently have access.` : 'Member list is temporarily unavailable.'}</p></div><button type="button" className="dc-members-refresh" onClick={() => loadMembers().catch((failure) => setError(errorMessage(failure)))} disabled={membersLoading} aria-label="Refresh workspace members">{membersLoading ? <LoaderCircle size={14} className="animate-spin" /> : 'Refresh'}</button></div>
            <div className="dc-member-list">{membersLoading && !members ? <div className="dc-members-state"><LoaderCircle size={18} className="animate-spin" /><span>Loading workspace members…</span></div> : members?.length ? members.map((member) => <div key={member.id} className="dc-member-row">
              <span className="dc-member-avatar" aria-hidden="true">{member.name?.charAt(0)?.toUpperCase() || '?'}</span>
              <div className="dc-member-identity"><strong>{member.name}</strong><small>{member.email}</small></div>
              {user.role === 'owner' && member.role !== 'owner' ? <>
                <select aria-label={`Role for ${member.name}`} value={member.role} disabled={actionBusy} onChange={(event) => act(async () => { await api.patch(`/auth/members/${member.id}`, { role: event.target.value }); await loadMembers(); })}>{roles.map((value) => <option key={value}>{value}</option>)}</select>
                <button type="button" className="dc-danger-icon" title={`Revoke ${member.name}'s access`} aria-label={`Revoke ${member.name}'s access`} disabled={actionBusy} onClick={() => act(async () => { await api.delete(`/auth/members/${member.id}`); await loadMembers(); })}><Trash2 size={15} /></button>
              </> : <span className="dc-role-badge">{member.role}</span>}
            </div>) : <div className="dc-members-state"><Users size={19} /><span>No members were returned. Refresh after checking the API connection.</span></div>}</div>
          </section>
        </>}
        <section className="dc-settings-section">
          <div className="dc-section-heading"><span><Plus size={16} /></span><div><h3>Create another workspace</h3><p>Start a separate knowledge space with its own members and documents.</p></div></div>
          <form className="dc-auth-form dc-inline-form" onSubmit={(event) => { event.preventDefault(); act(async () => { await api.post('/auth/workspaces', { name: workspaceName }); await refresh(); onClose(); }); }}>
            <input aria-label="New workspace name" required maxLength={100} placeholder="Workspace name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
            <button type="submit" className="dc-auth-primary" disabled={actionBusy}><Plus size={15} />Create workspace</button>
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
