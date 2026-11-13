"""Tests for the workspace-bound Nexconn connection bootstrap."""

import hashlib
import unittest
from unittest.mock import AsyncMock, call, patch

import webhook


class NexconnTests(unittest.IsolatedAsyncioTestCase):
    def settings(self, **changes):
        values = {
            "base_url": "https://api.sg-light-api.com",
            "app_key": "app-key",
            "app_secret": "app-secret",
            "workspace_id": "workspace-1",
            "channel_type": "group",
            "channel_id": "engineering",
            "subchannel_id": "",
            "channel_name": "Engineering",
            "area_code": "sg",
        }
        values.update(changes)
        return values

    def test_signature_matches_nexconn_sha1_contract(self):
        expected = hashlib.sha1(b"secretnonce1700000000000").hexdigest()
        self.assertEqual(webhook._signature("secret", "nonce", "1700000000000"), expected)

    def test_configuration_is_workspace_bound_and_validated(self):
        self.assertIsNone(webhook._configuration_error(self.settings(), "workspace-1"))
        self.assertIn("workspace", webhook._configuration_error(self.settings(), "workspace-2").lower())
        self.assertIn("HTTPS", webhook._configuration_error(self.settings(base_url="http://example.com"), "workspace-1"))
        self.assertIn("SUBCHANNEL", webhook._configuration_error(
            self.settings(channel_type="community", subchannel_id=""), "workspace-1"))

    def test_user_id_is_stable_opaque_and_within_provider_limit(self):
        first = webhook._nexconn_user_id("workspace", "user")
        self.assertEqual(first, webhook._nexconn_user_id("workspace", "user"))
        self.assertNotIn("workspace", first)
        self.assertLessEqual(len(first.encode()), 64)

    async def test_session_returns_only_safe_client_credentials(self):
        principal = {"id": "user-1", "name": "Ada", "workspace_id": "workspace-1", "role": "owner"}
        settings = self.settings()
        with patch.object(webhook, "current", return_value=principal), \
             patch.object(webhook, "_settings", return_value=settings), \
             patch.object(webhook, "_issue_access_token", new=AsyncMock(return_value="user-token")) as issue, \
             patch.object(webhook, "_ensure_group_membership", new=AsyncMock()) as membership:
            result = await webhook.nexconn_session()

        self.assertTrue(result["enabled"])
        self.assertEqual(result["token"], "user-token")
        self.assertEqual(result["channel"]["id"], "engineering")
        self.assertNotIn("app_secret", result)
        issue.assert_awaited_once()
        membership.assert_awaited_once()

    async def test_session_does_not_contact_nexconn_for_another_workspace(self):
        principal = {"id": "user-1", "name": "Ada", "workspace_id": "workspace-2", "role": "viewer"}
        with patch.object(webhook, "current", return_value=principal), \
             patch.object(webhook, "_settings", return_value=self.settings()), \
             patch.object(webhook, "_issue_access_token", new=AsyncMock()) as issue:
            result = await webhook.nexconn_session()
        self.assertFalse(result["enabled"])
        issue.assert_not_awaited()

    async def test_every_workspace_role_can_connect_without_role_escalation(self):
        for role in ("viewer", "member", "editor", "admin", "owner"):
            principal = {
                "id": f"{role}-user", "name": role.title(),
                "workspace_id": "workspace-1", "role": role,
            }
            with self.subTest(role=role), \
                 patch.object(webhook, "current", return_value=principal), \
                 patch.object(webhook, "_settings", return_value=self.settings()), \
                 patch.object(webhook, "_issue_access_token", new=AsyncMock(return_value="token")), \
                 patch.object(webhook, "_ensure_group_membership", new=AsyncMock()) as membership:
                result = await webhook.nexconn_session()

            self.assertTrue(result["enabled"])
            membership.assert_awaited_once()
            self.assertEqual(membership.await_args.args[2], role == "owner")

    async def test_group_provisioning_uses_documented_server_api_contract(self):
        settings = self.settings()
        request = AsyncMock(side_effect=[
            {"code": 100},
            {"code": 0},
        ])
        with patch.object(webhook, "_signed_post", new=request):
            await webhook._ensure_group_membership(settings, "user-1", can_create=True)

        self.assertEqual(request.await_args_list, [
            call(settings, "/v4/group-channel/join", {
                "channelId": "engineering", "userIds": ["user-1"],
            }),
            call(settings, "/v4/group-channel/create", {
                "channelId": "engineering", "name": "Engineering", "owner": "user-1",
            }),
        ])

    async def test_only_owner_can_provision_a_missing_group(self):
        with patch.object(webhook, "_signed_post", new=AsyncMock(return_value={"code": 100})) as request:
            with self.assertRaises(webhook.HTTPException) as raised:
                await webhook._ensure_group_membership(self.settings(), "user-1", can_create=False)
        self.assertEqual(raised.exception.status_code, 409)
        request.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
