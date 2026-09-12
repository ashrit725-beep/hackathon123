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
        self.anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
        self.openai_key = os.environ.get("OPENAI_API_KEY", "")
        self.kimi_key = os.environ.get("KIMI_API_KEY", "")
        self.kimi_base_url = os.environ.get("KIMI_BASE_URL", "https://api.moonshot.ai/v1").rstrip("/")
        self.emergent_key = os.environ.get("EMERGENT_LLM_KEY", "")
        self.github_token = os.environ.get("GITHUB_TOKEN", "")
        self.github_repo = os.environ.get("GITHUB_REPO", "").strip()
        # approve_all | auto_low
        self.autonomy = os.environ.get("SHADOWQA_AUTONOMY", "approve_all")

    @property
    def model_chain(self) -> list[str]:
        return [m for m in (self.primary_model, self.fallback_model, self.tertiary_model) if m]

    @property
    def models(self) -> dict:
        return {"primary": self.primary_model, "fallback": self.fallback_model, "tertiary": self.tertiary_model or None}

    def key_for(self, provider: str) -> str:
        if provider == "anthropic" and self.anthropic_key:
            return self.anthropic_key
        if provider == "openai" and self.openai_key:
            return self.openai_key
        if provider == "kimi":
            return self.kimi_key
        return self.emergent_key


settings = Settings()
