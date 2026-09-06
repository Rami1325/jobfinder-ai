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
 * ROUTE-OWNED, deliberately. It used to sit inside `MarketingLayout` with
 * `/scan`, sharing that layout's header, its warm-paper token scope and its
 * aurora. `/scan` still does, unchanged — this page carries its own header and
 * its own `.jobfinder-landing` token scope instead, so nothing here can reach
 * another route and `/scan` cannot drag the landing back to paper.
 *
 * The wrapper class is the whole isolation mechanism: `.jobfinder-landing`
 * re-declares --bg / --ink / --line / --accent on this subtree only (see
 * styles.css), so every Tailwind token utility underneath resolves to the
 * landing palette while `/app` keeps whatever the theme toggle chose.
 *
 * Order: one immersive opening, then the product itself, then how it is made,
 * then where else it is used, then the free way in, then the questions, then
 * the invitation. Each section is calmer than the one before it.
 */
export default function Landing() {
  const { t } = useTranslation("marketing");
  const { mode, toggle } = useLandingTheme();

  return (
    <div className={`jobfinder-landing min-h-screen ${mode === "light" ? "is-light" : ""}`}>
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
