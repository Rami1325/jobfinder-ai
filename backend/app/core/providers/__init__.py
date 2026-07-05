"""Job-source provider registry.

Add a new board by implementing `JobProvider` (see base.py) and registering an
instance here; `app.core.job_search` fans out to whatever `SearchContext.sources`
selects, validated against this registry (unknown names are ignored).
"""
from __future__ import annotations

from app.core.providers.base import (
    JobHit,
    JobProvider,
    NoResultsError,
    fetch_description_via_url,
)
from app.core.providers.comeet import ComeetProvider
from app.core.providers.drushim import DrushimProvider
from app.core.providers.jobmaster import JobMasterProvider
from app.core.providers.linkedin import LinkedInProvider

# Jooble is deliberately NOT registered: Jooble discontinued its Israeli index
# (il.jooble.org dead at the network level, global API is US-only, verified
# live 2026-07-05). The provider lives on in providers/jooble.py, parser tests
# and all — re-add it here if Jooble ever brings Israel back.
PROVIDERS: dict[str, JobProvider] = {
    provider.name: provider
    for provider in (
        LinkedInProvider(),
        DrushimProvider(),
        ComeetProvider(),
        JobMasterProvider(),
    )
}

DEFAULT_SOURCES: list[str] = list(PROVIDERS)

__all__ = [
    "DEFAULT_SOURCES",
    "PROVIDERS",
    "JobHit",
    "JobProvider",
    "NoResultsError",
    "fetch_description_via_url",
]
