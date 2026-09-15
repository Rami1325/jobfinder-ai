import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** `search` without the parameter `name`, every other parameter kept. The same
 * string back when `name` is not in it, so nothing is rewritten for nothing. */
export function withoutParam(search: string, name: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(name)) return search;
  params.delete(name);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * A one-shot flag in the address, read once and then taken out of it.
 *
 * Continue with Google comes back as `?google=<code>` on /login and /signup
 * when it was refused, and with `google=superseded` on the page it signed in to
 * (Phase 30 F3). The value is read ONCE, into state, so it survives its own
 * removal. It is removed so a reload does not repeat an old refusal over a page
 * that has moved on, with a REPLACE so Back does not return to it either.
 *
 * Only that key goes. `next` rides in the same query, and a strip that rebuilt
 * the query from scratch would send the person to /app instead of where they
 * were going. The hash and the history state are kept for the same reason.
 * check-mirrors 32(l) executes `withoutParam` and pins this wiring.
 */
export function useTakeParam(name: string): string {
  const location = useLocation();
  const navigate = useNavigate();
  const [value] = useState(() => new URLSearchParams(location.search).get(name) ?? "");
  useEffect(() => {
    const search = withoutParam(location.search, name);
    if (search === location.search) return;
    navigate({ pathname: location.pathname, search, hash: location.hash }, { replace: true, state: location.state });
    // Once, on mount: the flag was read into state above, and every later
    // render has an address without it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}
