"""Incident pipeline: ingest → correlate → diagnose → (auto)apply → validate → replay → verify | rollback."""
import asyncio
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone

from . import correlation, git_ops, memory, orchestrator, risk, server_sdk
from .config import settings
from .core import hooks
from .db import audit, get_incident, incidents, now_iso, now_ms, update_incident
from .llm import LLMUnavailable
from .patching import apply_files, plan_patch, restore_files
from .security import sanitize
from .sourcemap import parse_stack, resolver
from .validation import run_validation
from .workspace import get_workspace

log = logging.getLogger("shadowqa.pipeline")
TERMINAL = {"verified", "dismissed", "rolled_back", "validation_failed", "replay_failed", "diagnosis_failed", "no_safe_fix", "committed", "superseded"}
APPLIED_UNVERIFIED = {"applying", "validating", "awaiting_replay", "replaying"}


async def _supersede_stale(ws) -> None:
    """Stuck incidents are superseded; applied-but-unverified patches older than 10 min are reverted (never leave the workspace worse)."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
    stale = await incidents.find({"status": {"$nin": list(TERMINAL)}, "updated_at": {"$lt": cutoff.isoformat()}},
                                 {"_id": 0, "id": 1, "status": 1, "checkpoint": 1}).to_list(20)
    for inc in stale:
        fields = {"status": "superseded"}
        if inc.get("status") in APPLIED_UNVERIFIED and inc.get("checkpoint"):
            restore_files(ws, inc["checkpoint"]["files"])
            fields["rolled_back_at"] = now_iso()
            fields["telemetry.rollback"] = True
            await audit("rollback.superseded", inc["id"], actor="system")
        await update_incident(inc["id"], fields)


async def ingest(payload: dict) -> dict:
    t0 = time.time()
    ws = get_workspace()
    payload = sanitize(payload, max_len=4000)
    failure = payload.get("failure") or {}
    frames = parse_stack(failure.get("stack"))
    frames = await resolver.resolve_frames(frames, settings.dev_server_url, ws.source_strip_prefixes, ws.source_map_to, str(ws.root))
    corr = correlation.build(payload, frames, server_error_for=server_sdk.match)
    await _supersede_stale(ws)
    detected = (payload.get("timing") or {}).get("detected_at") or failure.get("ts") or now_ms()
    incident = {
        "id": uuid.uuid4().hex[:12],
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "status": "captured",
        "source": payload.get("source", "runtime"),
        "flow_name": payload.get("flow_name"),
        "app": payload.get("app") or {},
        "failure": failure,
        "frames": frames,
        "events": payload.get("events", [])[-50:],
        "network": payload.get("network", [])[-20:],
        "dom": payload.get("dom") or {},
        "state": payload.get("state"),
        "policy": {"autonomy": settings.autonomy},
        "telemetry": {"detection_ms": max(0, int(failure.get("ts", detected)) - int(failure.get("ts", detected))),
                      "capture_to_bridge_ms": max(0, now_ms() - int(detected)),
                      "correlation_ms": int((time.time() - t0) * 1000),
                      "source_map_resolved": bool(corr.get("source_location", {}) and corr["source_location"].get("resolved"))},
        **corr,
    }
    incident["regression"] = await memory.record_incident(incident)
    if incident["regression"]:
        incident["title"] = f"Regression: {incident['title']}"
    await incidents.insert_one(dict(incident))
    await audit("incident.captured", incident["id"], actor="sdk", title=incident["title"], route=incident["app"].get("route"),
                fingerprint=incident["fingerprint"], source=incident["source"])
    asyncio.create_task(run_diagnosis(incident["id"]))
    return incident


async def run_diagnosis(incident_id: str) -> None:
    inc = await get_incident(incident_id)
    if not inc or inc.get("status") in TERMINAL:
        return
    ws = get_workspace()
    await update_incident(incident_id, {"status": "diagnosing"})
    telemetry = dict(inc.get("telemetry") or {})
    t0 = time.time()
    try:
        loc = inc.get("source_location") or {}
        brief = await memory.brief_for(inc["fingerprint"], [loc.get("file")] if loc.get("file") else [])
        result = await orchestrator.diagnose(ws, inc, brief, telemetry)
    except LLMUnavailable as exc:
        telemetry["ai_ms"] = int((time.time() - t0) * 1000)
        await update_incident(incident_id, {"status": "diagnosis_failed", "error": f"AI unavailable: {exc}", "telemetry": telemetry})
        await audit("diagnosis.failed", incident_id, error=str(exc)[:300])
        return
    except Exception as exc:  # never let the agent crash silently
        log.exception("diagnosis crashed")
        telemetry["ai_ms"] = int((time.time() - t0) * 1000)
        await update_incident(incident_id, {"status": "diagnosis_failed", "error": f"{type(exc).__name__}: {exc}", "telemetry": telemetry})
        return

    plan = result.pop("_patch_plan", None)
    diagnosis = {
        "intent": result.get("intent"), "root_cause": result.get("root_cause"), "explanation": result.get("explanation"),
        "symptom_location": result.get("symptom_location"), "cause_location": result.get("cause_location"),
        "confidence": float(result.get("confidence") or 0), "hypotheses": result.get("hypotheses") or [],
        "fix_plan": result.get("fix_plan"), "risk_notes": result.get("risk_notes") or [], "safe_to_apply": bool(result.get("safe_to_apply")),
        "verification": result.get("verification") or {}, "retrieved_files": result.get("_files", []), "rounds": result.get("_rounds", []),
        "model": (result.get("_rounds") or [{}])[-1].get("model"), "provider": (result.get("_rounds") or [{}])[-1].get("provider"),
    }
    fields: dict = {"diagnosis": diagnosis, "telemetry": telemetry}
    signals = list(inc.get("context_signals") or [])
    retrieved = diagnosis["retrieved_files"]
    if retrieved:
        names = ", ".join(f["path"].split("/")[-1] for f in retrieved[:4])
        signals.append({"kind": "workspace", "label": f"{len(retrieved)} workspace file{'s' if len(retrieved) != 1 else ''} read from disk ({names})"})
    if brief:
        signals.append({"kind": "memory", "label": "Application memory consulted" + (" — known regression" if inc.get("regression") else "")})
    fields["context_signals"] = signals
    if isinstance(result.get("title"), str) and result["title"].strip():
        fields["title"] = ("Regression: " if inc.get("regression") else "") + result["title"].strip()[:48]

    if plan:
        patch = {"files": [{"path": f["path"], "diff": f["diff"], "added": f["added"], "removed": f["removed"], "hunks": f["hunks"]} for f in plan],
                 "reason": (result.get("patch") or {}).get("reason")}
        assessment = risk.assess(plan, diagnosis)
        fields.update(patch=patch, risk=assessment, status="diagnosed")
        rp = dict(inc.get("replay_plan") or {})
        ver = diagnosis["verification"] or {}
        exp = dict(rp.get("expectations") or {})
        if ver.get("success_selector") or ver.get("success_text"):
            exp["ui"] = {"selector": ver.get("success_selector"), "text": ver.get("success_text")}
        if ver.get("expected_request") and not exp.get("request"):
            er = ver["expected_request"]
            exp["request"] = {"method": er.get("method"), "path": er.get("path"), "status_min": 200, "status_max": 399}
        rp["expectations"] = exp
        fields["replay_plan"] = rp
    else:
        fields.update(status="no_safe_fix", risk=None, patch=None)
    # The developer may have dismissed the incident while the model was thinking: keep the diagnosis for history, never act on it.
    current = await get_incident(incident_id)
    if not current or current.get("status") in TERMINAL:
        fields.pop("status", None)
        await update_incident(incident_id, fields)
        await audit("diagnosis.completed_after_dismiss", incident_id, confidence=diagnosis["confidence"])
        return
    await update_incident(incident_id, fields)
    await audit("diagnosis.completed", incident_id, status=fields["status"], confidence=diagnosis["confidence"],
                risk=(fields.get("risk") or {}).get("level"), model=diagnosis["model"])

    # Autonomous application only for failures observed live with the developer present; QA-discovered failures queue for review.
    if plan and settings.autonomy == "auto_low" and fields["risk"]["autonomous_eligible"] and inc.get("source") != "qa":
        await update_incident(incident_id, {"policy.auto_applied": True})
        await audit("policy.autonomous_apply", incident_id, risk="LOW", confidence=diagnosis["confidence"])
        asyncio.create_task(hooks.incident_event(incident_id, "diagnosed"))
        await run_apply(incident_id, actor="policy:auto_low")
    else:
        asyncio.create_task(hooks.incident_event(incident_id, fields["status"]))


async def run_apply(incident_id: str, actor: str = "developer") -> None:
    inc = await get_incident(incident_id)
    if not inc or not inc.get("patch") or inc.get("status") != "diagnosed":
        return
    ws = get_workspace()
    telemetry = dict(inc.get("telemetry") or {})
    t0 = time.time()
    ok, plan, err = plan_patch(ws, {"files": inc["patch"]["files"]})
    if not ok:
        await update_incident(incident_id, {"status": "no_safe_fix", "error": f"patch no longer applies: {err[:300]}"})
        return
    checkpoint = {"id": uuid.uuid4().hex[:10], "created_at": now_iso(), "files": [{"path": f["path"], "content": f["original"]} for f in plan]}
    await update_incident(incident_id, {"checkpoint": checkpoint, "status": "applying"})
    await audit("checkpoint.created", incident_id, actor=actor, files=[f["path"] for f in plan])
    apply_files(ws, plan)
    telemetry["patch_ms"] = int((time.time() - t0) * 1000)
    await update_incident(incident_id, {"status": "validating", "telemetry": telemetry, "applied_at": now_iso()})
    await audit("patch.applied", incident_id, actor=actor, files=[f["path"] for f in plan], lines=sum(f["added"] + f["removed"] for f in plan))
    await _validate_and_advance(incident_id, ws, [f["path"] for f in plan], checkpoint, telemetry)


async def _validate_and_advance(incident_id: str, ws, files: list[str], checkpoint: dict, telemetry: dict) -> None:
    async def progress(steps: list[dict]) -> None:
        await update_incident(incident_id, {"validation": {"status": "running", "steps": steps}})

    t1 = time.time()
    try:
        validation = await run_validation(ws, files, progress)
    except Exception as exc:
        validation = {"status": "failed", "steps": [{"name": "validation engine", "status": "failed", "output": str(exc)[:500]}]}
    telemetry["validation_ms"] = int((time.time() - t1) * 1000)
    await update_incident(incident_id, {"validation": validation, "telemetry": telemetry})
    current = await get_incident(incident_id) or {"id": incident_id}
    await memory.record_validation({**current, "validation": validation})
    if validation["status"] != "passed":
        restore_files(ws, checkpoint["files"])
        telemetry["rollback"] = True
        await update_incident(incident_id, {"status": "validation_failed", "rolled_back_at": now_iso(), "telemetry": telemetry,
                                            "error": "validation failed; workspace restored from checkpoint"})
        await audit("rollback.validation_failed", incident_id, actor="system")
        return
    await update_incident(incident_id, {"status": "awaiting_replay", "validated_at": now_iso()})
    await audit("validation.passed", incident_id, steps=[s["name"] for s in validation["steps"]])


async def resume_interrupted() -> None:
    """A backend-side patch reloads this very server mid-validation: on boot, finish the interrupted work instead of leaving incidents spinning."""
    ws = get_workspace()
    stuck = await incidents.find({"status": {"$in": ["applying", "validating"]}},
                                 {"_id": 0, "id": 1, "status": 1, "checkpoint": 1, "telemetry": 1, "patch": 1}).to_list(20)
    for inc in stuck:
        files = [f["path"] for f in (inc.get("patch") or {}).get("files", [])]
        if not inc.get("checkpoint") or not files:
            await update_incident(inc["id"], {"status": "no_safe_fix", "error": "interrupted before a checkpoint existed"})
            continue
        if inc["status"] == "applying":
            ok, plan, _ = plan_patch(ws, {"files": inc["patch"]["files"]})
            if ok:  # search text still present → the patch was never written
                apply_files(ws, plan)
            await update_incident(inc["id"], {"status": "validating"})
        await audit("pipeline.resumed_after_restart", inc["id"], actor="system", interrupted_in=inc["status"])
        await _validate_and_advance(inc["id"], ws, files, inc["checkpoint"], dict(inc.get("telemetry") or {}))


async def record_replay(incident_id: str, result: dict) -> dict | None:
    inc = await get_incident(incident_id)
    if not inc:
        return None
    if inc.get("status") not in ("replaying", "awaiting_replay"):
        # A late or duplicate replay report (e.g. from a second tab) must never overturn an established verdict.
        await audit("replay.ignored", incident_id, actor="sdk", status=inc.get("status"), reported=result.get("status"))
        return inc
    ws = get_workspace()
    telemetry = dict(inc.get("telemetry") or {})
    telemetry["replay_ms"] = result.get("duration_ms")
    replay = sanitize(result, max_len=1500)
    replay["finished_at"] = now_iso()
    passed = result.get("status") == "passed"
    if passed:
        telemetry["total_ms"] = now_ms() - int((inc.get("failure") or {}).get("ts") or now_ms())
        await update_incident(incident_id, {"replay": replay, "status": "verified", "verified_at": now_iso(), "telemetry": telemetry})
        await memory.record_fix({**inc, "replay": replay}, verified=True)
        await audit("replay.verified", incident_id, actor="sdk", evidence=[e.get("label") for e in result.get("evidence", [])][:12])
        asyncio.create_task(hooks.incident_event(incident_id, "verified"))
    else:
        if inc.get("checkpoint"):
            restore_files(ws, inc["checkpoint"]["files"])
            telemetry["rollback"] = True
        await update_incident(incident_id, {"replay": replay, "status": "replay_failed", "rolled_back_at": now_iso(), "telemetry": telemetry,
                                            "error": "replay did not confirm recovery; workspace restored from checkpoint"})
        await memory.record_fix(inc, verified=False)
        await audit("rollback.replay_failed", incident_id, actor="system")
    return await get_incident(incident_id)


async def rollback(incident_id: str, actor: str = "developer") -> dict | None:
    inc = await get_incident(incident_id)
    if not inc:
        return None
    if inc.get("checkpoint") and inc.get("status") in ("verified", "committed", "awaiting_replay", "replaying", "validating", "applying"):
        restore_files(get_workspace(), inc["checkpoint"]["files"])
        telemetry = dict(inc.get("telemetry") or {})
        telemetry["rollback"] = True
        await update_incident(incident_id, {"status": "rolled_back", "rolled_back_at": now_iso(), "telemetry": telemetry})
        await memory.record_fix(inc, verified=False)
        await audit("rollback.manual", incident_id, actor=actor, files=[f["path"] for f in inc["checkpoint"]["files"]])
    return await get_incident(incident_id)


async def create_pr(incident_id: str) -> dict:
    inc = await get_incident(incident_id)
    if not inc or inc.get("status") not in ("verified", "committed"):
        raise git_ops.GitError("only verified fixes can be committed")
    ws = get_workspace()
    branch = f"{ws.git_cfg.get('branch_prefix', 'shadowqa/fix-')}{inc['id']}"
    d = inc.get("diagnosis") or {}
    files = [f["path"] for f in (inc.get("patch") or {}).get("files", [])]
    replay = inc.get("replay") or {}
    validation = inc.get("validation") or {}
    body_lines = [f"## ShadowQA fix: {inc.get('title')}", "", f"**Intent:** {d.get('intent')}", f"**Root cause:** {d.get('root_cause')}", "",
                  d.get("explanation") or "", "", "### Evidence",
                  f"- Failure reproduced from live session (`{inc.get('fingerprint')}`)",
                  f"- Patch generated: {', '.join(files)} ({(inc.get('risk') or {}).get('lines')} lines, risk {(inc.get('risk') or {}).get('level')})",
                  *[f"- Validation: {s.get('name')} → {s.get('status')}" for s in validation.get("steps", [])],
                  *[f"- Replay: {e.get('label')} → {'✓' if e.get('ok') else '✗'}" for e in replay.get("evidence", [])[:10]],
                  "", f"_Confidence {int(float(d.get('confidence') or 0) * 100)}% · model {d.get('model')} · incident {inc['id']}_"]
    message = f"fix: {inc.get('title')}\n\n{d.get('root_cause')}\n\nShadowQA incident {inc['id']} — validated and replay-verified."
    git = await git_ops.create_fix_branch(ws, branch, files, message)
    git["pr_body"] = "\n".join(body_lines)
    git["pr_title"] = f"ShadowQA: {inc.get('title')}"
    if settings.github_repo and settings.github_token:
        try:
            pr = await git_ops.push_and_open_pr(ws, branch, git["base_branch"], git["pr_title"], git["pr_body"])
            git["pr"] = pr
        except git_ops.GitError as exc:
            git["pr_error"] = str(exc)
    else:
        git["pr_error"] = "GITHUB_REPO not configured — branch created locally; PR-ready summary attached"
    await update_incident(incident_id, {"git": git, "status": "committed"})
    await audit("git.branch_created", incident_id, branch=branch, commit=git.get("commit"), pr=(git.get("pr") or {}).get("url"))
    return git
