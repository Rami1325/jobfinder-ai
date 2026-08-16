"""SSRF guard for server-side URL fetches.

Every outbound fetch this app makes goes through `job_match._http_get`, and two
routes let the CALLER name the URL: `POST /jobs/fetch` and
`POST /tools/company-brief`. Both return the fetched body, so without a guard an
invite-code holder can aim the server at cloud metadata (169.254.169.254), a
loopback admin port, or anything else inside the deployment's network and read
the response back. `fetch_job_text` carried a docstring saying exactly this —
"single-user local tool … if this is ever exposed to multiple users, add an
allowlist / block private ranges" — and the multi-user deployment landed in
Phase 7 without it.

The rule: resolve the host, and refuse unless EVERY address it resolves to is
publicly routable. `is_global` is the right predicate rather than a hand-rolled
range list — it covers loopback, RFC1918, link-local (which is where the cloud
metadata endpoint lives), CGNAT 100.64/10 (which `is_private` does NOT catch on
3.12), and the reserved blocks, for v4 and v6 alike.

Redirects are re-checked per hop, because validating only the URL the user typed
buys nothing against `http://harmless.test/` → 302 → `http://169.254.169.254/`.

Residual risk, stated rather than hidden: this resolves the name and then lets
urllib resolve it again, so a record that changes between the two lookups (DNS
rebinding) is not covered. Closing that means connecting to the validated IP
with a Host header override — a lot of machinery for a surface that is behind
the access gate. Revisit if these routes ever serve anonymous traffic.
"""
from __future__ import annotations

import ipaddress
import socket
import urllib.request

# Deliberately not configurable. A job posting is on a public board by
# definition, so there is no legitimate call that this blocks — a flag would
# only ever be a way to turn the guard off.
_ALLOWED_SCHEMES = ("http", "https")


class BlockedURLError(ValueError):
    """The URL resolves somewhere the server must not fetch.

    A ValueError so it lands on the existing user-facing 400 paths (the
    `/jobs/fetch` and `/tools/company-brief` handlers, and the providers'
    per-board failure isolation) without any of them needing to know about it.
    """


def is_public_ip(ip: str) -> bool:
    """True when `ip` is a publicly routable unicast address. Pure; smoke-pinned."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # is_global already excludes loopback/private/link-local/CGNAT/reserved;
    # multicast reports global but is not a thing we ever want to fetch.
    return addr.is_global and not addr.is_multicast


def assert_fetchable(url: str) -> None:
    """Raise BlockedURLError unless `url` is http(s) on a publicly routable host.

    Every resolved address must pass: a name answering with both a public and a
    private address is exactly the shape of an attack, so one bad answer refuses
    the whole fetch.
    """
    parsed = urllib.request.urlparse(url)
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise BlockedURLError("Only http:// and https:// links can be fetched.")
    host = parsed.hostname
    if not host:
        raise BlockedURLError("That link has no host to fetch from.")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise BlockedURLError(f"Couldn't resolve '{host}'.") from e
    if not infos:
        raise BlockedURLError(f"Couldn't resolve '{host}'.")
    for info in infos:
        if not is_public_ip(info[4][0]):
            raise BlockedURLError(
                f"'{host}' points inside a private network, so it isn't a public job posting."
            )


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-runs `assert_fetchable` on every hop of a redirect chain."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        assert_fetchable(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Built once: openers are stateless and thread-safe for our use (no cookie jar,
# no auth handler), and the parallel search fans many fetches out at once.
guarded_opener = urllib.request.build_opener(_GuardedRedirectHandler)
