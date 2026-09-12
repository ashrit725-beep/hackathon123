import asyncio
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from demo_store.router import router as demo_router  # noqa: E402
from shadowqa import pipeline as shadowqa_pipeline  # noqa: E402
from shadowqa.api import router as shadowqa_router  # noqa: E402
from shadowqa.core import github as core_github  # noqa: E402
from shadowqa.core.api import router as core_router  # noqa: E402
from shadowqa.core.slack import connector as slack_connector  # noqa: E402
from shadowqa.db import client as shadowqa_client  # noqa: E402
from shadowqa.server_sdk import ServerErrorObserver  # noqa: E402
from shadowqa.workspace import get_workspace  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("server")

app = FastAPI(title="ShadowQA Bridge + Lumen Supply Co. demo API")


@app.get("/api/")
async def root():
    return {"service": "shadowqa-bridge", "demo": "lumen-supply-co", "ok": True}


app.include_router(demo_router)
app.include_router(shadowqa_router)
app.include_router(core_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
# ShadowQA server observer: joins a 5xx seen in the browser to the exception + handler that produced it.
app.add_middleware(ServerErrorObserver, root=get_workspace().root)


@app.on_event("startup")
async def resume_shadowqa_pipeline():
    # A ShadowQA patch to backend code reloads this server; pick up any validation it interrupted.
    asyncio.create_task(shadowqa_pipeline.resume_interrupted())
    # Development-context connectors: Slack (Socket Mode) and GitHub (polling). Both are no-ops when unconfigured.
    asyncio.create_task(slack_connector.start())
    asyncio.create_task(core_github.connector.start())


@app.on_event("shutdown")
async def shutdown_db_client():
    await slack_connector.stop()
    shadowqa_client.close()
