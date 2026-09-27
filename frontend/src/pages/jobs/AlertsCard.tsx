// Email-alert settings card + the shared Customize-search fields
// (split out of JobsPage.tsx — PLAN 12.5d).
import { useEffect, useId, useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, X } from "lucide-react";
import {
  addPushDevice,
  getJobAlert,
  getPushDevices,
  getWhatsApp,
  runJobAlert,
  searchContext,
  updateJobAlert,
} from "../../api/client";
import { Button, Card, CardTitle, useToast, WhyNote } from "../../components/ui";
import UsesNote from "../../components/UsesNote";
import { apiErrorMessage } from "../../lib/apiError";
import { currentSubscription, type PushSub } from "../../lib/push";
import { formatUsesDate, useUses } from "../../lib/usesStore";
import type { AlertSettings, PushDevices, ResumeModel, SearchContext, WhatsAppStatus } from "../../types";
import { PushRow, WhatsAppRow, pushLang } from "./AlertChannels";
import {
  allowsRemote,
  contextKey,
  inputCls,
  joinWorkModes,
  LOCATION_PRESETS,
  MAX_AGE_OPTIONS,
  MIN_SCORE_OPTIONS,
  parseWorkModes,
  SOURCE_IDS,
  sourceLabel,
  WORK_MODES,
  type WorkMode,
} from "./shared";

/** The customized-search fields — keywords, location, work mode, posted-within,
 * result limit, location presets, and board checkboxes. Shared by the search
 * card and the email-alerts card so customizing the alert is literally the
 * same panel; edits go straight into the parent-owned SearchContext draft. */
