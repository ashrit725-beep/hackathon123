import { useEffect, useState } from "react";
import { Stat } from "../ui";
import { PolicyPanel } from "./PolicyPanel";
import { SourcesPanel } from "./SourcesPanel";
import { KnowledgePanel } from "./KnowledgePanel";
import { PlanDetail, PlansPanel } from "./PlansPanel";
import { ActivityFeed, GraphView } from "./GraphView";

export function ContextView({ bridge, core, say, initialPlan, refreshRuntime }) {
  const { overview, sources, knowledge, plans, graph, activity, refresh } = core;
  const [selected, setSelected] = useState(initialPlan || null);
  useEffect(() => {
    if (initialPlan) setSelected(initialPlan);
  }, [initialPlan]);
  useEffect(() => {
    if (!selected && plans?.length) setSelected(plans[0].id);
  }, [plans, selected]);

  const setMode = async (mode) => {
    try {
      await bridge.putMode(mode);
      say(`Mode → ${mode}.`);
      refresh();
      refreshRuntime?.();
    } catch (e) {
      say(e.message);
    }
  };
  const k = overview?.knowledge || {};
  const p = overview?.plans || {};
  return (
    <div className="grid gap-6" data-testid="cc-context-view">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" data-testid="cc-context-stats">
        <Stat label="sources tracked" value={overview?.sources ?? "—"} testid="cc-ctx-stat-sources" />
        <Stat label="confirmed knowledge" value={k.confirmed ?? "—"} tone="text-[#4fd6a3]" testid="cc-ctx-stat-confirmed" />
        <Stat label="proposed" value={k.proposed ?? "—"} tone="text-[#f2b95a]" testid="cc-ctx-stat-proposed" />
        <Stat label="plans built" value={p.done ?? "—"} testid="cc-ctx-stat-plans" />
        <Stat label="awaiting approval" value={p.awaiting ?? "—"} tone={p.awaiting ? "text-[#f2b95a]" : ""} testid="cc-ctx-stat-awaiting" />
        <Stat label="mode" value={<span className="text-base">{overview?.mode || "—"}</span>} hint={overview?.planning_model?.split(":")[1]} tone="text-[#37b6d3]" testid="cc-ctx-stat-mode" />
      </div>
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-6 min-w-0">
        <SourcesPanel bridge={bridge} overview={overview} sources={sources} say={say} refresh={refresh} />
        <PolicyPanel overview={overview} onMode={setMode} />
      </div>
      <KnowledgePanel bridge={bridge} knowledge={knowledge} say={say} refresh={refresh} />
      <div className="grid lg:grid-cols-[1fr_1.5fr] gap-6 min-w-0">
        <PlansPanel bridge={bridge} plans={plans} say={say} refresh={refresh} selectedId={selected} onSelect={setSelected} />
        <PlanDetail bridge={bridge} planId={selected} say={say} refresh={refresh} />
      </div>
      <GraphView graph={graph} />
      <ActivityFeed activity={activity} />
    </div>
  );
}
