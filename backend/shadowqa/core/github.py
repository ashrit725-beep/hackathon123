"""GitHub connector: issues, pull requests, reviews, comments, check runs and commits of the watched repository become sources."""
import asyncio
import logging

import httpx

from ..config import settings
from ..db import audit, now_iso
from . import context, store

log = logging.getLogger("shadowqa.core.github")
API = "https://api.github.com"


class GitHubConnector:
    def __init__(self) -> None:
        self.repo = settings.github_watch_repo
        self.state: dict = {"configured": bool(self.repo and settings.github_token), "repo": self.repo or None, "last_sync": None,
                            "syncing": False, "counts": {}, "error": None, "default_branch": None, "rate_remaining": None}
        self._lock = asyncio.Lock()

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {settings.github_token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}

    async def _get(self, http: httpx.AsyncClient, path: str, **params) -> list | dict:
        res = await http.get(f"{API}{path}", headers=self._headers(), params={k: v for k, v in params.items() if v is not None})
        self.state["rate_remaining"] = res.headers.get("x-ratelimit-remaining")
        if res.status_code == 404:
            return []
        res.raise_for_status()
        return res.json()

    async def start(self) -> None:
        if not self.state["configured"]:
            return
        saved = await store.connector_state("github")
        self.state["last_sync"] = saved.get("last_sync")
        self.state["counts"] = saved.get("counts") or {}
        while True:
            try:
                await self.sync()
            except Exception as exc:
                self.state["error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
                log.warning("GitHub sync failed: %s", self.state["error"])
            await asyncio.sleep(max(60, settings.github_poll_seconds))

    async def sync(self, force: bool = False) -> dict:
        if not self.state["configured"]:
            return {"new": 0, "error": "GitHub connector not configured"}
        async with self._lock:
            self.state["syncing"] = True
            since = None if force else self.state.get("last_sync")
            new = 0
            try:
                async with httpx.AsyncClient(timeout=30) as http:
                    repo = await self._get(http, f"/repos/{self.repo}")
                    self.state["default_branch"] = repo.get("default_branch", "main")
                    for doc in await self._collect(http, since):
                        _, is_new = await store.upsert_source(doc)
                        new += int(is_new)
                        self.state["counts"][doc["kind"]] = self.state["counts"].get(doc["kind"], 0) + int(is_new)
                self.state["last_sync"] = now_iso()
                self.state["error"] = None
                await store.save_connector_state("github", {"last_sync": self.state["last_sync"], "counts": self.state["counts"]})
                if new:
                    context.schedule_extraction()
                    await audit("github.synced", actor="system", repo=self.repo, new=new)
                return {"new": new, "last_sync": self.state["last_sync"]}
            except httpx.HTTPStatusError as exc:
                self.state["error"] = f"HTTP {exc.response.status_code} on {exc.request.url.path}"
                raise
            finally:
                self.state["syncing"] = False

    async def _collect(self, http: httpx.AsyncClient, since: str | None) -> list[dict]:
        r = self.repo
        out: list[dict] = []
        issues = await self._get(http, f"/repos/{r}/issues", state="all", sort="updated", direction="desc", per_page=40, since=since)
        prs: list[dict] = []
        for it in issues if isinstance(issues, list) else []:
            if it.get("pull_request"):
                prs.append(it)
                continue
            out.append(self._doc(f"gh:issue:{r}#{it['number']}", "github_issue", it, f"#{it['number']} {it.get('title')}",
                                 f"{it.get('title')}\n\n{it.get('body') or ''}\nlabels: {', '.join(l['name'] for l in it.get('labels') or [])} · state: {it.get('state')}"))
        for it in prs[:12]:
            n = it["number"]
            pr = await self._get(http, f"/repos/{r}/pulls/{n}")
            if not isinstance(pr, dict):
                continue
            files = await self._get(http, f"/repos/{r}/pulls/{n}/files", per_page=30)
            names = ", ".join(f["filename"] for f in files[:30]) if isinstance(files, list) else ""
            state = "merged" if pr.get("merged_at") else pr.get("state")
            out.append(self._doc(f"gh:pr:{r}#{n}", "github_pr", pr, f"PR #{n} {pr.get('title')}",
                                 f"{pr.get('title')}\n\n{pr.get('body') or ''}\nstate: {state} · {pr.get('head', {}).get('ref')} → {pr.get('base', {}).get('ref')}\nfiles: {names}"))
            for rv in await self._get(http, f"/repos/{r}/pulls/{n}/reviews", per_page=30) or []:
                if rv.get("body") or rv.get("state") in ("APPROVED", "CHANGES_REQUESTED"):
                    out.append(self._doc(f"gh:review:{rv['id']}", "github_review", rv, f"Review on PR #{n}",
                                         f"{rv.get('state')}: {rv.get('body') or ''}", ts=rv.get("submitted_at")))
            sha = (pr.get("head") or {}).get("sha")
            if sha:
                checks = await self._get(http, f"/repos/{r}/commits/{sha}/check-runs", per_page=20)
                for cr in (checks.get("check_runs") if isinstance(checks, dict) else []) or []:
                    o = cr.get("output") or {}
                    out.append(self._doc(f"gh:check:{cr['id']}", "github_check", {"html_url": cr.get("html_url"), "user": {"login": (cr.get("app") or {}).get("slug", "ci")}},
                                         f"Check {cr.get('name')} on PR #{n}", f"{cr.get('name')}: {cr.get('status')} / {cr.get('conclusion')}\n{o.get('title') or ''}\n{(o.get('summary') or '')[:800]}",
                                         ts=cr.get("completed_at") or cr.get("started_at")))
        for c in await self._get(http, f"/repos/{r}/issues/comments", sort="updated", direction="desc", per_page=40, since=since) or []:
            ref = (c.get("issue_url") or "").rsplit("/", 1)[-1]
            out.append(self._doc(f"gh:comment:{c['id']}", "github_comment", c, f"Comment on #{ref}", c.get("body") or ""))
        for c in await self._get(http, f"/repos/{r}/pulls/comments", sort="updated", direction="desc", per_page=40, since=since) or []:
            ref = (c.get("pull_request_url") or "").rsplit("/", 1)[-1]
            out.append(self._doc(f"gh:rcomment:{c['id']}", "github_comment", c, f"Review comment on PR #{ref} · {c.get('path')}",
                                 f"{c.get('path')}:{c.get('line') or c.get('original_line') or ''}\n{c.get('body') or ''}"))
        commits = await self._get(http, f"/repos/{r}/commits", sha=self.state["default_branch"], per_page=30, since=since)
        for c in commits if isinstance(commits, list) else []:
            meta = c.get("commit") or {}
            author = (c.get("author") or {}).get("login") or (meta.get("author") or {}).get("name")
            out.append(self._doc(f"gh:commit:{c['sha']}", "github_commit", {"html_url": c.get("html_url"), "user": {"login": author}},
                                 f"Commit {c['sha'][:7]}", meta.get("message") or "", ts=(meta.get("author") or {}).get("date")))
        return out

    def _doc(self, external_id: str, kind: str, raw: dict, title: str, text: str, ts: str | None = None) -> dict:
        return {"external_id": external_id, "kind": kind, "provider": "github", "title": title[:160], "text": text.strip()[:4000],
                "author": (raw.get("user") or {}).get("login") or "github", "url": raw.get("html_url"),
                "ts": ts or raw.get("created_at") or now_iso(), "repo": self.repo, "deleted": False}

    def status(self) -> dict:
        return dict(self.state)


connector = GitHubConnector()
