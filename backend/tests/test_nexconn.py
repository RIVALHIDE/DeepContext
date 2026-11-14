"""Tests for the per-workspace Nexconn connection bootstrap."""

import hashlib
import os
import unittest
from unittest.mock import AsyncMock, call, patch

import webhook


class NexconnTests(unittest.IsolatedAsyncioTestCase):
    def settings(self, **changes):
        values = {
            "base_url": "https://api.sg-light-api.com",
            "app_key": "app-key",
            "app_secret": "app-secret",
            "area_code": "sg",
        }
        values.update(changes)
        return values

    def test_signature_matches_nexconn_sha1_contract(self):
        expected = hashlib.sha1(b"secretnonce1700000000000").hexdigest()
        self.assertEqual(webhook._signature("secret", "nonce", "1700000000000"), expected)

    def test_global_configuration_is_validated_without_workspace_binding(self):
        self.assertIsNone(webhook._configuration_error(self.settings()))
        self.assertIn("HTTPS", webhook._configuration_error(self.settings(base_url="http://example.com")))
        self.assertIn("NEXCONN_APP_KEY", webhook._configuration_error(self.settings(app_key="")))

    def test_legacy_api_token_is_used_only_as_app_key_migration_fallback(self):
        with patch.dict(os.environ, {
            "NEXCONN_API_BASE_URL": "https://api.sg-light-api.com",
            "NEXCONN_APP_KEY": "",
            "NEXCONN_API_TOKEN": "legacy-app-key",
            "NEXCONN_APP_SECRET": "app-secret",
        }):
            self.assertEqual(webhook._settings()["app_key"], "legacy-app-key")

    def test_each_workspace_gets_a_stable_distinct_provider_safe_group(self):
        first = webhook._workspace_channel("workspace-1", "Engineering")
        self.assertEqual(first, webhook._workspace_channel("workspace-1", "Engineering"))
        self.assertNotEqual(first["id"], webhook._workspace_channel("workspace-2", "Engineering")["id"])
        self.assertEqual(first["type"], "group")
        self.assertEqual(first["name"], "Engineering")
        self.assertTrue(first["id"].isalnum())
        self.assertLessEqual(len(first["id"]), 64)

    def test_user_id_is_stable_opaque_and_within_provider_limit(self):
        first = webhook._nexconn_user_id("workspace", "user")
        self.assertEqual(first, webhook._nexconn_user_id("workspace", "user"))
        self.assertNotIn("workspace", first)
        self.assertLessEqual(len(first.encode()), 64)

    async def test_session_returns_only_safe_client_credentials(self):
        principal = {"id": "user-1", "name": "Ada", "workspace_id": "workspace-1", "workspace_name": "Engineering", "role": "owner"}
        members = [{"id": "user-1", "name": "Ada", "role": "owner"}]
        settings = self.settings()
        with patch.object(webhook, "current", return_value=principal), \
             patch.object(webhook, "_settings", return_value=settings), \
             patch.object(webhook, "_workspace_members", return_value=members), \
             patch.object(webhook, "_issue_access_token", new=AsyncMock(return_value="user-token")) as issue, \
             patch.object(webhook, "_ensure_group_membership", new=AsyncMock()) as membership:
            result = await webhook.nexconn_session()

        self.assertTrue(result["enabled"])
        self.assertEqual(result["token"], "user-token")
        self.assertEqual(result["members"][0]["name"], "Ada")
        self.assertNotIn("email", result["members"][0])
        self.assertEqual(result["channel"], webhook._workspace_channel("workspace-1", "Engineering"))
        self.assertNotIn("app_secret", result)
        issue.assert_awaited_once()
        membership.assert_awaited_once()

    async def test_every_workspace_role_can_connect_without_role_escalation(self):
        for role in ("viewer", "member", "editor", "admin", "owner"):
            principal = {
                "id": f"{role}-user", "name": role.title(),
                "workspace_id": "workspace-1", "workspace_name": "Engineering", "role": role,
            }
            with self.subTest(role=role), \
                 patch.object(webhook, "current", return_value=principal), \
                 patch.object(webhook, "_settings", return_value=self.settings()), \
                 patch.object(webhook, "_workspace_members", return_value=[{
                     "id": f"{role}-user", "name": role.title(), "role": role,
                 }]), \
                 patch.object(webhook, "_issue_access_token", new=AsyncMock(return_value="token")), \
                 patch.object(webhook, "_ensure_group_membership", new=AsyncMock()) as membership:
                result = await webhook.nexconn_session()

            self.assertTrue(result["enabled"])
            membership.assert_awaited_once()
            self.assertEqual(membership.await_args.args[3], role == "owner")

    async def test_huddle_session_is_workspace_scoped_and_never_returns_secret(self):
        principal = {"id": "user-1", "name": "Ada", "workspace_id": "workspace-1", "workspace_name": "Engineering", "role": "owner"}
        members = [{"id": "user-1", "name": "Ada"}, {"id": "user-2", "name": "Grace"}]
        with patch.object(webhook, "current", return_value=principal), \
             patch.object(webhook, "_settings", return_value=self.settings()), \
             patch.object(webhook, "_workspace_members", return_value=members), \
             patch.object(webhook, "_issue_access_token", new=AsyncMock(side_effect=["ada-token", "grace-token"])), \
             patch.object(webhook, "_ensure_group_membership", new=AsyncMock()), \
             patch.object(webhook, "_huddle_call", return_value="call-1"):
            result = await webhook.nexconn_huddle_session()

        self.assertTrue(result["enabled"])
        self.assertEqual(result["token"], "ada-token")
        self.assertEqual(result["call_id"], "call-1")
        self.assertEqual(result["workspace"]["id"], "workspace-1")
        self.assertEqual(result["callee_ids"], [webhook._nexconn_user_id("workspace-1", "user-2")])
        self.assertNotIn("app_secret", result)

    async def test_group_provisioning_uses_documented_server_api_contract(self):
        settings = self.settings()
        channel = webhook._workspace_channel("workspace-1", "Engineering")
        request = AsyncMock(side_effect=[
            {"code": 25410},
            {"code": 0},
        ])
        with patch.object(webhook, "_signed_post", new=request):
            await webhook._ensure_group_membership(settings, channel, "user-1", can_create=True)

        self.assertEqual(request.await_args_list, [
            call(settings, "/v4/group-channel/join", {
                "channelId": channel["id"], "userIds": ["user-1"],
            }),
            call(settings, "/v4/group-channel/create", {
                "channelId": channel["id"], "name": "Engineering", "owner": "user-1",
            }),
        ])

    async def test_only_owner_can_provision_a_missing_group(self):
        with patch.object(webhook, "_signed_post", new=AsyncMock(return_value={"code": 25410})) as request:
            with self.assertRaises(webhook.HTTPException) as raised:
                await webhook._ensure_group_membership(
                    self.settings(), webhook._workspace_channel("workspace-1", "Engineering"),
                    "user-1", can_create=False,
                )
        self.assertEqual(raised.exception.status_code, 409)
        request.assert_awaited_once()

    async def test_existing_group_membership_is_idempotent(self):
        with patch.object(webhook, "_signed_post", new=AsyncMock(return_value={"code": 25412})) as request:
            await webhook._ensure_group_membership(
                self.settings(), webhook._workspace_channel("workspace-1", "Engineering"),
                "user-1", can_create=False,
            )
        request.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
