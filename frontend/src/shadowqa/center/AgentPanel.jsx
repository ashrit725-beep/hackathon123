import { Empty, Panel, Stat, clock, ms } from "./ui";

const STAGES = [["capture_to_bridge_ms", "capture → bridge"], ["correlation_ms", "correlation"], ["ai_ms", "diagnosis (AI)"], ["patch_ms", "patch"], ["validation_ms", "validation"], ["replay_ms", "replay"], ["total_ms", "end-to-end"]];

export function AgentPanel({ telemetry, audit, settings }) {
  const a = telemetry?.averages || {};
  return (
    <Panel eyebrow="Agent" title="Latency, models & audit trail" testid="cc-agent">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4" data-testid="cc-stage-latency">
        {STAGES.map(([k, l]) => <Stat key={k} label={l} value={ms(a[k])} testid={`cc-latency-${k}`} />)}
        <Stat label="model chain" testid="cc-model-chain" value={<span className="text-[12px] break-all" title={[settings?.models?.fallback, settings?.models?.tertiary].filter(Boolean).join(" → ")}>{settings?.models?.primary || telemetry?.models?.primary || "—"}{settings?.models?.fallback ? <span className="text-[#667081]"> → {[settings.models.fallback, settings.models.tertiary].filter(Boolean).map((m) => m.split(":")[0]).join(" → ")}</span> : null}</span>} />
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#667081] font-mono mb-2">LLM calls</div>
          <div className="grid gap-1" data-testid="cc-llm-calls">
            {(telemetry?.llm_calls || []).slice(0, 6).map((c, i) => (
              <div key={`${c.ts}${i}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 text-[11.5px] font-mono border-t border-white/[0.05] pt-1">
                <span className="text-[#98a3b3]">{c.purpose}</span><span className="text-[#667081] truncate" title={c.model}>{c.model}</span><span className={c.ok ? "text-[#4fd6a3]" : "text-[#ff8d7f]"}>{c.ok ? ms(c.latency_ms) : "failed"}</span>
              </div>
            ))}
            {!(telemetry?.llm_calls || []).length && <Empty>No calls yet.</Empty>}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#667081] font-mono mb-2">Audit trail</div>
          <div className="grid gap-1 max-h-48 overflow-auto pr-1" data-testid="cc-audit">
            {(audit || []).slice(0, 14).map((e, i) => (
              <div key={`${e.ts}${i}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 text-[11.5px] font-mono border-t border-white/[0.05] pt-1">
                <span className="text-[#667081]">{clock(e.ts)}</span><span className="text-[#eef2f6] truncate">{e.action}</span><span className="text-[#667081] truncate max-w-[120px]" title={e.actor}>{e.actor}</span>
              </div>
            ))}
            {!(audit || []).length && <Empty>Empty.</Empty>}
          </div>
        </div>
      </div>
    </Panel>
  );
}

const SIGNAL_META = {
  interaction: ["The click", "what the developer was trying to do"],
  inputs: ["Field values", "masked, kept locally only for replay"],
  route: ["Route", "which screen was live"],
  component: ["React component", "resolved from the fiber tree"],
  network: ["Failed request", "method, path, status and response body"],
  server: ["Server exception", "traceback + failing handler, captured in the backend process"],
  network_window: ["Request window", "the requests that preceded the failure"],
  source: ["Source map", "bundle frame → original file:line"],
  state: ["App state", "cart / auth snapshot from the host"],
  console: ["Console", "errors logged in the window"],
  workspace: ["Workspace files", "only the relevant source, read from disk"],
  memory: ["Application memory", "prior failures, fixes and APIs"],
};

export function ContextPanel({ incidents }) {
  const counts = {};
  for (const inc of incidents || []) for (const s of inc.context_signals || []) counts[s.kind] = (counts[s.kind] || 0) + 1;
  const kinds = Object.keys(SIGNAL_META);
  return (
    <Panel eyebrow="Why the browser" title="Context a chatbox never receives" testid="cc-context">
      <p className="text-[11.5px] text-[#98a3b3] mb-3">Every incident is grounded in signals that only exist where the developer is already working — the running app. Seen so far across {(incidents || []).length} incident{(incidents || []).length === 1 ? "" : "s"}:</p>
      <div className="grid sm:grid-cols-2 gap-1.5" data-testid="cc-signal-kinds">
        {kinds.map((k) => (
          <div key={k} className={`flex items-center justify-between gap-3 rounded border px-3 py-1.5 text-[12px] ${counts[k] ? "border-[#37b6d3]/30 bg-[#37b6d3]/[0.06]" : "border-white/[0.06] opacity-60"}`}>
            <span><span className="text-[#eef2f6]">{SIGNAL_META[k][0]}</span> <span className="text-[#667081]">· {SIGNAL_META[k][1]}</span></span>
            <span className="font-mono text-[#37b6d3]">{counts[k] || 0}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
