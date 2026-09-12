# ShadowQA — PRD

## Original problem statement
Build ShadowQA: a production-quality autonomous debugging and QA agent embedded in the web application developers already use (Zero-UI / ambient agent). Loop: OBSERVE → UNDERSTAND → DIAGNOSE → PLAN → ACT → VALIDATE → REPLAY → VERIFY, with real browser instrumentation, correlation engine, context graph, source maps, secure local workspace bridge, structured AI orchestrator, minimal diffs, risk engine, human control, checkpoints/rollback, adaptive validation, failure replay, autonomous QA mode, application memory, observability, git/PR integration, security model, graceful failure handling, premium minimal UI, a polished demo e-commerce app with realistic bugs, docs and tests. Theme: "Agents are leaving the chatbox" — the browser/dev environment is the place.

Positioning (user-mandated, 2026-06): ShadowQA does NOT compete with Claude Code / Cursor / Copilot on "who writes code better". Their model: developer tells AI about a task → AI works on the codebase. ShadowQA: application experiences something → observes → understands context → acts on the codebase → verifies the result. Differentiation = where the context comes from and when it acts. Hackathon goal: 10/10 rubric, zero bugs, premium polish.

## User choices
- LLM: user's own keys (rotated 2026-06, all three verified live through `llm._session` + `complete_json`, full cascade tested with invalid upstream keys). Chain `SHADOWQA_PRIMARY_MODEL` `anthropic:claude-sonnet-4-6` → `SHADOWQA_FALLBACK_MODEL` `openai:gpt-5.4` → `SHADOWQA_TERTIARY_MODEL` `kimi:kimi-k2.7-code-highspeed` (`KIMI_API_KEY`, `KIMI_BASE_URL=https://api.moonshot.ai/v1`; Kimi via the `openai` SDK OpenAI-compatible endpoint, no temperature, ≥16k max_tokens, `reasoning_content` echoed on the repair turn). Kimi account offers kimi-k2.7-code(-highspeed), kimi-k2.6, kimi-k3 — NOT kimi-k2.5. Settings/health/telemetry expose `models.{primary,fallback,tertiary}`; Command Center `cc-model-chain` + inspector Agent tab show the chain. Tests: `tests/test_llm_chain.py`.
- Git: local branch + PR-ready summary for the demo (no `GITHUB_REPO`); real PR supported when configured.
- Delivery: embedded runtime SDK + Chrome MV3 extension wrapper (`extension/shadowqa.js`, rebuilt via `yarn build:sdk`).
- Autonomy: auto-apply LOW risk, approval for MEDIUM/HIGH; QA-discovered incidents always queue for review.

