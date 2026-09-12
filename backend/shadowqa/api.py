"""ShadowQA bridge API — every route requires the bridge token."""
import asyncio
import uuid

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query
from pydantic import BaseModel

from . import demo, git_ops, memory, pipeline, qa
from .config import settings
from .db import audit, audit_log, get_incident, incidents, llm_log, update_incident
from .workspace import WorkspaceError, get_workspace

router = APIRouter(prefix="/api/shadowqa", tags=["shadowqa"])


def require_token(x_shadowqa_token: str | None) -> None:
    if not settings.bridge_token or x_shadowqa_token != settings.bridge_token:
        raise HTTPException(status_code=401, detail="bridge token required")


class IncidentPayload(BaseModel):
    model_config = {"extra": "allow"}


class ReplayResult(BaseModel):
    model_config = {"extra": "allow"}
    status: str
    duration_ms: int | None = None


class QARun(BaseModel):
    model_config = {"extra": "allow"}
    flows: list[dict]
    duration_ms: int | None = None


class ObservePayload(BaseModel):
    model_config = {"extra": "allow"}


@router.get("/health")
async def health(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    ws = get_workspace()
    git = await git_ops.status(ws)
    return {"ok": True, "workspace": ws.name, "root": str(ws.root), "write_roots": [ws.rel(p) for p in ws.write_roots],
            "autonomy": settings.autonomy, "models": settings.models,
            "git": git}


@router.post("/incidents")
async def create_incident(payload: IncidentPayload, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    data = payload.model_dump()
    if not data.get("failure"):
        raise HTTPException(status_code=400, detail="failure is required")
    inc = await pipeline.ingest(data)
    inc.pop("_id", None)
    return inc


@router.get("/incidents")
async def list_incidents(limit: int = Query(default=20, le=100), x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    docs = await incidents.find({}, {"_id": 0, "events": 0, "network": 0, "frames": 0, "checkpoint": 0}).sort("created_at", -1).to_list(limit)
    return docs


@router.get("/incidents/{incident_id}")
async def read_incident(incident_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    inc = await get_incident(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="incident not found")
    if inc.get("checkpoint"):
        inc["checkpoint"] = {"id": inc["checkpoint"]["id"], "created_at": inc["checkpoint"]["created_at"],
                             "files": [f["path"] for f in inc["checkpoint"]["files"]]}
    return inc


@router.post("/incidents/{incident_id}/diagnose")
async def rediagnose(incident_id: str, background: BackgroundTasks, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    inc = await get_incident(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="incident not found")
    await update_incident(incident_id, {"status": "captured", "error": None})
    background.add_task(pipeline.run_diagnosis, incident_id)
    return {"ok": True}


@router.post("/incidents/{incident_id}/apply")
async def apply_fix(incident_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    inc = await get_incident(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="incident not found")
    if inc.get("status") != "diagnosed":
        raise HTTPException(status_code=409, detail=f"cannot apply in status {inc.get('status')}")
    await audit("developer.approved_fix", incident_id, actor="developer")
    asyncio.create_task(pipeline.run_apply(incident_id, actor="developer"))
    return {"ok": True}


@router.post("/incidents/{incident_id}/replay-started")
async def replay_started(incident_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    await update_incident(incident_id, {"status": "replaying"})
    return {"ok": True}


@router.post("/incidents/{incident_id}/replay-result")
async def replay_result(incident_id: str, result: ReplayResult, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    inc = await pipeline.record_replay(incident_id, result.model_dump())
    if not inc:
        raise HTTPException(status_code=404, detail="incident not found")
    inc.pop("checkpoint", None)
    return inc


@router.post("/incidents/{incident_id}/rollback")
async def rollback(incident_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    inc = await pipeline.rollback(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="incident not found")
    inc.pop("checkpoint", None)
    return inc


@router.post("/incidents/{incident_id}/dismiss")
async def dismiss(incident_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    await update_incident(incident_id, {"status": "dismissed"})
    await audit("developer.dismissed", incident_id, actor="developer")
    return {"ok": True}


@router.post("/incidents/{incident_id}/git/pr")
async def create_pr(incident_id: str, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    try:
        return await pipeline.create_pr(incident_id)
    except git_ops.GitError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/workspace/file")
async def read_file(path: str, line: int | None = None, radius: int = 25, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    ws = get_workspace()
    try:
        text = ws.read_text(path)
    except WorkspaceError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    lines = text.splitlines()
    if line:
        start = max(1, line - radius)
        end = min(len(lines), line + radius)
    else:
        start, end = 1, min(len(lines), 200)
    return {"path": path, "start_line": start, "lines": lines[start - 1:end], "total_lines": len(lines), "highlight": line}


@router.get("/memory")
async def read_memory(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return memory.decode_for_client(await memory.get())


@router.post("/memory/observe")
async def observe(payload: ObservePayload, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    await memory.observe(payload.model_dump())
    return {"ok": True}


@router.get("/qa/flows")
async def qa_flows(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return {"flows": await qa.all_flows(get_workspace())}


@router.post("/qa/runs")
async def qa_run(run: QARun, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    data = run.model_dump()
    data["id"] = uuid.uuid4().hex[:10]
    doc = await qa.record_run(data)
    await audit("qa.run_completed", actor="sdk", passed=doc["passed"], failed=doc["failed"])
    return doc


@router.get("/qa/runs/latest")
async def qa_latest(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return await qa.latest_run() or {}


@router.get("/audit")
async def read_audit(limit: int = Query(default=60, le=300), x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return await audit_log.find({}, {"_id": 0}).sort("ts", -1).to_list(limit)


@router.get("/telemetry")
async def telemetry(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    docs = await incidents.find({}, {"_id": 0, "id": 1, "status": 1, "telemetry": 1, "created_at": 1, "title": 1, "context_signals": 1,
                                     "risk.level": 1, "diagnosis.confidence": 1, "source": 1}).sort("created_at", -1).to_list(50)
    llm_calls = await llm_log.find({}, {"_id": 0}).sort("ts", -1).to_list(30)
    keys = ["capture_to_bridge_ms", "correlation_ms", "ai_ms", "patch_ms", "validation_ms", "replay_ms", "total_ms"]
    agg: dict[str, list[int]] = {k: [] for k in keys}
    for d in docs:
        for k in keys:
            v = (d.get("telemetry") or {}).get(k)
            if isinstance(v, (int, float)):
                agg[k].append(int(v))
    averages = {k: (sum(v) // len(v) if v else None) for k, v in agg.items()}
    statuses: dict[str, int] = {}
    for d in docs:
        statuses[d.get("status", "?")] = statuses.get(d.get("status", "?"), 0) + 1
    signal_counts = [len(d.get("context_signals") or []) for d in docs if d.get("context_signals")]
    return {"incidents": docs, "averages": averages, "statuses": statuses,
            "rollbacks": sum(1 for d in docs if (d.get("telemetry") or {}).get("rollback")),
            "verified": statuses.get("verified", 0) + statuses.get("committed", 0),
            "avg_signals": (sum(signal_counts) / len(signal_counts)) if signal_counts else None,
            "llm_calls": llm_calls, "models": settings.models}


class SettingsUpdate(BaseModel):
    autonomy: str


@router.get("/settings")
async def read_settings(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return {"autonomy": settings.autonomy, "policies": ["approve_all", "auto_low"], "models": settings.models}


@router.put("/settings")
async def write_settings(body: SettingsUpdate, x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    if body.autonomy not in ("approve_all", "auto_low"):
        raise HTTPException(status_code=400, detail="autonomy must be approve_all or auto_low")
    settings.autonomy = body.autonomy
    await audit("policy.changed", actor="developer", autonomy=body.autonomy)
    return {"autonomy": settings.autonomy}


@router.get("/demo/scenarios")
async def demo_scenarios(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return {"scenarios": demo.bug_state(get_workspace())}


@router.post("/demo/reset")
async def demo_reset(x_shadowqa_token: str | None = Header(default=None)):
    require_token(x_shadowqa_token)
    return await demo.reset(get_workspace())
