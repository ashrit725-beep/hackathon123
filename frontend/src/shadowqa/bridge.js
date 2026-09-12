/** HTTP client for the local workspace bridge. Every call carries the bridge token. */
export class Bridge {
  constructor({ bridgeUrl, token }) {
    this.base = bridgeUrl.replace(/\/$/, "");
    this.token = token;
  }

  async call(method, path, body, { keepalive = false } = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-ShadowQA-Token": this.token || "" },
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `bridge ${res.status}`);
    return data;
  }

  health = () => this.call("GET", "/health");
  createIncident = (payload) => this.call("POST", "/incidents", payload);
  getIncident = (id) => this.call("GET", `/incidents/${id}`);
  listIncidents = () => this.call("GET", "/incidents?limit=20");
  apply = (id) => this.call("POST", `/incidents/${id}/apply`);
  rediagnose = (id) => this.call("POST", `/incidents/${id}/diagnose`);
  replayStarted = (id) => this.call("POST", `/incidents/${id}/replay-started`);
  postReplayResult = (id, result) => this.call("POST", `/incidents/${id}/replay-result`, result);
  rollback = (id) => this.call("POST", `/incidents/${id}/rollback`);
  dismiss = (id) => this.call("POST", `/incidents/${id}/dismiss`);
  createPr = (id) => this.call("POST", `/incidents/${id}/git/pr`);
  readFile = (path, line) => this.call("GET", `/workspace/file?path=${encodeURIComponent(path)}${line ? `&line=${line}` : ""}`);
  getMemory = () => this.call("GET", "/memory");
  observe = (payload) => this.call("POST", "/memory/observe", payload, { keepalive: true });
  getFlows = () => this.call("GET", "/qa/flows");
  postQaRun = (run) => this.call("POST", "/qa/runs", run);
  latestQaRun = () => this.call("GET", "/qa/runs/latest");
  getAudit = () => this.call("GET", "/audit?limit=60");
  getTelemetry = () => this.call("GET", "/telemetry");
  getSettings = () => this.call("GET", "/settings");
  putSettings = (body) => this.call("PUT", "/settings", body);
  getScenarios = () => this.call("GET", "/demo/scenarios");
  resetDemo = () => this.call("POST", "/demo/reset");

  // Development-context layer (ShadowQA Core)
  coreOverview = () => this.call("GET", "/core/overview");
  putMode = (mode) => this.call("PUT", "/core/mode", { mode });
  listSources = (limit = 40) => this.call("GET", `/core/sources?limit=${limit}`);
  importSource = (body) => this.call("POST", "/core/sources/import", body);
  syncGithub = () => this.call("POST", "/core/connectors/github/sync");
  testSlack = () => this.call("POST", "/core/connectors/slack/test");
  listKnowledge = () => this.call("GET", "/core/knowledge?limit=120");
  extractKnowledge = () => this.call("POST", "/core/knowledge/extract");
  updateKnowledge = (id, body) => this.call("PUT", `/core/knowledge/${id}`, body);
  listPlans = () => this.call("GET", "/core/plans?limit=30");
  getPlan = (id) => this.call("GET", `/core/plans/${id}`);
  compilePlan = (objective) => this.call("POST", "/core/plans", { objective });
  approvePlan = (id) => this.call("POST", `/core/plans/${id}/approve`);
  rejectPlan = (id) => this.call("POST", `/core/plans/${id}/reject`);
  rollbackPlan = (id) => this.call("POST", `/core/plans/${id}/rollback`);
  verifyPlan = (id, body = {}) => this.call("POST", `/core/plans/${id}/verify`, body);
  planBrief = (id) => this.call("GET", `/core/plans/${id}/brief`);
  coreGraph = () => this.call("GET", "/core/graph");
  coreActivity = (limit = 40) => this.call("GET", `/core/activity?limit=${limit}`);
}
