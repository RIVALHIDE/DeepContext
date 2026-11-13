import ast
from pathlib import Path
import unittest

from access_policy import ROLES, retrieval_filter


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


if __name__ == '__main__':
    unittest.main()
