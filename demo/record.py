"""Records the ShadowQA demo video (Playwright screencast) in sync with the narration, then muxes narration → MP4."""
import asyncio
import json
import os
import subprocess
import time
from pathlib import Path

import imageio_ffmpeg
from playwright.async_api import async_playwright

BASE = "https://context-bridge-18.preview.emergentagent.com"
TOKEN = "sqa_bridge_7f3c9a1e4b2d"
OUT = Path("/app/demo/out")
OUT.mkdir(parents=True, exist_ok=True)
TEMPO = float(os.environ.get("DEMO_TEMPO", "1.28"))
MANIFEST = {m["scene"]: m for m in json.loads(Path("/app/demo/audio/manifest.json").read_text())}
W, H = 1600, 900

CURSOR_JS = """
(() => { if (window.__demoCursor) return; window.__demoCursor = true;
const c = document.createElement('div'); c.id='__cur';
c.style.cssText='position:fixed;z-index:2147483647;width:18px;height:18px;border-radius:50%;background:rgba(55,182,211,.85);box-shadow:0 0 0 3px rgba(55,182,211,.35),0 2px 10px rgba(0,0,0,.5);pointer-events:none;transform:translate(-50%,-50%);left:-40px;top:-40px;transition:transform .12s';
document.documentElement.appendChild(c);
window.addEventListener('mousemove', e => { c.style.left=e.clientX+'px'; c.style.top=e.clientY+'px'; }, true);
window.addEventListener('mousedown', () => { c.style.transform='translate(-50%,-50%) scale(.6)'; }, true);
window.addEventListener('mouseup', () => { c.style.transform='translate(-50%,-50%) scale(1)'; }, true);
})();"""

SLIDE = """<html><body style="margin:0;background:#0b0c0f;color:#eef2f6;font-family:Inter,ui-sans-serif,system-ui;display:flex;align-items:center;justify-content:center;height:100vh;
background-image:linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:32px 32px">
<div style="max-width:1100px;padding:40px">
<div style="font:600 11px ui-monospace,monospace;letter-spacing:.2em;color:#37b6d3;text-transform:uppercase;margin-bottom:22px">{eyebrow}</div>
<h1 style="font-size:72px;line-height:1.02;letter-spacing:-.03em;margin:0 0 26px;font-weight:600">{title}</h1>
<p style="font-size:22px;line-height:1.5;color:#98a3b3;margin:0;max-width:900px">{sub}</p>
<div style="margin-top:40px;display:flex;gap:10px;font:500 13px ui-monospace,monospace;color:#667081">{chips}</div>
</div></body></html>"""


def chips(*xs):
    return "".join(f'<span style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:6px 12px">{x}</span>' for x in xs)


class Demo:
    def __init__(self, page):
        self.page = page
        self.t0 = time.time()
        self.scenes: list[dict] = []
        self.cur = None

    def start(self, name):
        self.cur = {"scene": name, "start": time.time() - self.t0, "min": MANIFEST[name]["seconds"] / TEMPO + 0.9}
        self.scenes.append(self.cur)
        print(f"▶ {name} @ {self.cur['start']:.1f}s (needs {self.cur['min']:.1f}s)")

    async def settle(self):
        """Hold the scene until its narration has finished."""
        remaining = self.cur["start"] + self.cur["min"] - (time.time() - self.t0)
        if remaining > 0:
            await self.page.wait_for_timeout(int(remaining * 1000))

    async def move(self, selector, dwell=350):
        el = self.page.locator(selector).first
        await el.scroll_into_view_if_needed()
        box = await el.bounding_box()
        if not box:
            return None
        await self.page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=22)
        await self.page.wait_for_timeout(dwell)
        return box

    async def click(self, selector, dwell=350):
        if await self.move(selector, dwell) is not None:
            await self.page.mouse.down()
            await self.page.wait_for_timeout(90)
            await self.page.mouse.up()
        await self.page.wait_for_timeout(300)

    async def type_into(self, selector, text, delay=26):
        await self.click(selector, 200)
        await self.page.keyboard.type(text, delay=delay)

    async def scroll_to(self, selector, offset=-90):
        await self.page.evaluate("([s,o]) => { const el=document.querySelector(s); if(el){ window.scrollTo({top: el.getBoundingClientRect().top + window.scrollY + o, behavior:'smooth'}); } }", [selector, offset])
        await self.page.wait_for_timeout(900)

    async def slide(self, eyebrow, title, sub, *cs):
        await self.page.set_content(SLIDE.format(eyebrow=eyebrow, title=title, sub=sub, chips=chips(*cs)))

    async def wait_js(self, expr, timeout_s, every=0.8):
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                v = await self.page.evaluate(expr)
                if v:
                    return v
            except Exception:
                pass
            await asyncio.sleep(every)
        return None


