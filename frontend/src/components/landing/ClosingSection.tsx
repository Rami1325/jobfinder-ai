import { useId } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Logo from "../Logo";
import EchoCanvas from "./EchoCanvas";
import { Cta, Rise, signupFor } from "./ui";
import type { LandingMode } from "../../hooks/useLandingTheme";

/**
 * The last invitation, and the footer under it.
 *
 * Behind it, a STATIC echo of the hero's formation — `EchoCanvas` draws one
 * frame and schedules nothing, and the `.lp-echo` gradient underneath is what
 * a browser with no 2D context is left with. Never a second particle engine:
 * there is no animation loop anywhere in this half of the page.
 *
 * The footer carries the navigation and one sentence about the product. What
 * it deliberately does not carry any more is the paragraph explaining why
 * there are no reviews: a page with no testimonials on it does not need a
 * footnote drawing attention to the fact.
 */
export default function ClosingSection({ mode }: { mode: LandingMode }) {
  const { t } = useTranslation();
  const { t: tm } = useTranslation("marketing");
  const headingId = useId();

  return (
    <>
      <section
        aria-labelledby={headingId}
        className="lp-echo relative isolate overflow-hidden px-5 pb-24 pt-20 text-center sm:px-8 md:pb-32 md:pt-28 lg:px-14"
      >
        <EchoCanvas mode={mode} />
        <Rise className="relative z-10 mx-auto w-full max-w-[760px]">
          <h2 id={headingId} className="lp-display text-[2.25rem] text-ink sm:text-[3rem] lg:text-[3.5rem]">
            {tm("landing.closing.title")}
          </h2>
          <p className="mx-auto mt-5 max-w-[46ch] text-[17px] leading-relaxed text-ink-muted sm:text-[19px]">
            {tm("landing.closing.sub")}
          </p>
          <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <Cta to="/signup" arrow>
              {tm("landing.hero.ctaPrimary")}
            </Cta>
            <Cta to={signupFor("/tools/scan")} variant="secondary">
              {tm("landing.closing.ctaSecondary")}
            </Cta>
          </div>
        </Rise>
      </section>

      {/* Edge to edge with the same px as LandingHeader, so the mark and the
          nav links line up under the header's mark and buttons. */}
      <footer className="border-t border-line px-5 py-12 sm:px-8">
        <div className="flex w-full flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-[42ch]">
            <Logo size={26} />
            <p className="mt-3 text-[14px] leading-relaxed text-ink-muted">
              {tm("landing.footer.blurb")}
            </p>
          </div>
          <nav
            aria-label={tm("footer.navLabel")}
            className="-my-1 flex flex-wrap gap-x-7 text-[14px] text-ink-muted"
          >
            <Link to="/app" className="inline-flex min-h-[44px] items-center rounded hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t("footer.app")}
            </Link>
            <Link to={signupFor("/tools/scan")} className="inline-flex min-h-[44px] items-center rounded hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t("footer.freeScan")}
            </Link>
            <a href="#templates" className="inline-flex min-h-[44px] items-center rounded hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {tm("templates.nav")}
            </a>
            <a href="#how" className="inline-flex min-h-[44px] items-center rounded hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t("footer.how")}
            </a>
            <a href="#features" className="inline-flex min-h-[44px] items-center rounded hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t("header.features")}
            </a>
            <a href="#faq" className="inline-flex min-h-[44px] items-center rounded hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t("footer.faq")}
            </a>
            <Link to="/privacy" className="inline-flex min-h-[44px] items-center rounded hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t("footer.privacy")}
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
