// Monthly uses (Phase 30 / C3): what this page knows about the signed-in
// account's free monthly limit, in ONE module-level store every page reads.
//
// The writers, all in api/client.ts, and nothing else writes here:
//   - every /auth/me answer (`getAuthMe` hands its `usage` to `setUsage`); the
//     first is AppLayout's guard, which answers before the shell renders;
//   - `refreshUses`, AppLayout's re-read of /auth/me when the tab is shown
//     again (P30-EXT-LIMIT): the Chrome extension, another tab and another
//     device spend uses whose headers never reach this page. It writes only
//     when the answer is the account the guard saw (`usageIfSameUser`), and
//     at most once a minute (`shouldRefreshUses`);
//   - the X-Uses-Remaining and X-Uses-Pass headers on any API response, read by
//     the axios interceptor and by the search stream's own fetch;
//   - a 429 `monthly_limit`, from the shared `onRejected` both paths reach.
//
// A reader may disable a counted control on `out`, and on nothing else. `out`
// is false whenever this page does not know the count (a failed /auth/me), for
// the admin and for a plan with no monthly limit, and the server decides every
// call anyway: a count that is wrong here can cost a note, never a call the
// server would have served.
//
// It imports react for the hook and nothing else from the app, so check-mirrors
// 32(e) can bundle it and run it in node. A sign-out is a document load, which
// starts this module over along with every other store.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { UsageOut } from "../types";

/** The response headers the backend's `uses_meter` middleware sets. */
export const USES_REMAINING_HEADER = "X-Uses-Remaining";
export const USES_PASS_HEADER = "X-Uses-Pass";

/** An open session pass: interview practice or screening answers. `deadline` is
 * `Date.now()` on arrival plus the seconds the server said were left. The server
 * sends relative seconds so a phone whose clock is wrong cannot end a pass early,
 * and computing the deadline here, on arrival, keeps that true. */
export interface UsesPass {
  callsLeft: number;
  deadline: number;
}

/** `limit` and `remaining` are null for the admin and for a plan with no monthly
 * limit. The state itself is null while this page has no answer at all. */
export interface UsesState {
  limit: number | null;
  remaining: number | null;
  /** "YYYY-MM-DD", the 1st of the next UTC month; "" when unknown. */
  resetsOn: string;
  passes: Record<string, UsesPass>;
}

/** One feature's reading of the store: what a note says and whether its control is out. */
export interface UsesView {
  /** This page knows the current month's count for a limited plan. False while
   * the count is unknown, for an exempt account, and once the month the stored
   * count describes has ended. */
  limited: boolean;
  limit: number | null;
  /** Null whenever `limited` is false. */
  remaining: number | null;
  resetsOn: string;
  /** This feature's open pass, if any, whether or not it still covers a call. */
  pass: UsesPass | null;
  /** The call rides a pass or a per-posting inclusion, and uses nothing. */
  covered: boolean;
  /** No use left and nothing covers the call: the ONE reason to disable a control. */
  out: boolean;
}

let state: UsesState | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

// A browser fires any setTimeout longer than 2^31 - 1 ms at once, so a deadline
// further out than that (about 24.8 days; no pass lasts one) waits for a write.
const MAX_DELAY_MS = 2_147_483_647;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PASS_HEADER = /^([a-z][a-z_]*);(\d{1,9});(\d{1,9})$/;

export function getUsesState(): UsesState | null {
  return state;
}

export function subscribeUses(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: UsesState | null): void {
  state = next;
  schedule();
  listeners.forEach((listener) => listener());
}

/** One re-emit at the earliest pass deadline still ahead, so a note reading
 * "Included until 14:30" stops reading it at 14:30 without anyone tapping. */
