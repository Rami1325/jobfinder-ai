import { useTranslation } from "react-i18next";
import LandingHeader from "../components/landing/LandingHeader";
import LandingHero from "../components/landing/LandingHero";
import TemplateStage from "../components/landing/TemplateStage";
import HowItWorks from "../components/landing/HowItWorks";
import FeatureList from "../components/landing/FeatureList";
import ScanBand from "../components/landing/ScanBand";
import LandingFaq from "../components/landing/LandingFaq";
import ClosingSection from "../components/landing/ClosingSection";
import { useLandingTheme } from "../hooks/useLandingTheme";

/**
 * The public landing page.
 *
 * ROUTE-OWNED, deliberately. It used to sit inside `MarketingLayout` with the
 * public scan, sharing that layout's header, its warm-paper token scope and its
 * aurora. `/privacy` still does. This page carries its own header and its own
 * `.jobfinder-landing` token scope instead, so nothing here can reach another
 * route and the marketing shell cannot drag the landing back to paper.
 *
 * The wrapper class is the whole isolation mechanism: `.jobfinder-landing`
 * re-declares --bg / --ink / --line / --accent on this subtree only (see
 * styles.css), so every Tailwind token utility underneath resolves to the
 * landing palette while `/app` keeps whatever the theme toggle chose.
 *
 * Order: one immersive opening, then the product itself, then how it is made,
 * then where else it is used, then the CV scan, then the questions, then the
 * invitation. Each section is calmer than the one before it.
 */
export default function Landing() {
  const { t } = useTranslation("marketing");
  const { mode, toggle } = useLandingTheme();

  return (
    /* `isolate` is not decoration: the hero's star scene sits at `-z-10` so it
       can pass UNDER the next section's text, and without a stacking context
       here that negative z escapes to the root element and paints BEHIND this
       wrapper's own background — the whole sculpture simply disappears, on a
       green build. Seen, not reasoned about. */
    <div className={`jobfinder-landing isolate min-h-screen ${mode === "light" ? "is-light" : ""}`}>
      {/* First tab stop on the page. Visible the moment it has focus. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-[rgb(var(--cta-fill))] focus:px-5 focus:py-3 focus:text-[15px] focus:font-medium focus:text-[rgb(var(--cta-ink))]"
      >
        {t("landing.skipToContent")}
      </a>

      <LandingHeader mode={mode} toggleTheme={toggle} />

      <main id="main">
        <LandingHero mode={mode} />
        <TemplateStage />
        <HowItWorks />
        <FeatureList />
        <ScanBand />
        <LandingFaq />
        <ClosingSection mode={mode} />
      </main>
    </div>
  );
}
