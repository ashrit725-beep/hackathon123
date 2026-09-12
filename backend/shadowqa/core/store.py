"""Collections and small helpers for the development-context layer."""
import hashlib
import re
import uuid

from ..db import db, now_iso

sources = db.sqa_sources          # Slack messages, GitHub items, imported conversations (source documents with provenance)
knowledge = db.sqa_knowledge      # decisions / requirements / constraints / bugs / questions extracted from sources
plans = db.sqa_plans              # compiled development plans with tasks, execution results and verification
connectors = db.sqa_connectors    # connector state (Slack channels seen, GitHub cursors)

PROJECTION = {"_id": 0}


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def fingerprint(text: str) -> str:
    norm = re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower())
    norm = " ".join(w for w in norm.split() if len(w) > 2)
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def tokens(text: str) -> set[str]:
    return {w for w in re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower()).split() if len(w) > 3}


def overlap(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


async def upsert_source(doc: dict) -> tuple[dict, bool]:
    """Upsert by stable external identity; returns (document, is_new). Text edits bump the revision and re-queue extraction."""
    existing = await sources.find_one({"external_id": doc["external_id"]}, PROJECTION)
    now = now_iso()
    if existing:
        changed = (doc.get("text") or "") != (existing.get("text") or "")
        fields = {**doc, "updated_at": now, "revision": existing.get("revision", 1) + (1 if changed else 0)}
        if changed:
            fields["processed"] = False
        await sources.update_one({"external_id": doc["external_id"]}, {"$set": fields})
        return {**existing, **fields}, False
    record = {"id": new_id(), "created_at": now, "updated_at": now, "revision": 1, "processed": False, "deleted": False, **doc}
    await sources.insert_one(dict(record))
    return record, True


async def tombstone_source(external_id: str) -> None:
    await sources.update_one({"external_id": external_id}, {"$set": {"deleted": True, "text": "", "processed": True, "updated_at": now_iso()}})


async def connector_state(name: str) -> dict:
    return await connectors.find_one({"name": name}, PROJECTION) or {"name": name}


async def save_connector_state(name: str, fields: dict) -> None:
    await connectors.update_one({"name": name}, {"$set": {**fields, "updated_at": now_iso()}}, upsert=True)


async def get_plan(plan_id: str) -> dict | None:
    return await plans.find_one({"id": plan_id}, PROJECTION)


async def update_plan(plan_id: str, fields: dict) -> None:
    await plans.update_one({"id": plan_id}, {"$set": {**fields, "updated_at": now_iso()}})