CONVO = ("User: On the Lumen store cart page customers keep asking how to get back to the catalog after adding items. "
         "We decided to add a 'Continue shopping' link under the summary card that goes to /products.\n\n"
         "Assistant: Should it be a button or a text link?\n\n"
         "User: A quiet text link, same muted style as the free-shipping hint. Requirement: it must not change checkout behaviour and must be keyboard accessible. "
         "We also agreed the free shipping threshold stays at $300 — do not change pricing logic.\n\n"
         "Assistant: Understood — link to /products under the summary, muted style, no pricing changes.")


async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": W, "height": H}, record_video_dir=str(OUT), record_video_size={"width": W, "height": H},
                                        device_scale_factor=1, color_scheme="dark")
        await ctx.add_init_script(CURSOR_JS)
        page = await ctx.new_page()
        d = Demo(page)

        # S0 — intro
        d.start("s0_intro")
        await d.slide("ShadowQA · agents where the work already happens", "From conversation<br><span style='color:#98a3b3;font-weight:300;font-style:italic'>to verified code.</span>",
                      "Slack + GitHub + AI chats → source-linked knowledge → plans → an agent that builds, validates, watches the running app, fixes what breaks and replays the failure to prove it.",
                      "understand", "plan", "build", "observe", "fix", "verify")
        await d.settle()

        # S1 — runtime command center
        d.start("s1_runtime")
        await page.goto(f"{BASE}/shadowqa", wait_until="networkidle")
        await page.wait_for_timeout(2500)
        await d.scroll_to('[data-testid="cc-loop"]', -60)
        await page.wait_for_timeout(2500)
        await d.scroll_to('[data-testid="cc-incidents"]', -80)
        await d.settle()

        # S2 — development context: sources + import
        d.start("s2_context")
        await page.evaluate("window.scrollTo({top:0,behavior:'smooth'})")
        await page.wait_for_timeout(700)
        await d.click('[data-testid="cc-view-context"]')
        await page.wait_for_timeout(1800)
        await d.scroll_to('[data-testid="cc-sources"]', -70)
        await d.move('[data-testid="cc-connector-slack"]', 900)
        await d.move('[data-testid="cc-connector-github"]', 900)
        await d.click('[data-testid="cc-import-btn"]')
        await page.wait_for_timeout(600)
        await d.type_into('[data-testid="cc-import-title"]', "Cart UX — continue shopping", delay=28)
        await d.click('[data-testid="cc-import-text"]', 150)
        await page.keyboard.type(CONVO[:140], delay=8)
        await page.fill('[data-testid="cc-import-text"]', CONVO)
        await d.settle()
        await d.click('[data-testid="cc-import-submit"]')

        # S3 — knowledge extracted + confirm
        d.start("s3_knowledge")
        await page.wait_for_selector('[data-testid="cc-import-dialog"]', state="detached", timeout=60000)
        await page.wait_for_timeout(1200)
        await d.scroll_to('[data-testid="cc-knowledge"]', -70)
        for _ in range(3):
            btn = page.locator('[data-testid^="cc-confirm-"]').first
            if await btn.count() == 0:
                break
            tid = await btn.get_attribute("data-testid")
            await d.click(f'[data-testid="{tid}"]', 500)
            await page.wait_for_timeout(600)
        await d.settle()

        # S4 — compile plan
        d.start("s4_plan")
        await d.scroll_to('[data-testid="cc-plans"]', -70)
        await d.type_into('[data-testid="cc-plan-objective"]', "Add a Continue shopping link under the cart summary that returns to the product catalog", delay=22)
        await d.click('[data-testid="cc-compile-plan-btn"]')
        await d.wait_js("() => document.querySelector('[data-testid=\"cc-plan-detail-status\"]') && !/Select a plan|Loading/.test(document.querySelector('[data-testid=\"cc-plan-detail\"]').textContent)", 60)
        await page.wait_for_timeout(800)
        await d.scroll_to('[data-testid="cc-plan-detail"]', -70)
        await d.move('[data-testid="cc-plan-tasks"]', 600)
        await d.settle()

        # S5 — build result
        d.start("s5_build")
        await d.wait_js("() => /done|verified|failed/.test((document.querySelector('[data-testid=\"cc-plan-detail-status\"]')||{}).textContent||'')", 90)
        await page.wait_for_timeout(600)
        await d.click('[data-testid="cc-task-t1"] button', 300)
        await page.wait_for_timeout(900)
        await d.scroll_to('[data-testid="cc-task-t1"]', -110)
        await page.wait_for_timeout(2500)
        await d.scroll_to('[data-testid="cc-plan-actions"]', -420)
        await d.move('[data-testid="cc-plan-brief-btn"]', 800)
        await d.settle()

        # S6 — runtime failure inside the store
        d.start("s6_runtime_fix")
        await page.goto(f"{BASE}/login", wait_until="networkidle")
        await page.fill('[data-testid="login-email"]', "demo@lumen.supply")
        await page.fill('[data-testid="login-password"]', "lumen-demo")
        await d.click('[data-testid="login-form"] button[type="submit"]')
        await page.wait_for_selector('[data-testid="nav-help"]', timeout=20000)
        await page.wait_for_timeout(1500)
        await d.click('[data-testid="nav-help"]')
        await d.wait_js("() => { const i = window.__shadowqa && window.__shadowqa.incident; return i && (i.status==='verified' || /failed|no_safe_fix/.test(i.status)); }", 100, every=1.0)
        await page.wait_for_timeout(1500)
        await d.settle()

        # S7 — verified + project graph
        d.start("s7_verified")
        await page.wait_for_timeout(2500)
        await page.goto(f"{BASE}/shadowqa?view=graph", wait_until="networkidle")
        await page.wait_for_timeout(2000)
        await d.scroll_to('[data-testid="cc-graph"]', -70)
        await page.wait_for_timeout(1500)
        await page.evaluate("() => { const el=document.querySelector('[data-testid=\"cc-graph\"] .overflow-x-auto'); if(el) el.scrollTo({left: 400, behavior:'smooth'}); }")
        await d.settle()

        # S8 — outro
        d.start("s8_outro")
        await d.slide("ShadowQA", "From conversation to code.<br><span style='color:#98a3b3;font-weight:300'>From code to runtime.</span><br><span style='color:#37b6d3'>From runtime to verified results.</span>",
                      "Slack · GitHub · ChatGPT / Claude · Gemini planning · Claude / GPT / Kimi execution · in-app observer · failure replay · Command Center approvals",
                      "Business: Slack + GitHub + runtime", "Individual: ChatGPT + Claude + Codex sessions")
        await d.settle()
        await page.wait_for_timeout(800)

        video_path = await page.video.path()
        await ctx.close()
        await browser.close()
    (OUT / "scenes.json").write_text(json.dumps(d.scenes, indent=1))
    return Path(video_path), d.scenes


def mux(video: Path, scenes: list[dict]) -> Path:
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    inputs, filters, labels = ["-i", str(video)], [], []
    for i, s in enumerate(scenes):
        inputs += ["-i", MANIFEST[s["scene"]]["file"]]
        delay = int(s["start"] * 1000)
        filters.append(f"[{i + 1}:a]atempo={TEMPO},adelay={delay}|{delay}[a{i}]")
        labels.append(f"[a{i}]")
    filters.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0,alimiter=limit=0.95[aout]")
    out = Path("/app/frontend/public/shadowqa-demo.mp4")
    cmd = [ff, "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
           "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True, capture_output=True)
    return out


if __name__ == "__main__":
    video, scenes = asyncio.run(run())
    print("video", video, "duration ≈", round(scenes[-1]["start"] + scenes[-1]["min"] + 1, 1), "s")
    out = mux(video, scenes)
    print("MP4", out, out.stat().st_size // 1024, "KB")
