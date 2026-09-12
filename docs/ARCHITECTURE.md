# ShadowQA — Architecture

## 1. System overview

```
┌──────────────────────────── Browser (developer's app) ────────────────────────────┐
│  Lumen Supply Co. (React)                                                           │
│  ┌──────────────── ShadowQA Runtime SDK (frontend/src/shadowqa) ────────────────┐  │
│  │ observe/interaction  observe/network  observe/runtime   → RingBuffer(140)     │  │
│  │ detector (debounce, rate-limit, suppression) → capture (bounded window)       │  │
│  │ replay engine · QA runner · memory heartbeat · Zero-UI overlay (Shadow DOM)   │  │
│  └───────────────────────────────┬───────────────────────────────────────────────┘  │
└──────────────────────────────────┼─────────────────────────────────────────────────┘
                                   │ HTTPS + X-ShadowQA-Token
┌──────────────────────────────────▼──────────── Local Workspace Bridge (FastAPI) ────┐
│ api.py            token-gated REST surface                                          │
│ pipeline.py       ingest → correlate → diagnose → apply → validate → replay-result   │
│ server_sdk.py     ASGI server observer: unhandled exception → handler file:line     │
│ sourcemap.py      bundle.js:line:col → src/file.jsx:line (VLQ decoder, cached)      │
│ correlation.py    causal timeline · context graph · replay plan · fingerprint       │
│ retrieval.py      targeted source retrieval (frames, route handler, component…)     │
│ orchestrator.py   structured agent loop (understand/diagnose/retrieve/plan/generate)│
│ llm.py            provider fallback (Claude → GPT → Kimi), strict JSON extraction    │
│ patching.py       exact search/replace hunks → unified diff, limits, dry-run        │
│ risk.py           explainable LOW/MEDIUM/HIGH + autonomy eligibility               │
│ validation.py     allow-listed argv: Babel parse · ESLint · Jest related · pyflakes │
│ git_ops.py        plumbing-built fix branches, optional push + GitHub PR            │
│ memory.py         routes · APIs · components · known failures · fixes · flows       │
│ qa.py             declared + learned flows, run history                             │
│ workspace.py      authorized roots, denied paths, traversal protection              │
│ security.py       redaction, sanitization, <untrusted> delimiting                   │
│ db.py             MongoDB: incidents, audit, memory, qa_runs, llm_log               │
└──────────────────────────────────┬──────────────────────────────────────────────────┘
                                   ▼
                       Developer workspace (/app) · git · dev server source maps
```

## 2. Incident lifecycle (state machine)

```
captured → diagnosing → diagnosed ──(approve | auto LOW)──▶ applying → validating ─┬─▶ awaiting_replay → replaying ─┬─▶ verified → committed
                        │                                                          │                                └─▶ replay_failed (rolled back)
                        ├─▶ no_safe_fix / diagnosis_failed                          └─▶ validation_failed (rolled back)
                        └─▶ dismissed        any applied state ──(Undo)──▶ rolled_back        stale → superseded (unverified patches reverted)
```

Every transition is written to `sqa_audit`. Stage latencies are recorded in `incident.telemetry`
(`capture_to_bridge_ms`, `correlation_ms`, `ai_ms`, `patch_ms`, `validation_ms`, `replay_ms`, `total_ms`, `rollback`).

## 3. Browser observation layer

| Signal | Mechanism | Bounded by |
|---|---|---|
| Runtime | `window.error` (capture phase, ignores resource errors), `unhandledrejection`, `console.error` hook | 1.5 s de-dupe per fingerprint |
| Network | `fetch` + `XMLHttpRequest` wrappers: method, url, status, timing, sanitized JSON body, response snippet **only on failure** | last 15 requests |
| Interaction | click / input (coalesced per element) / submit / `pushState` `replaceState` `popstate` | last 40 events |
| DOM | semantic descriptor: tag, type, role, accessible name (label text, never `.value`), testid, selector, React component via fiber walk, form field map | per trigger element |
| State | optional `getState()` hook provided by the host app (cart size, auth flag) | sanitized |

Raw input values never leave the browser: the SDK sends masked values and keeps the raw ones in `localStorage` only for replay.

### 3b. Server observation layer

A 5xx seen in the browser usually carries no client stack (`http_error` incidents: the detector synthesises the failure from the network observer; the UI may even degrade gracefully). `server_sdk.ServerErrorObserver` is a pure ASGI middleware installed in the backend: every unhandled exception is recorded with its type, message, **the failing route handler resolved to `file:line` from `scope["endpoint"]`**, application frames and a traceback tail, then re-raised untouched. At ingest, `correlation.build()` joins the failed request (same method + path, ≤ 90 s) to that record: the handler becomes the incident's `source_location` (`side: "server"`), a `server_exception` node enters the context graph, a `Server → …` line enters the timeline, a `server` context signal is emitted, and the orchestrator receives a *SERVER-SIDE EXCEPTION* block — so the diagnosis lands on the producer of the 500, never on the client's error handling.

## 4. Correlation engine and context graph

