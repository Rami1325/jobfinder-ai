// Deployed instances are gated by the backend (APP_ACCESS_CODE switches the
// gate on). There are two ways through it: an account session, which rides an
// httpOnly cookie the browser sends by itself, and the older invite code,
// remembered per device under ACCESS_CODE_KEY and sent as `X-App-Key` (the
// friends beta and the Chrome extension still use it).
//
// A 401 means neither worked, and AccessGate sends the visitor to /login. A 403
// `email_unverified` means an account that has not confirmed its address yet,
// and AccessGate sends it to /verify. Each outcome has its own event, because
// "who are you?" and "confirm your email" are different pages.
//
// These constants live here, apart from api/client.ts, ON PURPOSE.
// AccessGate is mounted eagerly in App.tsx (it has to be — a 401 can arrive
// before any route resolves), so anything it imports lands in the entry chunk.
// Importing them from api/client dragged axios and every typed wrapper onto the
// critical path of a marketing page that never calls the API: measured 493 kB
// raw / 162 kB gzip, versus 439 kB / 142 kB with this file in between.
// Keep this module dependency-free.
export const ACCESS_CODE_KEY = "jobfinder.accessCode";
export const UNAUTHORIZED_EVENT = "jobfinder:unauthorized";
export const UNVERIFIED_EVENT = "jobfinder:unverified";
