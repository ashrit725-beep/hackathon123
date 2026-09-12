"""Development-context API: sources, knowledge, plans, policy, graph — every route requires the bridge token."""
from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel

from .. import qa
from ..api import require_token
from ..config import MODES, settings
from ..db import audit, incidents, now_iso
from . import context, executor, github, graph, planner, store
from .slack import connector as slack

router = APIRouter(prefix="/api/shadowqa/core", tags=["shadowqa-core"])


class ImportSource(BaseModel):
    kind: str  # chatgpt | claude | note | codex | claude_code
    title: str = ""
    text: str
    url: str | None = None
    author: str | None = None


class KnowledgeUpdate(BaseModel):
    state: str | None = None  # confirmed | rejected | proposed
    statement: str | None = None
    type: str | None = None


class PlanRequest(BaseModel):
    objective: str


class ModeUpdate(BaseModel):
    mode: str


class VerifyRequest(BaseModel):
    qa_run_id: str | None = None


def _overview_counts(items: list[dict], plans: list[dict]) -> dict:
    return {"knowledge": {"confirmed": sum(1 for k in items if k["state"] == "confirmed"), "proposed": sum(1 for k in items if k["state"] == "proposed")},
            "plans": {"total": len(plans), "done": sum(1 for p in plans if p["status"] in ("done", "verified")), "awaiting": sum(1 for p in plans if p["status"] == "proposed")}}