`correlation.build()` orders events and network entries, picks the **trigger** (last click/submit, a submit within 400 ms of a click collapses into the click), the **related request** (a failed request between trigger and exception, else the last completed one), the **primary frame** (top-most non-vendor, non-SDK source-mapped frame), and builds:

* a **timeline** (`HH:MM:SS.mmm  Route changed → /checkout`, `User clicked → Pay $303.00`, `Network → POST /api/demo/payment`, `Network → HTTP 422`, `Runtime → TypeError…`, `Component → Checkout`, `Source → Checkout.jsx:31`),
* a **context graph** `user_action → ui_element → component → route → network_request → [server_exception] → network_response → runtime_error → source_location → file`,
* a **replay plan** (navigate → fill… → click, with the expected request and the original fingerprint),
* a stable **fingerprint** (type + digit-normalised message + source location) used for regression detection.

## 5. Source maps

The dev server's `bundle.js.map` is fetched (`SHADOWQA_DEV_SERVER_URL`), the VLQ `mappings` are decoded lazily and cached (8 s TTL, so hot reloads are honoured). Sources such as `/app/frontend/src/…`, `webpack://frontend/./src/…` and `webpack:///./node_modules/…` are normalised to workspace-relative paths; vendor frames are flagged and skipped. Missing maps degrade gracefully (`resolved: false`, bundle location shown).

## 6. Retrieval

Never the whole repository. In order: the primary frame's file, other application frames, the **backend route handler / client call site** found by grepping the failed request's path, the **React component** that rendered the trigger element, one hop of relative imports; capped at ~42 KB. The model may request up to 4 extra files (`need_files`) for a second round.

## 7. AI orchestrator

A bounded agent loop (≤ 3 rounds): the system prompt fixes the order *understand → diagnose → retrieve → plan → generate → assess → verification* and the JSON schema. Untrusted application content is wrapped in `<untrusted>` blocks. If a returned hunk does not apply verbatim, the failure reason is fed back for one repair round. Models reason before answering and fence their JSON: `extract_json` accepts prose + fenced blocks and picks the balanced object that parses; an unparseable reply gets one in-conversation repair turn with the same provider before falling back. Provider fallback: `anthropic:claude-sonnet-4-6` → `openai:gpt-5.4` (GPT-5 family receives no temperature override) → `kimi:kimi-k2.7-code-highspeed` (Moonshot's OpenAI-compatible endpoint via the `openai` SDK; thinking model, so no temperature and ≥ 16k output headroom, `reasoning_content` echoed back on the repair turn). Every call is logged (`sqa_llm_log`).

## 8. Patch, risk, validation, rollback

* **Patch**: exact `search`/`replace` hunks, unique match required (whitespace-tolerant fallback), unified diff via `difflib`, limits (3 files / 120 lines), write roots only, never ShadowQA's own code.
* **Risk**: lines, files, removals, sensitive paths (auth/db/config/API), new imports, env access, confidence < 70 %, model flags → score → LOW/MEDIUM/HIGH with human-readable factors. `autonomous_eligible = LOW ∧ confidence ≥ 0.8 ∧ safe_to_apply`.
* **Validation** (allow-listed argv, no shell): Babel parse → ESLint (flat config in `frontend/.shadowqa/`) → Jest `--findRelatedTests`; Python: `py_compile` → `pyflakes`. Progress is streamed to the overlay.
* **Checkpoint/rollback**: original file contents stored before writing; any validation or replay failure, manual Undo, or a stale unverified patch restores them.

## 9. Failure replay

After validation the SDK persists its session, flushes memory, waits for the dev server to pick up the change and reloads. On boot it detects the pending replay, waits for the app to mount, and executes the plan in the live DOM (React-compatible native value setters, real clicks, network-idle settling). Evidence: each step, the expected request and its status, the AI-provided success selector/text, absence of runtime errors. A failed replay rolls the patch back automatically. A replay interrupted by another reload is resumed once; a second interruption is reported as a failed replay (rollback) so an incident can never spin forever.

## 9b. Command Center (`/shadowqa`)

A React page served by the host app (`frontend/src/shadowqa/center/`) that reads the same bridge: incident history (rows open the inspector), the OBSERVE → VERIFY loop with per-stage latency, the "why the browser" comparison filled with the latest incident's live data, application health + QA sweep trigger, in-app context signal counts, agent telemetry & audit, application memory, demo scenario state + reset, and the autonomy policy switch. The overlay itself renders into persistent Shadow-DOM elements and patches HTML only when the structure changes (volatile counters update in place), so the 850 ms incident poll never re-mounts or re-animates the card.

## 10. Autonomous QA and memory

`shadowqa.flows.json` declares flows; every verified fix adds a **learned regression flow**. A QA sweep runs them in the real browser, files incidents (`source: qa`, queued for review rather than auto-applied) with reproducible sequences, and records application health. Memory (`sqa_memory`) accumulates routes, APIs, components, known failures (open/fixed/regressed), fixes and validation history, and is summarised into the diagnosis prompt.

## 11. Extensibility

All agents (runtime debugging, QA, regression) share the same context model, bridge, security boundaries and overlay. New agents subscribe to the `RingBuffer` and post incidents through the same pipeline.
