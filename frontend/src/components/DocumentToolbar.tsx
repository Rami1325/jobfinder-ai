import type { ReactNode } from "react";

interface Props {
  /** Before the title: a tailored draft's way back to the master. */
  lead?: ReactNode;
  /** The document's own name — this page's <h1>. */
  title: string;
  /** Measured, live readouts that sit beside the title. */
  badges?: ReactNode;
  /** Verbs and the save cluster, pushed to the far end. */
  actions?: ReactNode;
  /** Anything either side still has to say, on its own line. */
  notes?: ReactNode;
}

/**
 * One row of chrome directly over the document: identity and live metrics at
 * the start, verbs and save at the end, and whatever will not fit on a line
 * underneath.
 *
 * DUMB ON PURPOSE. Every prop is a slot, so the decisions about *which* badge
 * and *which* verb belong to a document stay in `TailorPage` and only the
 * geometry lives here. That is what lets the same bar carry a master resume,
 * a tailored draft and an empty page without a mode flag.
 *
 * The title IS the heading. `/app` used to open with "Tailor your resume" over
 * a one-line subtitle — two rows of chrome that between them said less than the
 * document's own name does, on a page whose whole subject is the document under
 * them. Naming the CV here let both strings go.
 *
 * ONE ROW on a phone, at most 64 px (PLAN 31.2/1: it measured 139 px on the
 * master and 241 on a tailored draft at 390, four rows and a note stuck over
 * the paper). The title takes whatever the other items leave (`flex-1
 * basis-0`), so a long name truncates instead of pushing a button onto a
 * second line; only `notes` and the save cluster's panels break the row.
 *
 * ONE flex row, wrapping. `notes` is a `w-full` child of that row rather than a
 * second container underneath, which is what lets a save failure or a language
 * warning break onto its own line *and* stay inside the same sticky, blurred
 * bar — a failure that scrolls away is the one that gets missed.
 *
 * Sticky under the app header (`h-14` / 3.5rem) and as wide as the window, the
 * same as the header: on /app `main` is full width (AppLayout), so this bar's
 * glass and hairline reach both edges with no bleed, and its `px-4 lg:px-8` is
 * the header's own padding, so the title lines up under the logo and the last
 * action under the account button. The document below it is centred by
 * `.app-col`; this bar deliberately does not wear it.
 */
export default function DocumentToolbar({ lead, title, badges, actions, notes }: Props) {
  return (
    <div className="sticky top-14 z-20 border-b border-line/70 bg-bg/85 px-4 py-2 backdrop-blur-xl lg:px-8">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 sm:gap-x-3">
        {lead}
        {/* `min-w-0` so a long name ellipsizes instead of shouldering the
            badges onto a line of their own.

            `dir="auto"` — the ONE place in this app it is right, and the paper
            is the reason to spell that out. `ResumeView` bans it because the
            document's direction has to match the file the renderers produce,
            computed from the resume's prose with the name deliberately
            excluded. This is chrome, and its whole content IS the name. A
            Hebrew name in an English UI is RTL text in an LTR block, so
            `truncate` clips at the box's right edge — the LOGICAL START of the
            name — and shows the tail with an ellipsis on the wrong side. */}
        <h1 dir="auto" className="min-w-0 flex-1 basis-0 truncate text-sm font-semibold text-ink">
          {title}
        </h1>
        {badges}
        {/* Not wrapped: the save cluster ships a `w-full` sibling for its error
            and language-warning panels, and a wrapper would make `w-full` mean
            the wrapper's own shrink-to-fit width instead of the row's. The
            growing title is what pushes these to the end. */}
        {actions}
        {notes && <div className="w-full">{notes}</div>}
      </div>
    </div>
  );
}
