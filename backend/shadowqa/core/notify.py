"""Slack message builders. Approvals never happen in Slack: every message links back to the Command Center."""
from ..config import settings

STATUS_ICON = {"diagnosed": "🔴", "verified": "🟢", "validation_failed": "🟠", "replay_failed": "🟠", "no_safe_fix": "🟡"}


def center_url(**params: str) -> str:
    base = settings.public_url or ""
    query = "&".join(f"{k}={v}" for k, v in params.items() if v)
    return f"{base}/shadowqa" + (f"?{query}" if query else "")


def _section(text: str) -> dict:
    return {"type": "section", "text": {"type": "mrkdwn", "text": text[:2900]}}


def _button(label: str, url: str) -> dict:
    return {"type": "actions", "elements": [{"type": "button", "text": {"type": "plain_text", "text": label}, "url": url}]}


def incident_message(inc: dict, event: str) -> tuple[str, list[dict]]:
    d = inc.get("diagnosis") or {}
    loc = inc.get("source_location") or {}
    risk = (inc.get("risk") or {}).get("level")
    where = f"`{loc.get('file')}:{loc.get('line')}`" if loc.get("file") else "location unresolved"
    chain = "  →  ".join(n.get("label", "") for n in (inc.get("graph") or {}).get("nodes", [])[:6])
    if event == "verified":
        head = f"{STATUS_ICON['verified']} *ShadowQA verified a fix* — {inc.get('title')}"
        detail = (f"Root cause: {d.get('root_cause')}\nPatched {', '.join(f['path'] for f in (inc.get('patch') or {}).get('files', []))}"
                  f" · risk {risk} · replay confirmed · {int(((inc.get('telemetry') or {}).get('total_ms') or 0) / 1000)}s end-to-end")
    elif event == "diagnosed":
        head = f"{STATUS_ICON['diagnosed']} *ShadowQA detected an issue* — {inc.get('title')}"
        detail = f"Root cause: {d.get('root_cause')}\n{where} · risk {risk} · confidence {int(float(d.get('confidence') or 0) * 100)}%"
        detail += "\n_A fix is proposed and waits for your approval in the Command Center._" if not (inc.get("policy") or {}).get("auto_applied") else "\n_Applying automatically (LOW risk) and verifying by replay…_"
    else:
        head = f"{STATUS_ICON.get(event, '🟡')} *ShadowQA* — {inc.get('title')} · {event.replace('_', ' ')}"
        detail = str(inc.get("error") or d.get("root_cause") or "")
    if inc.get("requirement_statements"):
        detail += "\nLinked requirement: " + "; ".join(inc["requirement_statements"][:2])
    blocks = [_section(head), _section(detail)]
    if chain:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": chain[:2000]}]})
    blocks.append(_button("Open in Command Center", center_url(incident=inc["id"])))
    return head, blocks


def plan_message(plan: dict, event: str) -> tuple[str, list[dict]]:
    tasks = plan.get("tasks") or []
    icon = {"proposed": "📋", "approved": "▶️", "done": "✅", "verified": "✅", "failed": "❌", "rejected": "⛔"}.get(event, "📋")
    label = {"proposed": "Plan ready for review", "approved": "Plan approved — building", "done": "Plan built and validated",
             "verified": "Plan verified at runtime", "failed": "Plan execution failed", "rejected": "Plan rejected"}.get(event, event)
    head = f"{icon} *ShadowQA · {label}* — {plan.get('title')}"
    lines = [f"Objective: {plan.get('objective')}", f"{len(tasks)} task{'s' if len(tasks) != 1 else ''} · overall risk {plan.get('risk')} · v{plan.get('version', 1)}"]
    for t in tasks[:6]:
        state = {"done": "✓", "failed": "✗", "running": "…"}.get(t.get("status"), "•")
        lines.append(f"{state} {t.get('title')} — `{'`, `'.join(t.get('files') or [])[:200]}`")
    if plan.get("error"):
        lines.append(f"Error: {plan['error'][:300]}")
    git = plan.get("git") or {}
    if git.get("branch"):
        lines.append(f"Branch `{git['branch']}` ({git.get('commit')})" + (f" · PR {git['pr']['url']}" if git.get("pr") else ""))
    if event == "proposed":
        lines.append("_Approve or reject in the Command Center — messages and emoji never approve execution._")
    blocks = [_section(head), _section("\n".join(lines)), _button("Review in Command Center", center_url(view="context", plan=plan["id"]))]
    return head, blocks
