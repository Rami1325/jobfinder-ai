import { Check, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChangeLogEntry, FabricationFlag } from "../types";
import type { DiffSeg, EditSection, ResumeEdit } from "../lib/resumeDiff";
import { editContainsValue, keywordsServed, wordDiff } from "../lib/resumeDiff";
import { Badge, Card, CardTitle } from "./ui";
import { cn } from "../lib/cn";

interface Props {
  edits: ResumeEdit[];
  changelog: ChangeLogEntry[];
  flags: FabricationFlag[];
  jdKeywords: string[];
  rejected: ReadonlySet<string>;
  onSetRejected: (ids: string[]) => void;
}

const SECTION_ORDER: EditSection[] = [
  "summary",
  "skills",
  "experience",
  "projects",
  "education",
  "certifications",
  "militaryService",
  "languages",
  "contact",
];

const kindTone: Record<ResumeEdit["kind"], "accent" | "mint" | "danger"> = {
  edited: "accent",
  added: "mint",
  removed: "danger",
};

function DiffText({ segs, mode }: { segs: DiffSeg[]; mode: "before" | "after" }) {
  return (
    <span dir="auto" className="whitespace-pre-wrap">
      {segs.map((s, i) =>
        s.op === "same" ? (
          <span key={i}>{s.text}</span>
        ) : mode === "before" ? (
          <del key={i} className="rounded bg-danger/15 px-0.5 text-danger no-underline line-through">
            {s.text}
          </del>
        ) : (
          <mark key={i} className="rounded bg-mint/20 px-0.5 font-medium text-mint">
            {s.text}
          </mark>
        ),
      )}
    </span>
  );
}

