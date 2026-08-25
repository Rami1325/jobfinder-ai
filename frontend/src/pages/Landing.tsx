import Hero from "../components/marketing/Hero";
import TemplateShowcase from "../components/marketing/TemplateShowcase";
import FreeScanStrip from "../components/marketing/FreeScanStrip";
import StatStrip from "../components/marketing/StatStrip";
import HowItWorks from "../components/marketing/HowItWorks";
import WhyHonesty from "../components/marketing/WhyHonesty";
import Receipts from "../components/marketing/Receipts";
import FeatureGrid from "../components/marketing/FeatureGrid";
import FAQ from "../components/marketing/FAQ";
import FinalCTA from "../components/marketing/FinalCTA";
import Footer from "../components/marketing/Footer";

/**
 * The marketing landing, on the paper palette (see MarketingLayout).
 *
 * Rhythm: the page runs light all the way down except for one full-bleed dark
 * band (WhyHonesty) roughly at the midpoint, which is where the argument
 * turns from "here is what it makes" to "here is why it is honest".
 */
export default function Landing() {
  return (
    <>
      <Hero />
      <TemplateShowcase />
      <FreeScanStrip />
      <StatStrip />
      <HowItWorks />
      <WhyHonesty />
      <Receipts />
      <FeatureGrid />
      <FAQ />
      <FinalCTA />
      <Footer />
    </>
  );
}
