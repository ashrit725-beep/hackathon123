"""Narration for the ShadowQA demo video — OpenAI gpt-4o-mini-tts, one MP3 per scene, durations measured for scene timing."""
import json
import os
import sys
from pathlib import Path

from mutagen.mp3 import MP3
from openai import OpenAI

OUT = Path("/app/demo/audio")
OUT.mkdir(parents=True, exist_ok=True)

VOICE = os.environ.get("DEMO_VOICE", "ash")
INSTRUCTIONS = (
    "You are narrating a tight two-minute product demo for developers. Sound like a real person: warm, confident, energetic but unhurried, "
    "genuinely interested — not a salesperson and not a robot. Natural conversational rhythm, brief pauses at dashes and sentence ends, "
    "clear articulation, light emphasis on key words. Brisk, steady pace."
)

SCENES = [
    ("s0_intro",
     "Software gets built in a dozen places — Slack, GitHub, ChatGPT — and the truth about whether it actually works lives in the browser. "
     "ShadowQA connects all of it into one loop: understand, plan, build, observe, fix, verify."),
    ("s1_runtime",
     "This is the ShadowQA Command Center, embedded in Lumen Supply, a real e-commerce app. "
     "Every incident here was observed, diagnosed, patched — and proved, by replaying the user's exact session."),
    ("s2_context",
     "Development Context. ShadowQA is live in the team's Slack, watching the GitHub repo — issues, pull requests, reviews, CI — "
     "and a developer can track a ChatGPT or Claude conversation. Let's paste one."),
    ("s3_knowledge",
     "Gemini extracts the durable knowledge — decisions, requirements, constraints — each linked to the exact message it came from. "
     "Nothing is invented. The developer confirms what's true."),
    ("s4_plan",
     "Now, an objective. Gemini combines the confirmed requirements with a live inspection of the codebase and compiles a plan: "
     "small tasks, exact files, acceptance criteria, risk. It's low risk and the project is in auto-fix mode — so ShadowQA's own coding agent starts building."),
    ("s5_build",
     "Each task becomes a precise patch, applied and validated — Babel, ESLint, Jest. If a check fails, the workspace is restored and the agent repairs its work. "
     "The result: a diff, green checks, a git branch — or a brief you can hand straight to Claude Code."),
    ("s6_runtime_fix",
     "Then, the part no chatbot can do. In the running app, a customer opens Help — and the tickets request fails with a 500. "
     "No JavaScript error; the page degrades gracefully. But ShadowQA saw the click, the request, and — from inside the backend — the failing handler. "
     "It patches the Python, validates, restarts the bridge, and replays the same navigation to prove the list renders."),
    ("s7_verified",
     "Fix verified, end to end, in under thirty seconds — and nobody typed a prompt. "
     "The project graph shows the whole chain: decision, requirement, plan, code, runtime incident, verification. And the team hears about it in Slack."),
    ("s8_outro",
     "ShadowQA. From conversation to code. From code to runtime. From runtime to verified results."),
]


def main() -> None:
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    manifest = []
    for name, text in SCENES:
        path = OUT / f"{name}.mp3"
        if not path.exists() or "--force" in sys.argv:
            with client.audio.speech.with_streaming_response.create(model="gpt-4o-mini-tts", voice=VOICE, input=text, instructions=INSTRUCTIONS, response_format="mp3") as res:
                res.stream_to_file(path)
        dur = MP3(path).info.length
        manifest.append({"scene": name, "file": str(path), "seconds": round(dur, 2), "text": text})
        print(f"{name:16s} {dur:5.1f}s")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print("total", round(sum(m["seconds"] for m in manifest), 1), "s")


if __name__ == "__main__":
    main()
