import os
from pathlib import Path
from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


class Settings:
    def __init__(self) -> None:
        self.mongo_url = os.environ["MONGO_URL"]
        self.db_name = os.environ["DB_NAME"]
        self.bridge_token = os.environ.get("SHADOWQA_BRIDGE_TOKEN", "")
        self.workspace_config_path = Path(os.environ.get("SHADOWQA_WORKSPACE_CONFIG", "/app/shadowqa.workspace.json"))
        self.dev_server_url = os.environ.get("SHADOWQA_DEV_SERVER_URL", "http://localhost:3000").rstrip("/")
        self.primary_model = os.environ.get("SHADOWQA_PRIMARY_MODEL", "anthropic:claude-sonnet-4-6")
        self.fallback_model = os.environ.get("SHADOWQA_FALLBACK_MODEL", "openai:gpt-5.4")
        self.tertiary_model = os.environ.get("SHADOWQA_TERTIARY_MODEL", "")
        # Development-context layer (extraction + planning) runs on Gemini, like the original ShadowQA service.
        self.planning_model = os.environ.get("SHADOWQA_PLANNING_MODEL", "gemini:gemini-3.6-flash")
        self.anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
        self.openai_key = os.environ.get("OPENAI_API_KEY", "")
        self.kimi_key = os.environ.get("KIMI_API_KEY", "")
        self.kimi_base_url = os.environ.get("KIMI_BASE_URL", "https://api.moonshot.ai/v1").rstrip("/")
        self.gemini_key = os.environ.get("GEMINI_API_KEY", "")
        self.emergent_key = os.environ.get("EMERGENT_LLM_KEY", "")
        self.github_token = os.environ.get("GITHUB_TOKEN", "")
        self.github_repo = os.environ.get("GITHUB_REPO", "").strip()
        self.github_watch_repo = os.environ.get("SHADOWQA_GITHUB_WATCH_REPO", "").strip()
        self.github_poll_seconds = int(os.environ.get("GITHUB_POLL_SECONDS", "180"))
        self.slack_bot_token = os.environ.get("SLACK_BOT_TOKEN", "")
        self.slack_app_token = os.environ.get("SLACK_APP_TOKEN", "")
        self.slack_notify_channel = os.environ.get("SLACK_NOTIFY_CHANNEL", "").strip()
        self.public_url = os.environ.get("SHADOWQA_PUBLIC_URL", "").rstrip("/")
        # Project automation mode (shared vocabulary with the ShadowQA service): observe | approval | auto-fix | full-auto
        self.mode = os.environ.get("SHADOWQA_MODE", "").strip() or None
        # approve_all | auto_low  (Live autonomy; derived from the mode when one is set)
        self.autonomy = os.environ.get("SHADOWQA_AUTONOMY", "approve_all")
        if self.mode:
            self.autonomy = MODE_TO_AUTONOMY.get(self.mode, self.autonomy)
        else:
            self.mode = AUTONOMY_TO_MODE.get(self.autonomy, "approval")

    def set_mode(self, mode: str) -> None:
        self.mode = mode
        self.autonomy = MODE_TO_AUTONOMY[mode]

    def set_autonomy(self, autonomy: str) -> None:
        self.autonomy = autonomy
        self.mode = AUTONOMY_TO_MODE[autonomy]

    @property
    def observe_only(self) -> bool:
        return self.mode == "observe"

    @property
    def model_chain(self) -> list[str]:
        chain = [m for m in (self.primary_model, self.fallback_model, self.tertiary_model) if m]
        if self.planning_model and self.planning_model not in chain:
            chain.append(self.planning_model)  # Gemini is the last resort for runtime diagnosis
        return chain

    @property
    def planning_chain(self) -> list[str]:
        return [self.planning_model] + [m for m in self.model_chain if m != self.planning_model]

    @property
    def models(self) -> dict:
        return {"primary": self.primary_model, "fallback": self.fallback_model, "tertiary": self.tertiary_model or None,
                "planning": self.planning_model or None}

    def key_for(self, provider: str) -> str:
        if provider == "anthropic" and self.anthropic_key:
            return self.anthropic_key
        if provider == "openai" and self.openai_key:
            return self.openai_key
        if provider == "kimi":
            return self.kimi_key
        if provider == "gemini" and self.gemini_key:
            return self.gemini_key
        return self.emergent_key


# observe: capture, correlate, diagnose, never write · approval: propose, wait for a person
# auto-fix: apply LOW-risk changes automatically, still verify · full-auto: auto-fix + branch/PR publication
MODE_TO_AUTONOMY = {"observe": "approve_all", "approval": "approve_all", "auto-fix": "auto_low", "full-auto": "auto_low"}
AUTONOMY_TO_MODE = {"approve_all": "approval", "auto_low": "auto-fix"}
MODES = ("observe", "approval", "auto-fix", "full-auto")


settings = Settings()
