"""Hooks between the runtime loop and the development-context layer. Never raise into the pipeline."""
import logging

from ..db import audit, get_incident, update_incident
from . import store

log = logging.getLogger("shadowqa.core.hooks")


async def _link_incident(inc: dict) -> dict:
    """Join a runtime incident to the plan / requirements whose files it touches, so the chain reads decision → code → runtime."""
    files = {f["path"] for f in ((inc.get("patch") or {}).get("files") or [])}
    loc = inc.get("source_location") or {}
    if loc.get("file"):
        files.add(loc["file"])
    if not files or inc.get("plan_id"):
        return inc
    plans = await store.plans.find({"status": {"$in": ["done", "verified", "executing", "approved"]}}, {"_id": 0, "id": 1, "tasks": 1, "requirement_ids": 1}).sort("created_at", -1).to_list(30)
    for p in plans:
        planned = {f for t in p.get("tasks") or [] for f in (t.get("files") or [])}
        if planned & files:
            items = await store.knowledge.find({"id": {"$in": p.get("requirement_ids") or []}}, {"_id": 0, "statement": 1}).to_list(5)
            fields = {"plan_id": p["id"], "requirement_ids": p.get("requirement_ids") or [], "requirement_statements": [k["statement"] for k in items]}
            await update_incident(inc["id"], fields)
            await audit("incident.linked_to_plan", inc["id"], actor="system", plan=p["id"])
            return {**inc, **fields}
    return inc


async def incident_event(incident_id: str, event: str) -> None:
    try:
        inc = await get_incident(incident_id)
        if not inc:
            return
        inc = await _link_incident(inc)
        from .slack import connector
        await connector.post_incident(inc, event)
    except Exception:
        log.exception("incident hook failed (%s)", event)


async def plan_event(plan_id: str, event: str) -> None:
    try:
        plan = await store.get_plan(plan_id)
        if plan:
            from .slack import connector
            await connector.post_plan(plan, event)
    except Exception:
        log.exception("plan hook failed (%s)", event)
