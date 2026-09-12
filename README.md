# ShadowQA

**An ambient debugging & QA agent that lives inside the web application developers are already using.**

> You break it. ShadowQA understands it. ShadowQA fixes it. ShadowQA proves it. You keep working.

ShadowQA is not a chatbot. It observes a running application from inside the browser, correlates *user intent → UI element → network → runtime error → source location*, retrieves only the relevant code from the developer's workspace, generates a minimal diff with a real LLM, validates it with the project's own tooling, hot-reloads the app, **replays the original interaction**, and reports evidence of recovery — or rolls back.

```
OBSERVE → UNDERSTAND → DIAGNOSE → PLAN → ACT → VALIDATE → REPLAY → VERIFY
```

Everything on the critical path is real: real browser instrumentation, real source-map resolution, real file access, real Claude/GPT diagnosis, real patching with checkpoints, real ESLint/Babel/Jest validation, real replay in the live app, real git branches.

---

## Repository layout

```
frontend/src/shadowqa/      Runtime SDK (vanilla JS, Shadow-DOM overlay) — observation, correlation hints,
                            detector, capture, replay engine, QA runner, memory heartbeat, Zero-UI overlay
frontend/src/demo/          Lumen Supply Co. — the demonstration storefront (four realistic bugs incl. one backend bug; pristine copies in scripts/demo_bugs/)
frontend/src/shadowqa/center/  ShadowQA Command Center (/shadowqa): incident history, health, memory, agent telemetry, autonomy policy
backend/shadowqa/           Workspace bridge, source maps, correlation engine, context graph, retrieval,
                            AI orchestrator, patch engine, risk engine, validation engine, git, memory, QA, audit
backend/demo_store/         Demo storefront API (auth, catalog, dashboard, orders, payment, settings)
extension/                  Chrome MV3 extension that injects the same SDK into any localhost app
shadowqa.workspace.json     Explicit workspace authorization (read/write roots, denied paths, limits)
shadowqa.flows.json         Declared QA flows (smoke tests ShadowQA can run in the real browser)
docs/                       Architecture, security/threat model, demo script
scripts/reset_demo.sh       Restore the intentional bugs and clear ShadowQA memory
```

## Quick start

1. `backend/.env` — set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and optionally `KIMI_API_KEY` (+ `KIMI_BASE_URL`, default `https://api.moonshot.ai/v1`). Provider chain: primary `anthropic:claude-sonnet-4-6` → fallback `openai:gpt-5.4` → last resort `kimi:kimi-k2.7-code-highspeed` (`SHADOWQA_PRIMARY_MODEL` / `SHADOWQA_FALLBACK_MODEL` / `SHADOWQA_TERTIARY_MODEL`), a `SHADOWQA_BRIDGE_TOKEN`, optionally `GITHUB_REPO=owner/repo` + `GITHUB_TOKEN` for real pull requests.
2. `frontend/.env` — `REACT_APP_SHADOWQA_TOKEN` must equal the bridge token.
3. Start backend (`uvicorn server:app --port 8001`) and frontend (`yarn start`). Open the app, sign in with `demo@lumen.supply / lumen-demo`.
4. Break something (see `docs/DEMO.md`). ShadowQA takes it from there.

See `docs/DEMO.md` for the exact demonstration script, `docs/ARCHITECTURE.md` for data flow and component design, and `docs/SECURITY.md` for the threat model.

## Why isn't this just Claude Code, Cursor or Copilot?

ShadowQA does not compete with coding agents on *who writes code better*. It differs in **where it gets context** and **when it acts**.

| | Claude Code · Cursor · Copilot | ShadowQA |
|---|---|---|
| Model | **Developer tells the AI about a task → AI works on the codebase** | **Application experiences something → ShadowQA observes it → understands the context → acts on the codebase → verifies the result** |
| Trigger | You, after you noticed the bug and described it | The failure itself, the moment it happens in the browser |
| Context | Whatever you paste into the prompt | The failing click, the field values (redacted), the route, the React component, the request/response, the source-mapped frame, the relevant workspace files and the app's memory of prior failures |
| Verification | You reload and click around by hand | It replays your exact gesture in the live app and reports evidence — or rolls back |

