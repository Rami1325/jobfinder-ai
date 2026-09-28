"""Job-source provider registry.

Add a new board by implementing `JobProvider` (see base.py) and registering an
instance here; `app.core.job_search` fans out to whatever `SearchContext.sources`
selects, validated against this registry (unknown names are ignored). The
frontend's board list (`SOURCE_IDS` and the board names in
pages/jobs/shared.ts) must name every board here, in this order: check-mirrors
98 holds the two together.
"""
from __future__ import annotations

from app.core.providers.ashby import AshbyProvider
from app.core.providers.base import (
    JobHit,
    JobProvider,
    NoResultsError,
    fetch_description_via_url,
)
from app.core.providers.comeet import ComeetProvider
from app.core.providers.drushim import DrushimProvider
from app.core.providers.greenhouse import GreenhouseProvider
from app.core.providers.himalayas import HimalayasProvider
from app.core.providers.jobicy import JobicyProvider
from app.core.providers.jobmaster import JobMasterProvider
from app.core.providers.lever import LeverProvider
from app.core.providers.linkedin import LinkedInProvider
from app.core.providers.smartrecruiters import SmartRecruitersProvider

# Jooble is deliberately NOT registered: Jooble discontinued its Israeli index
# (il.jooble.org dead at the network level, global API is US-only, verified
# live 2026-07-05). The provider lives on in providers/jooble.py, parser tests
# and all — re-add it here if Jooble ever brings Israel back.
# Lever: the July 2026 probe (60+ Israeli-company slugs against api.lever.co,
# 2026-07-06) found ZERO Israeli tenants, because Lever has a second region and
# the probe never asked it. On 2026-09-27 the EU host, api.eu.lever.co, held
# Mobileye with 145 openings in Israel, so Lever has a provider since
# 2026-09-28 that asks each site on its own host (providers/lever.py).
PROVIDERS: dict[str, JobProvider] = {
    provider.name: provider
    for provider in (
        LinkedInProvider(),
        DrushimProvider(),
        ComeetProvider(),
        JobMasterProvider(),
        GreenhouseProvider(),
        LeverProvider(),
        SmartRecruitersProvider(),
        AshbyProvider(),
        # Asked only by the worldwide pass (job_search.WORLDWIDE_ONLY_BOARDS).
        HimalayasProvider(),
        JobicyProvider(),
    )
}

DEFAULT_SOURCES: list[str] = list(PROVIDERS)

# Boards whose terms ask every surface that shows one of their postings to NAME
# the board beside a link back to the posting's page on it: Himalayas, whose API
# is offered on exactly that condition (providers/himalayas.py), and Jobicy, whose
# every answer asks for it (providers/jobicy.py). Read by the alert email; the Jobs
# page mirrors the ids (`ATTRIBUTED_SOURCES`, check-mirrors 99).
ATTRIBUTED: dict[str, str] = {HimalayasProvider.name: "Himalayas", JobicyProvider.name: "Jobicy"}

# The boards that existed before 2026-09-28. A saved search that names every one
# of them was saved as "all boards" (the Jobs page adopts the resolved context,
# which lists every board by name), so it is stored as "all boards" again, and
# every board added since joins it (`app/db/registry_seed.widen_saved_sources`).
BOARDS_BEFORE_2026_09_28: frozenset[str] = frozenset({"linkedin", "drushim", "comeet", "jobmaster", "greenhouse"})


def stored_sources(sources: list[str]) -> list[str]:
    """The board list to STORE for a saved search: [] ("every board, including
    boards added later") when it names every registered board, else as chosen.
    An explicit list of every board is how "all boards" used to be saved, and
    it silently left out each board added after the save."""
    return [] if set(PROVIDERS) <= set(sources or []) else list(sources or [])


__all__ = [
    "ATTRIBUTED",
    "BOARDS_BEFORE_2026_09_28",
    "DEFAULT_SOURCES",
    "PROVIDERS",
    "JobHit",
    "JobProvider",
    "NoResultsError",
    "fetch_description_via_url",
    "stored_sources",
]
