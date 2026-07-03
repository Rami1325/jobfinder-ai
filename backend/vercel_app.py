"""Vercel entrypoint: serves the API under /api.

The root vercel.json routes /api/(.*) to this service with the original
path intact; mounting the backend at /api strips the prefix, so every
route in app.main works unchanged. Mounted sub-apps never run their
lifespan hook, so the schema is created at import time instead
(idempotent create_all; once per instance).
"""
from fastapi import FastAPI

from app.db.database import init_db
from app.main import app as api

init_db()

app = FastAPI()
app.mount("/api", api)