That is a fundamentally different starting point: no prompt is ever written. Open `/shadowqa` (the Command Center) to see this comparison filled in with the live data of the latest incident.

## Why the environment matters

A standalone chatbot receives an error message. ShadowQA receives **the failing click, the field values (redacted), the route, the React component, the request/response that preceded the exception, the source-mapped frame, the relevant workspace files and the application's memory of prior failures** — and it can act on the workspace and *drive the application to prove the fix*. None of that exists outside the browser + workspace.

## Requirement coverage

| Requirement | Where | How to see it |
|---|---|---|
| Zero-UI / ambient — no chatbot, appears only when needed | `shadowqa/overlay/` (Shadow DOM dock, 22 px status dot) | Browse the store: nothing but a dim dot. Click **Pay** with the checkout bug: the card rises within ~1 s |
| Real browser instrumentation | `shadowqa/observe/{runtime,network,interaction}.js`, bounded `RingBuffer(140)` | Inspector → **Timeline** / **Network** |
| Server-side observation (5xx → failing handler) | `backend/shadowqa/server_sdk.py` (ASGI middleware, re-raises) | Help → *Your tickets*: card shows `demo_store/router.py:223`, chips **server traceback · server handler** |
| Correlation engine + context graph | `backend/shadowqa/correlation.py` | Card header chain `Click 'Pay' → POST … → HTTP 422 → TypeError`; Inspector → **Graph** |
| Source maps → exact file:line | `backend/shadowqa/sourcemap.py` (VLQ decoder) | Card shows `demo/pages/Checkout.jsx:31`; Inspector → **Source** highlights the line |
| Symptom ≠ cause diagnosis | `backend/shadowqa/orchestrator.py`, `retrieval.py` | Exception surfaces in `Checkout.jsx`, root cause pinned in `api/payments.js` |
| Minimal, validated patch | `patching.py` (exact hunks, 3 files / 120 lines max), `validation.py` (Babel · ESLint · Jest, allow-listed argv) | **View Fix** diff: 1 line; validation ticks stream live |
| Explainable risk + human control | `risk.py`, `SHADOWQA_AUTONOMY` | LOW → autonomous; MEDIUM/HIGH → **View Fix / Apply / Reject** with factors listed |
| Checkpoint & rollback | `pipeline.py` (`checkpoint`, `restore_files`) | **Undo** on any card; failed validation/replay reverts automatically |
| Failure replay & verification | `shadowqa/replay.js`, `pipeline.record_replay` | After hot reload the SDK re-drives your exact clicks; `🟢 FIX VERIFIED` with per-step evidence |
| Autonomous QA mode + learned regression flows | `shadowqa/qa.js`, `backend/shadowqa/qa.py`, `shadowqa.flows.json` | Inspector → **Health → Run QA sweep** |
| Application memory | `backend/shadowqa/memory.py` | Inspector → **Memory**; re-introduced bugs are titled *Regression* |
| Git / PR integration | `git_ops.py` (plumbing branches, GitHub PR via `GIT_ASKPASS`) | **Commit to branch** / **Create PR** on the verified card |
| Security model | `workspace.py`, `security.py`, `docs/SECURITY.md` | Bridge token, read/write roots, deny list, redaction, `<untrusted>` prompt delimiting |
| Observability & audit | `db.py` (`sqa_audit`, `sqa_llm_log`), telemetry per stage | Inspector → **Agent** |
| Graceful degradation | `views.renderBridgeError / renderUnsafe` | Stop the bridge or the LLM: the failure is still captured and explained |
| Delivery beyond one app | `extension/` (Chrome MV3), `yarn build:sdk` | Load the extension on any localhost app |
| Tests | `backend/tests/` (52 pytest), `frontend/src/**/*.test.js` (Jest) | `cd backend && pytest` · `cd frontend && yarn test --watchAll=false` |

Measured on the flagship checkout bug: detection < 1 s, diagnosis 12–20 s, validation 3–6 s, replay 4–6 s — **~30 s from broken click to verified fix**, no prompt typed. The backend tickets bug (HTTP 500, no client exception) verifies in ~28 s: server exception → `router.py:223` → 1-line projection fix → the bridge restarts itself → replay renders the list.
