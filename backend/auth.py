"""JWT sessions, workspace membership and document access policy."""
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import time
import tempfile
import uuid
from contextvars import ContextVar
from contextlib import contextmanager
from urllib.parse import urlsplit

import jwt
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from database import DB_PATH, IntegrityError, connect as database_connect, is_postgres
from access_policy import ROLES, retrieval_filter

router = APIRouter(prefix='/auth', tags=['Authentication and workspaces'])
principal_context = ContextVar('principal', default=None)
COOKIE = 'deepcontext_session'
SESSION_SECONDS = 8 * 3600


@contextmanager
def connect():
    connection = database_connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_auth():
    with connect() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS auth_users (
          id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memberships (
          workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
          PRIMARY KEY(workspace_id, user_id));
        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS invitations (
          token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL,
          role TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS document_access (
          source_name TEXT NOT NULL, workspace_id TEXT NOT NULL, access_level REAL NOT NULL,
          PRIMARY KEY(workspace_id, source_name));
        CREATE TABLE IF NOT EXISTS login_attempts (key TEXT NOT NULL, attempted INTEGER NOT NULL);
        ''')
        if is_postgres():
            db.execute('ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS access_level INTEGER NOT NULL DEFAULT 0')
            db.execute('CREATE INDEX IF NOT EXISTS idx_document_access_workspace ON document_access(workspace_id)')
            return

        columns = {row[1] for row in db.execute('PRAGMA table_info(pending_uploads)')}
        if 'access_level' not in columns:
            db.execute('ALTER TABLE pending_uploads ADD COLUMN access_level INTEGER NOT NULL DEFAULT 0')

        # Older installations keyed document access by source_name alone.
        # Rebuild it with a composite workspace key so identical filenames can
        # safely exist in separate workspaces even without filename prefixes.
        access_info = list(db.execute('PRAGMA table_info(document_access)'))
        primary_key = [row[1] for row in sorted(access_info, key=lambda row: row[5]) if row[5]]
        if primary_key != ['workspace_id', 'source_name']:
            db.executescript('''
                ALTER TABLE document_access RENAME TO document_access_legacy;
                CREATE TABLE document_access (
                  source_name TEXT NOT NULL,
                  workspace_id TEXT NOT NULL,
                  access_level REAL NOT NULL,
                  PRIMARY KEY(workspace_id, source_name));
                INSERT OR REPLACE INTO document_access(source_name, workspace_id, access_level)
                  SELECT source_name, workspace_id, access_level FROM document_access_legacy;
                DROP TABLE document_access_legacy;
            ''')
        db.execute('CREATE INDEX IF NOT EXISTS idx_document_access_workspace ON document_access(workspace_id)')


def signing_key():
    configured = os.getenv('JWT_SECRET')
    if configured:
        if len(configured) < 32:
            raise RuntimeError('JWT_SECRET must contain at least 32 characters')
        return configured
    path = Path(DB_PATH).parent / '.jwt-secret'
    if path.exists():
        return path.read_text().strip()
    fd, temporary = tempfile.mkstemp(prefix='.jwt-secret-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(secrets.token_urlsafe(48))
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
        return path.read_text().strip()
    finally:
        os.unlink(temporary)


def password_hash(password):
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return salt + ':' + digest


def verify_password(password, stored):
    salt, digest = stored.split(':', 1)
    actual = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return hmac.compare_digest(actual, digest)


def current():
    principal = principal_context.get()
    if not principal:
        raise HTTPException(401, 'Sign in to continue')
    return principal


def require_role(role):
    principal = current()
    if ROLES[principal['role']] < ROLES[role]:
        raise HTTPException(403, f'{role.title()} access required')
    return principal


def session_owner():
    user = current()
    return f"{user['workspace_id']}:{user['id']}:{user['role']}"


def retrieval_scope():
    user = current()
    return f"{user['workspace_id']}|{ROLES[user['role']]}"


def authenticate(request):
    authorization = request.headers.get('authorization', '')
    token = authorization[7:] if authorization.startswith('Bearer ') else request.cookies.get(COOKIE)
    try:
        claims = jwt.decode(token or '', signing_key(), algorithms=['HS256'], audience='deepcontext',
                            issuer='deepcontext', options={'require': ['exp', 'iat', 'sub', 'jti', 'wid']})
    except jwt.InvalidTokenError:
        raise HTTPException(401, 'Session expired or invalid. Please sign in again.')
    with connect() as db:
        row = db.execute('''SELECT u.id, u.email, u.name, m.role, w.id AS workspace_id, w.name AS workspace_name
            FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
            JOIN memberships m ON m.user_id=u.id AND m.workspace_id=s.workspace_id
            JOIN workspaces w ON w.id=m.workspace_id
            WHERE s.id=? AND s.user_id=? AND s.workspace_id=? AND s.expires>?''',
            (claims['jti'], claims['sub'], claims['wid'], int(time.time()))).fetchone()
    if not row:
        raise HTTPException(401, 'Session revoked. Please sign in again.')
    return dict(row)


def issue_session(response, user_id, workspace_id):
    now = int(time.time())
    session_id = uuid.uuid4().hex
    with connect() as db:
        db.execute('DELETE FROM auth_sessions WHERE expires<=?', (now,))
        db.execute('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)',
                   (session_id, user_id, workspace_id, now + SESSION_SECONDS))
    token = jwt.encode({'sub': user_id, 'wid': workspace_id, 'jti': session_id, 'iat': now,
                        'exp': now + SESSION_SECONDS, 'aud': 'deepcontext', 'iss': 'deepcontext'},
                       signing_key(), algorithm='HS256')
    secure = os.getenv('AUTH_COOKIE_SECURE', 'false').lower() == 'true'
    same_site = os.getenv('AUTH_COOKIE_SAMESITE', 'lax').strip().lower()
    if same_site not in {'lax', 'strict', 'none'}:
        raise RuntimeError('AUTH_COOKIE_SAMESITE must be lax, strict, or none')
    if same_site == 'none' and not secure:
        raise RuntimeError('AUTH_COOKIE_SECURE must be true when AUTH_COOKIE_SAMESITE=none')
    response.set_cookie(
        COOKIE, token, httponly=True, secure=secure, samesite=same_site,
        max_age=SESSION_SECONDS, path='/'
    )


def install_auth(app):
    init_auth()
    signing_key()
    app.include_router(router)

    @app.middleware('http')
    async def workspace_authentication(request, call_next):
        if request.method == 'OPTIONS':
            return await call_next(request)
        origin = request.headers.get('origin')
        allowed = {value.strip() for value in os.getenv('AUTH_ALLOWED_ORIGINS', '').split(',') if value.strip()}
        if origin:
            parsed = urlsplit(origin)
            same_host = parsed.hostname == request.url.hostname and parsed.port in (5173, request.url.port)
            if not same_host and origin not in allowed:
                return JSONResponse({'detail': 'Untrusted request origin'}, status_code=403)
        public = {'/auth/register', '/auth/login', '/auth/accept-invite', '/health', '/health/chroma', '/docs', '/openapi.json', '/redoc'}
        if request.url.path in public:
            return await call_next(request)
        try:
            principal = authenticate(request)
        except HTTPException as exc:
            return JSONResponse({'detail': exc.detail}, status_code=exc.status_code)
        marker = principal_context.set(principal)
        try:
            return await call_next(request)
        finally:
            principal_context.reset(marker)


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)


class Registration(Credentials):
    name: str = Field(min_length=1, max_length=100)
    workspace_name: str = Field(min_length=1, max_length=100)


def normalize_email(email):
    email = email.strip().lower()
    if '@' not in email or any(character.isspace() for character in email):
        raise HTTPException(422, 'Enter a valid email address')
    return email


@router.post('/register', status_code=201)
def register(payload: Registration, response: Response):
    email = normalize_email(payload.email)
    if not payload.name.strip() or not payload.workspace_name.strip():
        raise HTTPException(422, 'Your name and workspace name are required')
    user_id, workspace_id = uuid.uuid4().hex, uuid.uuid4().hex
    try:
        with connect() as db:
            db.execute('INSERT INTO auth_users VALUES (?, ?, ?, ?)',
                       (user_id, email, payload.name.strip(), password_hash(payload.password)))
            db.execute('INSERT INTO workspaces VALUES (?, ?)', (workspace_id, payload.workspace_name.strip()))
            db.execute('INSERT INTO memberships VALUES (?, ?, ?)', (workspace_id, user_id, 'owner'))
    except IntegrityError:
        raise HTTPException(409, 'An account with this email already exists. Please sign in.')
    issue_session(response, user_id, workspace_id)
    return {'message': 'Workspace created'}


@router.post('/login')
def login(payload: Credentials, request: Request, response: Response):
    email = normalize_email(payload.email)
    now = int(time.time())
    key = f'{request.client.host if request.client else "local"}:{email}'
    with connect() as db:
        db.execute('DELETE FROM login_attempts WHERE attempted<?', (now - 900,))
        attempts = db.execute('SELECT COUNT(*) FROM login_attempts WHERE key=?', (key,)).fetchone()[0]
        if attempts >= 10:
            raise HTTPException(429, 'Too many sign-in attempts. Try again in 15 minutes.')
        db.execute('INSERT INTO login_attempts VALUES (?, ?)', (key, now))
        user = db.execute('SELECT * FROM auth_users WHERE email=?', (email,)).fetchone()
    # Use the same expensive hash operation for nonexistent accounts.
    stored = user['password_hash'] if user else '0' * 32 + ':' + '0' * 128
    if not verify_password(payload.password, stored) or not user:
        raise HTTPException(401, 'Incorrect email or password')
    with connect() as db:
        member = db.execute('SELECT workspace_id FROM memberships WHERE user_id=? ORDER BY workspace_id LIMIT 1', (user['id'],)).fetchone()
        db.execute('DELETE FROM login_attempts WHERE key=?', (key,))
    if not member:
        raise HTTPException(403, 'You no longer have workspace access')
    issue_session(response, user['id'], member['workspace_id'])
    return {'message': 'Signed in'}


@router.get('/me')
def me():
    user = current()
    with connect() as db:
        workspaces = [dict(row) for row in db.execute('''SELECT w.id, w.name, m.role FROM memberships m
                      JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=?''', (user['id'],))]
    return {'user': user, 'workspaces': workspaces}


@router.post('/logout')
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE) or request.headers.get('authorization', '')[7:]
    claims = jwt.decode(token, signing_key(), algorithms=['HS256'], audience='deepcontext', issuer='deepcontext')
    with connect() as db:
        db.execute('DELETE FROM auth_sessions WHERE id=?', (claims['jti'],))
    response.delete_cookie(
        COOKIE,
        path='/',
        secure=os.getenv('AUTH_COOKIE_SECURE', 'false').lower() == 'true',
        samesite=os.getenv('AUTH_COOKIE_SAMESITE', 'lax').strip().lower(),
    )
    return {'message': 'Signed out'}


class WorkspaceSelection(BaseModel):
    workspace_id: str


@router.post('/switch-workspace')
def switch_workspace(payload: WorkspaceSelection, response: Response):
    user = current()
    with connect() as db:
        membership = db.execute('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?', (payload.workspace_id, user['id'])).fetchone()
    if not membership:
        raise HTTPException(403, 'Workspace access denied')
    issue_session(response, user['id'], payload.workspace_id)
    return {'message': 'Workspace selected'}


class WorkspaceCreation(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@router.post('/workspaces', status_code=201)
def create_workspace(payload: WorkspaceCreation, response: Response):
    user = current()
    if not payload.name.strip():
        raise HTTPException(422, 'Workspace name is required')
    workspace_id = uuid.uuid4().hex
    with connect() as db:
        db.execute('INSERT INTO workspaces VALUES (?, ?)', (workspace_id, payload.name.strip()))
        db.execute('INSERT INTO memberships VALUES (?, ?, ?)', (workspace_id, user['id'], 'owner'))
    issue_session(response, user['id'], workspace_id)
    return {'message': 'Workspace created'}


@router.get('/members')
def members():
    user = require_role('admin')
    with connect() as db:
        rows = db.execute('''SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN auth_users u
                          ON u.id=m.user_id WHERE m.workspace_id=?''', (user['workspace_id'],))
        return {'members': [dict(row) for row in rows]}


class Invitation(BaseModel):
    email: str
    role: str = 'viewer'


def validate_assignment(role, actor):
    if role not in ('viewer', 'member', 'editor', 'admin'):
        raise HTTPException(422, 'Choose viewer, member, editor or admin')
    if role == 'admin' and actor['role'] != 'owner':
        raise HTTPException(403, 'Only the owner can grant admin access')


@router.post('/invitations', status_code=201)
def invite(payload: Invitation):
    user = require_role('admin')
    validate_assignment(payload.role, user)
    token = secrets.token_urlsafe(32)
    with connect() as db:
        db.execute('INSERT INTO invitations VALUES (?, ?, ?, ?, ?, 0)',
                   (hashlib.sha256(token.encode()).hexdigest(), user['workspace_id'], normalize_email(payload.email), payload.role, int(time.time()) + 7 * 86400))
    return {'invite_token': token, 'expires_in_days': 7}


class AcceptInvitation(Credentials):
    token: str
    name: str = Field(min_length=1, max_length=100)


@router.post('/accept-invite')
def accept_invite(payload: AcceptInvitation, response: Response):
    email = normalize_email(payload.email)
    digest = hashlib.sha256(payload.token.encode()).hexdigest()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        invitation = db.execute('SELECT * FROM invitations WHERE token_hash=? AND email=? AND used=0 AND expires>?', (digest, email, int(time.time()))).fetchone()
        if not invitation:
            raise HTTPException(400, 'Invitation is invalid, expired or already used')
        user = db.execute('SELECT * FROM auth_users WHERE email=?', (email,)).fetchone()
        if user:
            if not verify_password(payload.password, user['password_hash']):
                raise HTTPException(401, 'Enter your existing account password')
            user_id = user['id']
        else:
            user_id = uuid.uuid4().hex
            db.execute('INSERT INTO auth_users VALUES (?, ?, ?, ?)', (user_id, email, payload.name.strip(), password_hash(payload.password)))
        existing = db.execute('SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=?', (user_id, invitation['workspace_id'])).fetchone()
        if existing:
            raise HTTPException(409, 'You already belong to this workspace')
        db.execute('INSERT INTO memberships VALUES (?, ?, ?)', (invitation['workspace_id'], user_id, invitation['role']))
        db.execute('UPDATE invitations SET used=1 WHERE token_hash=?', (digest,))
    issue_session(response, user_id, invitation['workspace_id'])
    return {'message': 'Workspace joined'}


class RoleChange(BaseModel):
    role: str


@router.patch('/members/{user_id}')
def change_role(user_id: str, payload: RoleChange):
    actor = require_role('owner')
    validate_assignment(payload.role, actor)
    with connect() as db:
        result = db.execute("UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=? AND role!='owner'", (payload.role, actor['workspace_id'], user_id))
        if not result.rowcount:
            raise HTTPException(400, 'Member not found or owner role cannot be changed')
    return {'message': 'Access updated'}


@router.delete('/members/{user_id}')
def remove_member(user_id: str):
    actor = require_role('owner')
    with connect() as db:
        result = db.execute("DELETE FROM memberships WHERE workspace_id=? AND user_id=? AND role!='owner'", (actor['workspace_id'], user_id))
        if not result.rowcount:
            raise HTTPException(400, 'Member not found or owner cannot be removed')
        db.execute('DELETE FROM auth_sessions WHERE workspace_id=? AND user_id=?', (actor['workspace_id'], user_id))
    return {'message': 'Workspace access revoked'}
