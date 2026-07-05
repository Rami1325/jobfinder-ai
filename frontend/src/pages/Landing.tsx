import Hero from "../components/marketing/Hero";
import FreeScanStrip from "../components/marketing/FreeScanStrip";
import HowItWorks from "../components/marketing/HowItWorks";
import FeatureGrid from "../components/marketing/FeatureGrid";
import WhyHonesty from "../components/marketing/WhyHonesty";
import FAQ from "../components/marketing/FAQ";
import FinalCTA from "../components/marketing/FinalCTA";
import Footer from "../components/marketing/Footer";

export default function Landing() {
  return (
    <>
      <Hero />
      <FreeScanStrip />
      <HowItWorks />
      <WhyHonesty />
      <FeatureGrid />
      <FAQ />
      <FinalCTA />
      <Footer />
    </>
  );
}
