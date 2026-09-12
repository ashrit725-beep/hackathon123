"""Project context graph: decision → requirement → plan → file → runtime incident → verification, plus a unified activity feed."""
from ..db import audit_log, incidents
from . import store


def _files_of_plan(plan: dict) -> set[str]:
    out: set[str] = set()
    for t in plan.get("tasks") or []:
        out.update(t.get("files") or [])
        out.update(f["path"] for f in ((t.get("result") or {}).get("files") or []))
    return out


def _files_of_incident(inc: dict) -> set[str]:
    out = {f["path"] for f in ((inc.get("patch") or {}).get("files") or [])}
    loc = inc.get("source_location") or {}
    if loc.get("file"):
        out.add(loc["file"])
    return out


async def build() -> dict:
    items = await store.knowledge.find({"state": {"$ne": "rejected"}}, store.PROJECTION).sort("created_at", -1).to_list(80)
    plans = await store.plans.find({}, {"_id": 0, "checkpoints": 0}).sort("created_at", -1).to_list(30)
    incs = await incidents.find({}, {"_id": 0, "id": 1, "title": 1, "status": 1, "patch.files.path": 1, "source_location": 1, "plan_id": 1,
                                      "requirement_ids": 1, "created_at": 1, "replay.status": 1, "telemetry.total_ms": 1, "app.route": 1}).sort("created_at", -1).to_list(60)
    nodes: list[dict] = []
    edges: list[tuple[str, str]] = []
    for k in items:
        nodes.append({"id": f"k:{k['id']}", "col": "knowledge", "type": k["type"], "label": k["statement"], "state": k["state"],
                      "sources": len(k.get("sources") or []), "ref": k["id"]})
    files: dict[str, dict] = {}
    for p in plans:
        nodes.append({"id": f"p:{p['id']}", "col": "plan", "type": "plan", "label": p["title"], "state": p["status"], "ref": p["id"],
                      "tasks": len(p.get("tasks") or []), "risk": p.get("risk")})
        for rid in p.get("requirement_ids") or []:
            edges.append((f"k:{rid}", f"p:{p['id']}"))
        for path in _files_of_plan(p):
            files.setdefault(path, {"id": f"f:{path}", "col": "file", "type": "file", "label": path, "state": "changed" if p["status"] in ("done", "verified") else "planned"})
            edges.append((f"p:{p['id']}", f"f:{path}"))
    linked_incidents: list[dict] = []
    for inc in incs:
        inc_files = _files_of_incident(inc)
        touches = [path for path in files if path in inc_files]
        if not (touches or inc.get("plan_id")):
            continue
        linked_incidents.append(inc)
        nodes.append({"id": f"i:{inc['id']}", "col": "incident", "type": "incident", "label": inc.get("title") or "Runtime failure", "state": inc.get("status"),
                      "ref": inc["id"], "route": (inc.get("app") or {}).get("route")})
        for path in touches:
            edges.append((f"f:{path}", f"i:{inc['id']}"))
        if inc.get("plan_id") and not touches:
            edges.append((f"p:{inc['plan_id']}", f"i:{inc['id']}"))
        if inc.get("status") in ("verified", "committed"):
            nodes.append({"id": f"v:{inc['id']}", "col": "verification", "type": "replay", "label": f"Replay verified · {int(((inc.get('telemetry') or {}).get('total_ms') or 0) / 1000)}s",
                          "state": "verified", "ref": inc["id"]})
            edges.append((f"i:{inc['id']}", f"v:{inc['id']}"))
    for p in plans:
        qa = p.get("qa_run") or {}
        if qa:
            nodes.append({"id": f"v:plan:{p['id']}", "col": "verification", "type": "qa_sweep", "label": f"QA sweep · {qa.get('passed', 0)} passed / {qa.get('failed', 0)} failed",
                          "state": "verified" if not qa.get("failed") else "failed", "ref": p["id"]})
            edges.append((f"p:{p['id']}", f"v:plan:{p['id']}"))
    nodes.extend(files.values())
    ids = {n["id"] for n in nodes}
    return {"nodes": nodes, "edges": [{"from": a, "to": b} for a, b in edges if a in ids and b in ids],
            "columns": ["knowledge", "plan", "file", "incident", "verification"],
            "counts": {"knowledge": len(items), "plans": len(plans), "files": len(files), "incidents": len(linked_incidents)}}


async def activity(limit: int = 40) -> list[dict]:
    """Unified feed across sources, knowledge, plans, incidents and the audit log."""
    out: list[dict] = []
    for s in await store.sources.find({"deleted": False}, {"_id": 0, "id": 1, "kind": 1, "author": 1, "title": 1, "text": 1, "ts": 1, "url": 1, "channel_name": 1}).sort("ts", -1).to_list(limit):
        out.append({"ts": s.get("ts"), "kind": "source", "sub": s["kind"], "who": s.get("author"), "label": s.get("title") or str(s.get("text") or "")[:120], "url": s.get("url"), "ref": s["id"]})
    for k in await store.knowledge.find({}, {"_id": 0, "id": 1, "type": 1, "statement": 1, "state": 1, "created_at": 1}).sort("created_at", -1).to_list(limit):
        out.append({"ts": k["created_at"], "kind": "knowledge", "sub": k["type"], "label": k["statement"], "state": k["state"], "ref": k["id"]})
    for p in await store.plans.find({}, {"_id": 0, "id": 1, "title": 1, "status": 1, "created_at": 1, "requested_by": 1}).sort("created_at", -1).to_list(limit):
        out.append({"ts": p["created_at"], "kind": "plan", "sub": p["status"], "who": p.get("requested_by"), "label": p["title"], "ref": p["id"]})
    for a in await audit_log.find({"action": {"$in": ["replay.verified", "diagnosis.completed", "plan.done", "plan.failed_rolled_back", "slack.connected", "github.synced", "context.extracted"]}},
                                  {"_id": 0}).sort("ts", -1).to_list(limit):
        out.append({"ts": a["ts"], "kind": "event", "sub": a["action"], "who": a.get("actor"), "label": a["action"].replace(".", " → ").replace("_", " "), "ref": a.get("incident_id")})
    out.sort(key=lambda e: str(e.get("ts") or ""), reverse=True)
    return out[:limit]