export function CustomizeFields({
  ctx,
  setCtx,
  prefilling,
}: {
  ctx: SearchContext | null;
  setCtx: Dispatch<SetStateAction<SearchContext | null>>;
  prefilling: boolean;
}) {
  const { t } = useTranslation("jobs");

  // Multi-keyword search: the UI edits ctx.job_titles (one input per keyword);
  // job_title mirrors the first entry so older backends and the results
  // summary stay coherent. Backend dedupes/strips and caps at 5.
  const MAX_KEYWORDS = 5;
  const keywords: string[] = ctx?.job_titles?.length ? ctx.job_titles : [ctx?.job_title ?? ""];
  function setKeywords(next: string[]) {
    setCtx((p) => ({ ...(p as SearchContext), job_titles: next, job_title: next[0] ?? "" }));
  }

  // Work modes live on ctx.work_mode as ONE string ("any" or "remote,hybrid").
  const workModeLabelId = useId();
  const pickedModes = parseWorkModes(ctx?.work_mode);
  function toggleWorkMode(mode: "any" | WorkMode) {
    setCtx((p) => {
      const cur = parseWorkModes(p?.work_mode);
      const next =
        mode === "any" ? [] : cur.includes(mode) ? cur.filter((m) => m !== mode) : [...cur, mode];
      return { ...(p as SearchContext), work_mode: joinWorkModes(next) };
    });
  }

  // Sources selection lives on ctx.sources; empty/absent means "all boards".
  const selectedSources: string[] = ctx?.sources?.length ? ctx.sources : [...SOURCE_IDS];
  function toggleSource(id: string) {
    setCtx((p) => {
      const cur = p?.sources?.length ? p.sources : [...SOURCE_IDS];
      const next = cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id];
      return { ...(p as SearchContext), sources: next };
    });
  }

  return (
    <>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.jobTitle")}
          {keywords.map((kw, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={kw}
                disabled={prefilling}
                onChange={(e) =>
                  setKeywords(keywords.map((k, j) => (j === i ? e.target.value : k)))
                }
                placeholder={
                  prefilling
                    ? t("search.detecting")
                    : i === 0
                      ? t("search.jobTitlePlaceholder")
                      : t("search.keywordPlaceholder")
                }
                className={`${inputCls} min-w-0 flex-1`}
              />
              {keywords.length > 1 && (
                <button
                  type="button"
                  disabled={prefilling}
                  onClick={() => setKeywords(keywords.filter((_, j) => j !== i))}
                  title={t("search.removeKeyword")}
                  className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:text-danger"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
          {keywords.length < MAX_KEYWORDS && (
            <button
              type="button"
              disabled={prefilling}
              onClick={() => setKeywords([...keywords, ""])}
              className="w-fit text-xs font-semibold text-accent-soft hover:underline disabled:opacity-50"
            >
              + {t("search.addKeyword")}
            </button>
          )}
        </div>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.location")}
          <input
            value={ctx?.location ?? ""}
            disabled={prefilling}
            onChange={(e) =>
              setCtx((p) => ({ ...(p as SearchContext), location: e.target.value }))
            }
            placeholder={prefilling ? t("search.detecting") : t("search.locationPlaceholder")}
            className={inputCls}
          />
        </label>
        {/* Several modes at once. "Any" is no pick at all; picking all three
            folds back into it (`joinWorkModes`), because the stored value has one
            spelling per meaning. The note under it says what the filter can
            honestly do: it reads what each posting SAYS, and a posting that says
            nothing stays in the results. */}
        <div
          role="group"
          aria-labelledby={workModeLabelId}
          className="flex flex-col gap-1 text-xs font-semibold text-ink-muted"
        >
          <span id={workModeLabelId}>{t("search.workMode")}</span>
          <div className="flex flex-wrap gap-1.5">
            {(["any", ...WORK_MODES] as const).map((w) => {
              const on = w === "any" ? pickedModes.length === 0 : pickedModes.includes(w);
              return (
                <button
                  key={w}
                  type="button"
                  aria-pressed={on}
                  disabled={prefilling}
                  onClick={() => toggleWorkMode(w)}
                  className={`min-h-[36px] rounded-full border px-3 text-sm font-medium transition-colors disabled:opacity-50 ${
                    on ? "border-accent/60 bg-accent/10 text-ink" : "border-line text-ink-muted hover:text-ink"
                  }`}
                >
                  {t(`workModes.${w}`)}
                </button>
              );
            })}
          </div>
          <span className="text-[11px] font-normal leading-snug text-ink-faint">{t("search.workModeHint")}</span>
        </div>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.postedWithin")}
          <select
            value={ctx?.max_age_days ?? 30}
            disabled={prefilling}
            onChange={(e) =>
              setCtx((p) => ({
                ...(p as SearchContext),
                max_age_days: Number(e.target.value),
              }))
            }
            className={inputCls}
          >
            {MAX_AGE_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {t(`postedWithin.${d === 0 ? "any" : `d${d}`}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.limit")}
          <input
            type="number"
            min={0}
            max={25}
            value={ctx?.limit === 0 ? "" : (ctx?.limit ?? 10)}
            disabled={prefilling}
            onChange={(e) =>
              // 0 stands for "empty box" — allowed while typing, but Search is disabled until it's 1–25.
              setCtx((p) => ({
                ...(p as SearchContext),
                limit:
                  e.target.value === ""
                    ? 0
                    : Math.max(0, Math.min(25, Math.floor(Number(e.target.value)) || 0)),
              }))
            }
            className={inputCls}
          />
        </label>
      </div>

      {/* Worldwide-remote opt-in: only meaningful (and only shown) for searches
          that can include remote roles ("remote" among the picks, or "any").
          Abroad, a posting is kept only when it SAYS it is remote. Rides SearchContext,
          so saving an alert with it customizes the daily alert email the same way.
          The pass runs on LinkedIn (the only board with worldwide inventory), and
          the board checkboxes are authoritative (PLAN 15.9) — with LinkedIn
          unchecked the toggle is inert, so grey it out and say why. */}
      {/* Opacity/transform only — never height:auto on a reveal (see Disclosure). */}
      {allowsRemote(ctx?.work_mode) && (
          <label
            className={`animate-fade-up mt-3 flex w-fit items-start gap-2 text-sm text-ink ${
              selectedSources.includes("linkedin") ? "cursor-pointer" : "opacity-50"
            }`}
          >
            <input
              type="checkbox"
              checked={!!ctx?.include_worldwide}
              disabled={prefilling || !selectedSources.includes("linkedin")}
              onChange={(e) =>
                setCtx((p) => ({ ...(p as SearchContext), include_worldwide: e.target.checked }))
              }
              className="mt-0.5 h-4 w-4 accent-accent"
            />
            <span>
              {t("search.worldwide")}
              {!selectedSources.includes("linkedin") && (
                <span className="block text-xs font-normal text-ink-muted">{t("search.worldwideNeedsLinkedIn")}</span>
              )}
            </span>
          </label>
      )}
      {/* One line, and which countries under "Why?" (PLAN 31.7): the list and
          the rule were three lines under a checkbox. Outside the label, so the
          button is not part of what toggles it. */}
      {allowsRemote(ctx?.work_mode) && selectedSources.includes("linkedin") && (
        <WhyNote className="ms-6 mt-0.5" line={t("search.worldwideLine")} why={t("search.worldwideWhy")} />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className="font-semibold">{t("search.presetsLabel")}</span>
        {LOCATION_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={prefilling}
            onClick={() =>
              setCtx((prev) => ({ ...(prev as SearchContext), location: p.value }))
            }
            className={`rounded-full border px-2.5 py-1 transition-colors ${
              ctx?.location === p.value
                ? "border-accent/60 bg-accent/10 text-ink"
                : "border-line hover:text-ink"
            }`}
          >
            {t(`search.presets.${p.key}`)}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-ink">
        <span className="text-xs font-semibold text-ink-muted">{t("search.sourcesLabel")}</span>
        {SOURCE_IDS.map((id) => {
          const checked = selectedSources.includes(id);
          return (
            <label key={id} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={checked}
                disabled={prefilling || (checked && selectedSources.length === 1)}
                onChange={() => toggleSource(id)}
                className="h-4 w-4 accent-accent"
              />
              {sourceLabel(id)}
            </label>
          );
        })}
      </div>
    </>
  );
}

/** Email-alert settings: daily saved-search re-run that emails unseen jobs.
 * The schedule itself is a server cron; this card is the toggle + "Run now"
 * plus its own Customize panel (the same fields as the search card) so the
 * daily run can be pinned to exact keywords/location/boards instead of
 * silently reusing whatever the search box held when the alert was saved. */
export function AlertsCard({
  resume,
  seedContext,
}: {
  /** The master resume, which the alert's own customize panel derives from.
   * Null in Settings before a resume exists: the panel then starts blank. */
  resume: ResumeModel | null;
  seedContext: () => SearchContext | null;
}) {
  const { t } = useTranslation("jobs");
  const toast = useToast();
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [email, setEmail] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [nudges, setNudges] = useState(false);
  // The fit bar. Seeded from the server (which owns the default), so an older
  // backend that doesn't send it leaves the picker at "any fit" and the PUT
  // below omits it — never inventing a bar the server hasn't got.
  const [minScore, setMinScore] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  // Alert-specific customized search (independent of the search card's panel).
  const [customOpen, setCustomOpen] = useState(false);
  const [ctx, setCtx] = useState<SearchContext | null>(null);
  const [prefilling, setPrefilling] = useState(false);
  const { t: tCommon } = useTranslation();
  const { i18n } = useTranslation();
  // Run now is a search the user pressed (Phase 30 / B6.4) and uses 1. A
  // scheduled morning uses 1 only when it emails jobs, and with none left the
  // mornings wait for the 1st.
  const searchUses = useUses("search");
  const alertUses = useUses("job_alert");
  // PLAN 32: this device's notifications. Read WITH the alert, so the card
  // appears whole: a row arriving later would move everything under it. A
  // server without push (or an older one) answers null and draws no row.
  const [push, setPush] = useState<PushDevices | null>(null);
  const [pushHere, setPushHere] = useState<PushSub | null>(null);
  // PLAN 32, part 2: WhatsApp, drawn only when the server offers it to this account.
  const [wa, setWa] = useState<WhatsAppStatus | null>(null);

  useEffect(() => {
    Promise.all([
      getJobAlert(),
      getPushDevices().catch(() => null),
      currentSubscription(),
      getWhatsApp().catch(() => null),
    ])
      .then(([s, devices, here, whats]) => {
        setPush(devices?.configured ? devices : null);
        setPushHere(here);
        setWa(whats?.available ? whats : null);
        // Keep a device's notifications in the language the app is in now
        // (only for a device the server already holds: after "Delete all my
        // data" this browser's old subscription must not quietly come back).
        const mine = here && devices?.configured ? devices.devices.find((d) => d.endpoint === here.endpoint) : undefined;
        if (here && mine && mine.lang !== pushLang(i18n.language))
          void addPushDevice({ ...here, lang: pushLang(i18n.language) }).catch(() => {});
        setSettings(s);
        setEmail(s.email);
        setEnabled(s.enabled);
        setNudges(!!s.nudge_emails);
        if (typeof s.min_score === "number") setMinScore(s.min_score);
        if (s.context) {
          // A saved context means the alert was customized — show it as such.
          setCtx(s.context);
          setCustomOpen(true);
        }
      })
      .catch(() => {}); // older backend without alerts — card hides itself
  }, []);

  if (!settings) return null;

  const limitInvalid = customOpen && (ctx?.limit ?? 10) < 1;
  // The daily cron runs against the SAVED settings, so show a Save button the
  // moment the card's draft (email or customized context) drifts from them.
  const unsaved =
    email.trim() !== settings.email ||
    nudges !== !!settings.nudge_emails ||
    (minScore !== null && minScore !== settings.min_score) ||
    contextKey(customOpen ? ctx : null) !== contextKey(settings.context);
  // Paused for want of a use (Phase 30 / B6.5): the server says so when the card
  // is read, and the store says so the moment another feature spends the last
  // use. Never while the count is unknown, which also keeps it off for an
  // account with no monthly limit.
  const paused =
    alertUses.limited && (settings.paused_reason === "monthly_limit" || (enabled && alertUses.out));
  const pausedDate = paused ? formatUsesDate(settings.resumes_on || alertUses.resetsOn, i18n.language) : "";

  function toggleCustomize(checked: boolean) {
    setCustomOpen(checked);
    if (checked && !ctx && !prefilling) {
      // Seed from the search card's customized context when there is one,
      // else derive from the resume exactly like the search panel does.
      const seed = seedContext();
      if (seed) {
        setCtx(seed);
        return;
      }
      if (!resume) {
        setCtx({ job_title: "", location: "", work_mode: "any", limit: 10 });
        return;
      }
      setPrefilling(true);
      searchContext(resume)
        .then((c) => setCtx(c))
        .catch(() => setCtx({ job_title: "", location: "", work_mode: "any", limit: 10 }))
        .finally(() => setPrefilling(false));
    }
  }

  async function save(
    nextEnabled: boolean,
    nextNudges: boolean = nudges,
  ): Promise<AlertSettings | null> {
    if ((nextEnabled || nextNudges) && !email.trim()) {
      toast("error", t("alerts.needEmail"));
      return null;
    }
    setSaving(true);
    try {
      const s = await updateJobAlert({
        enabled: nextEnabled,
        email,
        context: customOpen ? ctx : null,
        nudge_emails: nextNudges,
        ...(minScore === null ? {} : { min_score: minScore }),
      });
      setSettings(s);
      setEnabled(s.enabled);
      setNudges(!!s.nudge_emails);
      if (typeof s.min_score === "number") setMinScore(s.min_score);
      if (s.context) setCtx(s.context); // server echo — canonical field set
      toast("success", t("alerts.saved"));
      return s;
    } catch (e: any) {
      toast("error", apiErrorMessage(e, t("alerts.saveError")));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    // The run executes server-side against the saved settings — persist the
    // draft first so "Run now" always does what the card shows.
    if (unsaved && (await save(enabled)) === null) return;
    setRunning(true);
    try {
      const r = await runJobAlert();
      if (r.error) {
        toast("error", t("alerts.runError", { error: r.error }));
      } else {
        const bar = minScore ?? settings?.min_score ?? 0;
        toast(
          "success",
          t("alerts.runResult", { total: r.total, count: r.new_count }) +
            (bar > 0 && typeof r.above_min === "number"
              ? t("alerts.runAboveMin", { n: r.above_min, bar })
              : "") +
            (r.emailed ? t("alerts.runEmailed", { email }) : ""),
        );
      }
      setSettings(await getJobAlert());
    } catch (e: any) {
      toast("error", apiErrorMessage(e, t("alerts.runError", { error: "" })));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardTitle>
        <span className="inline-flex items-center gap-2">
          <Bell size={16} className="text-accent-soft" /> {t("alerts.title")}
        </span>
      </CardTitle>
      <p className="mt-1 text-sm text-ink-muted">{t("alerts.body")}</p>
      {alertUses.limited && <p className="mt-1 text-xs text-ink-faint">{tCommon("uses.alertMornings")}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => save(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {t("alerts.enable")}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={nudges}
            disabled={saving}
            onChange={(e) => save(enabled, e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {t("alerts.nudgeToggle")}
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("alerts.emailPlaceholder")}
          dir="ltr"
          className={inputCls}
        />
        <Button
          size="sm"
          variant="secondary"
          loading={running}
          disabled={saving || limitInvalid || searchUses.out}
          onClick={runNow}
        >
          {t("alerts.runNow")}
        </Button>
        {unsaved && (
          <Button size="sm" loading={saving} disabled={limitInvalid} onClick={() => save(enabled)}>
            {t("common:actions.save")}
          </Button>
        )}
      </div>
      <UsesNote feature="search" className="mt-2">
        {tCommon("uses.runNow")}
      </UsesNote>
      {/* Beside the two controls it explains -- the ticked "Email me new jobs"
          above it and the disabled Run now -- and not at the foot of the card.
          It used to be the last line of all, under the customize hint, so the
          reader met an enabled toggle and a dead button first and the one
          sentence that accounts for both was the furthest thing from them. */}
      {paused && (
        <p className="mt-1 text-xs text-warn">
          {pausedDate ? tCommon("uses.alertPaused", { date: pausedDate }) : tCommon("uses.alertPausedBare")}
        </p>
      )}

      {/* PLAN 32: the same morning, as a notification on this device. Only on a
          server that sends notifications (`push` is null otherwise). */}
      {push && (
        <PushRow
          devices={push}
          here={pushHere}
          onChange={(devices, here) => {
            setPush(devices);
            setPushHere(here);
          }}
        />
      )}
      {wa && <WhatsAppRow status={wa} onChange={(next) => setWa(next.available ? next : null)} />}

      {/* The fit bar. Its own row rather than a sixth control in the row above:
          at 390px that row already wraps to three lines, and this is a sentence
          about the email rather than another toggle. */}
      <div className="mt-4">
        <label className="flex max-w-xs flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("alerts.minScore")}
          <select
            value={minScore ?? 0}
            disabled={saving}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className={inputCls}
          >
            {MIN_SCORE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t("alerts.minScoreAny") : t("alerts.minScoreOption", { n })}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-xs text-ink-faint">{t("alerts.minScoreHint")}</p>
      </div>

      <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={customOpen}
          disabled={saving || prefilling}
          onChange={(e) => toggleCustomize(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        {t("alerts.customize")}
      </label>

      {customOpen && (
          <div className="animate-fade-up">
            <CustomizeFields ctx={ctx} setCtx={setCtx} prefilling={prefilling} />
            <p className="mt-3 text-xs text-ink-muted">{t("alerts.customizeHint")}</p>
          </div>
      )}
      {!customOpen && <p className="mt-1 text-xs text-ink-faint">{t("alerts.autoNote")}</p>}

      <div className="mt-3 space-y-1 text-xs text-ink-muted">
        {unsaved && <p className="text-warn">{t("alerts.unsaved")}</p>}
        {settings.last_run_at && (
          <p>
            {/* The bar line only for a run that actually measured against one.
                `last_above_min == null` is a run from before the bar existed —
                unknown, not zero — and claiming "0 above your 75% bar" about a
                morning that had no bar is the row-predates-the-field lie. */}
            {(settings.min_score ?? 0) > 0 && settings.last_above_min != null
              ? t("alerts.lastRunBar", {
                  date: settings.last_run_at.slice(0, 10),
                  count: settings.last_new_count,
                  n: settings.last_above_min,
                  bar: settings.min_score,
                })
              : t("alerts.lastRun", {
                  date: settings.last_run_at.slice(0, 10),
                  count: settings.last_new_count,
                })}
          </p>
        )}
        {settings.last_error && <p className="text-danger">{settings.last_error}</p>}
        {(enabled || nudges) && !settings.smtp_configured && (
          <p className="text-warn">{t("alerts.noSmtp")}</p>
        )}
      </div>
    </Card>
  );
}

/** The email alert's ONE switch, for the Jobs page (PLAN 31.5/3). The full form
 * (the address, the fit bar, the alert's own search, the reminders and Run now)
 * lives in Settings, `#alerts`; the Jobs page keeps what a person reaches for
 * beside their matches: on or off. The PUT sends the saved address, search and
 * reminder choice back as they are and never the fit bar, whose absence the
 * server reads as "leave it" (`AlertSettingsIn.min_score`). With no address
 * saved there is nothing to switch on yet, so the switch is a link to the form
 * where it is typed. Renders nothing until the alert has been read, and nothing
 * for a backend without alerts, like the card. */
export function AlertSwitch() {
  const { t } = useTranslation("jobs");
  const { t: tCommon, i18n } = useTranslation();
  const toast = useToast();
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const alertUses = useUses("job_alert");

  useEffect(() => {
    let live = true;
    getJobAlert()
      .then((s) => {
        if (live) setSettings(s);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // Its row is HELD while the alert is read: it sits above the saved matches,
  // and arriving late it pushed the first job down 18-44 px under the thumb
  // (measured at 390 px). Only an alert that cannot be read gives the row up.
  if (failed) return null;
  if (!settings) return <div aria-hidden className="min-h-[44px]" />;
  // The card's own paused rule, word for word: the server's reading, or a spent
  // month the store knows of, and never while the count is unknown.
  const paused =
    alertUses.limited && (settings.paused_reason === "monthly_limit" || (settings.enabled && alertUses.out));
  const pausedDate = paused ? formatUsesDate(settings.resumes_on || alertUses.resetsOn, i18n.language) : "";

  async function toggle(next: boolean) {
    if (!settings) return;
    setSaving(true);
    try {
      setSettings(
        await updateJobAlert({
          enabled: next,
          email: settings.email,
          context: settings.context ?? null,
          nudge_emails: !!settings.nudge_emails,
        }),
      );
      toast("success", t("alerts.saved"));
    } catch (e: any) {
      toast("error", apiErrorMessage(e, t("alerts.saveError")));
    } finally {
      setSaving(false);
    }
  }

  const needsAddress = !settings.enabled && !settings.email.trim();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {needsAddress ? (
        <Link
          to="/settings#alerts"
          className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-accent-soft hover:underline"
        >
          <Bell size={14} aria-hidden /> {t("alerts.setUp")}
        </Link>
      ) : (
        <>
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={saving}
              onChange={(e) => void toggle(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            {t("alerts.enable")}
          </label>
          <Link to="/settings#alerts" className="text-xs text-ink-muted hover:text-ink hover:underline">
            {t("alerts.settingsLink")}
          </Link>
        </>
      )}
      {paused && (
        <span className="text-xs text-warn">
          {pausedDate ? tCommon("uses.alertPaused", { date: pausedDate }) : tCommon("uses.alertPausedBare")}
        </span>
      )}
    </div>
  );
}
