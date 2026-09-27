// The Comeet send's refusals (PLAN 8.4, on a job's page since 31.4/5), read by
// their machine code. The server refuses with `{detail, code, params}`: `detail`
// is its English sentence, kept a string for a tab loaded before the codes
// existed, and `code` is one of `auto_submit.REFUSAL_CODES`, which the page
// turns into a sentence in the reader's language. Until 2026-09-27 the English
// went to the Hebrew page verbatim.
//
// Dependency-free, so check-mirrors 81 can bundle and EXECUTE it. That check
// reads REFUSAL_CODES out of the backend and requires a row here for every code
// and a sentence for every row in both tracker.json files, and no row for a code
// the server never sends.

/** One sentence per code (`tracker` namespace). */
export const SEND_REFUSAL_KEYS: Record<string, string> = {
  kit_not_found: "job.send.refused.kit_not_found",
  already_sent: "job.send.refused.already_sent",
  not_approved: "job.send.refused.not_approved",
  kit_flagged: "job.send.refused.kit_flagged",
  not_comeet: "job.send.refused.not_comeet",
  not_comeet_url: "job.send.refused.not_comeet_url",
  recaptcha: "job.send.refused.recaptcha",
  company_already_sent: "job.send.refused.company_already_sent",
  application_missing: "job.send.refused.application_missing",
  draft_changed: "job.send.refused.draft_changed",
  resume_unreadable: "job.send.refused.resume_unreadable",
  contact_missing: "job.send.refused.contact_missing",
  careers_unreachable: "job.send.refused.careers_unreachable",
  comeet_locked: "job.send.refused.comeet_locked",
  comeet_declined: "job.send.refused.comeet_declined",
  comeet_unreachable: "job.send.refused.comeet_unreachable",
};

/** A code this page does not know (a server newer than the tab) still says the
 * send failed, in the reader's language, never the code and never the English. */
export const SEND_REFUSAL_FALLBACK = "job.send.error";

export interface SendRefusal {
  code: string;
  /** What the sentence names: `company`, `status`. Strings and numbers only. */
  params: Record<string, string | number>;
}

/** The refusal an axios error carries, or null: a network failure, a 5xx, or a
 * refusal of another shape (the daily cap's `{detail: {code: "daily_limit"}}`,
 * which `apiErrorMessage` already translates). */
export function sendRefusal(e: unknown): SendRefusal | null {
  const data = (e as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  if (typeof code !== "string" || !code) return null;
  const raw = (data as { params?: unknown }).params;
  const params: Record<string, string | number> = {};
  if (raw && typeof raw === "object")
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" || typeof v === "number") params[k] = v;
  return { code, params };
}

/** The sentence's key for a code. Looked up by the table's OWN keys, like
 * `googleErrorMessage`: `constructor` is not a code. */
export function sendRefusalKey(code: string): string {
  return Object.prototype.hasOwnProperty.call(SEND_REFUSAL_KEYS, code) ? SEND_REFUSAL_KEYS[code] : SEND_REFUSAL_FALLBACK;
}