/** The trust panel: fabrication check + per-edit accept/reject review. */
export default function ChangeLog({ edits, changelog, flags, jdKeywords, rejected, onSetRejected }: Props) {
  const { t } = useTranslation("tailor");

  // A flag is resolved when every edit that introduced its value is rejected.
  const flagRows = flags.map((f) => {
    const carriers = edits.filter((e) => editContainsValue(e, f.value));
    return { flag: f, resolved: carriers.length > 0 && carriers.every((e) => rejected.has(e.id)) };
  });
  const clean = flags.length === 0;
  const allResolved = !clean && flagRows.every((r) => r.resolved);

  const acceptedCount = edits.filter((e) => !rejected.has(e.id)).length;

  const setRejected = (id: string, isRejected: boolean) => {
    const next = new Set(rejected);
    if (isRejected) next.add(id);
    else next.delete(id);
    onSetRejected([...next]);
  };

  return (
    <Card
      id="trust-panel"
      glow={clean || allResolved}
      className={cn("scroll-mt-20", clean || allResolved ? "border-mint/40" : "border-danger/50")}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl",
            clean || allResolved ? "bg-mint/15 text-mint" : "bg-danger/15 text-danger",
          )}
        >
          {clean || allResolved ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
        </span>
        <div>
          <CardTitle>{clean ? t("changelog.cleanTitle") : t("changelog.flaggedTitle")}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">
            {clean
              ? t("changelog.cleanBody")
              : allResolved
                ? t("review.resolvedBody")
                : t("changelog.flagged", { count: flags.length })}
          </p>
        </div>
      </div>

      {!clean && (
        <div className="mt-4 space-y-2">
          {flagRows.map(({ flag: f, resolved }, i) => (
            <div
              key={i}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm",
                resolved ? "border-mint/30 bg-mint/10" : "border-danger/30 bg-danger/10",
              )}
            >
              <span className={cn("font-semibold capitalize", resolved ? "text-mint" : "text-danger")}>
                {f.category}:
              </span>{" "}
              <span className={cn("text-ink", resolved && "line-through opacity-60")}>{f.value}</span>
              {resolved && <span className="ms-2 text-xs font-medium text-mint">{t("review.flagResolved")}</span>}
              {!resolved && f.detail && <div className="mt-0.5 text-xs text-ink-muted">{f.detail}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
          {t("review.title")}
        </h3>
        {edits.length > 0 && (
          <>
            <span className="text-xs tabular-nums text-ink-faint">
              {t("review.accepted", { accepted: acceptedCount, total: edits.length })}
            </span>
            <span className="ms-auto flex gap-3 text-xs">
              <button
                type="button"
                onClick={() => onSetRejected([])}
                disabled={acceptedCount === edits.length}
                className="text-mint hover:underline disabled:cursor-default disabled:opacity-40"
              >
                {t("review.acceptAll")}
              </button>
              <button
                type="button"
                onClick={() => onSetRejected(edits.map((e) => e.id))}
                disabled={acceptedCount === 0}
                className="text-danger hover:underline disabled:cursor-default disabled:opacity-40"
              >
                {t("review.rejectAll")}
              </button>
            </span>
          </>
        )}
      </div>
      {edits.length > 0 && <p className="mt-1 text-xs text-ink-faint">{t("review.note")}</p>}

      {edits.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">{t("changelog.noChanges")}</p>
      ) : (
        <div className="mt-3 space-y-4">
          {SECTION_ORDER.map((section) => {
            const group = edits.filter((e) => e.section === section);
            if (!group.length) return null;
            return (
              <div key={section}>
                <div className="mb-1.5 text-xs font-semibold text-accent-soft">
                  {t(`sections.${section}`)}
                </div>
                <div className="space-y-2">
                  {group.map((edit) => {
                    const isRej = rejected.has(edit.id);
                    const serves = keywordsServed(edit, jdKeywords);
                    const editFlags = flags.filter((f) => editContainsValue(edit, f.value));
                    const d = edit.kind === "edited" ? wordDiff(edit.before, edit.after) : null;
                    return (
                      <div
                        key={edit.id}
                        className={cn(
                          "rounded-lg border border-line bg-panel-2/60 px-3 py-2.5",
                          isRej && "opacity-70",
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={kindTone[edit.kind]}>{t(`review.kind.${edit.kind}`)}</Badge>
                          {edit.context && (
                            <span dir="auto" className="min-w-0 truncate text-xs text-ink-muted">
                              {edit.context}
                            </span>
                          )}
                          {editFlags.length > 0 ? (
                            <Badge tone={isRej ? "mint" : "danger"}>
                              <ShieldAlert size={11} />
                              {isRej
                                ? t("review.flagResolved")
                                : t("review.guardFlagged", { category: editFlags[0].category })}
                            </Badge>
                          ) : (
                            edit.kind !== "removed" && (
                              <Badge tone="mint">
                                <ShieldCheck size={11} /> {t("review.guardOk")}
                              </Badge>
                            )
                          )}
                          <span className="ms-auto inline-flex overflow-hidden rounded-lg border border-line">
                            <button
                              type="button"
                              aria-pressed={!isRej}
                              onClick={() => setRejected(edit.id, false)}
                              className={cn(
                                "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium transition",
                                !isRej ? "bg-mint/20 text-mint" : "text-ink-muted hover:bg-panel-2 hover:text-ink",
                              )}
                            >
                              <Check size={12} /> {t("review.accept")}
                            </button>
                            <button
                              type="button"
                              aria-pressed={isRej}
                              onClick={() => setRejected(edit.id, true)}
                              className={cn(
                                "inline-flex items-center gap-1 border-s border-line px-2 py-1 text-xs font-medium transition",
                                isRej ? "bg-danger/15 text-danger" : "text-ink-muted hover:bg-panel-2 hover:text-ink",
                              )}
                            >
                              <X size={12} /> {t("review.reject")}
                            </button>
                          </span>
                        </div>

                        <div className="mt-2 space-y-1 text-sm leading-relaxed">
                          {edit.kind === "edited" && d && (
                            <>
                              <div className="text-ink-muted">
                                <DiffText segs={d.before} mode="before" />
                              </div>
                              <div className="text-ink">
                                <DiffText segs={d.after} mode="after" />
                              </div>
                            </>
                          )}
                          {edit.kind === "added" && (
                            <div dir="auto" className="whitespace-pre-wrap text-ink">
                              {edit.after}
                            </div>
                          )}
                          {edit.kind === "removed" && (
                            <div dir="auto" className="whitespace-pre-wrap text-ink-muted line-through">
                              {edit.before}
                            </div>
                          )}
                        </div>

                        {(serves.length > 0 || isRej) && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {serves.length > 0 && (
                              <>
                                <span className="text-xs text-ink-faint">{t("review.serves")}</span>
                                {serves.map((kw) => (
                                  <Badge key={kw} tone="accent">
                                    {kw}
                                  </Badge>
                                ))}
                              </>
                            )}
                            {isRej && (
                              <span className="ms-auto text-xs font-medium text-warn">
                                {t(`review.rejectedNote.${edit.kind}`)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {changelog.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted hover:text-ink">
            {t("review.aiNotes")}
          </summary>
          <div className="mt-2 space-y-2">
            {changelog.map((c, i) => (
              <div key={i} className="rounded-lg border-s-2 border-accent bg-panel-2/60 px-3 py-2">
                <div className="text-sm">
                  <span className="font-semibold capitalize text-accent-soft">{c.section}</span>
                  <span className="text-ink"> — {c.change}</span>
                </div>
                {c.reason && (
                  <div className="mt-0.5 text-xs text-ink-muted">{t("changelog.why", { reason: c.reason })}</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
