# ShadowQA — learnings & gotchas

- Dev server hot-reloads EVERY open tab when ShadowQA patches a file. Concurrent tabs/users interfere with a running replay. Test in one tab; `restoreSession` resumes an interrupted replay once, then fails+rolls back.
- Claude Sonnet 4.6 often prefixes reasoning prose and fences the JSON. Never `text.find("{")`; use `llm.extract_json` (fenced blocks → balanced objects) + repair round.
- GPT-5.x rejects `temperature` ≠ 1 via litellm → omit temperature for `openai:gpt-5*`.
- Overlay: never rebuild `root.innerHTML` on every poll — the `.card` CSS entrance animation replays and scroll resets ("card spacing out"). Use persistent elements + `patchHtml` (data-volatile spans update in place).
- `pagehide` fetch flushes show as `net::ERR_ABORTED` in Playwright/DevTools. Memory heartbeat is timer-only; flushed explicitly before `location.reload()`.
- `/api/shadowqa/demo/scenarios` compares working files to `scripts/demo_bugs/*` pristine copies — they must exist and be the BUGGY versions.
- Platform pre-completion linter needs `frontend/eslint.config.mjs` (flat config, re-exports `.shadowqa/eslint.config.mjs`). CRA uses its nested eslint 8 and ignores it.
- Always end a test session with `POST /api/shadowqa/demo/reset` (bugs restored, sqa_* collections cleared, autonomy untouched).
- Detector dedupes identical failures for 30 s; `detector.reset()` on dismiss/rollback/verdict so a retry after Undo is detected immediately.
- `http_error` incidents (5xx, no JS exception) have an empty stack → the LLM used to "fix" the client (`res.ok` guard). The server observer (`server_sdk.py`) must stay installed in `server.py`; `correlation.build` needs `server_error_for=server_sdk.match` to join the 5xx to the handler. FastAPI serialisation errors (ObjectId) have NO app frames — the handler location comes from `scope["endpoint"]`, not the traceback.
- A backend patch triggers `uvicorn --reload`; validation (py_compile+pyflakes ≈130 ms) usually finishes before the restart, otherwise `resume_interrupted` picks it up. Frontend `waitForBridge` covers the ~3-5 s restart.
- `backend/demo_store/router.py` and `scripts/demo_bugs/router.py` must stay byte-identical (scenario state = equality). Any seed/behaviour change must be applied to both.
- Demo tickets created by QA sweeps persist in `demo_tickets`; the seed is keyed on `id == LUM-T4821` so the integration test stays deterministic.
- Kimi/Moonshot keys are platform-bound: this key works on `api.moonshot.ai` only (`.cn` → Invalid Authentication). Check `GET /v1/models` before choosing a model id; the playbook's `kimi-k2.5` is not on this account. `kimi-k2.7-code-highspeed` answers in ~1 s; `kimi-k3` ~7 s.
