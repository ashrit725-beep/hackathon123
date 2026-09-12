import { checklist, escapeHtml as esc, ms, pct, renderDiff, riskBadge, shortPath, statusIcon } from "./util";

export const TABS = [
  ["timeline", "Timeline"], ["graph", "Graph"], ["network", "Network"], ["source", "Source"], ["diagnosis", "Diagnosis"], ["patch", "Patch"],
  ["validation", "Validation"], ["replay", "Replay"], ["health", "Health"], ["memory", "Memory"], ["agent", "Agent"],
];

const empty = (text) => `<p class="empty">${esc(text)}</p>`;

function timeline(inc) {
  if (!inc) return empty("No incident selected. Timelines are built from the bounded event window preceding a failure.");
  return `<h3>Causal timeline · ${inc.timeline.length} entries</h3><ul class="tl" data-testid="sqa-timeline">${inc.timeline
    .map((t) => `<li class="${t.severity === "error" ? "error" : t.kind}"><span class="t mono">${esc(t.time)}</span><span class="kind">${esc(t.kind)}</span><span class="l">${esc(t.label)}</span></li>`)
    .join("")}</ul>`;
}

function graph(inc) {
  if (!inc) return empty("No incident selected.");
  const nodes = inc.graph?.nodes || [];
  return `<h3>Context graph · ${nodes.length} nodes</h3><div class="graph" data-testid="sqa-graph">${nodes
    .map((n, i) => `${i ? '<div class="gedge"></div>' : ""}<div class="gnode ${esc(n.type)}"><div class="gt">${esc(n.type.replace(/_/g, " "))}</div><div class="gl mono">${esc(n.label)}</div></div>`)
    .join("")}</div>
    <h3>Trigger element</h3><pre class="raw mono">${esc(JSON.stringify(inc.trigger?.target || inc.dom?.trigger || {}, null, 2))}</pre>`;
}

function network(inc) {
  if (!inc) return empty("No incident selected.");
  const rows = inc.network || [];
  const rel = inc.related_request;
  return `<h3>Network chain · ${rows.length} requests in window</h3><table class="grid" data-testid="sqa-network"><thead><tr><th>Method</th><th>Path</th><th>Status</th><th>Time</th></tr></thead><tbody>${rows
    .map((n) => `<tr class="${rel && n.id === rel.id ? "hl" : ""}"><td class="mono">${esc(n.method)}</td><td class="mono">${esc(n.path)}</td><td class="mono ${n.status >= 400 || !n.status ? "s-bad" : "s-ok"}">${esc(n.status || n.error || "…")}</td><td class="mono">${ms(n.duration_ms)}</td></tr>`)
    .join("")}</tbody></table>
    ${rel ? `<h3>Correlated request</h3><p><b class="mono">${esc(rel.method)} ${esc(rel.path)}</b> → HTTP ${esc(rel.status)} in ${ms(rel.duration_ms)}</p><h3>Request body (sanitized)</h3><pre class="raw mono">${esc(JSON.stringify(rel.request_body, null, 2))}</pre><h3>Response</h3><pre class="raw mono">${esc(rel.response_snippet || rel.error || "—")}</pre>` : ""}`;
}

function source(inc, file) {
  if (!inc) return empty("No incident selected.");
  const frames = inc.frames || [];
  const loc = inc.source_location;
  return `<h3>Stack (source-mapped)</h3><table class="grid" data-testid="sqa-frames"><thead><tr><th>Function</th><th>Original</th><th>Bundle</th></tr></thead><tbody>${frames
    .slice(0, 12)
    .map((f) => `<tr><td class="mono">${esc(f.function)}</td><td class="mono ${f.original ? (f.original.vendor ? "" : "s-ok") : "s-warn"}">${f.original ? `${esc(shortPath(f.original.file))}:${f.original.line}` : esc(f.resolve_error || "unresolved")}</td><td class="mono" style="color:var(--dim)">${esc(String(f.url || "").split("/").pop())}:${f.line}:${f.column}</td></tr>`)
    .join("")}</tbody></table>
    ${loc ? `<h3>${esc(loc.file)}</h3>${file ? `<div class="code mono" data-testid="sqa-source-code">${file.lines.map((l, i) => { const n = file.start_line + i; return `<div class="ln ${n === file.highlight ? "hl" : ""}"><span class="n">${n}</span><pre>${esc(l)}</pre></div>`; }).join("")}</div>` : '<p class="empty">Loading source…</p>'}` : empty("No application frame could be resolved — source map unavailable.")}`;
}

