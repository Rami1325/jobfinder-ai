# The tracker page — the board, the phone list, and Analytics

> **Handbook file.** Started on 2026-09-23 (PLAN 31.2/7); until then no department held the tracker PAGE, only
> the rows it shows. Every bullet records a defect that shipped or a measurement taken on the running app: edit it
> the way you would edit code, and add new findings here, not in `CLAUDE.md`.
>
> **Read before touching** `pages/TrackerPage.tsx`, `components/TrackerAnalytics.tsx`, `lib/trackerSort.ts` or
> `hooks/useTrackerMetrics.ts`. What a tracker ROW records, one posting one row, and the privacy wipe are in
> `data-and-privacy.md`; the inbox bar, the Needs-review sheet, each card's email timeline and its date line
> (`CardDate`) are in `inbox.md`; delete-with-undo is check-mirrors 51 (`testing.md`).

### A list on a phone, the board from `md` (PLAN 31.2/7, 2026-09-23)

- **What it was, measured at 390x664.** Five counters and two rate rings in one card filled the first screen, and the board's first column started at **y = 609 of 664**. The five status columns were swiped sideways, one per screen, and each card showed its status twice: a split-flap chip and a full-width `<select>` under it.
- **Below `md` it is status tabs over one vertical list** (the list at **y = 290**). Each tab carries its count, and the page opens on the first status that has anything in it, so it never lands on an empty tab while another holds the user's applications. A status change moves the card to its new tab, and C2's accent flash plays on the tab that received it. From `md` the five-column grid is unchanged.
- **Only ONE of the two is mounted** (`useBoardFits`, a live `matchMedia` on 768 px), never both behind CSS. Both render every card, and the board's `layoutId` glide and the split-flap's `pendingFlips` entry each assume one copy of a card on the page: a second copy would register the same `layoutId` and consume the flip the visible one needed.
- **The status is ONE tappable chip**: the split-flap face shows it, a chevron says it opens, and a native `<select>` lies over it, transparent, labelled "Status". A phone opens its own picker and a screen reader hears "Status, Applied". The full-width select is gone, on the board as well.
- **The list's sort includes the date applied** (`lib/trackerSort.ts`): Newest (the day it was added), Date applied, and Match. Under Date applied every row WITH an applied date comes before every row without one, newest first on both sides: an unknown date is not an early one (the house rule), and the explicit rule holds even if the direction is ever flipped. People rely on this sort; LinkedIn's new tracker drew complaints for dropping it, some from people who report their applications for unemployment.
- **The counters are one line** ("3 Total · 1 Applied · 0 Interviews · 0 Offers · 0 Declined"), and **the two rings moved to Analytics**, at its top, with the denominator still riding along as the label ("100%" over one application reads as that). The "gone quiet" nudge comes first, above the counters.
- check-mirrors 58 EXECUTES the sort (undated after dated, by score, by the day added, no sorting in place) and pins the one mount, the labelled chip, no full-width select, and the rings on Analytics rather than the board. Measured at 390x664 in both languages and at 1440x900.
