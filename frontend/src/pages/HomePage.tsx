import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ArrowUpRight,
  Award,
  BadgeCheck,
  Bell,
  FileCheck2,
  FileText,
  Layers,
  Lock,
  MessagesSquare,
  ScanLine,
  Search,
  Send,
  ShieldCheck,
  Wand2,
  XCircle,
} from "lucide-react";
import { getJobAlert, getJobHistory, listApplications } from "../api/client";
import { getKitsState, loadKits, subscribeKits } from "../state/kitsStore";
import { useMasterResume } from "../hooks/useMasterResume";
import { useSaveMasterResume, masterResumeLabel } from "../hooks/useSaveMasterResume";
import { useTrackerMetrics } from "../hooks/useTrackerMetrics";
import { resumeLanguage } from "../lib/lang";
import { cn } from "../lib/cn";
import ResumeUpload from "../components/ResumeUpload";
import {
  Badge,
  Card,
  CardTitle,
  CountUp,
  ProgressRing,
  SectionLabel,
  Skeleton,
  SpotlightCard,
} from "../components/ui";
import type {
  AlertSettings,
  ApplicationOut,
  FactsLedger,
  JobSearchHit,
  ResumeModel,
} from "../types";

const SOURCE_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  drushim: "Drushim",
  comeet: "Comeet",
  jobmaster: "JobMaster",
  greenhouse: "Greenhouse",
};
const sourceLabel = (s?: string) =>
  !s ? "" : SOURCE_LABELS[s.toLowerCase()] ?? s.charAt(0).toUpperCase() + s.slice(1);