@router.get("/overview")
async def overview(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    items = await store.knowledge.find({}, {"_id": 0, "state": 1}).to_list(500)
    plans = await store.plans.find({}, {"_id": 0, "status": 1}).to_list(200)
    return {"mode": settings.mode, "modes": list(MODES), "autonomy": settings.autonomy, "planning_model": settings.planning_model,
            "sources": await store.sources.count_documents({"deleted": False}), "pending_sources": await store.sources.count_documents({"processed": False, "deleted": False}),
            **_overview_counts(items, plans), "connectors": {"slack": slack.status(), "github": github.connector.status()},
            "public_url": settings.public_url}


@router.put("/mode")
async def set_mode(body: ModeUpdate, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    if body.mode not in MODES:
        raise HTTPException(status_code=400, detail=f"mode must be one of {', '.join(MODES)}")
    settings.set_mode(body.mode)
    await audit("policy.mode_changed", actor="developer", mode=body.mode, autonomy=settings.autonomy)
    return {"mode": settings.mode, "autonomy": settings.autonomy}


# ---- sources -------------------------------------------------------------------------------------
@router.get("/sources")
async def list_sources(kind: str | None = None, limit: int = Query(default=40, le=200), x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    query: dict = {"deleted": False}
    if kind:
        query["kind" if kind.startswith(("slack", "github", "conversation", "note")) else "provider"] = kind
    return await store.sources.find(query, store.PROJECTION).sort("ts", -1).to_list(limit)


@router.post("/sources/import")
async def import_source(body: ImportSource, x_shadowqa_token: str | None = Header(default=None)):
    """ShadowQA Individual: a ChatGPT / Claude conversation or a coding-agent session pasted by the developer becomes a tracked source."""
    require_token(x_shadowqa_token)
    text = body.text.strip()
    if len(text) < 20:
        raise HTTPException(status_code=400, detail="paste at least a few lines of the conversation")
    provider = body.kind if body.kind in ("chatgpt", "claude", "codex", "claude_code") else "manual"
    doc = {"external_id": f"import:{store.fingerprint(text[:2000])}", "kind": "conversation" if provider != "manual" else "note", "provider": provider,
           "title": (body.title or f"{provider} conversation").strip()[:160], "text": text[:12000], "author": (body.author or "developer")[:80],
           "url": body.url, "ts": now_iso(), "deleted": False}
    record, is_new = await store.upsert_source(doc)
    await audit("source.imported", actor="developer", kind=provider, chars=len(text), new=is_new)
    extracted = await context.extract_pending()
    return {"source": record, "new": is_new, "extracted": extracted}


@router.post("/connectors/github/sync")
async def github_sync(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    try:
        return await github.connector.sync(force=True)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GitHub sync failed: {type(exc).__name__}: {str(exc)[:200]}")


@router.post("/connectors/slack/test")
async def slack_test(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    channel = slack.notify_channel()
    if not channel:
        raise HTTPException(status_code=409, detail="no Slack channel known yet — invite the bot to a channel and post a message there first")
    ts = await slack.post(channel, f"ShadowQA is connected · mode `{settings.mode}` · <{settings.public_url}/shadowqa?view=context|Command Center>")
    if not ts:
        raise HTTPException(status_code=502, detail=slack.state.get("error") or "Slack post failed")
    return {"ok": True, "channel": channel, "ts": ts}


# ---- knowledge -----------------------------------------------------------------------------------
@router.get("/knowledge")
async def list_knowledge(state: str | None = None, limit: int = Query(default=120, le=400), x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    query = {"state": state} if state else {}
    return await store.knowledge.find(query, store.PROJECTION).sort("created_at", -1).to_list(limit)


@router.post("/knowledge/extract")
async def extract_now(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return await context.extract_pending()


@router.put("/knowledge/{item_id}")
async def update_knowledge(item_id: str, body: KnowledgeUpdate, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    item = await store.knowledge.find_one({"id": item_id}, store.PROJECTION)
    if not item:
        raise HTTPException(status_code=404, detail="knowledge item not found")
    fields: dict = {"updated_at": now_iso()}
    if body.state:
        if body.state not in ("confirmed", "rejected", "proposed"):
            raise HTTPException(status_code=400, detail="state must be confirmed, rejected or proposed")
        fields["state"] = body.state
        fields["confirmed_by"] = "developer" if body.state == "confirmed" else None
    if body.statement and body.statement.strip():
        fields["statement"] = body.statement.strip()[:200]
        fields["fingerprint"] = store.fingerprint(fields["statement"])
        fields["edited_by"] = "developer"  # a human correction is never overwritten by extraction
    if body.type in context.ITEM_TYPES:
        fields["type"] = body.type
    await store.knowledge.update_one({"id": item_id}, {"$set": fields})
    await audit("knowledge.updated", actor="developer", item=item_id, **{k: v for k, v in fields.items() if k in ("state", "type")})
    return await store.knowledge.find_one({"id": item_id}, store.PROJECTION)


# ---- plans ---------------------------------------------------------------------------------------
@router.get("/plans")
async def list_plans(limit: int = Query(default=30, le=100), x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return await store.plans.find({}, {"_id": 0, "checkpoints": 0}).sort("created_at", -1).to_list(limit)


@router.post("/plans")
async def create_plan(body: PlanRequest, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    if len(body.objective.strip()) < 8:
        raise HTTPException(status_code=400, detail="describe the objective in a sentence")
    try:
        return await planner.compile_plan(body.objective, actor="developer", origin={"kind": "center"})
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"planning failed: {type(exc).__name__}: {str(exc)[:200]}")


@router.get("/plans/{plan_id}")
async def read_plan(plan_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    plan = await store.plans.find_one({"id": plan_id}, {"_id": 0, "checkpoints": 0})
    if not plan:
        raise HTTPException(status_code=404, detail="plan not found")
    plan["knowledge"] = await store.knowledge.find({"id": {"$in": plan.get("requirement_ids") or []}}, store.PROJECTION).to_list(20)
    plan["incidents"] = await incidents.find({"plan_id": plan_id}, {"_id": 0, "id": 1, "title": 1, "status": 1, "created_at": 1}).sort("created_at", -1).to_list(10)
    return plan


@router.get("/plans/{plan_id}/brief")
async def plan_brief(plan_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    plan = await store.get_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="plan not found")
    items = await store.knowledge.find({"id": {"$in": plan.get("requirement_ids") or []}}, store.PROJECTION).to_list(20)
    return {"id": plan_id, "markdown": planner.brief_markdown(plan, items), "filename": f"shadowqa-plan-{plan_id}.md"}


@router.post("/plans/{plan_id}/approve")
async def approve_plan(plan_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    plan = await store.get_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="plan not found")
    if plan["status"] not in ("proposed", "failed", "rejected"):
        raise HTTPException(status_code=409, detail=f"cannot approve a plan in status {plan['status']}")
    if settings.observe_only:
        raise HTTPException(status_code=409, detail="project is in observe mode — switch to approval or auto-fix to execute plans")
    for t in plan["tasks"]:
        t.update(status="pending", result=None)
    await store.update_plan(plan_id, {"status": "approved", "approved_at": now_iso(), "approved_by": "developer", "tasks": plan["tasks"], "error": None})
    await audit("plan.approved", actor="developer", plan=plan_id)
    executor.launch(plan_id, actor="developer")
    return {"ok": True, "status": "approved"}


@router.post("/plans/{plan_id}/reject")
async def reject_plan(plan_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    plan = await store.get_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="plan not found")
    await store.update_plan(plan_id, {"status": "rejected", "rejected_at": now_iso()})
    await audit("plan.rejected", actor="developer", plan=plan_id)
    from . import hooks
    await hooks.plan_event(plan_id, "rejected")
    return {"ok": True, "status": "rejected"}


@router.post("/plans/{plan_id}/rollback")
async def rollback_plan(plan_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    plan = await executor.rollback_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="plan not found")
    plan.pop("checkpoints", None)
    return plan


@router.post("/plans/{plan_id}/verify")
async def verify_plan(plan_id: str, body: VerifyRequest, x_shadowqa_token: str | None = Header(default=None)):
    """Attach the latest browser QA sweep (run by the SDK in the developer's tab) as the plan's runtime verification."""
    require_token(x_shadowqa_token)
    plan = await store.get_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="plan not found")
    if plan["status"] not in ("done", "verified"):
        raise HTTPException(status_code=409, detail="only a built plan can be verified")
    run = await qa.latest_run()
    if not run or (body.qa_run_id and run.get("id") != body.qa_run_id):
        raise HTTPException(status_code=409, detail="no QA sweep result available yet")
    wanted = set((plan.get("verification") or {}).get("flows") or [])
    flows = [f for f in run.get("flows", []) if not wanted or f.get("name") in wanted] or run.get("flows", [])
    summary = {"id": run.get("id"), "at": run.get("at"), "passed": sum(1 for f in flows if f.get("status") == "passed"), "failed": sum(1 for f in flows if f.get("status") == "failed"),
               "flows": [{"name": f.get("name"), "status": f.get("status"), "error": f.get("error"), "incident_id": f.get("incident_id")} for f in flows[:20]]}
    status = "verified" if summary["failed"] == 0 and flows else "done"
    await store.update_plan(plan_id, {"qa_run": summary, "status": status, "verification": {**(plan.get("verification") or {}), "status": "verified" if status == "verified" else "failed"}})
    await audit("plan.verified" if status == "verified" else "plan.verification_failed", actor="sdk", plan=plan_id, passed=summary["passed"], failed=summary["failed"])
    if status == "verified":
        from . import hooks
        await hooks.plan_event(plan_id, "verified")
    return await store.plans.find_one({"id": plan_id}, {"_id": 0, "checkpoints": 0})


# ---- graph & activity -----------------------------------------------------------------------------
@router.get("/graph")
async def project_graph(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return await graph.build()


@router.get("/activity")
async def activity(limit: int = Query(default=40, le=100), x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return await graph.activity(limit)
