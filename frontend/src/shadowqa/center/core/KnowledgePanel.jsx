import { useState } from "react";
import { Badge, Button, Empty, Panel } from "../ui";

const TYPE_TONE = {
  decision: "text-[#8fd4ff] border-[#4fb3f0]/40 bg-[#4fb3f0]/10",
  requirement: "text-[#4fd6a3] border-[#2fbf8a]/40 bg-[#2fbf8a]/10",
  constraint: "text-[#f2b95a] border-[#e8a33c]/40 bg-[#e8a33c]/10",
  bug: "text-[#ff8d7f] border-[#f0533f]/40 bg-[#f0533f]/10",
  question: "text-[#e9a4ff] border-[#c96cf5]/40 bg-[#c96cf5]/10",
};
const STATE_TONE = { confirmed: "text-[#4fd6a3] border-[#2fbf8a]/40", proposed: "text-[#f2b95a] border-[#e8a33c]/40", rejected: "text-[#667081] border-white/10" };

function Provenance({ sources }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {(sources || []).slice(0, 4).map((p) => (
        <a key={p.id} href={p.url || undefined} target="_blank" rel="noreferrer" title={p.excerpt} className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded border border-white/[0.08] text-[#98a3b3] ${p.url ? "hover:border-[#37b6d3] hover:text-[#37b6d3]" : ""}`}>
          {p.kind?.replace("github_", "").replace("slack_message", "slack")} · {p.author}{p.channel ? ` · ${p.channel}` : ""}
        </a>
      ))}
    </div>
  );
}

export function KnowledgePanel({ bridge, knowledge, say, refresh }) {
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(null);
  const items = (knowledge || []).filter((k) => (filter === "all" ? k.state !== "rejected" : filter === "rejected" ? k.state === "rejected" : k.state === filter));
  const set = async (id, state) => {
    setBusy(id);
    try {
      await bridge.updateKnowledge(id, { state });
      refresh();
    } catch (e) {
      say(e.message);
    } finally {
      setBusy(null);
    }
  };
  const extract = () => bridge.extractKnowledge().then((r) => say(r.error ? r.error : `Extracted ${r.items} item${r.items === 1 ? "" : "s"} from ${r.processed} source${r.processed === 1 ? "" : "s"}.`)).then(refresh).catch((e) => say(e.message));
  const confirmed = (knowledge || []).filter((k) => k.state === "confirmed").length;
  return (
    <Panel eyebrow="Project knowledge" title={`Decisions & requirements · ${confirmed} confirmed`} testid="cc-knowledge"
      action={<div className="flex items-center gap-1.5">
        {["all", "proposed", "confirmed", "rejected"].map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={`px-2 py-1 rounded text-[11px] font-medium ${filter === f ? "bg-[#eef2f6] text-[#0b0c0f]" : "text-[#98a3b3] hover:text-[#eef2f6]"}`} data-testid={`cc-knowledge-filter-${f}`}>{f}</button>
        ))}
        <Button onClick={extract} testid="cc-extract-btn">Extract now</Button>
      </div>}>
      <div className="grid gap-2 max-h-[420px] overflow-auto pr-1" data-testid="cc-knowledge-list">
        {items.map((k) => (
          <div key={k.id} className="rounded-md border border-white/[0.08] bg-[#12151a] px-3 py-2.5" data-testid={`cc-knowledge-${k.id}`}>
            <div className="flex items-start gap-2">
              <Badge tone={TYPE_TONE[k.type]}>{k.type}</Badge>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-[#eef2f6] leading-snug" data-testid={`cc-knowledge-statement-${k.id}`}>{k.statement}</div>
                {k.rationale && <div className="text-[11px] text-[#98a3b3] mt-0.5 leading-snug">{k.rationale}</div>}
                <Provenance sources={k.sources} />
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Badge tone={STATE_TONE[k.state]} testid={`cc-knowledge-state-${k.id}`}>{k.state}</Badge>
                <div className="flex gap-1">
                  {k.state !== "confirmed" && <Button onClick={() => set(k.id, "confirmed")} disabled={busy === k.id} testid={`cc-confirm-${k.id}`} className="!px-2 !py-1 !text-[11px]">Confirm</Button>}
                  {k.state !== "rejected" && <Button onClick={() => set(k.id, "rejected")} disabled={busy === k.id} testid={`cc-reject-${k.id}`} className="!px-2 !py-1 !text-[11px]">Reject</Button>}
                  {k.state === "rejected" && <Button onClick={() => set(k.id, "proposed")} disabled={busy === k.id} testid={`cc-restore-${k.id}`} className="!px-2 !py-1 !text-[11px]">Restore</Button>}
                </div>
              </div>
            </div>
            {(k.plan_ids || []).length > 0 && <div className="mt-1.5 text-[10.5px] font-mono text-[#667081]">in {k.plan_ids.length} plan{k.plan_ids.length === 1 ? "" : "s"}</div>}
          </div>
        ))}
        {!items.length && <Empty>{filter === "all" ? "Nothing extracted yet. Sources are read by Gemini into decisions, requirements, constraints and bugs — each linked to where it was said." : `No ${filter} items.`}</Empty>}
      </div>
    </Panel>
  );
}
