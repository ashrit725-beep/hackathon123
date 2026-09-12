import { useLayoutEffect, useRef, useState } from "react";
import { Empty, Panel } from "../ui";

const COLS = [
  ["knowledge", "Decisions & requirements", "from Slack · GitHub · conversations"],
  ["plan", "Plans", "compiled by Gemini"],
  ["file", "Code changed", "by ShadowQA's agent"],
  ["incident", "Runtime incidents", "observed in the browser"],
  ["verification", "Verification", "replay · QA sweep"],
];
const STATE_TONE = {
  confirmed: "border-[#2fbf8a]/50", verified: "border-[#2fbf8a]/60 bg-[#2fbf8a]/10", done: "border-[#2fbf8a]/50", changed: "border-[#37b6d3]/50",
  proposed: "border-[#e8a33c]/50", planned: "border-[#e8a33c]/40", failed: "border-[#f0533f]/50", executing: "border-[#4fb3f0]/50",
};

export function GraphView({ graph }) {
  const ref = useRef(null);
  const [lines, setLines] = useState([]);
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const measure = () => {
      const box = root.getBoundingClientRect();
      const pos = {};
      root.querySelectorAll("[data-node]").forEach((el) => {
        const r = el.getBoundingClientRect();
        pos[el.dataset.node] = { x1: r.left - box.left, x2: r.right - box.left, y: r.top - box.top + r.height / 2 };
      });
      setLines(edges.filter((e) => pos[e.from] && pos[e.to]).map((e) => ({ ...e, a: pos[e.from], b: pos[e.to] })));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [edges, nodes.length]);

  if (!nodes.length) {
    return <Panel eyebrow="Project memory" title="Context graph" testid="cc-graph"><Empty>Nothing to connect yet. Confirm knowledge, compile a plan and let ShadowQA build it — the chain decision → requirement → code → runtime → verification appears here.</Empty></Panel>;
  }
  return (
    <Panel eyebrow="Project memory" title="Decision → Requirement → Code → Runtime → Verification" testid="cc-graph"
      action={<span className="text-[11px] font-mono text-[#667081]">{graph.counts.knowledge} items · {graph.counts.plans} plans · {graph.counts.files} files · {graph.counts.incidents} incidents</span>}>
      <div ref={ref} className="relative overflow-x-auto">
        <svg className="absolute inset-0 pointer-events-none" width="100%" height="100%" style={{ minWidth: 900 }}>
          {lines.map((l, i) => {
            const mx = (l.a.x2 + l.b.x1) / 2;
            return <path key={i} d={`M ${l.a.x2} ${l.a.y} C ${mx} ${l.a.y}, ${mx} ${l.b.y}, ${l.b.x1} ${l.b.y}`} fill="none" stroke="rgba(55,182,211,0.45)" strokeWidth="1.2" />;
          })}
        </svg>
        <div className="grid grid-cols-5 gap-6 min-w-[900px]" data-testid="cc-graph-columns">
          {COLS.map(([col, title, hint]) => (
            <div key={col} className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#667081] font-mono">{title}</div>
              <div className="text-[10.5px] text-[#667081] mb-3">{hint}</div>
              <div className="grid gap-2">
                {nodes.filter((n) => n.col === col).map((n) => (
                  <div key={n.id} data-node={n.id} className={`relative rounded-md border bg-[#12151a] px-2.5 py-2 ${STATE_TONE[n.state] || "border-white/[0.1]"}`} data-testid={`cc-graph-node-${n.type}-${n.ref}`} title={n.label}>
                    <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#667081]">{n.type}{n.state ? ` · ${n.state}` : ""}</div>
                    <div className="text-[11.5px] text-[#eef2f6] leading-snug break-words">{n.label}</div>
                    {n.sources != null && <div className="text-[10px] font-mono text-[#667081] mt-0.5">{n.sources} source{n.sources === 1 ? "" : "s"}</div>}
                  </div>
                ))}
                {!nodes.some((n) => n.col === col) && <div className="text-[11px] italic text-[#667081]">—</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

const FEED_ICON = { source: "◇", knowledge: "◆", plan: "▣", event: "•" };

export function ActivityFeed({ activity }) {
  return (
    <Panel eyebrow="One continuous loop" title="Activity across conversations, code and runtime" testid="cc-activity">
      <div className="grid gap-1 max-h-80 overflow-auto pr-1">
        {(activity || []).map((a, i) => (
          <div key={`${a.ts}${i}`} className="grid grid-cols-[auto_auto_1fr] items-baseline gap-3 text-[11.5px] border-t border-white/[0.05] pt-1" data-testid={`cc-activity-${a.kind}`}>
            <span className="font-mono text-[#667081]">{a.ts ? new Date(a.ts).toLocaleTimeString("en-US", { hour12: false }) : "—"}</span>
            <span className={`font-mono text-[10.5px] uppercase ${a.kind === "knowledge" ? "text-[#4fd6a3]" : a.kind === "plan" ? "text-[#8fd4ff]" : a.kind === "source" ? "text-[#e9a4ff]" : "text-[#98a3b3]"}`}>{FEED_ICON[a.kind]} {a.sub?.replace("github_", "").replace("slack_message", "slack")}</span>
            <span className="text-[#eef2f6] truncate">{a.who ? <span className="text-[#667081]">{a.who} · </span> : null}{a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="hover:text-[#37b6d3]">{a.label}</a> : a.label}</span>
          </div>
        ))}
        {!(activity || []).length && <Empty>Quiet so far.</Empty>}
      </div>
    </Panel>
  );
}