function schedule(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!state) return;
  const now = Date.now();
  let next = Infinity;
  for (const p of Object.values(state.passes)) if (p.deadline > now && p.deadline < next) next = p.deadline;
  if (next === Infinity || next - now > MAX_DELAY_MS) return;
  timer = setTimeout(() => {
    timer = null;
    if (!state) return;
    const at = Date.now();
    const passes = Object.fromEntries(Object.entries(state.passes).filter(([, p]) => p.deadline > at));
    commit({ ...state, passes });
  }, next - now);
}

/** A non-negative whole number from a JSON number or a header string, else null. */
function count(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

function dateOnly(value: unknown): string {
  return typeof value === "string" && YMD.test(value) ? value : "";
}

/** Today in UTC as "YYYY-MM-DD". Read through `Date.now()` alone, never through
 * `new Date()` with no argument, so there is one clock for the probe to drive. */
function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** What the server's `resets_on` is at `now`: the 1st of the next UTC month. */
function nextResetFrom(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** Whether the month a stored count describes has ended. Unknown has not. */
function monthOver(resetsOn: string, now: number): boolean {
  return resetsOn !== "" && todayUtc(now) >= resetsOn;
}

/** Milliseconds for an ISO instant. The server writes aware UTC ("+00:00");
 * one with no offset is read as UTC too, never as the device's local time,
 * which is what `Date.parse` alone would do with it. */
function instant(iso: string | undefined): number | null {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const s = iso.trim();
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const ms = Date.parse(zoned || !s.includes("T") ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** A header from axios's AxiosHeaders or fetch's Headers (both have a
 * case-insensitive `get`), or from a plain object keyed in lower case. */
function headerValue(source: unknown, name: string): string | null {
  if (!source || typeof source !== "object") return null;
  const bag = source as { get?: unknown } & Record<string, unknown>;
  const value =
    typeof bag.get === "function"
      ? (bag.get as (header: string) => unknown).call(source, name)
      : bag[name.toLowerCase()] ?? bag[name];
  return value === null || value === undefined ? null : String(value);
}

/** Adopt an /auth/me answer: `usage` is null for a signed-out caller, and absent
 * on an older backend, and both leave this page not knowing the count. */
export function setUsage(usage: UsageOut | null | undefined): void {
  if (!usage || typeof usage !== "object") {
    commit(null);
    return;
  }
  const limit = count(usage.limit);
  const now = Date.now();
  const passes: Record<string, UsesPass> = {};
  if (limit !== null && usage.passes && typeof usage.passes === "object") {
    for (const [feature, p] of Object.entries(usage.passes)) {
      const callsLeft = count(p?.calls_left);
      const seconds = count(p?.expires_in_s);
      if (callsLeft && seconds) passes[feature] = { callsLeft, deadline: now + seconds * 1000 };
    }
  }
  commit({
    limit,
    remaining: limit === null ? null : count(usage.remaining),
    resetsOn: dateOnly(usage.resets_on),
    passes,
  });
}

/** Adopt the X-Uses-Remaining and X-Uses-Pass headers of any response, an error
 * response included (a failed call's refund restores the count on the response
 * that reports the failure). Only a count this page already knows is updated: a
 * header alone says neither the limit nor the reset date, and a note built on a
 * guess is worse than no note. */
export function noteUsesHeaders(source: unknown): void {
  if (!state || state.limit === null) return;
  const remaining = count(headerValue(source, USES_REMAINING_HEADER));
  const pass = PASS_HEADER.exec((headerValue(source, USES_PASS_HEADER) ?? "").trim());
  if (remaining === null && !pass) return;
  const now = Date.now();
  let next: UsesState = state;
  if (remaining !== null) {
    // A count that arrives after the month turned over describes the new month.
    const resetsOn = monthOver(next.resetsOn, now) ? nextResetFrom(now) : next.resetsOn;
    next = { ...next, remaining, resetsOn };
  }
  if (pass) {
    const [, feature, calls, seconds] = pass;
    const passes = { ...next.passes };
    // `<feature>;0;0` is the server closing a pass it deleted or ended.
    if (Number(calls) > 0 && Number(seconds) > 0)
      passes[feature] = { callsLeft: Number(calls), deadline: now + Number(seconds) * 1000 };
    else delete passes[feature];
    next = { ...next, passes };
  }
  commit(next);
}

/** Adopt a 429 `monthly_limit` refusal. It carries its own numbers, and they are
 * taken as they are: a kits batch bigger than what is left is refused with, say,
 * 2 remaining, so a refusal is never read as zero. The refused feature's pass is
 * forgotten, because the server tries a pass before it refuses. */
export function noteMonthlyLimit(detail: unknown): void {
  if (!detail || typeof detail !== "object") return;
  const d = detail as Record<string, unknown>;
  if (d.code !== "monthly_limit") return;
  const limit = count(d.limit);
  const remaining = count(d.remaining);
  const resetsOn = dateOnly(d.resets_on);
  const passes = { ...(state?.passes ?? {}) };
  if (typeof d.feature === "string") delete passes[d.feature];
  if (!state) {
    if (limit === null || remaining === null) return;
    commit({ limit, remaining, resetsOn, passes });
    return;
  }
  commit({
    limit: limit ?? state.limit,
    remaining: remaining ?? state.remaining,
    resetsOn: resetsOn || state.resetsOn,
    passes,
  });
}

/** How long a tab must have been left alone before showing it again re-reads
 * /auth/me. Flipping between two tabs every few seconds is one read a minute,
 * not one per flip. */
export const USES_REFRESH_MS = 60_000;

/** Whether a tab that just became visible (or hidden) should re-read its uses.
 * Never while hidden. A clock that went BACKWARDS since the last ask (the
 * device's time was changed) allows one, rather than waiting for the clock to
 * catch up with an ask it now dates in the future. */
export function shouldRefreshUses(now: number, lastAskedAt: number, visible: boolean): boolean {
  if (!visible) return false;
  if (!Number.isFinite(now) || !Number.isFinite(lastAskedAt)) return true;
  return now < lastAskedAt || now - lastAskedAt >= USES_REFRESH_MS;
}

/** The `usage` of an /auth/me answer, but only when the answer is about the
 * account `expectedId`: signed in, with that same id. `undefined` means "not
 * this account's answer, change nothing". A tab can outlive its session, and
 * another tab of the same browser can sign in as someone else, and neither
 * answer may be read as this tab's count. `null` is a real answer, the same
 * account with no usage block, and `setUsage(null)` then forgets the count
 * rather than keep one the server no longer states. */
export function usageIfSameUser(expectedId: number | null | undefined, answer: unknown): UsageOut | null | undefined {
  if (typeof expectedId !== "number" || !answer || typeof answer !== "object") return undefined;
  const a = answer as { authenticated?: unknown; user?: { id?: unknown } | null; usage?: UsageOut | null };
  if (a.authenticated !== true || !a.user || a.user.id !== expectedId) return undefined;
  return a.usage ?? null;
}

/** A per-posting inclusion from the server's RELATIVE reading of one pass (a
 * cover letter's `changes_left` / `expires_in_s`, or the `UsagePassOut` that
 * POST /cover-letter/pass answers), for the caller to hold and pass back as
 * `includedUntil`: `until` is `Date.now()` on arrival plus the seconds left,
 * which is `setUsage`'s clock rule, so a phone whose clock runs ahead cannot end
 * the pass early. Null unless the pass has a change left AND time left. It
 * writes nothing here; a per-posting pass is the caller's, never the store's
 * (P30-RELOAD-PASS). */
export function inclusionFrom(
  p: { calls_left?: unknown; expires_in_s?: unknown } | null | undefined,
): { until: string; left: number } | null {
  const left = count(p?.calls_left);
  const seconds = count(p?.expires_in_s);
  if (!left || !seconds) return null;
  return { until: new Date(Date.now() + seconds * 1000).toISOString(), left };
}

/** Forget everything. The app never needs it (a sign-out loads a new document);
 * the check-mirrors probe calls it to clear the pass timer before node exits. */
export function resetUses(): void {
  commit(null);
}

/** One feature's reading of a state, the current one by default.
 *
 * `includedUntil` is a per-posting inclusion the caller holds, which the store
 * cannot know: the fit check's `tailor_included_until` for Tailor, and for a
 * cover letter's next change the deadline `inclusionFrom` took on arrival. While
 * it is in the future it covers the call. */
export function usesFor(feature: string, includedUntil?: string, from: UsesState | null = state): UsesView {
  const now = Date.now();
  const limited = !!from && from.limit !== null && from.remaining !== null && !monthOver(from.resetsOn, now);
  const pass = from?.passes[feature] ?? null;
  const until = instant(includedUntil);
  const covered = (!!pass && pass.callsLeft > 0 && pass.deadline > now) || (until !== null && until > now);
  const remaining = limited && from ? from.remaining : null;
  return {
    limited,
    limit: from?.limit ?? null,
    remaining,
    resetsOn: from?.resetsOn ?? "",
    pass,
    covered,
    out: limited && !covered && remaining === 0,
  };
}

/** Whether a counted control for `feature` is out right now. */
export function outFor(feature: string, includedUntil?: string): boolean {
  return usesFor(feature, includedUntil).out;
}

/** The store itself, for a surface that needs the plan's limit and no feature. */
export function useUsesState(): UsesState | null {
  return useSyncExternalStore(subscribeUses, getUsesState);
}

/** `usesFor`, re-rendered whenever the store changes, and once more when an
 * `includedUntil` the caller passed runs out: the store's own timer knows only
 * the passes it holds. */
export function useUses(feature: string, includedUntil?: string): UsesView {
  const from = useUsesState();
  const [, rerender] = useState(0);
  const until = instant(includedUntil);
  useEffect(() => {
    if (until === null) return;
    const delay = until - Date.now();
    if (delay <= 0 || delay > MAX_DELAY_MS) return;
    const id = setTimeout(() => rerender((n) => n + 1), delay);
    return () => clearTimeout(id);
  }, [until]);
  return usesFor(feature, includedUntil, from);
}

function utcDay(ymd: string, monthShift: number): Date | null {
  if (!YMD.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + monthShift, monthShift === 0 ? d : 1));
  return Number.isNaN(date.getTime()) ? null : date;
}

const localeOf = (lang: string | undefined) => ((lang ?? "").startsWith("he") ? "he" : "en");

/** "October 1" / "1 באוקטובר": the day the uses come back, in the reader's
 * language, or "" for a date this cannot read. */
export function formatUsesDate(resetsOn: string, lang?: string): string {
  const date = utcDay(resetsOn, 0);
  return date
    ? new Intl.DateTimeFormat(localeOf(lang), { month: "long", day: "numeric", timeZone: "UTC" }).format(date)
    : "";
}

/** "2:30 PM" / "14:30": when a pass or a per-posting inclusion ends, in the
 * reader's language and on the device's own clock, or "" for a time this cannot
 * read. Takes the store's `deadline` (milliseconds, already local to this
 * device) or the server's ISO instant (read as UTC when it carries no offset). */
export function formatUsesTime(at: number | string | undefined, lang?: string): string {
  const ms = typeof at === "number" ? at : instant(at);
  return ms !== null && Number.isFinite(ms)
    ? new Intl.DateTimeFormat(localeOf(lang), { hour: "numeric", minute: "2-digit" }).format(new Date(ms))
    : "";
}

/** "September" / "ספטמבר": the month whose uses ran out, the one before `resetsOn`. */
export function usedUpMonth(resetsOn: string, lang?: string): string {
  const date = utcDay(resetsOn, -1);
  return date ? new Intl.DateTimeFormat(localeOf(lang), { month: "long", timeZone: "UTC" }).format(date) : "";
}
