"""Authentication and isolation tests; no Redis, Chroma or Groq calls."""
import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

if importlib.util.find_spec('jwt') is None:
    raise unittest.SkipTest('Install PyJWT==2.10.1 to run authentication tests')

import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.cors import CORSMiddleware
import auth
import database


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        path = str(Path(self.directory.name, 'test.db'))
        for target in ('database.DB_PATH', 'auth.DB_PATH'):
            patcher = patch(target, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.dict(os.environ, {'JWT_SECRET': 'test-secret-' * 5})
        patcher.start()
        self.addCleanup(patcher.stop)
        database.initDB()
        app = FastAPI()
        auth.install_auth(app)
        app.add_middleware(CORSMiddleware, allow_origins=['http://testserver:5173'], allow_credentials=True, allow_methods=['*'], allow_headers=['*'])

        @app.get('/protected')
        def protected():
            return {'user': auth.current(), 'scope': auth.retrieval_filter(auth.retrieval_scope())}

        @app.post('/upload-test')
        def upload():
            auth.require_role('member')
            return {'ok': True}

        self.app = app
        self.owner = TestClient(app)
        self.addCleanup(self.owner.close)

    def register(self, client, email='owner@example.com', workspace='Alpha'):
        return client.post('/auth/register', json={'email': email, 'name': 'Owner', 'password': 'a-secure-password', 'workspace_name': workspace})

    def invite(self, role='viewer', email='viewer@example.com'):
        response = self.owner.post('/auth/invitations', json={'email': email, 'role': role})
        self.assertEqual(response.status_code, 201, response.text)
        token = response.json()['invite_token']
        viewer = TestClient(self.app)
        self.addCleanup(viewer.close)
        response = viewer.post('/auth/accept-invite', json={'token': token, 'name': 'Invited', 'email': email, 'password': 'viewer-password-123'})
        self.assertEqual(response.status_code, 200, response.text)
        return viewer, token

    def test_registration_creates_owner_and_httponly_jwt(self):
        response = self.register(self.owner)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertIn('HttpOnly', response.headers['set-cookie'])
        claims = jwt.decode(self.owner.cookies.get(auth.COOKIE), auth.signing_key(), algorithms=['HS256'], audience='deepcontext', issuer='deepcontext')
        me = self.owner.get('/auth/me').json()['user']
        self.assertEqual(me['role'], 'owner')
        self.assertEqual(claims['wid'], me['workspace_id'])
        with auth.connect() as db:
            stored = db.execute('SELECT password_hash FROM auth_users').fetchone()[0]
        self.assertNotIn('a-secure-password', stored)

    def test_anonymous_invalid_tampered_and_expired_tokens_denied(self):
        self.assertEqual(self.owner.get('/protected').status_code, 401)
        self.register(self.owner)
        token = self.owner.cookies.get(auth.COOKIE)
        self.owner.cookies.clear()
        self.assertEqual(self.owner.get('/protected', headers={'Authorization': 'Bearer ' + token + 'tampered'}).status_code, 401)
        expired = jwt.encode({'sub': 'x', 'wid': 'x', 'jti': 'x', 'iat': 1, 'exp': 2, 'aud': 'deepcontext', 'iss': 'deepcontext'}, auth.signing_key(), algorithm='HS256')
        self.assertEqual(self.owner.get('/protected', headers={'Authorization': 'Bearer ' + expired}).status_code, 401)

    def test_invitation_email_role_and_single_use(self):
        self.register(self.owner)
        viewer, token = self.invite()
        self.assertEqual(viewer.get('/auth/me').json()['user']['role'], 'viewer')
        self.assertEqual(viewer.post('/upload-test').status_code, 403)
        self.assertEqual(viewer.post('/auth/invitations', json={'email': 'x@example.com', 'role': 'admin'}).status_code, 403)
        self.assertEqual(viewer.post('/auth/accept-invite', json={'token': token, 'email': 'viewer@example.com', 'name': 'Viewer', 'password': 'viewer-password-123'}).status_code, 400)

    def test_wrong_email_cannot_redeem_invitation(self):
        self.register(self.owner)
        token = self.owner.post('/auth/invitations', json={'email': 'expected@example.com'}).json()['invite_token']
        response = self.owner.post('/auth/accept-invite', json={'token': token, 'email': 'different@example.com', 'name': 'Wrong', 'password': 'viewer-password-123'})
        self.assertEqual(response.status_code, 400)

    def test_role_changes_and_removal_apply_to_existing_jwt(self):
        self.register(self.owner)
        member, _ = self.invite('member')
        user_id = member.get('/auth/me').json()['user']['id']
        self.assertEqual(member.post('/upload-test').status_code, 200)
        self.assertEqual(self.owner.patch('/auth/members/' + user_id, json={'role': 'viewer'}).status_code, 200)
        self.assertEqual(member.post('/upload-test').status_code, 403)
        self.owner.delete('/auth/members/' + user_id)
        self.assertEqual(member.get('/protected').status_code, 401)

    def test_cannot_switch_to_another_owners_workspace(self):
        self.register(self.owner)
        another = TestClient(self.app)
        self.addCleanup(another.close)
        self.register(another, 'another@example.com', 'Beta')
        workspace = another.get('/auth/me').json()['user']['workspace_id']
        self.assertEqual(self.owner.post('/auth/switch-workspace', json={'workspace_id': workspace}).status_code, 403)
        scope = self.owner.get('/protected').json()['scope']
        self.assertNotEqual(scope['$and'][0]['team_id'], workspace)
        self.assertEqual(scope['$and'][1], {'access_level': {'$lte': 3}})

    def test_logout_revokes_copied_token(self):
        self.register(self.owner)
        token = self.owner.cookies.get(auth.COOKIE)
        self.assertEqual(self.owner.post('/auth/logout').status_code, 200)
        self.assertEqual(self.owner.get('/protected', headers={'Authorization': 'Bearer ' + token}).status_code, 401)

    def test_origin_checks_and_cors_error_responses(self):
        self.register(self.owner)
        self.assertEqual(self.owner.post('/upload-test', headers={'Origin': 'http://evil.example:5173'}).status_code, 403)
        self.assertEqual(self.owner.get('/protected', headers={'Origin': 'http://evil.example:5173'}).status_code, 403)
        self.owner.cookies.clear()
        response = self.owner.get('/protected', headers={'Origin': 'http://testserver:5173'})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers['access-control-allow-origin'], 'http://testserver:5173')

    def test_default_retrieval_never_reads_all_workspaces(self):
        for scope in (None, '', 'default', 'workspace', 'workspace|999'):
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                auth.retrieval_filter(scope)

    def test_owner_cannot_be_demoted_or_removed(self):
        self.register(self.owner)
        user_id = self.owner.get('/auth/me').json()['user']['id']
        self.assertEqual(self.owner.patch('/auth/members/' + user_id, json={'role': 'viewer'}).status_code, 400)
        self.assertEqual(self.owner.delete('/auth/members/' + user_id).status_code, 400)

    def test_login_wrong_password_and_throttling(self):
        self.register(self.owner)
        self.owner.post('/auth/logout')
        for _ in range(10):
            response = self.owner.post('/auth/login', json={'email': 'owner@example.com', 'password': 'wrong-password-123'})
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self.owner.post('/auth/login', json={'email': 'owner@example.com', 'password': 'a-secure-password'}).status_code, 429)


if __name__ == '__main__':
    unittest.main()
