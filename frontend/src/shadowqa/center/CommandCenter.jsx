import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useCenterData } from "./useCenterData";
import { CenterHeader } from "./CenterHeader";
import { LoopPanel } from "./LoopPanel";
import { WhyPanel } from "./WhyPanel";
import { IncidentTable, ScenarioPanel } from "./IncidentTable";
import { HealthPanel, MemoryPanel } from "./HealthPanel";
import { AgentPanel, ContextPanel } from "./AgentPanel";
import { ContextView } from "./core/ContextView";
import { GraphView } from "./core/GraphView";
import { useCoreData } from "./core/useCoreData";
import { Stat, ms } from "./ui";

const VIEWS = [
  ["runtime", "Runtime loop", "observe · fix · replay"],
  ["context", "Development context", "Slack · GitHub · plans"],
  ["graph", "Project graph", "decision → verification"],
];

const STYLE = `
.cc-root { background-color: #0b0c0f; background-image: linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px); background-size: 32px 32px; }
.cc-root ::selection { background: #37b6d3; color: #0b0c0f; }
.cc-rise { animation: ccRise 0.55s cubic-bezier(0.16,1,0.3,1) both; }
.cc-d1 { animation-delay: 0.05s } .cc-d2 { animation-delay: 0.1s } .cc-d3 { animation-delay: 0.15s } .cc-d4 { animation-delay: 0.2s } .cc-d5 { animation-delay: 0.25s }
@keyframes ccRise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
`;