function greetingKey(): "morning" | "afternoon" | "evening" {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

function QuickAction({
  to,
  icon: Icon,
  title,
  body,
}: {
  to: string;
  icon: typeof Search;
  title: string;
  body: string;
}) {
  return (
    <Link
      to={to}
      className="block rounded-xl2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <SpotlightCard className="flex h-full flex-col p-5">
        <div className="flex items-center justify-between">
          <span className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-panel-2 text-accent-soft transition-colors group-hover:border-accent/40">
            <Icon size={19} />
          </span>
          <ArrowUpRight
            size={18}
            className="text-ink-faint transition-colors group-hover:text-accent-soft rtl:-scale-x-100"
          />
        </div>
        <h3 className="mt-4 text-base font-semibold text-ink">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{body}</p>
      </SpotlightCard>
    </Link>
  );
}

function MatchRow({ hit }: { hit: JobSearchHit }) {
  const { t } = useTranslation("home");
  const nav = useNavigate();
  const tone =
    hit.overall >= 80
      ? "border-mint/50 bg-mint/10"
      : hit.overall >= 60
        ? "border-warn/50 bg-warn/10"
        : "border-accent/40 bg-accent/10";
  return (
    <div className="flex items-center gap-3 border-t border-line/60 py-3 first:border-t-0">
      <span
        className={cn(
          "grid h-12 w-12 shrink-0 place-items-center rounded-xl border-2 text-sm font-bold tabular-nums text-ink",
          tone,
        )}
      >
        {Math.round(hit.overall)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 max-w-full truncate text-sm font-semibold text-ink">
            {hit.title || "—"}
          </p>
          {hit.source && <Badge className="shrink-0">{sourceLabel(hit.source)}</Badge>}
        </div>
        <p className="truncate text-xs text-ink-muted">
          {hit.company || "—"}
          {hit.location ? ` · ${hit.location}` : ""}
        </p>
      </div>
      <button
        onClick={() =>
          nav("/app", {
            state: {
              jdText: hit.jd_text,
              jobUrl: hit.url || undefined,
              jobTitle: hit.title,
              company: hit.company,
            },
          })
        }
        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-accent/55"
      >
        <ArrowRight size={13} className="rtl:-scale-x-100" /> {t("recent.tailor")}
      </button>
    </div>
  );
}

// Module-level cache so revisiting Home renders the pipeline + recent matches
// from the last load instead of flashing skeletons; it refreshes in the
// background. null = never loaded.
let homeCache: {
  apps: ApplicationOut[];
  history: JobSearchHit[];
  alert: AlertSettings | null;
} | null = null;

export default function HomePage() {
  const { t } = useTranslation("home");
  const nav = useNavigate();
  const { master, masters, loading: masterLoading } = useMasterResume();
  const persistMaster = useSaveMasterResume();

  const [apps, setApps] = useState<ApplicationOut[]>(homeCache?.apps ?? []);
  const [history, setHistory] = useState<JobSearchHit[]>(homeCache?.history ?? []);
  const [alert, setAlert] = useState<AlertSettings | null>(homeCache?.alert ?? null);
  const [dataLoading, setDataLoading] = useState(homeCache === null);
  const { kits } = useSyncExternalStore(subscribeKits, getKitsState);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Best-effort in parallel — each card just hides itself if its call fails.
      const [a, h, al] = await Promise.allSettled([
        listApplications(),
        getJobHistory(),
        getJobAlert(),
      ]);
      if (!alive) return;
      // Merge with the prior cache so a single failed call doesn't blank a card.
      const next = {
        apps: a.status === "fulfilled" ? a.value : homeCache?.apps ?? [],
        history: h.status === "fulfilled" ? h.value.hits : homeCache?.history ?? [],
        alert: al.status === "fulfilled" ? al.value : homeCache?.alert ?? null,
      };
      homeCache = next;
      setApps(next.apps);
      setHistory(next.history);
      setAlert(next.alert);
      setDataLoading(false);
    })();
    loadKits();
    return () => {
      alive = false;
    };
  }, []);

  const metrics = useTrackerMetrics(apps);
  const awaitingKits = kits?.filter((k) => k.status === "done").length ?? 0;

  async function onResumeUploaded(r: ResumeModel, l: FactsLedger) {
    await persistMaster(r, l); // best-effort; useMasterResume re-derives on next mount
  }

  if (masterLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-72" />
        <Skeleton className="h-40 w-full" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  // Gate: no master résumé yet → the front-door upload.
  if (!master?.resume) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mx-auto max-w-2xl"
      >
        <Card className="px-5 py-10 text-center sm:px-10">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-accent/10 text-accent-soft">
            <FileText />
          </div>
          <h1 className="text-2xl font-bold text-ink">{t("gate.title")}</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">{t("gate.body")}</p>
          <div className="mt-6 text-start">
            <ResumeUpload onParsed={onResumeUploaded} />
          </div>
        </Card>
      </motion.div>
    );
  }

  const firstName = master.resume.contact.name?.trim().split(/\s+/)[0] ?? "";
  const greeting = t(`greeting.${greetingKey()}`, { name: firstName ? `, ${firstName}` : "" });

  const tiles: { label: string; value: number; icon: typeof Layers; cls: string }[] = [
    { label: t("snapshot.total"), value: metrics.total, icon: Layers, cls: "bg-accent/12 text-accent" },
    { label: t("snapshot.applied"), value: metrics.applied, icon: Send, cls: "bg-accent/12 text-accent" },
    { label: t("snapshot.interviews"), value: metrics.interviews, icon: MessagesSquare, cls: "bg-mint/12 text-mint" },
    { label: t("snapshot.offers"), value: metrics.offers, icon: Award, cls: "bg-mint/12 text-mint" },
    { label: t("snapshot.declined"), value: metrics.declined, icon: XCircle, cls: "bg-danger/12 text-danger" },
  ];

  const trust = [
    { icon: ShieldCheck, text: t("trust.guard") },
    { icon: FileCheck2, text: t("trust.ats") },
    { icon: Lock, text: t("trust.private") },
  ];

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink sm:text-[26px]">{greeting}</h1>
          <p className="mt-1 text-sm text-ink-muted">{t("sub")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {masters.map((m) => (
            <span
              key={m.language ?? "en"}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-mint/40 bg-mint/10 px-3 py-1 text-xs font-medium text-mint"
            >
              <BadgeCheck size={13} className="shrink-0" />
              <span className="truncate">{m.label || masterResumeLabel(m.resume)}</span>
              {masters.length > 1 && (
                <span className="shrink-0 text-mint/80">
                  · {(m.language ?? resumeLanguage(m.resume)) === "he" ? "HE" : "EN"}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Pipeline snapshot */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <Card glow className="relative overflow-hidden p-0">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-accent-gradient" aria-hidden />
          <div className="flex flex-col gap-6 p-5 sm:p-6 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1">
              <SectionLabel>{t("snapshot.title")}</SectionLabel>
              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
                {tiles.map((tile, i) => (
                  <motion.div
                    key={tile.label}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.06 * i, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                    className="flex items-center gap-3"
                  >
                    <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", tile.cls)}>
                      <tile.icon size={17} />
                    </span>
                    <div className="min-w-0">
                      <CountUp
                        to={tile.value}
                        className="block text-2xl font-bold leading-none tabular-nums text-ink"
                      />
                      <div className="mt-1 truncate text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-muted sm:tracking-[0.12em]">
                        {tile.label}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-center gap-6 border-line lg:border-s lg:ps-6">
              <ProgressRing value={metrics.responseRate} size={104} stroke={9} tone="accent" sublabel={t("snapshot.responseRate")} />
              <ProgressRing value={metrics.interviewRate} size={104} stroke={9} tone="mint" sublabel={t("snapshot.interviewRate")} />
            </div>
          </div>
        </Card>
      </motion.div>

      {/* Quick actions */}
      <div>
        <SectionLabel className="mb-2">{t("actions.title")}</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-3">
          <QuickAction to="/jobs" icon={Search} title={t("actions.findJobs.title")} body={t("actions.findJobs.body")} />
          <QuickAction to="/app" icon={Wand2} title={t("actions.tailor.title")} body={t("actions.tailor.body")} />
          <QuickAction to="/scan" icon={ScanLine} title={t("actions.scan.title")} body={t("actions.scan.body")} />
        </div>
      </div>

      {/* Recent matches + side column */}
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card className="min-w-0">
          <div className="flex items-center justify-between">
            <CardTitle>{t("recent.title")}</CardTitle>
            <Link to="/jobs" className="text-xs font-semibold text-accent-soft hover:underline">
              {t("recent.viewAll")} →
            </Link>
          </div>
          <div className="mt-2">
            {dataLoading ? (
              <div className="space-y-3 py-2">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : history.length === 0 ? (
              <p className="py-6 text-sm text-ink-muted">{t("recent.empty")}</p>
            ) : (
              history.slice(0, 4).map((hit) => <MatchRow key={hit.id} hit={hit} />)
            )}
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {/* Kits awaiting review */}
          <Card className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent-soft">
              <Wand2 size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle>{t("kits.title")}</CardTitle>
              <p className="mt-1 text-xs text-ink-muted">
                {awaitingKits > 0 ? t("kits.awaiting", { count: awaitingKits }) : t("kits.none")}
              </p>
              {awaitingKits > 0 && (
                <button
                  onClick={() => nav("/jobs", { state: { tab: "kits" } })}
                  className="mt-2 text-xs font-semibold text-accent-soft hover:underline"
                >
                  {t("kits.review")} →
                </button>
              )}
            </div>
          </Card>

          {/* Daily alert */}
          <Card className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent-soft">
              <Bell size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle className="flex items-center gap-2">
                {t("alert.title")}
                {alert?.enabled && (
                  <span className="h-2 w-2 rounded-full bg-mint shadow-[0_0_0_3px_rgb(var(--mint)/0.18)]" aria-hidden />
                )}
              </CardTitle>
              <p className="mt-1 text-xs text-ink-muted">
                {alert?.enabled
                  ? t("alert.on", { count: alert.last_new_count })
                  : t("alert.off")}
              </p>
              <Link to="/jobs" className="mt-2 inline-block text-xs font-semibold text-accent-soft hover:underline">
                {t("alert.manage")} →
              </Link>
            </div>
          </Card>
        </div>
      </div>

      {/* Trust strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-dashed border-line bg-bg-soft/50 px-4 py-3">
        {trust.map(({ icon: Icon, text }) => (
          <span key={text} className="inline-flex items-center gap-2 text-xs text-ink-muted">
            <Icon size={15} className="shrink-0 text-mint" /> {text}
          </span>
        ))}
      </div>
    </div>
  );
}
