// Deployed instances are gated by an access code (backend APP_ACCESS_CODE).
// The code is remembered per device; a 401 pops the AccessGate overlay.
//
// These two constants live here, apart from api/client.ts, ON PURPOSE.
// AccessGate is mounted eagerly in App.tsx (it has to be — a 401 can arrive
// before any route resolves), so anything it imports lands in the entry chunk.
// Importing them from api/client dragged axios and every typed wrapper onto the
// critical path of a marketing page that never calls the API: measured 493 kB
// raw / 162 kB gzip, versus 439 kB / 142 kB with this file in between.
// Keep this module dependency-free.
export const ACCESS_CODE_KEY = "jobfinder.accessCode";
export const UNAUTHORIZED_EVENT = "jobfinder:unauthorized";