function diagnosis(inc) {
  if (!inc) return empty("No incident selected.");
  const d = inc.diagnosis;
  const signals = inc.context_signals || [];
  const signalsBlock = signals.length ? `<h3>In-situ context · ${signals.length} signals a chatbox never receives</h3><ul class="factors" data-testid="sqa-diag-signals">${signals.map((s) => `<li><span class="mono" style="color:var(--dim)">${esc(s.kind)}</span> · ${esc(s.label)}</li>`).join("")}</ul>` : "";
  if (!d) return `${signalsBlock}<p class="empty">${inc.status === "diagnosing" || inc.status === "captured" ? "Diagnosis in progress…" : inc.error || "No diagnosis available."}</p>`;
  return `${signalsBlock}<h3>User intent</h3><p><b>${esc(d.intent)}</b></p>
    <h3>Root cause</h3><p data-testid="sqa-diag-root-cause"><b>${esc(d.root_cause)}</b></p><p>${esc(d.explanation)}</p>
    <div class="row"><span>Symptom: <b class="mono">${esc(shortPath(d.symptom_location))}</b></span><span>Cause: <b class="mono">${esc(shortPath(d.cause_location))}</b></span></div>
    <h3>Hypotheses</h3><table class="grid"><tbody>${(d.hypotheses || []).map((h) => `<tr><td>${esc(h.cause)}</td><td class="mono" style="width:60px">${pct(h.probability)}</td></tr>`).join("")}</tbody></table>
    <h3>Plan</h3><p>${esc(d.fix_plan || "—")}</p>
    <h3>Retrieved context</h3><table class="grid"><tbody>${(d.retrieved_files || []).map((f) => `<tr><td class="mono">${esc(f.path)}</td><td style="color:var(--dim)">${esc(f.reason)}</td><td class="mono" style="color:var(--dim)">${f.whole ? "whole" : `from L${f.start_line}`} · ${f.chars}c</td></tr>`).join("")}</tbody></table>
    <p style="margin-top:12px">Confidence <b>${pct(d.confidence)}</b> · model <b class="mono">${esc(d.model || "—")}</b> · ${(d.rounds || []).length} round(s)${inc.regression ? ' · <b style="color:var(--red)">REGRESSION</b>' : ""}</p>`;
}

function patch(inc) {
  if (!inc?.patch) return empty(inc?.error || "No patch proposed.");
  const r = inc.risk || {};
  return `<div class="row">${riskBadge(r.level)}<span>score ${r.score} · ${r.files} file(s) · ${r.lines} line(s)</span></div><ul class="factors">${(r.factors || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    ${inc.patch.files.map((f) => `<h3>${esc(f.path)}</h3><div class="diff mono">${renderDiff(f.diff)}</div>`).join("")}
    <h3>Reason</h3><p>${esc(inc.patch.reason || "")}</p>
    ${inc.checkpoint ? `<h3>Checkpoint</h3><p class="mono">${esc(inc.checkpoint.id)} · ${(inc.checkpoint.files || []).map((f) => esc(typeof f === "string" ? f : f.path)).join(", ")}</p>` : ""}
    ${inc.git ? `<h3>Git</h3><p class="mono">${esc(inc.git.branch)} @ ${esc(inc.git.commit)}${inc.git.pr?.url ? ` · <a href="${esc(inc.git.pr.url)}" target="_blank" rel="noreferrer" style="color:var(--cyan)">${esc(inc.git.pr.url)}</a>` : ""}</p>${inc.git.pr_error ? `<p class="s-warn">${esc(inc.git.pr_error)}</p>` : ""}<pre class="raw mono">${esc(inc.git.stat || "")}</pre>` : ""}`;
}

function validation(inc) {
  if (!inc?.validation) return empty("No validation has run for this incident.");
  return `<h3>Validation · ${esc(inc.validation.status)}</h3>${checklist(inc.validation.steps.map((s) => ({ ...s, label: s.name, detail: `${s.summary || ""} ${ms(s.duration_ms)}` })), "sqa-validation-detail")}
    ${inc.validation.steps.filter((s) => s.output).map((s) => `<h3>${esc(s.name)} output</h3><pre class="raw mono">${esc(s.output.slice(-2500))}</pre>`).join("")}`;
}