## Architecture
- Frontend `src/shadowqa/` vanilla-JS SDK: observers (runtime/network/interaction — JSON response shape sample captured, redacted), ring buffer, detector (resettable dedupe), capture, bridge client (keepalive observe), replay engine, QA runner, memory heartbeat (timer-only, no unload flush), Shadow-DOM Zero-UI overlay with persistent elements + change-detecting `patchHtml` (no re-animation on poll), 11-tab inspector.
- Frontend `src/shadowqa/center/` React Command Center at `/shadowqa`: CenterHeader (bridge LED, git, model, autonomy switch, Run QA sweep), hero + stats, LoopPanel (7 stages w/ latency), WhyPanel (Claude Code/Cursor/Copilot vs ShadowQA, filled with the latest incident's live data), IncidentTable (row → inspector), ScenarioPanel (3 bugs + Reset), HealthPanel, ContextPanel (signal kinds), AgentPanel (latency, LLM calls, audit), MemoryPanel (known failures, APIs, routes).
- Backend `shadowqa/`: token-gated API, pipeline state machine, source-map resolver, correlation + context graph + replay plan, targeted retrieval, orchestrator (bounded loop, robust `extract_json` for prose+fenced JSON, in-conversation repair round, provider fallback w/ gpt-5 temperature rule), patch engine, risk engine, validation engine, checkpoint/rollback, git plumbing, memory (input-tolerant), QA flows (11 declared), audit, telemetry, demo reset/scenarios from pristine copies in `scripts/demo_bugs/`.
- Demo `Lumen Supply Co.`: login, dashboard, products (wishlist toggle), product detail, cart (promo bug), checkout (contract bug), orders, order detail + tracking (legacy-shape bug), wishlist, account, help/support, settings.

## Intentional demo bugs (NEVER fix by hand; pristine copies in scripts/demo_bugs/ — keep pristine == working copy except for the bug)
1. `frontend/src/demo/api/payments.js` sends `total` (gateway requires `amount`) → 422 + TypeError in Checkout.jsx.
2. `frontend/src/demo/lib/promo.js` case-sensitive promo lookup → TypeError reading 'rate'.
3. `frontend/src/demo/api/store.js` `fetchTracking` unwraps `data.tracking` from an unwrapped v2 response → GET 200 then TypeError reading 'events' in OrderDetail.jsx (a *successful* request that breaks the UI).
4. `backend/demo_store/router.py` `list_support_tickets` returns raw Mongo docs (ObjectId) → GET /api/demo/support/tickets 500, NO client exception (Help.jsx degrades gracefully). Backend patch → uvicorn reload → `resume_interrupted` on boot.
Reset: `POST /api/shadowqa/demo/reset`, Command Center button, or `scripts/reset_demo.sh`.

## Implemented & verified (2026-06, iteration 3 — /app/test_reports/iteration_3.json)
- **Server-side observer** `backend/shadowqa/server_sdk.py`: pure ASGI middleware (installed in server.py) records unhandled exceptions with type/message/failing handler `file:line` (from `scope["endpoint"]`)/app frames/traceback tail and re-raises. `correlation.build(..., server_error_for=server_sdk.match)` joins a 5xx to it → `source_location.side="server"`, `server_exception` graph node, `Server →` timeline line, `server` context signal, SERVER-SIDE EXCEPTION block in the LLM prompt + `http_error` framing ("no client exception; fix the producer"). Before: Claude misdiagnosed the tickets 500 as a client `res.json()` guard (MEDIUM, wrong file). After: `router.py:223` 1-line `{"_id": 0}` projection, 98 %, RISK LOW, autonomous, verified in ~28 s. Undo of a backend fix verified (500 reproduces).
- Overlay chips `server traceback` / `server handler`; Command Center ContextPanel "Server exception" kind; inspector graph/timeline styling for server nodes.
- Seed ticket idempotent (`LUM-T4821` re-seeded if missing) in both router.py copies; Help.jsx `<option>` template literal (no React child warning).
- Command Center mobile: scrollWidth 390 at 390 px; incident table hides Conf./End-to-end below md.
- Backend 52/52 pytest (new `tests/test_server_sdk.py`), Jest 7/7, extension bundle rebuilt. Checkout + tracking loops re-verified (30 s / 28 s). Docs updated (README, ARCHITECTURE §3b, DEMO).

## Implemented & verified (2026-06, iteration 2 — /app/test_reports/iteration_2.json)
- Command Center built (was a missing import → whole app compile error) and verified at 1920/390.
- Tracking bug loop: verified in ~28 s, cause pinned to store.js:9 by claude-sonnet-4-6, replay renders tracking timeline.
- Checkout loop regression verified (~32 s), Undo restores bug. Claude prose+fenced JSON now parses (previously → diagnosis_failed).
- Overlay flicker ("spacing out") fixed: same `.card` DOM node persists across polls.
- Stuck "replaying" after an interrupted reload fixed (resume once, then fail+rollback).
- GPT-5.4 fallback fixed (temperature), verified live.
- QA sweep from Command Center: 13 flows, failures queued for review, Investigate → View Fix → Apply → verified.
- Backend 38/38 pytest, Jest 7/7. Docs (README, DEMO, ARCHITECTURE) updated with positioning + third bug + Command Center.

## Backlog
- P1: "before fix" reproduction replay (prove the failure reproduces prior to patching) as extra evidence.
- P1: per-tab session isolation for concurrent tabs; TypeScript typecheck validator; pytest related tests for backend patches.
- P2: `GET /api/shadowqa/server-errors` + inspector tab for the server observer; multi-incident queue UI; scheduled regression alerts; Slack/GitHub notifications; extension icons/store packaging; set `GITHUB_REPO` for real PRs.
- P2: detect mount-time 5xx on a direct page load (no prior click → detector currently requires an initiator interaction).

## Next tasks
1. Optional: provide GitHub repo → validate real PR flow.
2. Testing-agent regression pass after any SDK/overlay change (reset demo at the end).
