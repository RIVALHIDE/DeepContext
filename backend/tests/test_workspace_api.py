"""Exercise real API handlers with model/queue services replaced by test doubles."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

if importlib.util.find_spec('jwt') is None:
    raise unittest.SkipTest('Install PyJWT==2.10.1 to run workspace API tests')

from fastapi.testclient import TestClient
import auth
import database


class WorkspaceAPITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        path = str(Path(self.directory.name, 'workspace.db'))
        for target in ('database.DB_PATH', 'auth.DB_PATH'):
            patcher = patch(target, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.dict(os.environ, {'JWT_SECRET': 'workspace-api-test-' * 4})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.engine = MagicMock()
        self.engine.get_answer.return_value = {'answer': 'Workspace answer', 'sources': [], 'retrieved': False}
        self.engine._build_answer_request.return_value = {'mode': 'no_docs', 'answer': 'No documents yet', 'sources': [], 'retrieved': False}
        self.task = MagicMock()
        self.task.delay.return_value = SimpleNamespace(id='test-job')
        engine = self.engine
        class FakeEngine:
            def __new__(cls):
                return engine

        stubs = {
            'rag_engine': SimpleNamespace(DeepContextEngine=FakeEngine, _normalize_markdown_answer=lambda value: value),
            'supervisor': SimpleNamespace(Supervisor=MagicMock()),
            'celery_worker': SimpleNamespace(process_document_task=self.task, app=MagicMock()),
        }
        patcher = patch.dict(sys.modules, stubs)
        patcher.start()
        self.addCleanup(patcher.stop)
        spec = importlib.util.spec_from_file_location('workspace_api_test', Path(__file__).resolve().parents[1] / 'MainApplicationRunner.py')
        self.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)
        for module in ('document_registry', 'chat_history_manager', 'chat_session_manager'):
            patcher = patch(module + '.DB_PATH', path)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.owner = TestClient(self.api.app)
        self.addCleanup(self.owner.close)
        response = self.owner.post('/auth/register', json={'email': 'owner@example.com', 'name': 'Owner', 'workspace_name': 'Alpha', 'password': 'a-secure-password'})
        self.assertEqual(response.status_code, 201, response.text)
        self.identity = self.owner.get('/auth/me').json()['user']

    def member_client(self, role='viewer'):
        invitation = self.owner.post('/auth/invitations', json={'email': 'member@example.com', 'role': role}).json()['invite_token']
        client = TestClient(self.api.app)
        self.addCleanup(client.close)
        response = client.post('/auth/accept-invite', json={'email': 'member@example.com', 'name': 'Member', 'password': 'member-password-123', 'token': invitation})
        self.assertEqual(response.status_code, 200, response.text)
        return client

    @staticmethod
    def session_id(identity):
        return f"session_{identity['workspace_id']}:{identity['id']}:{identity['role']}_test"

    def test_document_list_excludes_other_workspaces_and_restricted_sources(self):
        workspace = self.identity['workspace_id']
        with auth.connect() as db:
            for source, workspace_id, level in [('alpha-public.md', workspace, 0), ('alpha-secret.md', workspace, 2), ('beta.md', 'different-workspace', 0), ('legacy.md', 'default', 0)]:
                db.execute('INSERT INTO documents (document_id, source_name) VALUES (?, ?)', (source, source))
                db.execute('INSERT INTO document_access VALUES (?, ?, ?)', (source, workspace_id, level))
        viewer = self.member_client()
        self.assertEqual([doc['name'] for doc in viewer.get('/retriveAllDocuments').json()['files']], ['alpha-public.md'])
        self.assertEqual(len(self.owner.get('/retriveAllDocuments').json()['files']), 2)
        self.assertEqual(viewer.delete('/deleteDocument/alpha-public.md').status_code, 403)
        self.assertEqual(self.owner.delete('/deleteDocument/beta.md').status_code, 404)

    def test_sessions_and_history_cannot_be_opened_by_another_user(self):
        session = self.session_id(self.identity)
        self.assertEqual(self.owner.post('/chat-sessions', json={'sessionId': session, 'title': 'Private'}).status_code, 200)
        viewer = self.member_client()
        self.assertEqual(viewer.get('/chat-sessions').json()['sessions'], [])
        for url in ('/get-history/', '/delete-chat/'):
            self.assertEqual(viewer.post(url + session).status_code, 404)
        self.assertEqual(viewer.patch('/chat-sessions/' + session, json={'title': 'Hijacked'}).status_code, 404)

    def test_chat_ignores_payload_team_and_uses_authenticated_scope(self):
        session = self.session_id(self.identity)
        response = self.owner.post('/get-answer', json={'question': 'Hello', 'sessionId': session, 'userTeam': 'different-workspace|3'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.engine.get_answer.call_args.kwargs['user_team'], self.identity['workspace_id'] + '|3')
        streamed = self.owner.post('/get-answer/stream', json={'question': 'Hello', 'sessionId': session, 'userTeam': 'default'})
        self.assertEqual(streamed.status_code, 200, streamed.text)
        self.assertIn('event: done', streamed.text)
        self.assertEqual(self.engine._build_answer_request.call_args.kwargs['team_id'], self.identity['workspace_id'] + '|3')

    def test_upload_permission_and_cross_workspace_approval_job_guards(self):
        viewer = self.member_client()
        self.assertEqual(viewer.post('/upload', files={'file': ('example.txt', b'example')}).status_code, 403)
        self.assertEqual(self.owner.get('/job-status/not-my-job').status_code, 404)
        self.assertEqual(self.owner.get('/job-progress/not-my-job').status_code, 404)
        with auth.connect() as db:
            db.execute('''INSERT INTO pending_uploads (document_id, source_name, file_path, file_size, team_id)
                          VALUES ('foreign-document', 'foreign.txt', '/not/read', 10, 'other-workspace')''')
        self.assertEqual(self.owner.post('/approve-document/foreign-document').status_code, 404)
        self.assertEqual(self.owner.post('/reject-document/foreign-document').status_code, 404)
        self.task.delay.assert_not_called()

    def test_workspace_scoped_upload_assigns_access_and_safe_path(self):
        # Capture the saved file in a temporary directory, not the repository's runtime data.
        original_open = open
        def temporary_open(filename, mode='r', *args, **kwargs):
            if mode == 'wb':
                filename = Path(self.directory.name, Path(filename).name)
            return original_open(filename, mode, *args, **kwargs)

        with patch('builtins.open', side_effect=temporary_open), patch.object(self.api.os, 'makedirs'):
            response = self.owner.post('/upload', files={'file': ('../policy.txt', b'Workspace policy', 'text/plain')}, data={'access_role': 'admin'})
        self.assertEqual(response.status_code, 200, response.text)
        with auth.connect() as db:
            row = db.execute('SELECT * FROM pending_uploads WHERE document_id=?', (response.json()['document_id'],)).fetchone()
        self.assertEqual(row['team_id'], self.identity['workspace_id'])
        self.assertEqual(row['access_level'], 2)
        self.assertEqual(Path(row['file_path']).name, self.identity['workspace_id'] + '__policy.txt')
        self.assertNotIn('..', row['file_path'])
        self.assertEqual(row['uploaded_by'], self.identity['id'])


if __name__ == '__main__':
    unittest.main()
