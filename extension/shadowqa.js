/* ShadowQA runtime SDK — built from frontend/src/shadowqa */
(() => {
  // src/shadowqa/buffer.js
  var RingBuffer = class {
    constructor(capacity = 120) {
      this.capacity = capacity;
      this.items = [];
      this.listeners = /* @__PURE__ */ new Set();
    }
    push(item) {
      this.items.push(item);
      if (this.items.length > this.capacity) this.items.shift();
      this.listeners.forEach((fn) => {
        try {
          fn(item);
        } catch {
        }
      });
      return item;
    }
    toArray() {
      return this.items.slice();
    }
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
  };
  var seq = 0;
  var newId = (prefix) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;
  var sleep = (ms2) => new Promise((r) => setTimeout(r, ms2));

  // src/shadowqa/bridge.js
  var Bridge = class {
    constructor({ bridgeUrl, token }) {
      this.base = bridgeUrl.replace(/\/$/, "");
      this.token = token;
    }
    async call(method, path, body, { keepalive = false } = {}) {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-ShadowQA-Token": this.token || "" },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        keepalive
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
  };

  // src/shadowqa/dom.js
  var INTERACTIVE = 'button, a, [role="button"], input, select, textarea, label, summary, [data-testid]';
  var SKIP_COMPONENTS = /* @__PURE__ */ new Set(["Fragment", "Suspense", "Provider", "Consumer", "Outlet", "Routes", "Route", "RenderedRoute", "Router", "BrowserRouter", "Protected", "ErrorBoundary", "Field", "PageHeader", "StatusPill", "Link", "NavLink", "Navigate", "App"]);
  var GENERIC_COMPONENT = /(Provider|Context|Boundary)$/;
  var SENSITIVE_RE = /(card|cvc|cvv|exp|secret|token|password|passwd|ssn|iban|account)/i;
  var cssEscape = (s) => window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
  function isShadowQANode(node) {
    return Boolean(node?.closest?.("shadowqa-root")) || node?.getRootNode?.()?.host?.tagName === "SHADOWQA-ROOT";
  }
  function closestInteractive(node) {
    if (!(node instanceof Element)) return null;
    return node.closest(INTERACTIVE) || node;
  }
  function textOf(el) {
    const tag = el.tagName;
    const isField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    const isContainer = tag === "FORM" || tag === "DIV" || tag === "SECTION" || tag === "MAIN" || tag === "UL" || tag === "TABLE";
    let raw = el.getAttribute?.("aria-label") || "";
    if (!raw && isField) raw = (el.labels?.[0]?.innerText || "").split("\n")[0] || el.placeholder || el.getAttribute("name") || el.dataset?.testid || "";
    else if (!raw && !isContainer) raw = el.innerText || el.title || "";
    if (!raw && isContainer) raw = el.dataset?.testid || el.id || el.getAttribute("name") || "";
    return String(raw).trim().replace(/\s+/g, " ").slice(0, 60);
  }
  function selectorFor(el) {
    if (el.dataset?.testid) return `[data-testid="${cssEscape(el.dataset.testid)}"]`;
    if (el.id) return `#${cssEscape(el.id)}`;
    if (el.name && el.form) return `${el.tagName.toLowerCase()}[name="${cssEscape(el.name)}"]`;
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 7 && cur !== document.body) {
      if (cur.dataset?.testid) {
        parts.unshift(`[data-testid="${cssEscape(cur.dataset.testid)}"]`);
        break;
      }
      if (cur.id) {
        parts.unshift(`#${cssEscape(cur.id)}`);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }
  function componentNameOf(el) {
    try {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      let fiber = key ? el[key] : null;
      let hops = 0;
      while (fiber && hops++ < 60) {
        const t = fiber.type;
        const name = typeof t === "function" ? t.displayName || t.name : t && typeof t === "object" ? t.displayName || t.render?.name : null;
        if (name && /^[A-Z]/.test(name) && !SKIP_COMPONENTS.has(name) && !GENERIC_COMPONENT.test(name)) return name;
        fiber = fiber.return;
      }
    } catch {
    }
    return null;
  }
  function isSensitiveField(el) {
    if (el.type === "password") return true;
    const hint = `${el.name || ""} ${el.id || ""} ${el.dataset?.testid || ""} ${el.autocomplete || ""}`;
    return SENSITIVE_RE.test(hint);
  }
  function maskValue(value, el) {
    const v = String(value ?? "");
    if (el?.type === "password") return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 8) return `\u2022\u2022\u2022\u2022 ${digits.slice(-4)}`;
    return v.length ? "\u2022\u2022\u2022\u2022" : "";
  }
  function describe(el) {
    if (!(el instanceof Element)) return null;
    const form = el.closest?.("form");
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || void 0,
      role: el.getAttribute("role") || void 0,
      text: textOf(el) || void 0,
      name: el.getAttribute("name") || void 0,
      testid: el.dataset?.testid || void 0,
      id: el.id || void 0,
      href: el.tagName === "A" ? el.getAttribute("href") : void 0,
      selector: selectorFor(el),
      component: componentNameOf(el) || void 0,
      form: form ? form.dataset?.testid || form.id || form.getAttribute("name") || "form" : void 0
    };
  }
  function formContext(form) {
    if (!form) return null;
    return {
      testid: form.dataset?.testid || void 0,
      id: form.id || void 0,
      fields: [...form.elements].filter((e) => e.name || e.dataset?.testid).slice(0, 30).map((e) => ({ name: e.name || void 0, type: e.type, testid: e.dataset?.testid, filled: e.type === "checkbox" ? e.checked : Boolean(e.value) }))
    };
  }

  // src/shadowqa/capture.js
  var CONTEXT_KINDS = /* @__PURE__ */ new Set(["click", "input", "submit", "navigation", "console", "error"]);
  function buildPayload({ failure, buffer, ctx, config, source: source2 = "runtime", flowName = null }) {
    const all = buffer.toArray();
    const events = all.filter((e) => CONTEXT_KINDS.has(e.kind) && e.ts <= failure.ts + 100).slice(-40);
    const network2 = all.filter((e) => e.kind === "network" && e.ts <= failure.ts + 1500).slice(-15).map(({ transport, ...rest }) => rest);
    const trigger = [...events].reverse().find((e) => e.kind === "click" || e.kind === "submit");
    const triggerEl = ctx.lastTrigger && document.contains(ctx.lastTrigger) ? ctx.lastTrigger : null;
    let state = null;
    try {
      state = config.getState ? config.getState() : null;
    } catch {
      state = null;
    }
    return {
      app: {
        name: config.appName,
        url: location.href,
        route: location.pathname,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        user_agent: navigator.userAgent.slice(0, 120)
      },
      source: source2,
      flow_name: flowName,
      failure,
      events,
      network: network2,
      dom: { trigger: trigger?.target || null, form: triggerEl ? formContext(triggerEl.closest("form")) : null },
      state,
      timing: { detected_at: failure.ts, captured_at: Date.now() }
    };
  }
  function pickReplayValues(events, replayValues) {
    const out = {};
    for (const e of events) if (e.kind === "input" && e.id in replayValues) out[e.id] = replayValues[e.id];
    return out;
  }

  // src/shadowqa/detector.js
  var Detector = class {
    constructor({ onIncident }) {
      this.onIncident = onIncident;
      this.suppressed = false;
      this.active = false;
      this.recent = /* @__PURE__ */ new Map();
      this.timer = null;
      this.lastFailureTs = 0;
      this.onSuppressedFailure = null;
    }
    handleFailure(failure) {
      this.lastFailureTs = failure.ts;
      if (this.suppressed) {
        this.onSuppressedFailure?.(failure);
        return;
      }
      if (this.active) return;
      const fp = `${failure.type}|${failure.message.replace(/\d+/g, "#").slice(0, 100)}`;
      const seen = this.recent.get(fp);
      if (seen && Date.now() - seen < 3e4) return;
      this.recent.set(fp, Date.now());
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.onIncident(failure), 400);
    }
    /** After a verdict or an explicit developer action the same failure must be detectable again immediately (e.g. retry after Undo). */
    reset() {
      this.recent.clear();
      this.active = false;
    }
    handleNetwork(item) {
      if (this.suppressed || this.active) return;
      if ((item.status || 0) < 500 && item.status !== 0) return;
      if (!item.initiator_event_id) return;
      setTimeout(() => {
        if (this.active || Date.now() - this.lastFailureTs < 2e3) return;
        const failure = { kind: "http_error", type: item.status === 0 ? "NetworkError" : "HttpError", message: `${item.method} ${item.path} \u2192 ${item.status === 0 ? item.error || "no response" : `HTTP ${item.status}`}`, stack: "", ts: item.end_ts || Date.now() };
        this.handleFailure(failure);
      }, 700);
    }
  };

  // src/shadowqa/memoryObserver.js
  var MemoryObserver = class {
    constructor(bridge) {
      this.bridge = bridge;
      this.routes = /* @__PURE__ */ new Map();
      this.apis = /* @__PURE__ */ new Map();
      this.components = /* @__PURE__ */ new Map();
      this.timer = null;
    }
    noteRoute(path) {
      const e = this.routes.get(path) || { path, count: 0 };
      e.count++;
      e.title = document.title;
      this.routes.set(path, e);
    }
    noteNetwork(item) {
      if (!item.path || !item.end_ts) return;
      const key = `${item.method} ${item.path} ${item.status}`;
      const e = this.apis.get(key) || { method: item.method, path: item.path.replace(/\/[0-9a-f-]{8,}|\/LUM-\d+/gi, "/:id"), status: item.status, count: 0 };
      e.count++;
      this.apis.set(key, e);
    }
    noteInteraction(item) {
      const name = item.target?.component;
      if (!name) return;
      const e = this.components.get(name) || { name, count: 0, route: item.route };
      e.count++;
      this.components.set(name, e);
    }
    start() {
      this.timer = setInterval(() => this.flush(), 2e4);
    }
    stop() {
      clearInterval(this.timer);
      this.timer = null;
    }
    async flush() {
      if (!this.routes.size && !this.apis.size && !this.components.size) return;
      const payload = { routes: [...this.routes.values()], apis: [...this.apis.values()], components: [...this.components.values()] };
      this.routes.clear();
      this.apis.clear();
      this.components.clear();
      try {
        await this.bridge.observe(payload);
      } catch {
      }
    }
  };

  // src/shadowqa/observe/interaction.js
  function observeInteractions(buffer, ctx) {
    let lastInput = null;
    const rememberValue = (id, value) => {
      ctx.replayValues[id] = value;
      const keys = Object.keys(ctx.replayValues);
      if (keys.length > 300) delete ctx.replayValues[keys[0]];
    };
    const onClick = (e) => {
      const el = closestInteractive(e.target);
      if (!el || isShadowQANode(el)) return;
      const item = { id: newId("e"), ts: Date.now(), kind: "click", route: location.pathname, target: describe(el) };
      ctx.lastInteractionId = item.id;
      ctx.lastTrigger = el;
      ctx.onInteraction?.(item);
      buffer.push(item);
      lastInput = null;
    };
    const onInput = (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) || isShadowQANode(el)) return;
      const sensitive = isSensitiveField(el);
      const raw = el.type === "checkbox" ? String(el.checked) : el.value;
      const shown = sensitive ? maskValue(raw, el) : String(raw).slice(0, 80);
      if (lastInput && lastInput.el === el && Date.now() - lastInput.item.ts < 2e3) {
        lastInput.item.ts = Date.now();
        lastInput.item.value = shown;
        rememberValue(lastInput.item.id, raw);
        return;
      }
      const item = { id: newId("e"), ts: Date.now(), kind: "input", route: location.pathname, target: describe(el), value: shown, redacted: sensitive };
      rememberValue(item.id, raw);
      lastInput = { el, item };
      ctx.lastInteractionId = item.id;
      buffer.push(item);
    };
    const onSubmit = (e) => {
      if (isShadowQANode(e.target)) return;
      const item = { id: newId("e"), ts: Date.now(), kind: "submit", route: location.pathname, target: describe(e.target) };
      ctx.lastInteractionId = item.id;
      buffer.push(item);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);
    document.addEventListener("submit", onSubmit, true);
    let current = location.pathname;
    const record = (to) => {
      if (to === current) return;
      buffer.push({ id: newId("e"), ts: Date.now(), kind: "navigation", from: current, to });
      current = to;
      ctx.onRoute?.(to);
    };
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patched(...args) {
        const result = original.apply(this, args);
        record(location.pathname);
        return result;
      };
    }
    window.addEventListener("popstate", () => record(location.pathname));
    buffer.push({ id: newId("e"), ts: Date.now(), kind: "navigation", from: null, to: current });
    ctx.onRoute?.(current);
  }

  // src/shadowqa/observe/network.js
  var SENSITIVE_KEY = /(authorization|cookie|token|secret|passw|api[-_]?key|card|cvc|cvv|^exp$|^number$|ssn)/i;
  var IGNORE = [".map", "sockjs-node", "hot-update", "/__", "fonts.g", "unsplash.com"];
  function sanitizeBody(body) {
    if (body === void 0 || body === null) return void 0;
    if (typeof body === "string") {
      try {
        return sanitizeObject(JSON.parse(body));
      } catch {
        return { _raw: body.slice(0, 200) };
      }
    }
    if (body instanceof FormData) return { _formdata_keys: [...body.keys()].slice(0, 30) };
    return { _type: body?.constructor?.name || typeof body };
  }
  function sanitizeObject(value, depth = 0) {
    if (depth > 6) return "[depth]";
    if (Array.isArray(value)) return value.slice(0, 30).map((v) => sanitizeObject(v, depth + 1));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 40)) {
        out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitizeObject(v, depth + 1);
      }
      return out;
    }
    if (typeof value === "string") return value.slice(0, 300);
    return value;
  }
  var pathOf = (url) => {
    try {
      return new URL(url, location.href).pathname;
    } catch {
      return String(url);
    }
  };
  function observeNetwork(buffer, ctx, { ignorePrefixes = [] } = {}) {
    const ignored = (url) => ignorePrefixes.some((p) => url.startsWith(p)) || IGNORE.some((p) => url.includes(p));
    const finish = (item, status, snippetPromise) => {
      item.end_ts = Date.now();
      item.duration_ms = item.end_ts - item.ts;
      item.status = status;
      item.ok = status >= 200 && status < 400;
      ctx.inflight = Math.max(0, ctx.inflight - 1);
      const done = () => ctx.onNetwork?.(item);
      if (snippetPromise) {
        snippetPromise.then((text) => {
          item.response_snippet = item.ok ? sanitizeSnippet(text) : String(text || "").slice(0, 1500);
          done();
        }, done);
      } else done();
    };
    const sanitizeSnippet = (text) => {
      try {
        return JSON.stringify(sanitizeObject(JSON.parse(text))).slice(0, 600);
      } catch {
        return String(text || "").slice(0, 200);
      }
    };
    const isJson = (res) => /json/i.test(res.headers.get("content-type") || "");
    const originalFetch = window.fetch;
    window.fetch = function shadowqaFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url || String(input);
      if (ignored(url)) return originalFetch.apply(this, arguments);
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const item = { id: newId("n"), ts: Date.now(), kind: "network", transport: "fetch", method, url, path: pathOf(url), initiator_event_id: ctx.lastInteractionId, request_body: sanitizeBody(init?.body) };
      ctx.inflight++;
      buffer.push(item);
      return originalFetch.apply(this, arguments).then(
        (res) => {
          item.content_type = res.headers.get("content-type") || void 0;
          finish(item, res.status, !res.ok || isJson(res) ? res.clone().text() : null);
          return res;
        },
        (err) => {
          item.error = String(err?.message || err);
          finish(item, 0, null);
          throw err;
        }
      );
    };
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function shadowqaOpen(method, url) {
      this.__sqa = { method: String(method).toUpperCase(), url: String(url) };
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function shadowqaSend(body) {
      const meta = this.__sqa;
      if (meta && !ignored(meta.url)) {
        const item = { id: newId("n"), ts: Date.now(), kind: "network", transport: "xhr", method: meta.method, url: meta.url, path: pathOf(meta.url), initiator_event_id: ctx.lastInteractionId, request_body: sanitizeBody(body) };
        ctx.inflight++;
        buffer.push(item);
        this.addEventListener("loadend", () => {
          if (this.status === 0) item.error = "network error";
          finish(item, this.status, this.status >= 400 ? Promise.resolve(this.responseText) : null);
        });
      }
      return send.apply(this, arguments);
    };
  }

  // src/shadowqa/observe/runtime.js
  var NOISE = /ResizeObserver loop|^Script error\.?$|Loading chunk|ChunkLoadError|Download the React DevTools/;
  function observeRuntime(buffer, ctx, onFailure) {
    const recent = /* @__PURE__ */ new Map();
    const record = (kind, err, fallbackMessage) => {
      const type = err && (err.name || err.constructor?.name) || "Error";
      const message = String(err && err.message || fallbackMessage || err || "Unknown error");
      if (NOISE.test(message)) return;
      const stack = String(err && err.stack || "");
      const fp = `${type}|${message.replace(/\d+/g, "#").slice(0, 120)}`;
      const now = Date.now();
      if (recent.has(fp) && now - recent.get(fp) < 1500) return;
      recent.set(fp, now);
      buffer.push({ id: newId("e"), ts: now, kind: "error", type, message: message.slice(0, 300) });
      onFailure({ kind, type, message: message.slice(0, 800), stack: stack.slice(0, 8e3), ts: now });
    };
    window.addEventListener(
      "error",
      (e) => {
        if (e.target && e.target !== window) return;
        if (e.error) record("runtime_error", e.error, e.message);
        else if (e.message) record("runtime_error", null, e.message);
      },
      true
    );
    window.addEventListener("unhandledrejection", (e) => {
      const reason = e.reason;
      record("unhandled_rejection", reason instanceof Error ? reason : { name: "UnhandledRejection", message: String(reason), stack: "" });
    });
    const originalError = console.error;
    console.error = function shadowqaConsoleError(...args) {
      try {
        const msg = args.map((a) => typeof a === "string" ? a : a?.message || safeString(a)).join(" ").slice(0, 300);
        if (!/^Warning:|act\(|DevTools|\[shadowqa\]/.test(msg)) buffer.push({ id: newId("e"), ts: Date.now(), kind: "console", level: "error", message: msg });
      } catch {
      }
      return originalError.apply(this, args);
    };
  }
  function safeString(value) {
    try {
      return JSON.stringify(value).slice(0, 200);
    } catch {
      return String(value);
    }
  }

  // src/shadowqa/overlay/styles.js
  var STYLES = `
:host { all: initial; }
:host, .root {
  --bg: rgba(10, 11, 14, 0.94); --card: #0d0f13; --sub: #12151a; --line: rgba(255,255,255,0.09); --line-strong: rgba(255,255,255,0.16);
  --text: #eef2f6; --muted: #98a3b3; --dim: #667081; --red: #f0533f; --green: #2fbf8a; --amber: #e8a33c; --cyan: #37b6d3; --indigo: #7c83f5;
  font-family: "IBM Plex Sans", system-ui, sans-serif; font-size: 12.5px; line-height: 1.5; color: var(--text);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
.dock { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; pointer-events: none; }
.dock > * { pointer-events: auto; }

.dot { width: 22px; height: 22px; border-radius: 999px; display: grid; place-items: center; opacity: 0.38; transition: opacity 0.25s, transform 0.25s; }
.dot:hover { opacity: 1; transform: scale(1.05); }
.dot i { width: 8px; height: 8px; border-radius: 999px; background: var(--green); box-shadow: 0 0 0 4px rgba(47,191,138,0.14); display: block; }
.dot.busy i { background: var(--amber); box-shadow: 0 0 0 4px rgba(232,163,60,0.16); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(0.72); opacity: 0.6 } }

.card { width: 392px; max-width: calc(100vw - 32px); max-height: calc(100vh - 72px); overflow-y: auto; background: var(--bg); backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: 0 24px 60px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.6); overflow: hidden;
  animation: rise 0.28s cubic-bezier(0.16,1,0.3,1); }
@keyframes rise { from { opacity: 0; transform: translateY(10px) scale(0.985) } to { opacity: 1; transform: none } }
.card-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.card-head .led { width: 8px; height: 8px; border-radius: 999px; background: var(--red); box-shadow: 0 0 10px var(--red); }
.card-head .led.green { background: var(--green); box-shadow: 0 0 10px var(--green); }
.card-head .led.amber { background: var(--amber); box-shadow: 0 0 10px var(--amber); animation: pulse 1.4s ease-in-out infinite; }
.card-head .brand { font-weight: 600; letter-spacing: 0.02em; font-size: 12px; }
.card-head .phase { margin-left: auto; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.card-body { padding: 14px 14px 12px; }
.title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 8px; }
.sub { color: var(--muted); margin: 0 0 10px; }
.label { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); margin: 10px 0 4px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; }
.kv .k { color: var(--dim); }
.chain { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 11.5px; color: var(--muted); }
.chain .node { padding: 2px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--sub); color: var(--text); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.chain .node.bad { border-color: rgba(240,83,63,0.5); color: #ff8d7f; }
.chain .arrow { color: var(--dim); }
.loc { font-size: 12.5px; color: var(--cyan); word-break: break-all; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 4px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; border: 1px solid; }
.badge-low { color: #4fd6a3; border-color: rgba(47,191,138,0.35); background: rgba(47,191,138,0.1); }
.badge-medium { color: #f2b95a; border-color: rgba(232,163,60,0.4); background: rgba(232,163,60,0.1); }
.badge-high { color: #ff8d7f; border-color: rgba(240,83,63,0.45); background: rgba(240,83,63,0.12); }
.badge-\u2014 { color: var(--muted); border-color: var(--line); }
.conf { font-size: 11.5px; color: var(--muted); }
.conf b { color: var(--text); font-weight: 600; }
.actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
.btn { padding: 7px 12px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--sub); font-size: 12px; font-weight: 500; transition: background-color 0.15s, border-color 0.15s, transform 0.1s; }
.btn:hover { background: #1a1e26; border-color: rgba(255,255,255,0.28); }
.btn:active { transform: translateY(1px); }
.btn.primary { background: var(--text); color: #0b0c0f; border-color: var(--text); }
.btn.primary:hover { background: #ffffff; }
.btn.danger { border-color: rgba(240,83,63,0.5); color: #ff9c90; }
.btn.link { border: 0; background: none; color: var(--muted); padding: 7px 4px; margin-left: auto; }
.btn.link:hover { color: var(--text); }
.btn:disabled { opacity: 0.45; cursor: default; }
a.btn { color: inherit; text-decoration: none; display: inline-flex; align-items: center; }
.spin { display: inline-block; width: 12px; height: 12px; border: 1.5px solid var(--line-strong); border-top-color: var(--cyan); border-radius: 999px; animation: spin 0.8s linear infinite; vertical-align: -2px; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg) } }

.diff { background: #07080a; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 8px 0; font-size: 11.5px; line-height: 1.55; overflow-x: auto; white-space: pre; max-height: 260px; }
.diff .d-add { display: block; color: #5fe0aa; background: rgba(47,191,138,0.1); }
.diff .d-del { display: block; color: #ff8d7f; background: rgba(240,83,63,0.1); }
.diff .d-ctx { display: block; color: var(--dim); }
.diff .d-hunk { display: block; color: var(--indigo); margin-top: 4px; }
.file { font-size: 11.5px; color: var(--muted); margin-top: 8px; }
.file b { color: var(--text); font-weight: 500; }

.check { list-style: none; margin: 6px 0 0; padding: 0; }
.check-item { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; }
.check-item:last-child { border-bottom: 0; }
.check-item.running .check-label { color: var(--text); }
.check-item.pending .check-label { color: var(--dim); }
.check-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.check-detail { color: var(--dim); font-size: 11px; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ic { width: 14px; display: inline-block; text-align: center; font-weight: 700; flex: none; }
.ic-ok { color: var(--green); } .ic-bad { color: var(--red); } .ic-skip, .ic-pending { color: var(--dim); }
.ic-run { width: 10px; height: 10px; border: 1.5px solid var(--line-strong); border-top-color: var(--cyan); border-radius: 999px; animation: spin 0.8s linear infinite; position: relative; top: 1px; margin-right: 4px; }
.verdict { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 6px; margin-top: 12px; font-weight: 600; letter-spacing: 0.02em; }
.verdict.ok { background: rgba(47,191,138,0.12); border: 1px solid rgba(47,191,138,0.35); color: #5fe0aa; }
.verdict.bad { background: rgba(240,83,63,0.1); border: 1px solid rgba(240,83,63,0.4); color: #ff9c90; }
.verdict.warn { background: rgba(232,163,60,0.1); border: 1px solid rgba(232,163,60,0.4); color: #f2b95a; }
.hint { font-size: 11px; color: var(--dim); margin-top: 8px; }
.factors { margin: 6px 0 0; padding-left: 16px; color: var(--muted); font-size: 11.5px; }
.factors li { margin: 1px 0; }
.policy { font-size: 11px; color: var(--amber); margin-top: 6px; }
.dim { color: var(--dim); }

.signals { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 10px; }
.sig-count { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cyan); margin-right: 4px; }
.sig { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid rgba(55,182,211,0.25); background: rgba(55,182,211,0.07); color: var(--muted); white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }

.ba { display: grid; gap: 6px; margin-top: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--sub); }
.ba-row { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 8px; align-items: start; }
.ba-k { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); padding-top: 3px; }
.ba-row.ok .ba-k { color: var(--green); }
.ba-row.bad .ba-k { color: #ff8d7f; }
.ba-v { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 11.5px; }
.ba-v .node { padding: 2px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.ba-v .node.bad { border-color: rgba(240,83,63,0.5); color: #ff8d7f; }
.ba-v .arrow { color: var(--dim); }

.pr { margin-top: 8px; padding: 10px 12px; border: 1px solid rgba(47,191,138,0.3); border-radius: 6px; background: rgba(47,191,138,0.06); }
.pr-title { font-size: 12.5px; color: var(--text); }

.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 720px; max-width: 100vw; background: #090a0d; border-left: 1px solid var(--line-strong); z-index: 2147483001;
  box-shadow: -30px 0 80px rgba(0,0,0,0.6); display: flex; flex-direction: column; animation: slide 0.3s cubic-bezier(0.16,1,0.3,1); }
@keyframes slide { from { transform: translateX(40px); opacity: 0 } to { transform: none; opacity: 1 } }
.drawer-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.drawer-head .brand { font-weight: 600; white-space: nowrap; }
.drawer-head .sub { margin: 0; font-size: 11.5px; white-space: nowrap; }
.drawer-head select { max-width: 300px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; }
.drawer-head .close { color: var(--muted); font-size: 16px; padding: 4px 8px; }
.tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.tab { padding: 9px 10px; font-size: 11.5px; color: var(--muted); border-bottom: 2px solid transparent; white-space: nowrap; transition: color 0.15s, border-color 0.15s; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--cyan); }
.pane { flex: 1; overflow: auto; padding: 16px; }
.pane h3 { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); margin: 16px 0 8px; font-weight: 600; }
.pane h3:first-child { margin-top: 0; }
.pane p { margin: 6px 0; color: var(--muted); }
.pane p b { color: var(--text); font-weight: 500; }
.tl { list-style: none; margin: 0; padding: 0; }
.tl li { display: grid; grid-template-columns: 92px 84px 1fr; gap: 10px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; align-items: baseline; }
.tl .t { color: var(--dim); font-size: 11px; }
.tl .kind { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); }
.tl li.error .kind, .tl li.error .l { color: #ff8d7f; }
.tl li.source .kind { color: var(--cyan); }
.tl li.server .kind, .tl li.server .l { color: #ff8d7f; }
.tl li.user .kind { color: var(--indigo); }
.graph { display: flex; flex-direction: column; align-items: flex-start; gap: 0; }
.gnode { border: 1px solid var(--line-strong); background: var(--sub); border-radius: 6px; padding: 7px 12px; min-width: 240px; }
.gnode .gt { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
.gnode .gl { font-size: 12.5px; word-break: break-all; }
.gnode.runtime_error, .gnode.server_exception { border-color: rgba(240,83,63,0.5); } .gnode.source_location, .gnode.file { border-color: rgba(55,182,211,0.5); } .gnode.user_action { border-color: rgba(124,131,245,0.5); }
.gedge { width: 1px; height: 16px; background: var(--line-strong); margin-left: 18px; position: relative; }
.gedge::after { content: ""; position: absolute; bottom: -1px; left: -3px; border: 3.5px solid transparent; border-top-color: var(--line-strong); }
.code { background: #07080a; border: 1px solid var(--line); border-radius: 6px; padding: 8px 0; font-size: 11.5px; line-height: 1.55; overflow: auto; max-height: 420px; }
.code .ln { display: grid; grid-template-columns: 44px 1fr; }
.code .ln .n { color: var(--dim); text-align: right; padding-right: 10px; user-select: none; }
.code .ln.hl { background: rgba(240,83,63,0.12); }
.code .ln.hl .n { color: var(--red); }
.code .ln pre { margin: 0; white-space: pre; }
table.grid { width: 100%; border-collapse: collapse; font-size: 12px; }
table.grid th { text-align: left; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); padding: 4px 6px; border-bottom: 1px solid var(--line); font-weight: 600; }
table.grid td { padding: 5px 6px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
.s-ok { color: var(--green); } .s-bad { color: var(--red); } .s-warn { color: var(--amber); }
.health { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.hcard { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; background: var(--sub); display: flex; flex-direction: column; gap: 4px; }
.hcard .hn { display: flex; align-items: center; gap: 8px; font-weight: 500; }
.hcard .hd { font-size: 11px; color: var(--dim); }
.hcard.failed { border-color: rgba(240,83,63,0.45); }
.hcard.passed { border-color: rgba(47,191,138,0.35); }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.stat { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; background: var(--sub); }
.stat .sv { font-size: 18px; font-weight: 600; }
.stat .sl { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); }
.empty { color: var(--dim); font-style: italic; }
pre.raw { white-space: pre-wrap; word-break: break-word; color: var(--muted); font-size: 11.5px; background: #07080a; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 6px 0; max-height: 220px; overflow: auto; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
@media (max-width: 640px) { .card { width: calc(100vw - 24px); } .dock { right: 12px; bottom: 12px; } .drawer { width: 100vw; } }
`;

  // src/shadowqa/overlay/util.js
  var escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  var pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
  var ms = (v) => v == null ? "\u2014" : v >= 1e3 ? `${(v / 1e3).toFixed(1)}s` : `${Math.round(v)}ms`;
  var shortPath = (p) => String(p || "").replace(/^frontend\/src\//, "").replace(/^backend\//, "");
  function statusIcon(status) {
    if (status === "passed" || status === "ok" || status === true) return '<span class="ic ic-ok">\u2713</span>';
    if (status === "failed" || status === false) return '<span class="ic ic-bad">\u2717</span>';
    if (status === "running") return '<span class="ic ic-run"></span>';
    if (status === "skipped") return '<span class="ic ic-skip">\u2013</span>';
    return '<span class="ic ic-pending">\u25CB</span>';
  }
  function renderDiff(diff) {
    const lines = String(diff || "").split("\n");
    return lines.filter((l) => !/^(---|\+\+\+) /.test(l)).map((l) => {
      if (l.startsWith("@@")) return `<span class="d-hunk">${escapeHtml(l)}</span>`;
      if (l.startsWith("+")) return `<span class="d-add">${escapeHtml(l)}</span>`;
      if (l.startsWith("-")) return `<span class="d-del">${escapeHtml(l)}</span>`;
      return `<span class="d-ctx">${escapeHtml(l)}</span>`;
    }).join("");
  }
  function riskBadge(level) {
    const l = (level || "\u2014").toUpperCase();
    return `<span class="badge badge-${l.toLowerCase()}" data-testid="sqa-risk-badge">Risk ${escapeHtml(l)}</span>`;
  }
  function checklist(items, testid) {
    return `<ul class="check" data-testid="${testid}">${items.map((i) => `<li class="check-item ${i.status || (i.ok ? "passed" : "failed")}">${statusIcon(i.status ?? i.ok)}<span class="check-label">${escapeHtml(i.label || i.name)}</span>${i.detail || i.summary ? `<span class="check-detail">${escapeHtml(i.detail || i.summary)}</span>` : ""}</li>`).join("")}</ul>`;
  }

  // src/shadowqa/overlay/inspector.js
  var TABS = [
    ["timeline", "Timeline"],
    ["graph", "Graph"],
    ["network", "Network"],
    ["source", "Source"],
    ["diagnosis", "Diagnosis"],
    ["patch", "Patch"],
    ["validation", "Validation"],
    ["replay", "Replay"],
    ["health", "Health"],
    ["memory", "Memory"],
    ["agent", "Agent"]
  ];
  var empty = (text) => `<p class="empty">${escapeHtml(text)}</p>`;
  function timeline(inc) {
    if (!inc) return empty("No incident selected. Timelines are built from the bounded event window preceding a failure.");
    return `<h3>Causal timeline \xB7 ${inc.timeline.length} entries</h3><ul class="tl" data-testid="sqa-timeline">${inc.timeline.map((t) => `<li class="${t.severity === "error" ? "error" : t.kind}"><span class="t mono">${escapeHtml(t.time)}</span><span class="kind">${escapeHtml(t.kind)}</span><span class="l">${escapeHtml(t.label)}</span></li>`).join("")}</ul>`;
  }
  function graph(inc) {
    if (!inc) return empty("No incident selected.");
    const nodes = inc.graph?.nodes || [];
    return `<h3>Context graph \xB7 ${nodes.length} nodes</h3><div class="graph" data-testid="sqa-graph">${nodes.map((n, i) => `${i ? '<div class="gedge"></div>' : ""}<div class="gnode ${escapeHtml(n.type)}"><div class="gt">${escapeHtml(n.type.replace(/_/g, " "))}</div><div class="gl mono">${escapeHtml(n.label)}</div></div>`).join("")}</div>
    <h3>Trigger element</h3><pre class="raw mono">${escapeHtml(JSON.stringify(inc.trigger?.target || inc.dom?.trigger || {}, null, 2))}</pre>`;
  }
  function network(inc) {
    if (!inc) return empty("No incident selected.");
    const rows = inc.network || [];
    const rel = inc.related_request;
    return `<h3>Network chain \xB7 ${rows.length} requests in window</h3><table class="grid" data-testid="sqa-network"><thead><tr><th>Method</th><th>Path</th><th>Status</th><th>Time</th></tr></thead><tbody>${rows.map((n) => `<tr class="${rel && n.id === rel.id ? "hl" : ""}"><td class="mono">${escapeHtml(n.method)}</td><td class="mono">${escapeHtml(n.path)}</td><td class="mono ${n.status >= 400 || !n.status ? "s-bad" : "s-ok"}">${escapeHtml(n.status || n.error || "\u2026")}</td><td class="mono">${ms(n.duration_ms)}</td></tr>`).join("")}</tbody></table>
    ${rel ? `<h3>Correlated request</h3><p><b class="mono">${escapeHtml(rel.method)} ${escapeHtml(rel.path)}</b> \u2192 HTTP ${escapeHtml(rel.status)} in ${ms(rel.duration_ms)}</p><h3>Request body (sanitized)</h3><pre class="raw mono">${escapeHtml(JSON.stringify(rel.request_body, null, 2))}</pre><h3>Response</h3><pre class="raw mono">${escapeHtml(rel.response_snippet || rel.error || "\u2014")}</pre>` : ""}`;
  }
  function source(inc, file) {
    if (!inc) return empty("No incident selected.");
    const frames = inc.frames || [];
    const loc = inc.source_location;
    return `<h3>Stack (source-mapped)</h3><table class="grid" data-testid="sqa-frames"><thead><tr><th>Function</th><th>Original</th><th>Bundle</th></tr></thead><tbody>${frames.slice(0, 12).map((f) => `<tr><td class="mono">${escapeHtml(f.function)}</td><td class="mono ${f.original ? f.original.vendor ? "" : "s-ok" : "s-warn"}">${f.original ? `${escapeHtml(shortPath(f.original.file))}:${f.original.line}` : escapeHtml(f.resolve_error || "unresolved")}</td><td class="mono" style="color:var(--dim)">${escapeHtml(String(f.url || "").split("/").pop())}:${f.line}:${f.column}</td></tr>`).join("")}</tbody></table>
    ${loc ? `<h3>${escapeHtml(loc.file)}</h3>${file ? `<div class="code mono" data-testid="sqa-source-code">${file.lines.map((l, i) => {
      const n = file.start_line + i;
      return `<div class="ln ${n === file.highlight ? "hl" : ""}"><span class="n">${n}</span><pre>${escapeHtml(l)}</pre></div>`;
    }).join("")}</div>` : '<p class="empty">Loading source\u2026</p>'}` : empty("No application frame could be resolved \u2014 source map unavailable.")}`;
  }
  function diagnosis(inc) {
    if (!inc) return empty("No incident selected.");
    const d = inc.diagnosis;
    const signals = inc.context_signals || [];
    const signalsBlock = signals.length ? `<h3>In-situ context \xB7 ${signals.length} signals a chatbox never receives</h3><ul class="factors" data-testid="sqa-diag-signals">${signals.map((s) => `<li><span class="mono" style="color:var(--dim)">${escapeHtml(s.kind)}</span> \xB7 ${escapeHtml(s.label)}</li>`).join("")}</ul>` : "";
    if (!d) return `${signalsBlock}<p class="empty">${inc.status === "diagnosing" || inc.status === "captured" ? "Diagnosis in progress\u2026" : inc.error || "No diagnosis available."}</p>`;
    return `${signalsBlock}<h3>User intent</h3><p><b>${escapeHtml(d.intent)}</b></p>
    <h3>Root cause</h3><p data-testid="sqa-diag-root-cause"><b>${escapeHtml(d.root_cause)}</b></p><p>${escapeHtml(d.explanation)}</p>
    <div class="row"><span>Symptom: <b class="mono">${escapeHtml(shortPath(d.symptom_location))}</b></span><span>Cause: <b class="mono">${escapeHtml(shortPath(d.cause_location))}</b></span></div>
    <h3>Hypotheses</h3><table class="grid"><tbody>${(d.hypotheses || []).map((h) => `<tr><td>${escapeHtml(h.cause)}</td><td class="mono" style="width:60px">${pct(h.probability)}</td></tr>`).join("")}</tbody></table>
    <h3>Plan</h3><p>${escapeHtml(d.fix_plan || "\u2014")}</p>
    <h3>Retrieved context</h3><table class="grid"><tbody>${(d.retrieved_files || []).map((f) => `<tr><td class="mono">${escapeHtml(f.path)}</td><td style="color:var(--dim)">${escapeHtml(f.reason)}</td><td class="mono" style="color:var(--dim)">${f.whole ? "whole" : `from L${f.start_line}`} \xB7 ${f.chars}c</td></tr>`).join("")}</tbody></table>
    <p style="margin-top:12px">Confidence <b>${pct(d.confidence)}</b> \xB7 model <b class="mono">${escapeHtml(d.model || "\u2014")}</b> \xB7 ${(d.rounds || []).length} round(s)${inc.regression ? ' \xB7 <b style="color:var(--red)">REGRESSION</b>' : ""}</p>`;
  }
  function patch(inc) {
    if (!inc?.patch) return empty(inc?.error || "No patch proposed.");
    const r = inc.risk || {};
    return `<div class="row">${riskBadge(r.level)}<span>score ${r.score} \xB7 ${r.files} file(s) \xB7 ${r.lines} line(s)</span></div><ul class="factors">${(r.factors || []).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
    ${inc.patch.files.map((f) => `<h3>${escapeHtml(f.path)}</h3><div class="diff mono">${renderDiff(f.diff)}</div>`).join("")}
    <h3>Reason</h3><p>${escapeHtml(inc.patch.reason || "")}</p>
    ${inc.checkpoint ? `<h3>Checkpoint</h3><p class="mono">${escapeHtml(inc.checkpoint.id)} \xB7 ${(inc.checkpoint.files || []).map((f) => escapeHtml(typeof f === "string" ? f : f.path)).join(", ")}</p>` : ""}
    ${inc.git ? `<h3>Git</h3><p class="mono">${escapeHtml(inc.git.branch)} @ ${escapeHtml(inc.git.commit)}${inc.git.pr?.url ? ` \xB7 <a href="${escapeHtml(inc.git.pr.url)}" target="_blank" rel="noreferrer" style="color:var(--cyan)">${escapeHtml(inc.git.pr.url)}</a>` : ""}</p>${inc.git.pr_error ? `<p class="s-warn">${escapeHtml(inc.git.pr_error)}</p>` : ""}<pre class="raw mono">${escapeHtml(inc.git.stat || "")}</pre>` : ""}`;
  }
  function validation(inc) {
    if (!inc?.validation) return empty("No validation has run for this incident.");
    return `<h3>Validation \xB7 ${escapeHtml(inc.validation.status)}</h3>${checklist(inc.validation.steps.map((s) => ({ ...s, label: s.name, detail: `${s.summary || ""} ${ms(s.duration_ms)}` })), "sqa-validation-detail")}
    ${inc.validation.steps.filter((s) => s.output).map((s) => `<h3>${escapeHtml(s.name)} output</h3><pre class="raw mono">${escapeHtml(s.output.slice(-2500))}</pre>`).join("")}`;
  }
  function replay(inc) {
    if (!inc) return empty("No incident selected.");
    const plan = inc.replay_plan || {};
    const r = inc.replay;
    return `<h3>Reproduction sequence</h3><ol style="padding-left:18px;margin:4px 0">${(plan.steps || []).map((s) => `<li>${escapeHtml(s.label)} <span class="mono" style="color:var(--dim)">${escapeHtml(s.selector || s.route || "")}</span></li>`).join("")}</ol>
    <h3>Expectations</h3><pre class="raw mono">${escapeHtml(JSON.stringify(plan.expectations || {}, null, 2))}</pre>
    ${r ? `<h3>Last replay \xB7 ${escapeHtml(r.status)} \xB7 ${ms(r.duration_ms)}</h3>${checklist([...r.steps || [], ...r.evidence || []], "sqa-replay-detail")}` : empty("Not replayed yet.")}`;
  }
  function health(data) {
    const run = data.qaRun;
    const flows = data.flows || [];
    const scenarios = data.scenarios || [];
    return `<div class="row"><button class="btn primary" data-action="run-qa" data-testid="sqa-run-qa-btn">Run QA sweep</button><span style="color:var(--muted)">${flows.length} flows (${flows.filter((f) => f.source === "declared").length} declared \xB7 ${flows.filter((f) => f.source === "learned").length} learned regression)</span><a class="btn" href="/shadowqa" data-testid="sqa-open-center-link" style="margin-left:auto;text-decoration:none">Command Center \u2197</a></div>
    ${run?.flows ? `<h3>Application health \xB7 ${escapeHtml(run.at)}</h3><div class="health" data-testid="sqa-health-grid">${run.flows.map((f) => `<div class="hcard ${escapeHtml(f.status)}"><div class="hn">${statusIcon(f.status)}${escapeHtml(f.name)}</div><div class="hd">${f.error ? escapeHtml(f.error) : `${(f.steps || []).length} steps \xB7 ${ms(f.duration_ms)}`}</div>${f.incident_id ? `<button class="btn" data-action="investigate" data-id="${escapeHtml(f.incident_id)}">Investigate</button>` : ""}</div>`).join("")}</div>` : `<p class="empty" style="margin-top:12px">No QA sweep recorded yet.</p>`}
    <h3>Flows</h3><table class="grid"><tbody>${flows.map((f) => `<tr><td>${escapeHtml(f.name)}</td><td style="color:var(--dim)">${escapeHtml(f.source)}</td><td style="color:var(--dim)">${(f.steps || []).length} steps</td></tr>`).join("")}</tbody></table>
    ${scenarios.length ? `<h3>Demo scenarios</h3><table class="grid" data-testid="sqa-scenarios"><tbody>${scenarios.map((s) => `<tr><td>${escapeHtml(s.title)}</td><td class="mono" style="color:var(--dim)">${escapeHtml(shortPath(s.file))}</td><td class="${s.bug_present ? "s-warn" : "s-ok"}" data-testid="sqa-scenario-${escapeHtml(s.id)}">${s.bug_present ? "bug present" : "fixed"}</td></tr>`).join("")}</tbody></table>
    <div class="row" style="margin-top:10px"><button class="btn" data-action="reset-demo" data-testid="sqa-reset-demo-btn">Reset demo bugs</button><span style="color:var(--dim);font-size:11px">Restores every intentional bug from its pristine copy and clears ShadowQA memory.</span></div>` : ""}`;
  }
  function memory(data) {
    const m = data.memory;
    if (!m) return empty("Loading memory\u2026");
    const known = Object.values(m.known_failures || {});
    return `<div class="stats"><div class="stat"><div class="sv">${Object.keys(m.routes || {}).length}</div><div class="sl">routes</div></div><div class="stat"><div class="sv">${Object.keys(m.apis || {}).length}</div><div class="sl">apis</div></div><div class="stat"><div class="sv">${Object.keys(m.components || {}).length}</div><div class="sl">components</div></div><div class="stat"><div class="sv">${known.length}</div><div class="sl">known failures</div></div><div class="stat"><div class="sv">${(m.fixes || []).length}</div><div class="sl">fixes</div></div></div>
    <h3>Known failures</h3><table class="grid" data-testid="sqa-known-failures"><tbody>${known.map((k) => `<tr><td>${escapeHtml(k.title)}</td><td class="mono" style="color:var(--dim)">${escapeHtml(shortPath(k.file))}:${escapeHtml(k.line)}</td><td class="${k.status === "fixed" ? "s-ok" : k.status === "regressed" ? "s-bad" : "s-warn"}">${escapeHtml(k.status)} \xD7${k.count}</td></tr>`).join("") || '<tr><td class="empty">none</td></tr>'}</tbody></table>
    <h3>Fixes</h3><table class="grid"><tbody>${(m.fixes || []).map((f) => `<tr><td>${escapeHtml(f.title)}</td><td class="mono" style="color:var(--dim)">${(f.files || []).map(shortPath).join(", ")}</td><td class="${f.verified ? "s-ok" : "s-bad"}">${f.verified ? "verified" : "reverted"}</td></tr>`).join("") || '<tr><td class="empty">none</td></tr>'}</tbody></table>
    <h3>APIs</h3><table class="grid"><tbody>${Object.values(m.apis || {}).slice(0, 20).map((a) => `<tr><td class="mono">${escapeHtml(a.method)} ${escapeHtml(a.path)}</td><td class="mono" style="color:var(--dim)">${Object.entries(a.statuses || {}).map(([s, c]) => `${s}\xD7${c}`).join(" ")}</td></tr>`).join("")}</tbody></table>
    <h3>Components</h3><p>${Object.values(m.components || {}).map((c) => `<span class="mono">${escapeHtml(c.name)}</span>`).join(" \xB7 ") || "\u2014"}</p>`;
  }
  function agent(data, inc) {
    const t = data.telemetry;
    if (!t) return empty("Loading telemetry\u2026");
    const a = t.averages || {};
    const cur = inc?.telemetry || {};
    return `<h3>Models</h3><p>primary <b class="mono">${escapeHtml(t.models?.primary)}</b> \xB7 fallback <b class="mono">${escapeHtml(t.models?.fallback)}</b>${t.models?.tertiary ? ` \xB7 last resort <b class="mono">${escapeHtml(t.models.tertiary)}</b>` : ""}</p>
    <h3>This incident</h3><div class="stats">${[["capture\u2192bridge", cur.capture_to_bridge_ms], ["correlation", cur.correlation_ms], ["ai", cur.ai_ms], ["patch", cur.patch_ms], ["validation", cur.validation_ms], ["replay", cur.replay_ms], ["total", cur.total_ms]].map(([l, v]) => `<div class="stat"><div class="sv mono">${ms(v)}</div><div class="sl">${l}</div></div>`).join("")}</div>
    <h3>Averages \xB7 last ${(t.incidents || []).length} incidents</h3><div class="stats">${Object.entries(a).map(([k, v]) => `<div class="stat"><div class="sv mono">${ms(v)}</div><div class="sl">${escapeHtml(k.replace(/_ms$/, "").replace(/_/g, " "))}</div></div>`).join("")}<div class="stat"><div class="sv">${t.verified}</div><div class="sl">verified</div></div><div class="stat"><div class="sv">${t.rollbacks}</div><div class="sl">rollbacks</div></div></div>
    <h3>LLM calls</h3><table class="grid"><tbody>${(t.llm_calls || []).slice(0, 10).map((c) => `<tr><td class="mono">${escapeHtml(c.purpose)}</td><td class="mono">${escapeHtml(c.model)}</td><td class="mono ${c.ok ? "s-ok" : "s-bad"}">${c.ok ? ms(c.latency_ms) : escapeHtml((c.error || "").slice(0, 60))}</td></tr>`).join("")}</tbody></table>
    <h3>Audit trail</h3><table class="grid" data-testid="sqa-audit"><tbody>${(data.audit || []).slice(0, 25).map((e) => `<tr><td class="mono" style="color:var(--dim)">${escapeHtml(e.ts.slice(11, 19))}</td><td class="mono">${escapeHtml(e.action)}</td><td style="color:var(--dim)">${escapeHtml(e.actor)}</td></tr>`).join("")}</tbody></table>`;
  }
  function renderInspector(state) {
    const inc = state.incident;
    const tab = state.tab;
    const panes = { timeline: () => timeline(inc), graph: () => graph(inc), network: () => network(inc), source: () => source(inc, state.sourceFile), diagnosis: () => diagnosis(inc), patch: () => patch(inc), validation: () => validation(inc), replay: () => replay(inc), health: () => health(state), memory: () => memory(state), agent: () => agent(state, inc) };
    return `<div class="drawer-head"><span class="led"></span><span class="brand">ShadowQA Inspector</span><p class="sub mono">${inc ? `${escapeHtml(inc.id)} \xB7 ${escapeHtml(inc.status)}` : "no active incident"}</p>${state.recent?.length ? `<select class="btn mono" data-action="select-incident" data-testid="sqa-incident-select">${state.recent.map((r) => `<option value="${escapeHtml(r.id)}" ${inc && r.id === inc.id ? "selected" : ""}>${escapeHtml(r.created_at.slice(11, 19))} \xB7 ${escapeHtml(r.title)} \xB7 ${escapeHtml(r.status)}</option>`).join("")}</select>` : ""}<button class="close" data-action="close-inspector" data-testid="sqa-inspector-close">\u2715</button></div>
    <div class="tabs">${TABS.map(([id, label]) => `<button class="tab ${tab === id ? "active" : ""}" data-action="tab" data-tab="${id}" data-testid="sqa-tab-${id}">${label}</button>`).join("")}</div>
    <div class="pane">${(panes[tab] || panes.timeline)()}</div>`;
  }

  // src/shadowqa/overlay/views.js
  var head = (led, phase) => `<div class="card-head"><span class="led ${led}"></span><span class="brand">ShadowQA</span><span class="phase">${escapeHtml(phase)}</span></div>`;
  function contextChain(inc) {
    const nodes = (inc.graph?.nodes || []).filter((n) => ["user_action", "network_request", "network_response", "runtime_error"].includes(n.type));
    if (!nodes.length) return "";
    return `<div class="chain">${nodes.map((n, i) => `${i ? '<span class="arrow">\u2192</span>' : ""}<span class="node ${n.type === "runtime_error" || n.type === "network_response" && (n.meta?.status ?? 0) >= 400 ? "bad" : ""}">${escapeHtml(n.label)}</span>`).join("")}</div>`;
  }
  function locationLine(inc) {
    const loc = inc.source_location;
    if (!loc) return "";
    return `<div class="label">${loc.resolved ? "Source" : "Location (no source map)"}</div><div class="loc mono" data-testid="sqa-source-location">${escapeHtml(shortPath(loc.file))}:${escapeHtml(loc.line)}</div>`;
  }
  var footer = (buttons) => `<div class="actions">${buttons}</div>`;
  var detailsBtn = `<button class="btn link" data-action="inspector" data-testid="sqa-details-btn">Details</button>`;
  var dismissBtn = `<button class="btn" data-action="dismiss" data-testid="sqa-dismiss-btn">Dismiss</button>`;
  function summaryBlock(inc) {
    const d = inc.diagnosis || {};
    const r = inc.risk || {};
    if (!d.root_cause) return "";
    const loc = d.cause_location || (inc.source_location ? `${inc.source_location.file}:${inc.source_location.line}` : "");
    return `<div class="loc mono" data-testid="sqa-root-cause-location">${escapeHtml(shortPath(loc))}</div>
    <p class="sub" style="margin:4px 0 0" data-testid="sqa-root-cause">${escapeHtml(d.root_cause)}</p>
    <div class="meta" style="margin-top:8px"><span class="conf">Confidence <b>${pct(d.confidence)}</b></span>${riskBadge(r.level)}<span class="conf">${r.files || 0} file \xB7 ${r.lines || 0} lines</span></div>`;
  }
  var SIGNAL_CHIP = {
    interaction: () => "your click",
    inputs: (l) => l.match(/^\d+ fields?/)?.[0] || "form fields",
    route: (l) => l.replace(/^Route /, ""),
    component: (l) => l.match(/<[^>]+>/)?.[0] || "component",
    network: (l) => l.match(/HTTP \d+/)?.[0] || "network",
    network_window: (l) => l.match(/^\d+ requests/)?.[0] || "requests",
    source: (l) => /source-mapped/.test(l) ? "source map" : /handler/.test(l) ? "server handler" : "stack",
    server: () => "server traceback",
    state: () => "app state",
    console: (l) => l.match(/^\d+ console errors?/)?.[0] || "console",
    workspace: (l) => l.match(/^\d+ workspace files?/)?.[0] || "workspace",
    memory: () => "memory"
  };
  function signalsLine(inc) {
    const signals = inc.context_signals || [];
    if (!signals.length) return "";
    const chips = signals.map((s) => `<span class="sig" title="${escapeHtml(s.label)}">${escapeHtml((SIGNAL_CHIP[s.kind] || (() => s.kind))(s.label))}</span>`).join("");
    return `<div class="signals" data-testid="sqa-context-signals"><span class="sig-count">${signals.length} in-app signals</span>${chips}</div>`;
  }
  function renderCapturing(state) {
    return `${head("amber", "detected")}<div class="card-body"><p class="title" data-testid="sqa-card-title">Failure detected</p><p class="sub"><span class="spin"></span>Correlating interaction, network and runtime context\u2026</p></div>`;
  }
  var STAGES = ["Reading the source-mapped frames", "Retrieving the relevant workspace files", "Reasoning about intent vs. behaviour", "Drafting the smallest safe patch", "Assessing risk and confidence"];
  function elapsedLine(inc) {
    const secs = Math.max(0, Math.round((Date.now() - new Date(inc.created_at).getTime()) / 1e3));
    const stage = STAGES[Math.min(STAGES.length - 1, Math.floor(secs / 5))];
    return `<p class="sub" style="margin-top:12px"><span class="spin"></span><span data-volatile="stage">${escapeHtml(stage)}</span>\u2026 <span class="dim mono" data-testid="sqa-elapsed" data-volatile="elapsed">${secs}s</span></p>`;
  }
  function renderAnalyzing(inc) {
    return `${head("amber", "analyzing")}<div class="card-body" data-testid="sqa-analyzing">
    <p class="title" data-testid="sqa-card-title">${escapeHtml(inc.title)}</p>
    ${contextChain(inc)}
    ${locationLine(inc)}
    ${signalsLine(inc)}
    ${elapsedLine(inc)}
    ${footer(`${dismissBtn}${detailsBtn}`)}</div>`;
  }
  function renderDiagnosed(inc) {
    const d = inc.diagnosis || {};
    const r = inc.risk || {};
    const loc = d.cause_location || (inc.source_location ? `${inc.source_location.file}:${inc.source_location.line}` : "");
    return `${head("", "diagnosed")}<div class="card-body" data-testid="sqa-incident-card">
    <p class="title" data-testid="sqa-card-title">${escapeHtml(inc.title)}</p>
    <div class="label">Root cause</div>
    <div class="loc mono" data-testid="sqa-root-cause-location">${escapeHtml(shortPath(loc))}</div>
    <p class="sub" style="margin-top:6px" data-testid="sqa-root-cause">${escapeHtml(d.root_cause || "")}</p>
    <div class="meta"><span class="conf" data-testid="sqa-confidence">Confidence <b>${pct(d.confidence)}</b></span>${riskBadge(r.level)}<span class="conf">${r.files || 0} file \xB7 ${r.lines || 0} lines</span></div>
    ${signalsLine(inc)}
    ${inc.policy?.auto_applied ? `<p class="policy">LOW risk \xB7 eligible for autonomous application</p>` : `<p class="policy">${escapeHtml(r.level || "")} risk \u2014 your approval is required before anything is written.</p>`}
    ${footer(`<button class="btn primary" data-action="view-fix" data-testid="sqa-view-fix-btn">View Fix</button>${dismissBtn}${detailsBtn}`)}</div>`;
  }
  function renderFix(inc) {
    const p = inc.patch || {};
    const r = inc.risk || {};
    const d = inc.diagnosis || {};
    return `${head("", "proposed fix")}<div class="card-body" data-testid="sqa-fix-view">
    <p class="title">${escapeHtml(inc.title)}</p>
    ${(p.files || []).map((f) => `<div class="file"><b>${escapeHtml(shortPath(f.path))}</b> \xB7 +${f.added} \u2212${f.removed}</div><div class="diff mono" data-testid="sqa-diff">${renderDiff(f.diff)}</div>`).join("")}
    <p class="sub" data-testid="sqa-fix-reason">${escapeHtml(p.reason || d.fix_plan || "")}</p>
    <div class="meta">${riskBadge(r.level)}<span class="conf">Confidence <b>${pct(d.confidence)}</b></span></div>
    <ul class="factors">${(r.factors || []).slice(0, 5).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
    ${footer(`<button class="btn primary" data-action="apply" data-testid="sqa-apply-fix-btn">Apply Fix</button><button class="btn" data-action="reject" data-testid="sqa-reject-btn">Reject</button>${detailsBtn}`)}</div>`;
  }
  function renderValidating(inc) {
    const steps = inc.validation?.steps || [];
    const phase = inc.status === "applying" ? "applying" : "validating";
    return `${head("amber", phase)}<div class="card-body" data-testid="sqa-validating">
    <p class="title">${escapeHtml(inc.title)}</p>
    ${summaryBlock(inc)}
    ${inc.policy?.auto_applied ? `<p class="policy">Applied autonomously (LOW risk) \u2014 checkpoint created, you can undo.</p>` : `<p class="sub" style="margin-top:8px">Checkpoint created \xB7 patch applied \xB7 running validation</p>`}
    <div class="label">Validation</div>
    ${steps.length ? checklist(steps, "sqa-validation-list") : '<p class="sub"><span class="spin"></span>Preparing checks\u2026</p>'}
    ${footer(`<button class="btn danger" data-action="rollback" data-testid="sqa-undo-btn">Undo</button>${detailsBtn}`)}</div>`;
  }
  function renderReloading(inc) {
    return `${head("amber", "reloading")}<div class="card-body" data-testid="sqa-reloading">
    <p class="title">${escapeHtml(inc.title)}</p>
    ${summaryBlock(inc)}
    <div class="label">Validation</div>
    ${checklist((inc.validation?.steps || []).map((s) => ({ ...s, label: s.name })), "sqa-validation-list")}
    <p class="sub" style="margin-top:10px"><span class="spin"></span>Validation passed \xB7 hot reloading application to replay the original failure\u2026</p></div>`;
  }
  function renderReplaying(inc, steps) {
    const list = steps && steps.length ? steps : (inc.replay_plan?.steps || []).map((s) => ({ ...s, status: "pending" }));
    return `${head("amber", "replaying")}<div class="card-body" data-testid="sqa-replaying">
    <p class="title">${escapeHtml(inc.title)}</p>
    <div class="label">Replaying original failure</div>
    ${checklist(list, "sqa-replay-list")}
    <p class="hint">ShadowQA is driving the application. Evidence is collected live.</p></div>`;
  }
  function beforeAfter(inc) {
    const before = (inc.graph?.nodes || []).filter((n) => ["user_action", "network_response", "runtime_error"].includes(n.type)).map((n) => n.label);
    const replay2 = inc.replay || {};
    const okResp = (replay2.evidence || []).find((e) => /^Response/.test(e.label));
    const ui = (replay2.evidence || []).find((e) => /UI reached/.test(e.label));
    const after = [inc.trigger ? `${(inc.trigger.kind || "click").replace(/^./, (c) => c.toUpperCase())} '${inc.trigger.target?.text || "element"}'` : "Same gesture", okResp ? okResp.label : null, ui?.ok ? "expected UI state" : null, "no runtime errors"].filter(Boolean);
    if (!before.length) return "";
    return `<div class="ba" data-testid="sqa-before-after">
    <div class="ba-row bad"><span class="ba-k">Before</span><span class="ba-v">${before.map((l) => `<span class="node bad">${escapeHtml(l)}</span>`).join('<span class="arrow">\u2192</span>')}</span></div>
    <div class="ba-row ok"><span class="ba-k">After</span><span class="ba-v">${after.map((l) => `<span class="node">${escapeHtml(l)}</span>`).join('<span class="arrow">\u2192</span>')}</span></div>
  </div>`;
  }
  function renderVerified(inc) {
    const replay2 = inc.replay || {};
    const items = [...replay2.steps || [], ...replay2.evidence || []];
    const git = inc.git;
    const t = inc.telemetry || {};
    return `${head("green", "verified")}<div class="card-body" data-testid="sqa-verified">
    <p class="title">${escapeHtml(inc.title)}</p>
    ${summaryBlock(inc)}
    ${signalsLine(inc)}
    ${beforeAfter(inc)}
    <div class="label">Replay of original failure</div>
    ${checklist(items, "sqa-evidence-list")}
    <div class="verdict ok" data-testid="sqa-verdict">\u{1F7E2} FIX VERIFIED <span style="font-weight:400;color:var(--muted);margin-left:auto;font-size:11px">${(inc.validation?.steps || []).filter((s) => s.status === "passed").length} checks \xB7 replay ${replay2.duration_ms ? `${(replay2.duration_ms / 1e3).toFixed(1)}s` : ""}${t.total_ms ? ` \xB7 ${(t.total_ms / 1e3).toFixed(0)}s end-to-end` : ""}</span></div>
    <p class="hint" data-testid="sqa-no-prompt">No prompt was written. ShadowQA started from the failure it observed in this tab \u2014 not from a task you described.</p>
    ${git ? `<p class="hint" data-testid="sqa-git-info">Branch <b class="mono">${escapeHtml(git.branch)}</b> \xB7 ${escapeHtml(git.commit)}${git.pr?.url ? ` \xB7 <a href="${escapeHtml(git.pr.url)}" target="_blank" rel="noreferrer" style="color:var(--cyan)">PR #${escapeHtml(git.pr.number)}</a>` : git.pr_error ? ` \xB7 ${escapeHtml(git.pr_error)}` : ""}</p>` : ""}
    ${footer(`<button class="btn danger" data-action="rollback" data-testid="sqa-undo-btn">Undo</button>${git ? "" : `<button class="btn" data-action="create-pr" data-testid="sqa-create-pr-btn">${inc.pr_enabled ? "Create PR" : "Commit to branch"}</button>`}<button class="btn" data-action="dismiss" data-testid="sqa-done-btn">Done</button><button class="btn link" data-action="inspector" data-tab="patch" data-testid="sqa-details-btn">View Diff</button>`)}</div>`;
  }
  function renderCommitted(inc) {
    const git = inc.git || {};
    const d = inc.diagnosis || {};
    const files = (inc.patch?.files || []).map((f) => `${shortPath(f.path)} (+${f.added} \u2212${f.removed})`);
    return `${head("green", git.pr?.url ? "pull request" : "committed")}<div class="card-body" data-testid="sqa-committed">
    <p class="title">${escapeHtml(inc.title)}</p>
    <div class="pr">
      <div class="pr-title mono" data-testid="sqa-pr-title">${escapeHtml(git.pr_title || `ShadowQA: ${inc.title}`)}</div>
      <div class="kv" style="margin-top:8px"><span class="k">Branch</span><span class="mono">${escapeHtml(git.branch || "\u2014")}</span><span class="k">Commit</span><span class="mono">${escapeHtml(git.commit || "\u2014")}</span><span class="k">Base</span><span class="mono">${escapeHtml(git.base_branch || "\u2014")}</span><span class="k">Files</span><span class="mono">${escapeHtml(files.join(", ") || "\u2014")}</span></div>
      ${git.pr?.url ? `<a class="btn primary" style="display:inline-flex;margin-top:10px" href="${escapeHtml(git.pr.url)}" target="_blank" rel="noreferrer" data-testid="sqa-pr-link">Open PR #${escapeHtml(git.pr.number)} \u2197</a>` : `<p class="hint" data-testid="sqa-pr-error">${escapeHtml(git.pr_error || "")}</p>`}
    </div>
    <div class="label">PR summary</div>
    <ul class="factors" data-testid="sqa-pr-summary"><li>Root cause: ${escapeHtml(d.root_cause || "\u2014")}</li><li>Validation: ${(inc.validation?.steps || []).map((s) => `${escapeHtml(s.name)} ${s.status === "passed" ? "\u2713" : "\u2717"}`).join(" \xB7 ")}</li><li>Replay: ${(inc.replay?.evidence || []).filter((e) => e.ok).length}/${(inc.replay?.evidence || []).length} evidence checks passed</li><li>Confidence ${pct(d.confidence)} \xB7 ${escapeHtml(d.model || "")}</li></ul>
    ${footer(`<button class="btn danger" data-action="rollback" data-testid="sqa-undo-btn">Undo</button><button class="btn" data-action="dismiss" data-testid="sqa-done-btn">Done</button><button class="btn link" data-action="inspector" data-tab="patch" data-testid="sqa-details-btn">View Diff</button>`)}</div>`;
  }
  function renderToast(text) {
    return `${head("green", "shadowqa")}<div class="card-body" data-testid="sqa-toast"><p class="sub" style="margin:0">${escapeHtml(text)}</p></div>`;
  }
  function renderFailed(inc) {
    const isValidation = inc.status === "validation_failed";
    const steps = isValidation ? inc.validation?.steps || [] : [...inc.replay?.steps || [], ...inc.replay?.evidence || []];
    return `${head("", "rolled back")}<div class="card-body" data-testid="sqa-failed">
    <p class="title">${escapeHtml(inc.title)}</p>
    ${checklist(steps, "sqa-failed-list")}
    <div class="verdict bad" data-testid="sqa-verdict">\u2717 ${isValidation ? "VALIDATION FAILED" : "REPLAY DID NOT CONFIRM RECOVERY"}</div>
    <p class="hint">The proposed change was reverted from the checkpoint. Workspace is back to its previous state.</p>
    ${footer(`<button class="btn" data-action="inspector" data-tab="diagnosis" data-testid="sqa-view-diagnosis-btn">View Diagnosis</button><button class="btn" data-action="retry" data-testid="sqa-retry-btn">Re-diagnose</button>${dismissBtn}`)}</div>`;
  }
  function renderUnsafe(inc) {
    const d = inc.diagnosis || {};
    const aiDown = inc.status === "diagnosis_failed";
    return `${head("", aiDown ? "degraded" : "needs review")}<div class="card-body" data-testid="sqa-unsafe">
    <p class="title">${escapeHtml(inc.title)}</p>
    ${locationLine(inc)}
    <div class="verdict warn">${aiDown ? "I captured the failure, but the diagnosis engine is unavailable." : "I found the likely failure, but I cannot safely verify a fix."}</div>
    ${d.root_cause ? `<p class="sub" style="margin-top:8px">${escapeHtml(d.root_cause)}</p>` : ""}
    ${inc.error ? `<p class="hint mono">${escapeHtml(inc.error)}</p>` : ""}
    ${footer(`<button class="btn" data-action="inspector" data-tab="diagnosis" data-testid="sqa-view-diagnosis-btn">View Diagnosis</button><button class="btn" data-action="retry" data-testid="sqa-retry-btn">Retry</button>${dismissBtn}`)}</div>`;
  }
  function renderRolledBack(inc) {
    return `${head("", "undone")}<div class="card-body" data-testid="sqa-rolled-back">
    <p class="title">${escapeHtml(inc.title)}</p>
    <div class="verdict warn">Change undone \u2014 files restored from checkpoint.</div>
    ${footer(`${dismissBtn}${detailsBtn}`)}</div>`;
  }
  function renderBridgeError(error) {
    return `${head("", "offline")}<div class="card-body" data-testid="sqa-bridge-error">
    <p class="title">Failure detected, bridge unreachable</p>
    <p class="sub mono">${escapeHtml(error)}</p>
    ${footer(`<button class="btn" data-action="dismiss" data-testid="sqa-dismiss-btn">Dismiss</button>`)}</div>`;
  }
  function renderQA(progress) {
    const results = progress.results || [];
    const items = results.map((r) => ({ label: r.name, status: r.status, detail: r.error ? String(r.error).slice(0, 60) : `${(r.duration_ms / 1e3).toFixed(1)}s` }));
    if (progress.current) items.push({ label: progress.current, status: "running" });
    return `${head("amber", "qa mode")}<div class="card-body" data-testid="sqa-qa-running">
    <p class="title">Exploring application flows</p>
    ${checklist(items, "sqa-qa-list")}
    <p class="hint">${results.length}/${progress.total || "?"} flows \xB7 ShadowQA is driving the application.</p></div>`;
  }
  function renderQASummary(run) {
    const items = (run.flows || []).map((f) => ({ label: f.name, status: f.status, detail: f.error ? String(f.error).slice(0, 60) : `${((f.duration_ms || 0) / 1e3).toFixed(1)}s` }));
    const failed = (run.flows || []).filter((f) => f.status === "failed");
    return `${head(failed.length ? "" : "green", "application health")}<div class="card-body" data-testid="sqa-qa-summary">
    <p class="title">${run.passed}/${(run.flows || []).length} flows healthy</p>
    ${checklist(items, "sqa-health-list")}
    ${failed.length ? `<p class="sub" style="margin-top:10px">Reproducible sequences captured for ${failed.length} failure${failed.length > 1 ? "s" : ""}.</p>` : `<div class="verdict ok">\u{1F7E2} ALL FLOWS HEALTHY</div>`}
    ${footer(`${failed.filter((f) => f.incident_id).slice(0, 2).map((f) => `<button class="btn primary" data-action="investigate" data-id="${escapeHtml(f.incident_id)}" data-testid="sqa-investigate-${escapeHtml(f.incident_id)}">Investigate ${escapeHtml(f.name)}</button>`).join("")}<button class="btn" data-action="dismiss" data-testid="sqa-dismiss-btn">Close</button>${detailsBtn}`)}</div>`;
  }

  // src/shadowqa/overlay/overlay.js
  var TRANSIENT_VIEWS = /* @__PURE__ */ new Set(["capturing", "bridge_error", "qa", "qa_summary", "fix", "toast"]);
  var Overlay = class {
    constructor({ actions }) {
      this.actions = actions;
      this.state = { view: null, incident: null, replaySteps: null, inspector: false, tab: "timeline", sourceFile: null, busy: false, qa: null, qaRun: null, memory: null, telemetry: null, audit: null, flows: null, recent: null, error: null };
    }
    mount() {
      if (this.host) return;
      this.host = document.createElement("shadowqa-root");
      this.shadow = this.host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLES;
      this.root = document.createElement("div");
      this.root.className = "root";
      this.dock = document.createElement("div");
      this.dock.className = "dock";
      this.dot = document.createElement("button");
      this.dot.className = "dot";
      this.dot.dataset.action = "dot";
      this.dot.dataset.testid = "sqa-status-dot";
      this.dot.innerHTML = "<i></i>";
      this.dock.appendChild(this.dot);
      this.root.appendChild(this.dock);
      this.cardEl = null;
      this.drawerEl = null;
      this.shadow.append(style, this.root);
      document.documentElement.appendChild(this.host);
      this.root.addEventListener("click", (e) => this.onClick(e));
      this.root.addEventListener("change", (e) => {
        const sel = e.target.closest("[data-action='select-incident']");
        if (sel) this.actions.selectIncident(sel.value);
      });
      window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "q") {
          e.preventDefault();
          this.toggleInspector();
        }
      });
      this.render();
    }
    set(fields) {
      Object.assign(this.state, fields);
      this.render();
    }
    setIncident(incident) {
      const view = this.state.view;
      const keepFix = view === "fix" && incident?.status === "diagnosed";
      this.set({ incident, view: keepFix ? "fix" : TRANSIENT_VIEWS.has(view) && view !== "fix" && !incident ? view : null });
    }
    setReplayProgress(steps) {
      this.set({ replaySteps: steps });
    }
    toggleInspector(tab) {
      this.set({ inspector: !this.state.inspector || Boolean(tab && tab !== this.state.tab), tab: tab || this.state.tab });
      if (this.state.inspector) this.actions.inspectorOpened(this.state.tab);
    }
    onClick(e) {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const a = this.actions;
      const map = {
        inspector: () => this.toggleInspector(btn.dataset.tab),
        "close-inspector": () => this.set({ inspector: false }),
        tab: () => {
          this.set({ tab: btn.dataset.tab });
          a.inspectorOpened(btn.dataset.tab);
        },
        "view-fix": () => this.set({ view: "fix" }),
        apply: () => a.apply(),
        reject: () => a.dismiss(),
        dismiss: () => a.dismiss(),
        rollback: () => a.rollback(),
        "create-pr": () => a.createPr(),
        retry: () => a.retry(),
        "run-qa": () => a.runQA(),
        investigate: () => a.investigate(btn.dataset.id),
        "reset-demo": () => a.resetDemo(),
        dot: () => this.toggleInspector("health")
      };
      map[action]?.();
    }
    cardHtml() {
      const s = this.state;
      const inc = s.incident;
      if (s.view === "capturing") return renderCapturing(s);
      if (s.view === "bridge_error") return renderBridgeError(s.error);
      if (s.view === "toast") return renderToast(s.toast);
      if (s.view === "qa") return renderQA(s.qa || {});
      if (s.view === "qa_summary") return renderQASummary(s.qaRun || {});
      if (!inc) return null;
      if (s.view === "fix" && inc.status === "diagnosed") return renderFix(inc);
      switch (inc.status) {
        case "captured":
        case "diagnosing":
          return renderAnalyzing(inc);
        case "diagnosed":
          return renderDiagnosed(inc);
        case "applying":
        case "validating":
          return renderValidating(inc);
        case "awaiting_replay":
          return renderReloading(inc);
        case "replaying":
          return renderReplaying(inc, s.replaySteps);
        case "verified":
          return renderVerified(inc);
        case "committed":
          return renderCommitted(inc);
        case "validation_failed":
        case "replay_failed":
          return renderFailed(inc);
        case "no_safe_fix":
        case "diagnosis_failed":
        case "superseded":
          return renderUnsafe(inc);
        case "rolled_back":
          return renderRolledBack(inc);
        default:
          return null;
      }
    }
    /** Persistent elements + change detection: the card animates in once and never re-mounts on the 850 ms poll, scroll is preserved. */
    render() {
      if (!this.root) return;
      const card = this.cardHtml();
      const s = this.state;
      const busy = s.incident && !["verified", "committed", "dismissed", "rolled_back", "validation_failed", "replay_failed", "no_safe_fix", "diagnosis_failed", "superseded"].includes(s.incident.status);
      this.dot.className = `dot ${busy || s.view === "qa" ? "busy" : ""}`;
      this.dot.title = `ShadowQA \xB7 ${busy ? "working" : "watching"} (Ctrl+Shift+Q)`;
      if (card) {
        if (!this.cardEl) {
          this.cardEl = document.createElement("div");
          this.cardEl.className = "card";
          this.dock.insertBefore(this.cardEl, this.dot);
        }
        patchHtml(this.cardEl, card, ".card-body");
      } else if (this.cardEl) {
        this.cardEl.remove();
        this.cardEl = null;
      }
      if (s.inspector) {
        const html = renderInspector(s);
        if (!this.drawerEl) {
          this.drawerEl = document.createElement("div");
          this.drawerEl.className = "drawer";
          this.drawerEl.dataset.testid = "sqa-inspector";
          this.root.appendChild(this.drawerEl);
        }
        patchHtml(this.drawerEl, html, ".pane");
      } else if (this.drawerEl) {
        this.drawerEl.remove();
        this.drawerEl = null;
      }
    }
  };
  var VOLATILE = /(<[^>]*data-volatile="([^"]+)"[^>]*>)([^<]*)(<\/[^>]+>)/g;
  function patchHtml(el, html, scrollSelector) {
    if (el.__html === html) return;
    const skeleton = html.replace(VOLATILE, "$1$4");
    if (el.__skeleton === skeleton) {
      for (const m of html.matchAll(VOLATILE)) {
        const target = el.querySelector(`[data-volatile="${m[2]}"]`);
        if (target && target.innerHTML !== m[3]) target.innerHTML = m[3];
      }
      el.__html = html;
      return;
    }
    const inner = el.querySelector(scrollSelector);
    const top = { el: el.scrollTop, inner: inner ? inner.scrollTop : 0 };
    const focusKey = el.querySelector(":focus")?.dataset?.testid;
    el.innerHTML = html;
    el.__html = html;
    el.__skeleton = skeleton;
    el.scrollTop = top.el;
    const nextInner = el.querySelector(scrollSelector);
    if (nextInner) nextInner.scrollTop = top.inner;
    if (focusKey) el.querySelector(`[data-testid="${focusKey}"]`)?.focus?.({ preventScroll: true });
  }

  // src/shadowqa/qa.js
  var QARunner = class {
    constructor({ bridge, replay: replay2, detector, buffer, ctx, config }) {
      Object.assign(this, { bridge, replay: replay2, detector, buffer, ctx, config });
      this.running = false;
    }
    async run({ onProgress } = {}) {
      if (this.running) return null;
      this.running = true;
      const started = Date.now();
      const results = [];
      const incidents = [];
      this.detector.suppressed = true;
      const returnTo = location.pathname;
      try {
        const { flows } = await this.bridge.getFlows();
        const routes = [...new Set(flows.map((f) => f.steps?.[0]?.route).filter(Boolean))];
        for (const flow of flows) {
          onProgress?.({ current: flow.name, results: results.slice(), total: flows.length });
          const t0 = Date.now();
          let failure = null;
          this.detector.onSuppressedFailure = (f) => {
            failure = failure || f;
          };
          const first = flow.steps?.[0];
          if (first?.action === "navigate" && first.route === location.pathname) {
            const neutral = routes.find((r) => r !== location.pathname);
            if (neutral) {
              await this.replay.execute({ action: "navigate", route: neutral }, {});
              await this.replay.settle();
            }
          }
          const res = await this.replay.run({ steps: flow.steps, expectations: flow.expectations }, { values: {} });
          const entry = { name: flow.name, source: flow.source, status: res.status, duration_ms: Date.now() - t0, steps: res.steps, evidence: res.evidence };
          if (res.status === "failed") {
            entry.error = res.errors[0] ? `${res.errors[0].type}: ${res.errors[0].message}` : res.evidence.find((e) => !e.ok)?.label || res.steps.find((s) => s.status === "failed")?.detail;
            if (!failure) {
              const badRequest = res.network.find((n) => n.status >= 400 || n.status === 0);
              if (badRequest) failure = { kind: "http_error", type: "HttpError", message: `${badRequest.method} ${badRequest.path} \u2192 HTTP ${badRequest.status}`, stack: "", ts: Date.now() };
            }
            if (failure) {
              try {
                const payload = buildPayload({ failure, buffer: this.buffer, ctx: this.ctx, config: this.config, source: "qa", flowName: flow.name });
                const inc = await this.bridge.createIncident(payload);
                entry.incident_id = inc.id;
                incidents.push({ id: inc.id, values: pickReplayValues(payload.events, this.ctx.replayValues) });
              } catch (err) {
                entry.error += ` (bridge: ${err.message})`;
              }
            }
          }
          results.push(entry);
          onProgress?.({ current: null, results: results.slice(), total: flows.length });
        }
        const run = await this.bridge.postQaRun({ flows: results, duration_ms: Date.now() - started });
        run.incident_values = incidents;
        return run;
      } finally {
        this.detector.onSuppressedFailure = null;
        this.detector.suppressed = false;
        this.running = false;
        if (location.pathname !== returnTo) {
          history.pushState({}, "", returnTo);
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
        }
      }
    }
  };

  // src/shadowqa/replay.js
  var safeQuery = (selector) => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };
  function setNativeValue(el, value) {
    if (el.type === "checkbox") {
      const want = value === true || value === "true";
      if (el.checked !== want) el.click();
      return;
    }
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    el.focus();
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  var ReplayEngine = class {
    constructor({ buffer, ctx }) {
      this.buffer = buffer;
      this.ctx = ctx;
    }
    async waitFor(fn, timeout = 5e3, interval = 80) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const v = fn();
        if (v) return v;
        await sleep(interval);
      }
      return null;
    }
    async settle() {
      await sleep(180);
      await this.waitFor(() => this.ctx.inflight === 0, 6e3);
      await sleep(150);
    }
    async find(step) {
      const el = await this.waitFor(() => {
        let e = step.selector ? safeQuery(step.selector) : null;
        const fb = step.fallback || {};
        if (!e && fb.testid) e = safeQuery(`[data-testid="${fb.testid}"]`);
        if (!e && fb.name) e = safeQuery(`[name="${fb.name}"]`);
        if (!e && fb.text) e = [...document.querySelectorAll('button, a, [role="button"]')].find((b) => b.innerText.trim() === fb.text);
        return e && !e.disabled ? e : null;
      }, 6e3);
      if (!el) throw new Error(`element not found: ${step.selector || step.fallback?.testid || step.fallback?.text}`);
      return el;
    }
    async goto(route, loose = false) {
      const before = location.pathname;
      if (before !== route) {
        history.pushState({}, "", route);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      }
      await this.waitFor(() => location.pathname === route || loose && location.pathname !== before, 3e3);
      await sleep(120);
    }
    async execute(step, values) {
      switch (step.action) {
        case "navigate": {
          if (location.pathname === step.route) {
            const away = step.from && step.from !== step.route ? step.from : step.route === "/" ? "/__shadowqa_remount" : "/";
            await this.goto(away, true);
            await this.settle();
          }
          await this.goto(step.route);
          return;
        }
        case "fill": {
          const el = await this.find(step);
          const value = step.value !== void 0 ? step.value : values[step.event_id];
          if (value === void 0) throw new Error("no recorded value for this field");
          setNativeValue(el, value);
          return;
        }
        case "click": {
          const el = await this.find(step);
          el.scrollIntoView?.({ block: "center" });
          el.click();
          return;
        }
        case "submit": {
          const el = await this.find(step);
          if (el.requestSubmit) el.requestSubmit();
          else el.submit();
          return;
        }
        default:
          throw new Error(`unknown action ${step.action}`);
      }
    }
    async run(plan, { values = {}, onStep } = {}) {
      const started = Date.now();
      const observed = { network: [], errors: [] };
      const unsub = this.buffer.subscribe((item) => {
        if (item.kind === "network") observed.network.push(item);
        if (item.kind === "error") observed.errors.push(item);
      });
      const steps = (plan.steps || []).map((s) => ({ ...s, status: "pending" }));
      const report = () => onStep?.(steps.map((s) => ({ id: s.id, label: s.label, action: s.action, status: s.status, detail: s.detail })));
      try {
        report();
        for (const step of steps) {
          step.status = "running";
          report();
          try {
            await this.execute(step, values);
            await this.settle();
            step.status = "passed";
          } catch (err) {
            step.status = "failed";
            step.detail = err.message;
            report();
            break;
          }
          report();
        }
        const exp = plan.expectations || {};
        const evidence = [];
        const stepsPassed = steps.every((s) => s.status === "passed");
        if (exp.request?.path) {
          const match = await this.waitFor(() => observed.network.find((n) => n.method === exp.request.method && n.path === exp.request.path && n.end_ts), 1e4);
          const min = exp.request.status_min ?? 200;
          const max = exp.request.status_max ?? 399;
          evidence.push({ label: `${exp.request.method} ${exp.request.path}`, ok: Boolean(match), detail: match ? `${match.duration_ms} ms` : "request not observed" });
          evidence.push({ label: match ? `Response ${match.status}` : "Response", ok: Boolean(match) && match.status >= min && match.status <= max, detail: match ? match.ok ? "success" : match.response_snippet?.slice(0, 120) || "error" : "\u2014" });
        }
        if (exp.ui?.selector || exp.ui?.text) {
          const found = await this.waitFor(() => exp.ui.selector && safeQuery(exp.ui.selector) || exp.ui.text && document.body.innerText.includes(exp.ui.text), 6e3);
          evidence.push({ label: "UI reached expected state", ok: Boolean(found), detail: exp.ui.selector || exp.ui.text });
        }
        await sleep(350);
        const first = observed.errors[0];
        evidence.push({ label: "No runtime errors", ok: observed.errors.length === 0, detail: first ? `${first.type}: ${first.message}`.slice(0, 140) : "clean" });
        const status = stepsPassed && evidence.every((e) => e.ok) ? "passed" : "failed";
        return {
          status,
          steps: steps.map(({ id, label, action, status: s, detail }) => ({ id, label, action, status: s, detail })),
          evidence,
          errors: observed.errors.map((e) => ({ type: e.type, message: e.message })).slice(0, 5),
          network: observed.network.map((n) => ({ method: n.method, path: n.path, status: n.status, duration_ms: n.duration_ms })).slice(0, 20),
          duration_ms: Date.now() - started
        };
      } finally {
        unsub();
      }
    }
  };

  // src/shadowqa/session.js
  var KEY = "shadowqa:session";
  var session = {
    load() {
      try {
        return JSON.parse(sessionStorage.getItem(KEY)) || null;
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        sessionStorage.setItem(KEY, JSON.stringify(state));
      } catch {
      }
    },
    patch(fields) {
      this.save({ ...this.load() || {}, ...fields });
    },
    clear() {
      try {
        sessionStorage.removeItem(KEY);
      } catch {
      }
    }
  };

  // src/shadowqa/core.js
  var TERMINAL = /* @__PURE__ */ new Set(["verified", "committed", "dismissed", "rolled_back", "validation_failed", "replay_failed", "no_safe_fix", "diagnosis_failed", "superseded"]);
  var RESTING = /* @__PURE__ */ new Set(["verified", "committed"]);
  var ShadowQA = class {
    constructor(config) {
      this.config = { appName: document.title || "application", ...config };
      this.buffer = new RingBuffer(140);
      this.ctx = { lastInteractionId: null, lastTrigger: null, replayValues: {}, inflight: 0 };
      this.bridge = new Bridge(this.config);
      this.overlay = new Overlay({ actions: this.actions() });
      this.replay = new ReplayEngine({ buffer: this.buffer, ctx: this.ctx });
      this.detector = new Detector({ onIncident: (f) => this.onIncident(f) });
      this.memory = new MemoryObserver(this.bridge);
      this.qa = new QARunner({ bridge: this.bridge, replay: this.replay, detector: this.detector, buffer: this.buffer, ctx: this.ctx, config: this.config });
      this.incident = null;
      this.pollTimer = null;
      this.replayValues = {};
    }
    start() {
      const bridgePrefix = this.config.bridgeUrl.replace(/\/api\/shadowqa\/?$/, "/api/shadowqa");
      this.ctx.onNetwork = (item) => {
        this.detector.handleNetwork(item);
        this.memory.noteNetwork(item);
      };
      this.ctx.onRoute = (path) => this.memory.noteRoute(path);
      this.ctx.onInteraction = (item) => this.memory.noteInteraction(item);
      observeNetwork(this.buffer, this.ctx, { ignorePrefixes: [bridgePrefix] });
      observeInteractions(this.buffer, this.ctx);
      observeRuntime(this.buffer, this.ctx, (failure) => this.detector.handleFailure(failure));
      this.overlay.mount();
      this.memory.start();
      this.bridge.health().then((h) => this.health = h).catch(() => this.health = null);
      window.__shadowqa = this;
      this.restoreSession();
    }
    // ---- incident lifecycle -------------------------------------------------
    async onIncident(failure) {
      this.detector.active = true;
      this.overlay.set({ view: "capturing", incident: null, replaySteps: null });
      const payload = buildPayload({ failure, buffer: this.buffer, ctx: this.ctx, config: this.config });
      const values = pickReplayValues(payload.events, this.ctx.replayValues);
      try {
        const inc = await this.bridge.createIncident(payload);
        this.replayValues = values;
        session.save({ incidentId: inc.id, phase: "active", replayValues: values });
        this.setIncident(inc);
        this.startPolling();
      } catch (err) {
        this.detector.active = false;
        this.overlay.set({ view: "bridge_error", error: err.message });
      }
    }
    setIncident(inc) {
      this.incident = inc;
      if (inc && this.health) inc.pr_enabled = Boolean(this.health.git?.pr_enabled);
      this.overlay.setIncident(inc);
    }
    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(() => this.refresh().catch(() => {
      }), 850);
    }
    stopPolling() {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    async refresh() {
      if (!this.incident) return;
      const inc = await this.bridge.getIncident(this.incident.id);
      this.setIncident(inc);
      if (inc.status === "awaiting_replay") {
        this.stopPolling();
        await this.reloadForReplay();
      } else if (TERMINAL.has(inc.status)) {
        this.stopPolling();
        this.detector.reset();
      }
    }
    async reloadForReplay() {
      session.patch({ phase: "reload_for_replay", reloadAt: Date.now() });
      this.memory.stop();
      await this.memory.flush();
      await sleep(2200);
      location.reload();
    }
    async restoreSession() {
      const s = session.load();
      if (!s?.incidentId) return;
      try {
        const midReplayPhase = s.phase === "reload_for_replay" || s.phase === "replaying";
        if (midReplayPhase) await this.waitForBridge();
        const inc = await this.bridge.getIncident(s.incidentId);
        this.replayValues = s.replayValues || {};
        const midReplay = midReplayPhase && (inc.status === "awaiting_replay" || inc.status === "replaying");
        if (midReplay) {
          const attempts = (s.replayAttempts || 0) + 1;
          session.patch({ replayAttempts: attempts });
          if (attempts > 2) {
            const updated = await this.bridge.postReplayResult(inc.id, { status: "failed", steps: [], evidence: [{ label: "Replay engine", ok: false, detail: "replay interrupted by repeated page reloads" }], duration_ms: 0 }).catch(() => null);
            session.patch({ phase: "done" });
            if (updated) this.setIncident(updated);
            return;
          }
          await this.runReplay(inc);
          return;
        }
        if (!TERMINAL.has(inc.status)) {
          this.detector.active = true;
          this.setIncident(inc);
          this.startPolling();
        } else if (RESTING.has(inc.status) && Date.now() - new Date(inc.updated_at).getTime() < 18e4) {
          this.setIncident(inc);
        } else {
          session.clear();
        }
      } catch {
        session.clear();
      }
    }
    async runReplay(inc) {
      this.detector.active = true;
      this.detector.suppressed = true;
      session.patch({ phase: "replaying" });
      this.incident = { ...inc, status: "replaying" };
      this.overlay.setIncident(this.incident);
      try {
        await this.bridge.replayStarted(inc.id);
        await this.waitForApp();
        const result = await this.replay.run(inc.replay_plan, { values: this.replayValues, onStep: (steps) => this.overlay.setReplayProgress(steps) });
        const updated = await this.bridge.postReplayResult(inc.id, result);
        session.patch({ phase: "done" });
        this.setIncident(updated);
      } catch (err) {
        const updated = await this.bridge.postReplayResult(inc.id, { status: "failed", steps: [], evidence: [{ label: "Replay engine", ok: false, detail: err.message }], duration_ms: 0 }).catch(() => null);
        if (updated) this.setIncident(updated);
      } finally {
        this.detector.suppressed = false;
        this.detector.reset();
      }
    }
    async waitForApp() {
      const started = Date.now();
      while (Date.now() - started < 8e3) {
        const root = document.getElementById("root");
        if (root && root.children.length && this.ctx.inflight === 0) break;
        await sleep(100);
      }
      await sleep(400);
    }
    async waitForBridge(timeout = 2e4) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await this.bridge.health().then(() => true).catch(() => false)) return true;
        await sleep(500);
      }
      return false;
    }
    // ---- developer actions --------------------------------------------------
    actions() {
      return {
        apply: async () => {
          if (!this.incident) return;
          try {
            await this.bridge.apply(this.incident.id);
            this.overlay.set({ view: null });
            this.startPolling();
          } catch (err) {
            this.overlay.set({ view: "bridge_error", error: err.message });
          }
        },
        dismiss: async () => {
          const inc = this.incident;
          this.stopPolling();
          this.detector.reset();
          this.incident = null;
          session.clear();
          this.overlay.set({ view: null, incident: null, replaySteps: null, qa: null, qaRun: null });
          if (inc && !TERMINAL.has(inc.status)) await this.bridge.dismiss(inc.id).catch(() => {
          });
        },
        resetDemo: async () => {
          try {
            await this.bridge.resetDemo();
            session.clear();
            this.overlay.set({ view: "toast", toast: "Demo reset \u2014 bugs restored, ShadowQA memory cleared. Reloading\u2026" });
            await sleep(900);
            location.reload();
          } catch (err) {
            this.overlay.set({ view: "bridge_error", error: err.message });
          }
        },
        rollback: async () => {
          if (!this.incident) return;
          this.stopPolling();
          const inc = await this.bridge.rollback(this.incident.id).catch(() => null);
          this.detector.reset();
          if (inc) this.setIncident(inc);
        },
        createPr: async () => {
          if (!this.incident) return;
          try {
            await this.bridge.createPr(this.incident.id);
            this.setIncident(await this.bridge.getIncident(this.incident.id));
          } catch (err) {
            this.overlay.set({ view: "bridge_error", error: err.message });
          }
        },
        retry: async () => {
          if (!this.incident) return;
          await this.bridge.rediagnose(this.incident.id).catch(() => {
          });
          this.detector.active = true;
          this.startPolling();
        },
        runQA: () => this.runQA(),
        investigate: async (id) => {
          const inc = await this.bridge.getIncident(id);
          const fromQa = (this.lastQaRun?.incident_values || []).find((v) => v.id === id);
          this.replayValues = fromQa?.values || {};
          session.save({ incidentId: id, phase: "active", replayValues: this.replayValues });
          this.detector.active = !TERMINAL.has(inc.status);
          this.overlay.set({ view: null, qa: null, inspector: false });
          this.setIncident(inc);
          if (!TERMINAL.has(inc.status)) this.startPolling();
        },
        selectIncident: async (id) => {
          const inc = await this.bridge.getIncident(id).catch(() => null);
          if (inc) this.overlay.set({ incident: inc, sourceFile: null });
          this.loadSource(inc);
        },
        inspectorOpened: (tab) => this.loadInspectorData(tab)
      };
    }
    async loadInspectorData(tab) {
      const o = this.overlay;
      const inc = o.state.incident;
      try {
        const recent = await this.bridge.listIncidents();
        o.set({ recent });
        if (tab === "health") o.set({ flows: (await this.bridge.getFlows()).flows, qaRun: await this.bridge.latestQaRun(), scenarios: (await this.bridge.getScenarios()).scenarios });
        if (tab === "memory") o.set({ memory: await this.bridge.getMemory() });
        if (tab === "agent") o.set({ telemetry: await this.bridge.getTelemetry(), audit: await this.bridge.getAudit() });
        if (tab === "source") await this.loadSource(inc);
      } catch {
      }
    }
    async loadSource(inc) {
      const loc = inc?.source_location;
      if (!loc?.resolved) return;
      const file = await this.bridge.readFile(loc.file, loc.line).catch(() => null);
      if (file) this.overlay.set({ sourceFile: file });
    }
    async runQA() {
      if (this.qa.running) return;
      this.overlay.set({ view: "qa", inspector: false, qa: { results: [], current: null } });
      try {
        const run = await this.qa.run({ onProgress: (p) => this.overlay.set({ view: "qa", qa: p }) });
        this.lastQaRun = run;
        this.overlay.set({ view: "qa_summary", qaRun: run });
      } catch (err) {
        this.overlay.set({ view: "bridge_error", error: `QA run failed: ${err.message}` });
      }
    }
  };

  // src/shadowqa/index.js
  var instance = null;
  function initShadowQA(config) {
    if (instance || typeof window === "undefined") return instance;
    try {
      instance = new ShadowQA(config);
      instance.start();
    } catch (err) {
      console.warn("[shadowqa] failed to start:", err);
    }
    return instance;
  }

  // src/shadowqa/standalone.js
  var script = document.currentScript;
  var cfg = window.__SHADOWQA_CONFIG__ || {
    bridgeUrl: script?.dataset.bridgeUrl,
    token: script?.dataset.token,
    appName: script?.dataset.appName || document.title
  };
  if (cfg.bridgeUrl) initShadowQA(cfg);
  else console.warn("[shadowqa] standalone: bridgeUrl missing");
})();
