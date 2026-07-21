// PLAN 12.5c — tiny staleTime cache for the read endpoints, living UNDER the
// api/client wrappers so pages keep their own render caches untouched.
// Within the fresh window a repeat call returns the cached payload with no
// network; concurrent callers share one in-flight request; every mutating
// wrapper invalidates the keys it touches, so in-app changes are never stale.

type Entry = { data: unknown; at: number };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

const DEFAULT_STALE_MS = 30_000;

export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  staleMs: number = DEFAULT_STALE_MS,
): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < staleMs) return hit.data as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fetcher()
    .then((data) => {
      entries.set(key, { data, at: Date.now() });
      inflight.delete(key);
      return data;
    })
    .catch((err: unknown) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, p);
  return p;
}

/** Drop cached entries. Each argument matches the key itself and any
 * sub-keys ("master" also drops "master:he"). */
export function invalidateData(...keys: string[]): void {
  for (const k of keys) {
    for (const existing of entries.keys()) {
      if (existing === k || existing.startsWith(`${k}:`)) entries.delete(existing);
    }
  }
}

/** Full reset — data wipe, access-code change, 401. */
export function clearDataCache(): void {
  entries.clear();
}
