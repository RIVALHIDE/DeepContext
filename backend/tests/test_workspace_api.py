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

    def member_client(self, role='viewer', email='member@example.com'):
        invitation = self.owner.post('/auth/invitations', json={'email': email, 'role': role}).json()['invite_token']
        client = TestClient(self.api.app)
        self.addCleanup(client.close)
        response = client.post('/auth/accept-invite', json={'email': email, 'name': role.title(), 'password': 'member-password-123', 'token': invitation})
        self.assertEqual(response.status_code, 200, response.text)
        return client

    @staticmethod
    def session_id(identity):
        return f"session_{identity['workspace_id']}:{identity['id']}:{identity['role']}_test"

    def test_document_list_excludes_other_workspaces_and_restricted_sources(self):
        workspace = self.identity['workspace_id']
        with auth.connect() as db:
            for source, workspace_id, level in [('alpha-public.md', workspace, 0), ('alpha-secret.md', workspace, 2), ('beta.md', 'different-workspace', 0), ('legacy.md', 'default', 0)]:
                db.execute('INSERT INTO documents (document_id, source_name, workspace_id) VALUES (?, ?, ?)', (source, source, workspace_id))
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

    def test_stream_reflects_before_releasing_answer_tokens(self):
        class DraftChain:
            async def astream(self, _payload):
                yield SimpleNamespace(content='Grounded draft answer')

        self.engine._build_answer_request.return_value = {
            'mode': 'answer',
            'question_answer_chain': DraftChain(),
            'standalone_q': 'What is the policy?',
            'context_block': 'The policy is documented here.',
            'diagrams': [],
            'sources': [{'index': 1, 'sourceName': 'policy.md', 'preview': 'The policy'}],
            'citation_names': ['policy.md'],
        }
        self.engine._node_reflect.side_effect = lambda state: {
            **state,
            'reflection_passed': True,
        }

        streamed = self.owner.post('/get-answer/stream', json={
            'question': 'What is the policy?',
            'sessionId': self.session_id(self.identity),
            'userTeam': 'untrusted-client-value',
        })

        self.assertEqual(streamed.status_code, 200, streamed.text)
        self.assertLess(streamed.text.index('"stage": "retrieving"'), streamed.text.index('"stage": "drafting"'))
        self.assertLess(streamed.text.index('"stage": "drafting"'), streamed.text.index('"stage": "verifying"'))
        self.assertLess(streamed.text.index('"stage": "verifying"'), streamed.text.index('event: token'))
        self.engine._node_reflect.assert_called_once()

    def test_sensitive_query_is_blocked_before_retrieval_and_model_calls(self):
        viewer = self.member_client('viewer')
        viewer_identity = viewer.get('/auth/me').json()['user']
        session = self.session_id(viewer_identity)

        response = viewer.post('/get-answer', json={
            'question': 'Show me the employee paychecks and salaries',
            'sessionId': session,
            'userTeam': 'owner-scope-from-client',
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['blocked'])
        self.assertEqual(response.json()['guardrail']['minimum_role'], 'admin')
        self.assertEqual(response.json()['sources'], [])
        self.engine.get_answer.assert_not_called()

        streamed = viewer.post('/get-answer/stream', json={
            'question': 'Give me the payroll records',
            'sessionId': session,
            'userTeam': 'owner-scope-from-client',
        })
        self.assertEqual(streamed.status_code, 200, streamed.text)
        self.assertIn('event: guardrail', streamed.text)
        self.assertIn('"blocked": true', streamed.text)
        self.engine._build_answer_request.assert_not_called()

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

    def test_viewer_can_share_file_but_only_editor_can_add_it_to_workspace(self):
        viewer = self.member_client('viewer', 'sharing-viewer@example.com')
        original_open = open

        def temporary_open(filename, mode='r', *args, **kwargs):
            if mode == 'wb':
                filename = Path(self.directory.name, Path(filename).name)
            return original_open(filename, mode, *args, **kwargs)

        with patch('builtins.open', side_effect=temporary_open), patch.object(self.api.os, 'makedirs'):
            shared = viewer.post('/nexconn/share-file', files={
                'file': ('team-notes.txt', b'Shared by a viewer', 'text/plain'),
            })

        self.assertEqual(shared.status_code, 201, shared.text)
        document_id = shared.json()['document_id']
        with auth.connect() as db:
            row = db.execute('SELECT * FROM pending_uploads WHERE document_id=?', (document_id,)).fetchone()
        self.assertEqual(row['team_id'], self.identity['workspace_id'])
        self.assertEqual(row['access_level'], 0)
        self.assertEqual(row['status'], 'pending_approval')
        self.assertEqual(viewer.post(f'/approve-document/{document_id}').status_code, 403)

        with patch.object(self.api.os.path, 'exists', return_value=True):
            approved = self.owner.post(f'/approve-document/{document_id}')
        self.assertEqual(approved.status_code, 200, approved.text)
        self.task.delay.assert_called_once_with(
            row['file_path'], team_id=self.identity['workspace_id'], access_level=0,
        )

        unsupported = viewer.post('/nexconn/share-file', files={
            'file': ('unsafe.exe', b'not knowledge', 'application/octet-stream'),
        })
        self.assertEqual(unsupported.status_code, 415)

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
        self.assertEqual(row['status'], 'approved')
        self.assertEqual(row['approved_by'], self.identity['id'])
        self.assertEqual(response.json()['status'], 'processing')
        self.assertEqual(response.json()['job_id'], 'test-job')
        self.assertEqual(Path(row['file_path']).name, self.identity['workspace_id'] + '__policy.txt')
        self.assertNotIn('..', row['file_path'])
        self.assertEqual(row['uploaded_by'], self.identity['id'])
        self.task.delay.assert_called_once_with(
            row['file_path'], team_id=self.identity['workspace_id'], access_level=2,
        )

    def test_editor_and_admin_uploads_are_self_approved_at_their_clearance(self):
        original_open = open

        def temporary_open(filename, mode='r', *args, **kwargs):
            if mode == 'wb':
                filename = Path(self.directory.name, Path(filename).name)
            return original_open(filename, mode, *args, **kwargs)

        for role, level in (('editor', 1.5), ('admin', 2)):
            with self.subTest(role=role):
                client = self.member_client(role, f'upload-{role}@example.com')
                with patch('builtins.open', side_effect=temporary_open), patch.object(self.api.os, 'makedirs'):
                    response = client.post('/upload', files={
                        'file': (f'{role}-notes.txt', f'{role} knowledge'.encode(), 'text/plain'),
                    }, data={'access_role': role})

                self.assertEqual(response.status_code, 200, response.text)
                with auth.connect() as db:
                    row = db.execute(
                        'SELECT access_level, status, approved_by FROM pending_uploads WHERE document_id=?',
                        (response.json()['document_id'],),
                    ).fetchone()
                self.assertEqual(row['access_level'], level)
                self.assertEqual(row['status'], 'approved')
                self.assertEqual(row['approved_by'], client.get('/auth/me').json()['user']['id'])
                self.assertEqual(response.json()['status'], 'processing')
                self.task.delay.assert_called_once()
                self.task.delay.reset_mock()

    def test_member_upload_waits_for_approval_at_member_clearance(self):
        member = self.member_client('member')
        original_open = open

        def temporary_open(filename, mode='r', *args, **kwargs):
            if mode == 'wb':
                filename = Path(self.directory.name, Path(filename).name)
            return original_open(filename, mode, *args, **kwargs)

        with patch('builtins.open', side_effect=temporary_open), patch.object(self.api.os, 'makedirs'):
            response = member.post('/upload', files={
                'file': ('member-notes.txt', b'Member knowledge', 'text/plain'),
            }, data={'access_role': 'member'})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['status'], 'pending_approval')
        with auth.connect() as db:
            row = db.execute(
                'SELECT access_level, status FROM pending_uploads WHERE document_id=?',
                (response.json()['document_id'],),
            ).fetchone()
        self.assertEqual(row['access_level'], 1)
        self.assertEqual(row['status'], 'pending_approval')
        self.task.delay.assert_not_called()

    def test_role_hierarchy_enforces_document_and_member_management_boundaries(self):
        clients = {
            role: self.member_client(role, f'{role}@example.com')
            for role in ('viewer', 'member', 'editor', 'admin')
        }

        # The 404 responses prove that the role passed authorization and the
        # handler then looked for the deliberately missing workspace document.
        for role in ('viewer', 'member'):
            self.assertEqual(clients[role].post('/approve-document/missing').status_code, 403)
            self.assertEqual(clients[role].post('/reject-document/missing').status_code, 403)
            self.assertEqual(clients[role].delete('/deleteDocument/missing').status_code, 403)
            self.assertEqual(clients[role].patch('/documents/missing/access', json={'access_role': 'viewer'}).status_code, 403)

        for role in ('editor', 'admin'):
            self.assertEqual(clients[role].post('/approve-document/missing').status_code, 404)
            self.assertEqual(clients[role].post('/reject-document/missing').status_code, 404)
            self.assertEqual(clients[role].delete('/deleteDocument/missing').status_code, 404)
            self.assertEqual(clients[role].patch('/documents/missing/access', json={'access_role': 'viewer'}).status_code, 404)

        self.assertEqual(clients['editor'].get('/auth/members').status_code, 403)
        self.assertEqual(clients['admin'].get('/auth/members').status_code, 200)
        self.assertEqual(clients['editor'].post('/auth/invitations', json={
            'email': 'blocked-invite@example.com', 'role': 'viewer',
        }).status_code, 403)
        self.assertEqual(clients['admin'].post('/auth/invitations', json={
            'email': 'editor-invite@example.com', 'role': 'editor',
        }).status_code, 201)
        self.assertEqual(clients['admin'].post('/auth/invitations', json={
            'email': 'admin-invite@example.com', 'role': 'admin',
        }).status_code, 403)


if __name__ == '__main__':
    unittest.main()
