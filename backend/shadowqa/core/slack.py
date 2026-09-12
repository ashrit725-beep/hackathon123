"""Slack connector (Socket Mode): channel messages become sources, `@ShadowQA plan …` compiles a plan, status is posted back."""
import asyncio
import logging
import re
from datetime import datetime, timezone

from slack_sdk.errors import SlackApiError
from slack_sdk.socket_mode.aiohttp import SocketModeClient
from slack_sdk.socket_mode.request import SocketModeRequest
from slack_sdk.socket_mode.response import SocketModeResponse
from slack_sdk.web.async_client import AsyncWebClient

from ..config import settings
from ..db import audit, incidents, now_iso
from . import context, store

log = logging.getLogger("shadowqa.core.slack")
MENTION_RE = re.compile(r"<@[A-Z0-9]+>")


def _iso(ts: str | None) -> str:
    try:
        return datetime.fromtimestamp(float(ts or 0), tz=timezone.utc).isoformat()
    except (TypeError, ValueError):
        return now_iso()


class SlackConnector:
    def __init__(self) -> None:
        self.web = AsyncWebClient(token=settings.slack_bot_token) if settings.slack_bot_token else None
        self.client: SocketModeClient | None = None
        self.bot_user_id = ""
        self.bot_id = ""
        self.team_url = ""
        self.users: dict[str, str] = {}
        self.channel_names: dict[str, str] = {}
        self.state: dict = {"configured": bool(settings.slack_bot_token and settings.slack_app_token), "connected": False,
                            "team": None, "channels": {}, "events": 0, "last_event_at": None, "last_channel": None, "error": None}

    # ---- lifecycle -----------------------------------------------------------------------------
    async def start(self) -> None:
        if not self.state["configured"]:
            return
        saved = await store.connector_state("slack")
        self.state["channels"] = saved.get("channels") or {}
        self.state["last_channel"] = saved.get("last_channel")
        self.channel_names = {cid: c.get("name") for cid, c in self.state["channels"].items() if c.get("name")}
        try:
            auth = await self.web.auth_test()
            self.bot_user_id, self.bot_id, self.team_url = auth["user_id"], auth.get("bot_id", ""), auth.get("url", "")
            self.state["team"] = auth.get("team")
            self.client = SocketModeClient(app_token=settings.slack_app_token, web_client=self.web)
            self.client.socket_mode_request_listeners.append(self._on_request)
            await self.client.connect()
            self.state["connected"] = True
            self.state["error"] = None
            log.info("Slack connected · team=%s bot=%s channels=%d", auth.get("team"), self.bot_user_id, len(self.state["channels"]))
            await audit("slack.connected", actor="system", team=auth.get("team"), channels=len(self.state["channels"]))
            for channel in list(self.state["channels"])[:10]:
                asyncio.create_task(self.backfill(channel))
        except Exception as exc:
            self.state["error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
            log.warning("Slack connect failed: %s", self.state["error"])

    async def stop(self) -> None:
        if self.client:
            await self.client.close()
            self.state["connected"] = False

    # ---- inbound -------------------------------------------------------------------------------
    async def _on_request(self, client: SocketModeClient, req: SocketModeRequest) -> None:
        if req.type != "events_api":
            return
        await client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))  # ack before any work
        event = req.payload.get("event") or {}
        try:
            await self.handle_event(event)
        except Exception:
            log.exception("slack event failed: %s", event.get("type"))

    async def handle_event(self, event: dict) -> None:
        kind, subtype = event.get("type"), event.get("subtype")
        self.state["events"] += 1
        self.state["last_event_at"] = now_iso()
        if kind == "app_mention":
            await self._ingest(event, event.get("channel"))
            asyncio.create_task(self._command(event))
            return
        if kind != "message" or event.get("channel_type") not in ("channel", "group", None):
            return
        channel = event.get("channel")
        if subtype == "message_changed":
            inner = dict(event.get("message") or {})
            await self._ingest(inner, channel)
        elif subtype == "message_deleted":
            await store.tombstone_source(f"slack:{channel}:{event.get('deleted_ts')}")
        elif subtype in (None, "file_share", "thread_broadcast"):
            await self._ingest(event, channel)

    async def _ingest(self, msg: dict, channel: str | None) -> dict | None:
        if not channel or not msg.get("ts") or (msg.get("user") == self.bot_user_id) or (self.bot_id and msg.get("bot_id") == self.bot_id):
            return None
        text = MENTION_RE.sub("", str(msg.get("text") or "")).strip()
        if not text:
            return None
        author = await self._user_name(msg.get("user")) if msg.get("user") else (msg.get("username") or "bot")
        name = await self._channel_name(channel)
        doc = {"external_id": f"slack:{channel}:{msg['ts']}", "kind": "slack_message", "provider": "slack", "text": text[:4000],
               "author": author, "ts": _iso(msg["ts"]), "url": f"{self.team_url.rstrip('/')}/archives/{channel}/p{msg['ts'].replace('.', '')}",
               "channel": channel, "channel_name": name, "thread_ts": msg.get("thread_ts"), "deleted": False}
        record, is_new = await store.upsert_source(doc)
        ch = self.state["channels"].setdefault(channel, {"name": name, "count": 0})
        ch["name"], ch["count"], ch["last_ts"] = name, ch.get("count", 0) + (1 if is_new else 0), msg["ts"]
        self.state["last_channel"] = channel
        await store.save_connector_state("slack", {"channels": self.state["channels"], "last_channel": channel})
        if is_new or not record.get("processed", True):
            context.schedule_extraction()
        return record

    async def backfill(self, channel: str, limit: int = 100) -> int:
        try:
            res = await self.web.conversations_history(channel=channel, limit=limit)
        except SlackApiError as exc:
            log.warning("backfill %s failed: %s", channel, exc.response.get("error") if exc.response else exc)
            return 0
        count = 0
        for msg in reversed(res.get("messages") or []):
            if msg.get("subtype") in (None, "file_share", "thread_broadcast") and await self._ingest(msg, channel):
                count += 1
        return count

    async def _user_name(self, user_id: str) -> str:
        if user_id in self.users:
            return self.users[user_id]
        try:
            info = await self.web.users_info(user=user_id)
            profile = info["user"]
            name = profile.get("real_name") or (profile.get("profile") or {}).get("display_name") or profile.get("name") or user_id
        except SlackApiError:
            name = user_id
        self.users[user_id] = name
        return name

    async def _channel_name(self, channel: str) -> str:
        if channel in self.channel_names:
            return self.channel_names[channel]
        try:
            info = await self.web.conversations_info(channel=channel)
            name = "#" + info["channel"].get("name", channel)
        except SlackApiError:  # channels:read not granted → fall back to the id
            name = channel
        self.channel_names[channel] = name
        return name

    # ---- commands ------------------------------------------------------------------------------
    async def _command(self, event: dict) -> None:
        text = MENTION_RE.sub("", str(event.get("text") or "")).strip()
        channel, thread = event.get("channel"), event.get("thread_ts") or event.get("ts")
        actor = f"slack:{await self._user_name(event.get('user'))}" if event.get("user") else "slack"
        m = re.match(r"^(plan|status|sync|help)\b\s*(.*)$", text, re.IGNORECASE | re.DOTALL)
        verb, arg = (m.group(1).lower(), m.group(2).strip()) if m else ("help", "")
        if verb == "plan" and arg:
            from . import planner  # local import: planner posts back through this connector
            await self.post(channel, f"Compiling a plan for *{arg[:140]}* from the project's confirmed context…", thread_ts=thread)
            await audit("slack.plan_requested", actor=actor, objective=arg[:200], channel=channel)
            try:
                plan = await planner.compile_plan(arg, actor=actor, origin={"kind": "slack", "channel": channel, "thread_ts": thread})
                await self.post_plan(plan, "proposed" if plan.get("status") == "proposed" else plan.get("status"), channel=channel, thread_ts=thread)
            except Exception as exc:
                await self.post(channel, f"I couldn't compile that plan: {type(exc).__name__}: {str(exc)[:200]}", thread_ts=thread)
        elif verb == "status":
            await self.post(channel, await self._status_text(), thread_ts=thread)
        elif verb == "sync":
            from . import github
            summary = await github.connector.sync(force=True)
            extracted = await context.extract_pending()
            await self.post(channel, f"Synced GitHub ({summary.get('new', 0)} new items) and extracted {extracted.get('items', 0)} knowledge items.", thread_ts=thread)
        else:
            await self.post(channel, "I read this channel into the project's context. Commands: `@ShadowQA plan <objective>` · `@ShadowQA status` · `@ShadowQA sync`. "
                            "Approvals happen in the Command Center, never here.", thread_ts=thread)

    async def _status_text(self) -> str:
        n_src = await store.sources.count_documents({"deleted": False})
        n_items = await store.knowledge.count_documents({"state": "confirmed"})
        n_prop = await store.knowledge.count_documents({"state": "proposed"})
        n_plans = await store.plans.count_documents({})
        n_ver = await incidents.count_documents({"status": {"$in": ["verified", "committed"]}})
        return (f"*ShadowQA status* · mode `{settings.mode}`\n{n_src} sources · {n_items} confirmed + {n_prop} proposed knowledge items · "
                f"{n_plans} plans · {n_ver} runtime fixes verified by replay.\n<{settings.public_url}/shadowqa?view=context|Open the Command Center>")

    # ---- outbound ------------------------------------------------------------------------------
    def notify_channel(self) -> str | None:
        return settings.slack_notify_channel or self.state.get("last_channel")

    async def post(self, channel: str | None, text: str, blocks: list[dict] | None = None, thread_ts: str | None = None) -> str | None:
        if not (self.web and channel):
            return None
        try:
            res = await self.web.chat_postMessage(channel=channel, text=text[:3000], blocks=blocks, thread_ts=thread_ts, unfurl_links=False)
            return res.get("ts")
        except SlackApiError as exc:
            err = exc.response.get("error") if exc.response else str(exc)
            self.state["error"] = f"post failed: {err}"
            log.warning("slack post failed: %s", err)
            return None

    async def post_plan(self, plan: dict, event: str, channel: str | None = None, thread_ts: str | None = None) -> None:
        from .notify import plan_message
        origin = plan.get("origin") or {}
        channel = channel or origin.get("channel") or self.notify_channel()
        text, blocks = plan_message(plan, event)
        await self.post(channel, text, blocks, thread_ts=thread_ts or origin.get("thread_ts"))

    async def post_incident(self, inc: dict, event: str) -> None:
        from .notify import incident_message
        channel = self.notify_channel()
        if channel:
            text, blocks = incident_message(inc, event)
            await self.post(channel, text, blocks)

    def status(self) -> dict:
        return {**self.state, "bot_user_id": self.bot_user_id or None, "notify_channel": self.notify_channel(),
                "channel_list": [{"id": cid, **c} for cid, c in self.state["channels"].items()]}


connector = SlackConnector()
