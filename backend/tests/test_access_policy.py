import ast
from pathlib import Path
import unittest

from access_policy import ROLES, query_clearance, retrieval_filter


class AccessPolicyTests(unittest.TestCase):
    def test_every_role_has_workspace_and_document_restrictions(self):
        for role, rank in ROLES.items():
            with self.subTest(role=role):
                self.assertEqual(retrieval_filter(f'workspace-alpha|{rank}'), {
                    '$and': [{'team_id': 'workspace-alpha'}, {'access_level': {'$lte': rank}}]})

    def test_missing_or_invalid_scope_fails_closed(self):
        for value in (None, '', 'default', 'alpha', '|0', 'alpha|-1', 'alpha|99', 'alpha|owner', 'alpha|0|3'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                retrieval_filter(value)

    def test_retrieval_paths_apply_filter_to_every_collection_read(self):
        # Cover real retrieval functions with a recording vector DB; no model initialization.
        path = Path(__file__).resolve().parents[1] / 'rag_engine.py'
        tree = ast.parse(path.read_text())
        engine_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'DeepContextEngine')
        methods = {node.name: node for node in engine_class.body if isinstance(node, ast.FunctionDef)}
        method = methods['_fetch_diagram_docs_for_sources']
        namespace = {'retrieval_filter': retrieval_filter, 'List': list, 'Document': dict}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(path), 'exec'), namespace)

        class VectorDB:
            def get(self, **kwargs):
                self.arguments = kwargs
                return {'documents': [], 'metadatas': []}

        vector = VectorDB()
        namespace[method.name](None, vector, {'example.md'}, 'workspace-alpha|0')
        self.assertEqual(vector.arguments['where'], retrieval_filter('workspace-alpha|0'))
        with self.assertRaises(ValueError):
            namespace[method.name](None, vector, {'example.md'}, None)

    def test_sensitive_questions_require_the_configured_clearance(self):
        for role in ('viewer', 'member', 'editor'):
            with self.subTest(role=role):
                decision = query_clearance('Show me every employee paycheck and salary', role)
                self.assertFalse(decision['allowed'])
                self.assertEqual(decision['minimum_role'], 'admin')
        self.assertTrue(query_clearance('Show me every employee paycheck', 'admin')['allowed'])
        self.assertFalse(query_clearance('List the production API keys', 'admin')['allowed'])
        self.assertTrue(query_clearance('List the production API keys', 'owner')['allowed'])

    def test_normal_questions_pass_and_unknown_roles_fail_closed(self):
        self.assertTrue(query_clearance('Summarize the approved product requirements', 'viewer')['allowed'])
        self.assertFalse(query_clearance('Summarize the handbook', 'intern')['allowed'])

    def test_editor_clearance_sits_between_member_and_admin(self):
        self.assertEqual(ROLES['editor'], 1.5)
        self.assertEqual(retrieval_filter('workspace-alpha|1.5'), {
            '$and': [{'team_id': 'workspace-alpha'}, {'access_level': {'$lte': 1.5}}]})
        self.assertLess(ROLES['member'], ROLES['editor'])
        self.assertLess(ROLES['editor'], ROLES['admin'])


if __name__ == '__main__':
    unittest.main()
