import { useCallback, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import StarfieldCanvas from "./StarfieldCanvas";
import { Cta } from "./ui";
import type { LandingMode } from "../../hooks/useLandingTheme";

/**
 * The immersive opening: a full-bleed star scene with the copy centred in a
 * clear reading area and the brightest part of the sculpture below it.
 *
 * WHAT MOVES AND WHAT DOES NOT. The scene has depth and answers the pointer.
 * The heading, the paragraph, the buttons and the header do not move at all —
 * no tilt, no magnetism, no parallax on type. The one thing the visitor can
 * read is the one thing that stays still.
 *
 * LAYERS. The scene (wash + canvas) sits at `-z-10` and is TALLER than this
 * section, so it continues past the fold and is masked out rather than cut.
 * Above it, in order: the scrim, the copy, the Pause control. The header is
 * `fixed z-50` over everything.
 *
 * The minimum height is viewport-BASED, not fixed: on a short window the
 * padding shrinks and the section is free to grow, so the heading and both
 * calls to action are inside the first screen at 1366x768 and at 390x844
 * without ever being clipped.
 */
export default function LandingHero({ mode }: { mode: LandingMode }) {
  const { t } = useTranslation("marketing");
  const heroRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [capable, setCapable] = useState(false);

  // Stable identity: this is a dependency of the renderer's listener effect,
  // and a new function every render would tear the loop down and rebuild it.
  const onCapableChange = useCallback((v: boolean) => setCapable(v), []);

  return (
    <section
      ref={heroRef}
      className="relative flex min-h-[100svh] flex-col justify-center px-5 pb-28 pt-28 sm:px-8 sm:pt-32 lg:px-14"
    >
      {/* THE SCENE IS TALLER THAN THE HERO AND DISSOLVES INTO THE PAGE.
          Clipped at the section boundary it read as a cropped photograph: the
          lower arms were sliced by a dead-straight line and the base wash
          stopped dead against the flat near-black below it. So the scene box
          runs 32% past the hero (`.lp-scene`), carries the wash with it, and is
          masked out over that overhang — the arms simply thin away into the
          next section's ground.

          It sits at `-z-10` and the landing root is the stacking context that
          contains it, which is what lets it pass UNDER the following section's
          text instead of over it. That is also why this section no longer
          carries `isolate`: a stacking context here would keep the whole hero
          — overhang included — painting above every later sibling. */}
      <div ref={sceneRef} aria-hidden className="lp-scene lp-space pointer-events-none absolute inset-x-0 top-0 -z-10">
        <StarfieldCanvas
          containerRef={heroRef}
          sceneRef={sceneRef}
          readingRef={readingRef}
          paused={paused}
          mode={mode}
          onCapableChange={onCapableChange}
        />
      </div>

      {/* The restrained scrim. It is a soft ellipse behind the copy, not an
          opaque rectangle over the scene — the particle fade around the
          reading zone does most of this work already. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            mode === "dark"
              ? "radial-gradient(52% 34% at 50% 40%, rgb(5 9 13 / 0.72) 0%, rgb(5 9 13 / 0) 100%)"
              : "radial-gradient(52% 34% at 50% 40%, rgb(247 248 250 / 0.8) 0%, rgb(247 248 250 / 0) 100%)",
        }}
      />

      {/* `readingRef` is the WHOLE copy column. The sculpture dims behind it
          and places its nucleus just below it, so the composition follows the
          text instead of a fixed fraction of the hero — which is what keeps the
          bright knot clear of the copy at 1366x768, where the block sits much
          lower in the viewport than it does at 1440x900. */}
      <div ref={readingRef} className="relative z-10 mx-auto w-full max-w-[1040px] text-center">
        <p className="lp-in text-[13px] font-medium uppercase tracking-[0.24em] text-ink-faint rtl:tracking-normal">
          {t("landing.hero.eyebrow")}
        </p>

        <h1
          className="lp-display mx-auto mt-6 text-ink"
          style={{ fontSize: "clamp(2.625rem, 5.6vw, 5.75rem)", animationDelay: "70ms" }}
        >
          {/* Two lines by intent. They are separate blocks rather than a <br>,
              so each still wraps on its own at 320px instead of overflowing. */}
          <span className="lp-in block" style={{ animationDelay: "70ms" }}>
            {t("landing.hero.line1")}
          </span>
          <span className="lp-in block" style={{ animationDelay: "150ms" }}>
            {t("landing.hero.line2")}
          </span>
        </h1>

        <p
          className="lp-in mx-auto mt-6 max-w-[52ch] text-[17px] leading-relaxed text-ink-muted sm:text-[19px]"
          style={{ animationDelay: "230ms" }}
        >
          {t("landing.hero.sub")}
        </p>

        <div
          className="lp-in mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center"
          style={{ animationDelay: "300ms" }}
        >
          {/* To /signup, not /app: /app would bounce a new visitor through the
              auth guard to /login, which is the wrong door for someone who has
              no account yet. */}
          <Cta to="/signup" arrow>
            {t("landing.hero.ctaPrimary")}
          </Cta>
          <Cta to="/scan" variant="secondary">
            {t("landing.hero.ctaSecondary")}
          </Cta>
        </div>

        <p
          className="lp-in mt-8 text-[13px] text-ink-faint"
          style={{ animationDelay: "370ms" }}
        >
          {/* PDF and DOCX are Latin marks inside a Hebrew sentence: isolated so
              the separator does not migrate across them in RTL. */}
          <bdi>PDF</bdi> &amp; <bdi>DOCX</bdi> · {t("landing.hero.langs")}
        </p>
        <p
          className="lp-in mx-auto mt-2 max-w-[46ch] text-[13px] leading-relaxed text-ink-faint"
          style={{ animationDelay: "410ms" }}
        >
          {t("landing.hero.access")}
        </p>
      </div>

      {/* Ambient motion continues while people read, so the way to stop it is
          on the page — not in a settings screen. Hidden only when this device
          and these preferences never animate in the first place. */}
      {capable && (
        <div className="absolute inset-x-0 bottom-5 z-20 flex justify-center">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-[13px] font-medium text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
            {paused ? t("landing.hero.resumeBg") : t("landing.hero.pauseBg")}
          </button>
        </div>
      )}
    </section>
  );
}