export default function CommandCenter() {
  const data = useCenterData(4000);
  const { bridge, refresh, health, telemetry, incidents, qaRun, memory, settings, scenarios, flows, audit, loading, error } = data;
  const [params, setParams] = useSearchParams();
  const view = VIEWS.some(([id]) => id === params.get("view")) ? params.get("view") : "runtime";
  const core = useCoreData(bridge, 4000, view !== "runtime");
  const [notice, setNotice] = useState(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    const prev = document.title;
    document.title = "ShadowQA · Command Center";
    return () => (document.title = prev);
  }, []);

  useEffect(() => {
    const id = params.get("incident");
    if (!id || !window.__shadowqa) return;
    bridge.getIncident(id).then((inc) => {
      window.__shadowqa.overlay.set({ incident: inc, inspector: true, tab: "timeline" });
      window.__shadowqa.loadInspectorData("timeline");
    }).catch(() => {});
  }, [params, bridge]);

  const setView = (id) => {
    const next = new URLSearchParams(params);
    next.set("view", id);
    next.delete("incident");
    setParams(next, { replace: true });
  };

  const say = (text) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 3500);
  };

  const runQA = () => {
    const sdk = window.__shadowqa;
    if (!sdk) return say("ShadowQA SDK is not mounted on this page.");
    if (!localStorage.getItem("lumen:token")) return say("Sign in to Lumen Supply Co. first — the sweep drives authenticated flows in this tab.");
    sdk.runQA();
  };

  const resetDemo = async () => {
    setResetting(true);
    try {
      await bridge.resetDemo();
      sessionStorage.removeItem("shadowqa:session");
      await refresh();
      say("Demo reset — all intentional bugs restored, ShadowQA memory cleared.");
    } catch (e) {
      say(`Reset failed: ${e.message}`);
    } finally {
      setResetting(false);
    }
  };

  const setAutonomy = async (autonomy) => {
    await bridge.putSettings({ autonomy }).catch((e) => say(e.message));
    refresh();
  };

  const list = incidents || [];
  const verified = list.filter((i) => ["verified", "committed"].includes(i.status)).length;
  const avg = telemetry?.averages || {};

  return (
    <div className="cc-root min-h-screen text-[#eef2f6] font-sans antialiased" data-testid="command-center">
      <style>{STYLE}</style>
      <CenterHeader health={health} settings={settings} onAutonomy={setAutonomy} onRunQA={runQA} error={error} />
      {notice && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 rounded-md border border-[#37b6d3]/40 bg-[#0f1115] px-4 py-2 text-[12.5px] text-[#eef2f6] shadow-xl cc-rise" data-testid="cc-notice">{notice}</div>
      )}
      <main className="mx-auto max-w-[1440px] px-6 lg:px-10 py-10 grid gap-6">
        <section className="grid lg:grid-cols-[1.15fr_1fr] gap-8 items-end cc-rise">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#37b6d3] font-mono mb-3">Development context + execution context · one agent · embedded in {health?.workspace || "the application"}</div>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-[-0.03em] leading-[1.02]">
              From conversation <span className="text-[#98a3b3] font-light italic">to verified code.</span>
            </h1>
            <p className="mt-5 max-w-2xl text-[14px] leading-relaxed text-[#98a3b3]">
              ShadowQA reads what the team decided in Slack, GitHub and AI chats, turns it into plans, builds them with its coding agent, then lives inside the running app: it sees the click, the request, the exception and the source — diagnoses, patches, validates and <em className="text-[#eef2f6] not-italic">replays your exact failure</em> to prove the fix. Every fix links back to the requirement it came from.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link to="/" className="inline-flex items-center gap-2 rounded-md bg-[#eef2f6] text-[#0b0c0f] px-4 py-2 text-[12.5px] font-medium hover:bg-white transition-colors" data-testid="cc-open-store-btn">Open Lumen Supply Co. →</Link>
              <button type="button" onClick={() => window.__shadowqa?.overlay.toggleInspector("health")} className="inline-flex items-center gap-2 rounded-md border border-white/[0.16] px-4 py-2 text-[12.5px] font-medium hover:border-white/30 hover:bg-[#12151a] transition-colors" data-testid="cc-open-inspector-btn">Open inspector · Ctrl+Shift+Q</button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="cc-stats">
            <Stat label="incidents" value={loading ? "…" : list.length} testid="cc-stat-incidents" />
            <Stat label="fixes verified" value={loading ? "…" : verified} tone="text-[#4fd6a3]" testid="cc-stat-verified" />
            <Stat label="avg end-to-end" value={ms(avg.total_ms)} hint="failure → verified replay" testid="cc-stat-total" />
            <Stat label="avg AI diagnosis" value={ms(avg.ai_ms)} testid="cc-stat-ai" />
            <Stat label="signals / incident" value={telemetry?.avg_signals != null ? telemetry.avg_signals.toFixed(1) : "—"} hint="in-app context" tone="text-[#37b6d3]" testid="cc-stat-signals" />
            <Stat label="rollbacks" value={telemetry ? telemetry.rollbacks : "—"} tone={telemetry?.rollbacks ? "text-[#f2b95a]" : ""} testid="cc-stat-rollbacks" />
          </div>
        </section>

        <nav className="flex flex-wrap gap-1 rounded-lg border border-white/[0.08] bg-[#0f1115] p-1 cc-rise cc-d1 w-fit" role="tablist" data-testid="cc-views">
          {VIEWS.map(([id, label, hint]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={`text-left rounded-md px-3.5 py-2 transition-[background-color,color] duration-150 ${view === id ? "bg-[#eef2f6] text-[#0b0c0f]" : "text-[#98a3b3] hover:text-[#eef2f6] hover:bg-[#12151a]"}`} data-testid={`cc-view-${id}`}>
              <div className="text-[12.5px] font-semibold">{label}</div>
              <div className={`text-[10px] font-mono ${view === id ? "text-[#0b0c0f]/70" : "text-[#667081]"}`}>{hint}</div>
            </button>
          ))}
        </nav>

        {view === "context" && <div className="cc-rise cc-d2"><ContextView bridge={bridge} core={core} say={say} initialPlan={params.get("plan")} refreshRuntime={refresh} /></div>}
        {view === "graph" && <div className="cc-rise cc-d2"><GraphView graph={core.graph} /></div>}
        {view === "runtime" && <>
        <div className="cc-rise cc-d1"><LoopPanel incidents={list} /></div>
        <div className="cc-rise cc-d1"><WhyPanel incidents={list} /></div>

        <div className="grid lg:grid-cols-[1.6fr_1fr] gap-6 cc-rise cc-d2 min-w-0">
          <IncidentTable incidents={list} bridge={bridge} />
          <ScenarioPanel scenarios={scenarios} onReset={resetDemo} resetting={resetting} />
        </div>
        <div className="grid lg:grid-cols-2 gap-6 cc-rise cc-d3 min-w-0">
          <HealthPanel qaRun={qaRun} flows={flows} onRunQA={runQA} />
          <ContextPanel incidents={list} />
        </div>
        <div className="grid lg:grid-cols-2 gap-6 cc-rise cc-d4 min-w-0">
          <AgentPanel telemetry={telemetry} audit={audit} settings={settings} />
          <MemoryPanel memory={memory} />
        </div>
        </>}
        <footer className="pt-6 pb-2 flex flex-wrap items-center justify-between gap-3 text-[11px] text-[#667081] font-mono cc-rise cc-d5">
          <span>ShadowQA · bridge {health ? "online" : error ? "offline" : "…"} · {health?.root}</span>
          <span>write roots: {(health?.write_roots || []).join(", ") || "—"}</span>
        </footer>
      </main>
    </div>
  );
}
