import { useEffect, useState } from "react";
import { Badge, Button, Empty, Panel, clock, ms } from "../ui";

const PLAN_TONE = {
  proposed: "text-[#f2b95a] border-[#e8a33c]/40 bg-[#e8a33c]/10", approved: "text-[#8fd4ff] border-[#4fb3f0]/40 bg-[#4fb3f0]/10",
  executing: "text-[#8fd4ff] border-[#4fb3f0]/40 bg-[#4fb3f0]/10", done: "text-[#4fd6a3] border-[#2fbf8a]/40 bg-[#2fbf8a]/10",
  verified: "text-[#4fd6a3] border-[#2fbf8a]/40 bg-[#2fbf8a]/10", failed: "text-[#ff8d7f] border-[#f0533f]/40 bg-[#f0533f]/10",
  rejected: "text-[#667081] border-white/10", rolled_back: "text-[#f2b95a] border-[#e8a33c]/40",
};
const RISK_TONE = { low: "text-[#4fd6a3] border-[#2fbf8a]/40", medium: "text-[#f2b95a] border-[#e8a33c]/40", high: "text-[#ff8d7f] border-[#f0533f]/40" };
const TASK_ICON = { pending: "○", running: "◔", done: "●", failed: "✕", skipped: "–" };

export function PlansPanel({ bridge, plans, say, refresh, selectedId, onSelect }) {
  const [objective, setObjective] = useState("");
  const [compiling, setCompiling] = useState(false);
  const compile = async () => {
    if (objective.trim().length < 8) return say("Describe the objective in a sentence.");
    setCompiling(true);
    try {
      const plan = await bridge.compilePlan(objective.trim());
      setObjective("");
      onSelect(plan.id);
      say(plan.status === "approved" ? "Plan compiled — LOW risk, executing under the auto-fix policy." : "Plan compiled — review the tasks and approve.");
      refresh();
    } catch (e) {
      say(e.message);
    } finally {
      setCompiling(false);
    }
  };
  return (
    <Panel eyebrow="Understand → Plan → Build" title={`Development plans · ${(plans || []).length}`} testid="cc-plans">
      <div className="flex gap-2 mb-3">
        <input value={objective} onChange={(e) => setObjective(e.target.value)} onKeyDown={(e) => e.key === "Enter" && compile()} placeholder="Objective — e.g. “Show the free-shipping progress in the cart summary”" className="flex-1 rounded-md border border-white/[0.14] bg-[#12151a] px-3 py-2 text-[12.5px] text-[#eef2f6] placeholder:text-[#667081]" data-testid="cc-plan-objective" />
        <Button primary onClick={compile} disabled={compiling} testid="cc-compile-plan-btn">{compiling ? "Gemini is planning…" : "Compile plan"}</Button>
      </div>
      <p className="text-[11px] text-[#667081] mb-3">Also from Slack: <span className="font-mono text-[#98a3b3]">@ShadowQA plan &lt;objective&gt;</span> — the plan is posted back in the thread; approval stays here.</p>
      <div className="grid gap-1.5 max-h-72 overflow-auto pr-1" data-testid="cc-plan-list">
        {(plans || []).map((p) => (
          <button key={p.id} type="button" onClick={() => onSelect(p.id)} className={`text-left rounded-md border px-3 py-2 transition-colors ${selectedId === p.id ? "border-[#37b6d3] bg-[#37b6d3]/10" : "border-white/[0.08] bg-[#12151a] hover:border-white/25"}`} data-testid={`cc-plan-${p.id}`}>
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-semibold text-[#eef2f6] truncate flex-1">{p.title}</span>
              <Badge tone={RISK_TONE[p.risk]}>{p.risk}</Badge>
              <Badge tone={PLAN_TONE[p.status]} testid={`cc-plan-status-${p.id}`}>{p.status.replace("_", " ")}</Badge>
            </div>
            <div className="text-[10.5px] font-mono text-[#667081] mt-0.5 truncate">{(p.tasks || []).length} task{(p.tasks || []).length === 1 ? "" : "s"} · {p.requested_by} · {clock(p.created_at)} · v{p.version}{p.origin?.kind === "slack" ? " · from Slack" : ""}</div>
          </button>
        ))}
        {!(plans || []).length && <Empty>No plans yet. Confirm some knowledge, then compile an objective into tasks.</Empty>}
      </div>
    </Panel>
  );
}

function Diff({ text }) {
  return (
    <pre className="mt-1 max-h-56 overflow-auto rounded border border-white/[0.08] bg-[#0b0c0f] p-2 text-[10.5px] font-mono leading-snug">
      {String(text || "").split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "text-[#4fd6a3]" : l.startsWith("-") && !l.startsWith("---") ? "text-[#ff8d7f]" : l.startsWith("@@") ? "text-[#37b6d3]" : "text-[#98a3b3]"}>{l}</div>
      ))}
    </pre>
  );
}

