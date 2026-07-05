"""FastAPI application entrypoint."""
from __future__ import annotations

import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.config import get_settings
from app.db.database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="JobFinder API", version="0.1.0", lifespan=lifespan)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths as seen locally and under the Vercel /api mount. The alerts cron is
# called by Vercel's scheduler (no X-App-Key); it enforces its own Bearer
# CRON_SECRET check in the handler.
_GATE_EXEMPT = {"/", "/health", "/api", "/api/health", "/jobs/alerts/cron", "/api/jobs/alerts/cron"}


@app.middleware("http")
async def access_gate(request: Request, call_next):
    """When APP_ACCESS_CODE is set (the public deployment), require every API
    call to present it in X-App-Key. Unset locally, so dev is unaffected."""
    code = settings.app_access_code
    if (
        code
        and request.method != "OPTIONS"
        and request.url.path not in _GATE_EXEMPT
        and not hmac.compare_digest(request.headers.get("x-app-key", ""), code)
    ):
        return JSONResponse({"detail": "Access code required."}, status_code=401)
    return await call_next(request)


app.include_router(router)


@app.get("/")
def root() -> dict[str, str]:
    return {"name": "JobFinder API", "docs": "/docs"}
