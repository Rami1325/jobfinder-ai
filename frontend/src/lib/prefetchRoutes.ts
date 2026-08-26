// Idle-time prefetch for the main app surfaces. The landing page ships as a
// small eager entry chunk (see App.tsx); once the browser is idle we warm the
// lazy route chunks a landing visitor is most likely to navigate to, so the
// first click into the app resolves instantly instead of waiting on a fetch.
//
// IMPORTANT: each import() below must resolve to the same module as the
// matching React.lazy(() => import(...)) call in App.tsx — same module id,
// same Rollup chunk. Do not point these at different paths or re-exports, or
// Vite will emit duplicate chunks.

let fired = false;

export function prefetchAppRoutes(): void {
  if (fired) return;
  fired = true;

  const load = () => {
    // Fire-and-forget: a failed prefetch is harmless (the route's own lazy()
    // will retry on navigation), so swallow errors to avoid unhandled
    // rejection noise on flaky connections.
    const quiet = (p: Promise<unknown>) => p.catch(() => {});
    quiet(import("../layouts/AppLayout"));
    quiet(import("../pages/JobsPage"));
    quiet(import("../pages/TailorPage"));
    quiet(import("../pages/TrackerPage"));
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(load, { timeout: 4000 });
  } else {
    window.setTimeout(load, 2000);
  }
}