function replay(inc) {
  if (!inc) return empty("No incident selected.");
  const plan = inc.replay_plan || {};
  const r = inc.replay;
  return `<h3>Reproduction sequence</h3><ol style="padding-left:18px;margin:4px 0">${(plan.steps || []).map((s) => `<li>${esc(s.label)} <span class="mono" style="color:var(--dim)">${esc(s.selector || s.route || "")}</span></li>`).join("")}</ol>
    <h3>Expectations</h3><pre class="raw mono">${esc(JSON.stringify(plan.expectations || {}, null, 2))}</pre>
    ${r ? `<h3>Last replay · ${esc(r.status)} · ${ms(r.duration_ms)}</h3>${checklist([...(r.steps || []), ...(r.evidence || [])], "sqa-replay-detail")}` : empty("Not replayed yet.")}`;
}

function health(data) {
  const run = data.qaRun;
  const flows = data.flows || [];
  const scenarios = data.scenarios || [];
  return `<div class="row"><button class="btn primary" data-action="run-qa" data-testid="sqa-run-qa-btn">Run QA sweep</button><span style="color:var(--muted)">${flows.length} flows (${flows.filter((f) => f.source === "declared").length} declared · ${flows.filter((f) => f.source === "learned").length} learned regression)</span><a class="btn" href="/shadowqa" data-testid="sqa-open-center-link" style="margin-left:auto;text-decoration:none">Command Center ↗</a></div>
    ${run?.flows ? `<h3>Application health · ${esc(run.at)}</h3><div class="health" data-testid="sqa-health-grid">${run.flows.map((f) => `<div class="hcard ${esc(f.status)}"><div class="hn">${statusIcon(f.status)}${esc(f.name)}</div><div class="hd">${f.error ? esc(f.error) : `${(f.steps || []).length} steps · ${ms(f.duration_ms)}`}</div>${f.incident_id ? `<button class="btn" data-action="investigate" data-id="${esc(f.incident_id)}">Investigate</button>` : ""}</div>`).join("")}</div>` : `<p class="empty" style="margin-top:12px">No QA sweep recorded yet.</p>`}
    <h3>Flows</h3><table class="grid"><tbody>${flows.map((f) => `<tr><td>${esc(f.name)}</td><td style="color:var(--dim)">${esc(f.source)}</td><td style="color:var(--dim)">${(f.steps || []).length} steps</td></tr>`).join("")}</tbody></table>
    ${scenarios.length ? `<h3>Demo scenarios</h3><table class="grid" data-testid="sqa-scenarios"><tbody>${scenarios.map((s) => `<tr><td>${esc(s.title)}</td><td class="mono" style="color:var(--dim)">${esc(shortPath(s.file))}</td><td class="${s.bug_present ? "s-warn" : "s-ok"}" data-testid="sqa-scenario-${esc(s.id)}">${s.bug_present ? "bug present" : "fixed"}</td></tr>`).join("")}</tbody></table>
    <div class="row" style="margin-top:10px"><button class="btn" data-action="reset-demo" data-testid="sqa-reset-demo-btn">Reset demo bugs</button><span style="color:var(--dim);font-size:11px">Restores every intentional bug from its pristine copy and clears ShadowQA memory.</span></div>` : ""}`;
}

function memory(data) {
  const m = data.memory;
  if (!m) return empty("Loading memory…");
  const known = Object.values(m.known_failures || {});
  return `<div class="stats"><div class="stat"><div class="sv">${Object.keys(m.routes || {}).length}</div><div class="sl">routes</div></div><div class="stat"><div class="sv">${Object.keys(m.apis || {}).length}</div><div class="sl">apis</div></div><div class="stat"><div class="sv">${Object.keys(m.components || {}).length}</div><div class="sl">components</div></div><div class="stat"><div class="sv">${known.length}</div><div class="sl">known failures</div></div><div class="stat"><div class="sv">${(m.fixes || []).length}</div><div class="sl">fixes</div></div></div>
    <h3>Known failures</h3><table class="grid" data-testid="sqa-known-failures"><tbody>${known.map((k) => `<tr><td>${esc(k.title)}</td><td class="mono" style="color:var(--dim)">${esc(shortPath(k.file))}:${esc(k.line)}</td><td class="${k.status === "fixed" ? "s-ok" : k.status === "regressed" ? "s-bad" : "s-warn"}">${esc(k.status)} ×${k.count}</td></tr>`).join("") || '<tr><td class="empty">none</td></tr>'}</tbody></table>
    <h3>Fixes</h3><table class="grid"><tbody>${(m.fixes || []).map((f) => `<tr><td>${esc(f.title)}</td><td class="mono" style="color:var(--dim)">${(f.files || []).map(shortPath).join(", ")}</td><td class="${f.verified ? "s-ok" : "s-bad"}">${f.verified ? "verified" : "reverted"}</td></tr>`).join("") || '<tr><td class="empty">none</td></tr>'}</tbody></table>
    <h3>APIs</h3><table class="grid"><tbody>${Object.values(m.apis || {}).slice(0, 20).map((a) => `<tr><td class="mono">${esc(a.method)} ${esc(a.path)}</td><td class="mono" style="color:var(--dim)">${Object.entries(a.statuses || {}).map(([s, c]) => `${s}×${c}`).join(" ")}</td></tr>`).join("")}</tbody></table>
    <h3>Components</h3><p>${Object.values(m.components || {}).map((c) => `<span class="mono">${esc(c.name)}</span>`).join(" · ") || "—"}</p>`;
}