export function PlanDetail({ bridge, planId, say, refresh }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  useEffect(() => {
    if (!planId) return undefined;
    let alive = true;
    const load = () => bridge.getPlan(planId).then((p) => alive && setPlan(p)).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [bridge, planId]);
  if (!planId) return <Panel eyebrow="Plan" title="Select a plan" testid="cc-plan-detail"><Empty>Pick a plan on the left to review its tasks, approve it, follow the build and verify it at runtime.</Empty></Panel>;
  if (!plan) return <Panel eyebrow="Plan" title="Loading…" testid="cc-plan-detail" />;

  const act = async (name, fn, okMsg) => {
    setBusy(name);
    try {
      await fn();
      if (okMsg) say(okMsg);
      setPlan(await bridge.getPlan(planId));
      refresh();
    } catch (e) {
      say(e.message);
    } finally {
      setBusy(null);
    }
  };
  const verify = () => act("verify", async () => {
    const sdk = window.__shadowqa;
    if (!sdk) throw new Error("ShadowQA SDK is not mounted on this page.");
    if (!localStorage.getItem("lumen:token")) throw new Error("Sign in to Lumen Supply Co. first — the sweep drives authenticated flows in this tab.");
    await sdk.runQA();
    await bridge.verifyPlan(planId, {});
  }, "QA sweep finished — results attached to the plan.");
  const exportBrief = () => act("brief", async () => {
    const b = await bridge.planBrief(planId);
    const blob = new Blob([b.markdown], { type: "text/markdown" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: b.filename });
    a.click();
    URL.revokeObjectURL(a.href);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(b.markdown).catch(() => {});
  }, "Brief downloaded and copied — paste it into Claude Code or Codex.");

  const canApprove = ["proposed", "failed", "rejected"].includes(plan.status);
  const files = (plan.tasks || []).flatMap((t) => t.result?.files || []);
  const qa = plan.qa_run;
  return (
    <Panel eyebrow={`Plan ${plan.id} · v${plan.version} · ${plan.model || ""}`} title={plan.title} testid="cc-plan-detail"
      action={<div className="flex flex-wrap gap-1.5 justify-end">
        <Badge tone={RISK_TONE[plan.risk]}>{plan.risk} risk</Badge>
        <Badge tone={PLAN_TONE[plan.status]} testid="cc-plan-detail-status">{plan.status.replace("_", " ")}</Badge>
      </div>}>
      <p className="text-[12.5px] text-[#98a3b3] leading-relaxed" data-testid="cc-plan-summary">{plan.summary}</p>
      <div className="mt-2 text-[11px] font-mono text-[#667081]">Objective: <span className="text-[#98a3b3]">{plan.objective}</span> · requested by {plan.requested_by} · {plan.context?.sources ?? 0} sources · {plan.context?.grep_hits ?? 0} grep hits · planned in {ms(plan.latency_ms)}</div>

      {(plan.knowledge || []).length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#667081] font-mono mb-1.5">Grounded in</div>
          <div className="grid gap-1" data-testid="cc-plan-knowledge">
            {plan.knowledge.map((k) => <div key={k.id} className="text-[11.5px] text-[#eef2f6]"><span className="text-[#667081] font-mono">{k.type}</span> · {k.statement} <span className="text-[#667081]">— {(k.sources || []).map((s) => s.author).filter(Boolean).slice(0, 2).join(", ")}</span></div>)}
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="text-[10px] uppercase tracking-[0.12em] text-[#667081] font-mono mb-1.5">Tasks</div>
        <div className="grid gap-1.5" data-testid="cc-plan-tasks">
          {(plan.tasks || []).map((t) => (
            <div key={t.id} className="rounded-md border border-white/[0.08] bg-[#12151a] px-3 py-2" data-testid={`cc-task-${t.id}`}>
              <button type="button" onClick={() => setOpenTask(openTask === t.id ? null : t.id)} className="w-full text-left flex items-start gap-2">
                <span className={`font-mono text-[13px] ${t.status === "done" ? "text-[#4fd6a3]" : t.status === "failed" ? "text-[#ff8d7f]" : t.status === "running" ? "text-[#37b6d3] animate-pulse" : "text-[#667081]"}`} data-testid={`cc-task-status-${t.id}`}>{TASK_ICON[t.status] || "○"}</span>
                <span className="flex-1 min-w-0">
                  <span className="text-[12.5px] font-semibold text-[#eef2f6]">{t.title}</span>
                  <span className="block text-[10.5px] font-mono text-[#667081] truncate">{(t.files || []).join(", ")}{t.unwritable?.length ? ` · outside write roots: ${t.unwritable.join(", ")}` : ""}{t.missing?.length ? ` · missing: ${t.missing.join(", ")}` : ""}</span>
                </span>
                <Badge tone={RISK_TONE[t.risk]}>{t.risk}</Badge>
              </button>
              {openTask === t.id && (
                <div className="mt-2 text-[11.5px] text-[#98a3b3] leading-relaxed">
                  <p>{t.description}</p>
                  <ul className="mt-1.5 list-disc pl-4 text-[#eef2f6]">{(t.acceptance || []).map((a, i) => <li key={i}>{a}</li>)}</ul>
                  {t.result?.explanation && <p className="mt-2 text-[#4fd6a3]">{t.result.explanation}</p>}
                  {t.result?.error && <p className="mt-2 text-[#ff8d7f]" data-testid={`cc-task-error-${t.id}`}>{t.result.error}</p>}
                  {(t.result?.validation?.steps || []).length > 0 && <div className="mt-1.5 font-mono text-[10.5px]">{t.result.validation.steps.map((s) => <span key={s.name} className={`mr-3 ${s.status === "passed" ? "text-[#4fd6a3]" : s.status === "failed" ? "text-[#ff8d7f]" : "text-[#667081]"}`}>{s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : "–"} {s.name}</span>)}</div>}
                  {(t.result?.files || []).map((f) => <Diff key={f.path} text={f.diff} />)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {(plan.unknowns || []).length > 0 && <div className="mt-3 rounded-md border border-[#e8a33c]/30 bg-[#e8a33c]/5 px-3 py-2 text-[11.5px] text-[#f2b95a]" data-testid="cc-plan-unknowns"><b>Open questions:</b> {plan.unknowns.join(" · ")}</div>}
      {plan.error && <div className="mt-3 rounded-md border border-[#f0533f]/30 bg-[#f0533f]/5 px-3 py-2 text-[11.5px] text-[#ff8d7f]" data-testid="cc-plan-error">{plan.error}</div>}

      <div className="mt-4 grid sm:grid-cols-2 gap-3 text-[11.5px]">
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#667081] font-mono mb-1">Verification</div>
          <div className="text-[#98a3b3]">Flows: {(plan.verification?.flows || []).join(", ") || "declared QA flows"}</div>
          <div className="text-[#98a3b3]">Expected: {plan.verification?.expected || "—"}</div>
          {qa && <div className={`mt-1 font-mono ${qa.failed ? "text-[#ff8d7f]" : "text-[#4fd6a3]"}`} data-testid="cc-plan-qa">QA sweep · {qa.passed} passed / {qa.failed} failed · {clock(qa.at)}</div>}
          {(plan.incidents || []).length > 0 && <div className="mt-1 text-[#98a3b3]">Runtime incidents linked: {plan.incidents.map((i) => `${i.title} (${i.status})`).join(", ")}</div>}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#667081] font-mono mb-1">Result</div>
          {plan.git?.branch ? <div className="text-[#98a3b3] font-mono break-all" data-testid="cc-plan-git">branch {plan.git.branch} @ {plan.git.commit}{plan.git.pr ? <> · <a className="text-[#37b6d3] hover:underline" href={plan.git.pr.url} target="_blank" rel="noreferrer">PR #{plan.git.pr.number}</a></> : plan.git.pr_error ? ` · ${plan.git.pr_error}` : ""}</div> : <div className="text-[#667081]">{files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : "not built yet"}</div>}
          {plan.duration_ms != null && <div className="text-[#667081] font-mono">built in {ms(plan.duration_ms)}</div>}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" data-testid="cc-plan-actions">
        {canApprove && <Button primary onClick={() => act("approve", () => bridge.approvePlan(planId), "Approved — ShadowQA's agent is building it.")} disabled={busy === "approve"} testid="cc-plan-approve-btn">{plan.status === "failed" ? "Retry build" : "Approve & build"}</Button>}
        {plan.status === "proposed" && <Button onClick={() => act("reject", () => bridge.rejectPlan(planId), "Plan rejected.")} disabled={busy === "reject"} testid="cc-plan-reject-btn">Reject</Button>}
        {["done", "verified"].includes(plan.status) && <Button primary onClick={verify} disabled={busy === "verify"} testid="cc-plan-verify-btn">{busy === "verify" ? "Running QA sweep…" : "Verify at runtime (QA sweep)"}</Button>}
        {["done", "verified"].includes(plan.status) && <Button danger onClick={() => act("rollback", () => bridge.rollbackPlan(planId), "Plan rolled back — workspace restored.")} disabled={busy === "rollback"} testid="cc-plan-rollback-btn">Undo changes</Button>}
        <Button onClick={exportBrief} disabled={busy === "brief"} testid="cc-plan-brief-btn">Export brief for Claude Code / Codex</Button>
        {plan.status === "executing" && <span className="text-[11.5px] text-[#37b6d3] animate-pulse self-center" data-testid="cc-plan-executing">building · validating each task…</span>}
      </div>
    </Panel>
  );
}