function agent(data, inc) {
  const t = data.telemetry;
  if (!t) return empty("Loading telemetry…");
  const a = t.averages || {};
  const cur = inc?.telemetry || {};
  return `<h3>Models</h3><p>primary <b class="mono">${esc(t.models?.primary)}</b> · fallback <b class="mono">${esc(t.models?.fallback)}</b>${t.models?.tertiary ? ` · last resort <b class="mono">${esc(t.models.tertiary)}</b>` : ""}</p>
    <h3>This incident</h3><div class="stats">${[["capture→bridge", cur.capture_to_bridge_ms], ["correlation", cur.correlation_ms], ["ai", cur.ai_ms], ["patch", cur.patch_ms], ["validation", cur.validation_ms], ["replay", cur.replay_ms], ["total", cur.total_ms]].map(([l, v]) => `<div class="stat"><div class="sv mono">${ms(v)}</div><div class="sl">${l}</div></div>`).join("")}</div>
    <h3>Averages · last ${(t.incidents || []).length} incidents</h3><div class="stats">${Object.entries(a).map(([k, v]) => `<div class="stat"><div class="sv mono">${ms(v)}</div><div class="sl">${esc(k.replace(/_ms$/, "").replace(/_/g, " "))}</div></div>`).join("")}<div class="stat"><div class="sv">${t.verified}</div><div class="sl">verified</div></div><div class="stat"><div class="sv">${t.rollbacks}</div><div class="sl">rollbacks</div></div></div>
    <h3>LLM calls</h3><table class="grid"><tbody>${(t.llm_calls || []).slice(0, 10).map((c) => `<tr><td class="mono">${esc(c.purpose)}</td><td class="mono">${esc(c.model)}</td><td class="mono ${c.ok ? "s-ok" : "s-bad"}">${c.ok ? ms(c.latency_ms) : esc((c.error || "").slice(0, 60))}</td></tr>`).join("")}</tbody></table>
    <h3>Audit trail</h3><table class="grid" data-testid="sqa-audit"><tbody>${(data.audit || []).slice(0, 25).map((e) => `<tr><td class="mono" style="color:var(--dim)">${esc(e.ts.slice(11, 19))}</td><td class="mono">${esc(e.action)}</td><td style="color:var(--dim)">${esc(e.actor)}</td></tr>`).join("")}</tbody></table>`;
}

export function renderInspector(state) {
  const inc = state.incident;
  const tab = state.tab;
  const panes = { timeline: () => timeline(inc), graph: () => graph(inc), network: () => network(inc), source: () => source(inc, state.sourceFile), diagnosis: () => diagnosis(inc), patch: () => patch(inc), validation: () => validation(inc), replay: () => replay(inc), health: () => health(state), memory: () => memory(state), agent: () => agent(state, inc) };
  return `<div class="drawer-head"><span class="led"></span><span class="brand">ShadowQA Inspector</span><p class="sub mono">${inc ? `${esc(inc.id)} · ${esc(inc.status)}` : "no active incident"}</p>${state.recent?.length ? `<select class="btn mono" data-action="select-incident" data-testid="sqa-incident-select">${state.recent.map((r) => `<option value="${esc(r.id)}" ${inc && r.id === inc.id ? "selected" : ""}>${esc(r.created_at.slice(11, 19))} · ${esc(r.title)} · ${esc(r.status)}</option>`).join("")}</select>` : ""}<button class="close" data-action="close-inspector" data-testid="sqa-inspector-close">✕</button></div>
    <div class="tabs">${TABS.map(([id, label]) => `<button class="tab ${tab === id ? "active" : ""}" data-action="tab" data-tab="${id}" data-testid="sqa-tab-${id}">${label}</button>`).join("")}</div>
    <div class="pane">${(panes[tab] || panes.timeline)()}</div>`;
}
