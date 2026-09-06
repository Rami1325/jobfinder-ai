/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic tokens defined as RGB channel triplets in src/styles.css
        // (:root = dark, :root.light = light). <alpha-value> keeps /opacity
        // modifiers (e.g. bg-accent/20) working per theme.
        bg: {
          DEFAULT: "rgb(var(--bg) / <alpha-value>)",
          soft: "rgb(var(--bg-soft) / <alpha-value>)",
          elevated: "rgb(var(--bg-elevated) / <alpha-value>)",
        },
        panel: {
          DEFAULT: "rgb(var(--panel) / <alpha-value>)",
          2: "rgb(var(--panel-2) / <alpha-value>)",
        },
        line: "rgb(var(--line) / <alpha-value>)",
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          muted: "rgb(var(--ink-muted) / <alpha-value>)",
          faint: "rgb(var(--ink-faint) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          soft: "rgb(var(--accent-soft) / <alpha-value>)",
          deep: "rgb(var(--accent-deep) / <alpha-value>)",
        },
        mint: "rgb(var(--mint) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        // Marketing-only aurora/tint hues. Decorative — they never carry
        // text. Defined on both :root and .paper in styles.css so these
        // utilities are safe anywhere, but they are only *designed* for the
        // paper landing.
        paper: {
          mint: "rgb(var(--paper-mint) / <alpha-value>)",
          violet: "rgb(var(--paper-violet) / <alpha-value>)",
          peach: "rgb(var(--paper-peach) / <alpha-value>)",
          blush: "rgb(var(--paper-blush) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
      },
      borderRadius: {
        xl2: "14px",
        xl3: "22px",
      },
      boxShadow: {
        // Per-theme shadow strings live in styles.css (glows in dark,
        // soft neutral shadows in light/paper).
        glow: "var(--shadow-glow)",
        "glow-mint": "var(--shadow-glow-mint)",
        panel: "var(--shadow-panel)",
        card: "var(--shadow-card)",
        // The resume-page lift used by the landing's document thumbnails.
        doc: "var(--shadow-doc)",
      },
      backgroundImage: {
        "grid-faint": "var(--grid-faint)",
        "accent-gradient":
          "linear-gradient(135deg, rgb(var(--accent)) 0%, rgb(var(--mint)) 100%)",
        "hero-glow": "var(--hero-glow)",
      },
      transitionTimingFunction: {
        // The house easing — every ease-out in the app is this curve.
        "out-quint": "cubic-bezier(.22,1,.36,1)",
      },
      keyframes: {
        // The spotlight a block gets when it takes your edit, or when a review
        // row points at it. It ENDS on the resting highlight, not on nothing:
        // styles.css collapses every animation to 0.001ms under
        // prefers-reduced-motion, which parks an element at its `to` state, so
        // a bloom that faded out would leave a reduced-motion user with no
        // indication at all. Ending settled means that user simply gets the
        // highlight instantly, which is the correct reduced-motion behaviour.
        "block-settle": {
          "0%": { outlineColor: "rgb(var(--accent) / 0)", outlineOffset: "8px", backgroundColor: "rgb(var(--accent) / 0)" },
          "45%": { outlineColor: "rgb(var(--accent) / 0.8)", outlineOffset: "2px", backgroundColor: "rgb(var(--accent) / 0.16)" },
          "100%": { outlineColor: "rgb(var(--accent) / 0.6)", outlineOffset: "2px", backgroundColor: "rgb(var(--accent) / 0.1)" },
        },
        // Byte-identical to the above, and that is the point. A CSS animation
        // only restarts when its NAME changes, and the class string is the same
        // when the same block is spotted twice running — so the second save to
        // one block would silently not re-bloom. The caller alternates these by
        // nonce parity.
        "block-settle-alt": {
          "0%": { outlineColor: "rgb(var(--accent) / 0)", outlineOffset: "8px", backgroundColor: "rgb(var(--accent) / 0)" },
          "45%": { outlineColor: "rgb(var(--accent) / 0.8)", outlineOffset: "2px", backgroundColor: "rgb(var(--accent) / 0.16)" },
          "100%": { outlineColor: "rgb(var(--accent) / 0.6)", outlineOffset: "2px", backgroundColor: "rgb(var(--accent) / 0.1)" },
        },

        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // The review drawer. TRANSFORM ONLY -- never a height tween, which is
        // what check-mirrors 11 exists to forbid and what froze seven shipped
        // reveals at an interpolated pixel height.
        //
        // The start offset is a custom property rather than a literal because
        // the drawer opens from the INLINE-END edge: that is the right in LTR
        // and the left in RTL, so a hard-coded `100%` would slide the Hebrew
        // drawer in from the wrong side of the screen, across the document it
        // is about to sit beside.
        "drawer-in": {
          "0%": { opacity: "0", transform: "translateX(var(--drawer-from, 100%))" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        // One radial spark line of a click burst; --a is set per-spark inline.
        spark: {
          "0%": { transform: "rotate(var(--a)) translateY(-6px) scaleY(1)", opacity: "1" },
          "100%": { transform: "rotate(var(--a)) translateY(-22px) scaleY(0.35)", opacity: "0" },
        },
        "pulse-glow": {
          "0%,100%": { opacity: "0.5" },
          "50%": { opacity: "1" },
        },
        float: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        // PLAN 15.9: the "Tailor my top matches" attention ring — opacity-only
        // (the ring's static shadow rides along on the compositor).
        "kit-attract": {
          "0%,100%": { opacity: "0" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        // `both` so the 0% state holds before the first frame and the settled
        // 100% state holds after the last one -- the highlight must persist
        // for the caller's full spotlight window, not snap away at 520ms.
        "block-settle": "block-settle .52s cubic-bezier(.22,1,.36,1) both",
        "block-settle-alt": "block-settle-alt .52s cubic-bezier(.22,1,.36,1) both",
        "fade-up": "fade-up .5s cubic-bezier(.22,1,.36,1) both",
        // `both`, so it ENDS on its resting state: the global
        // prefers-reduced-motion rule collapses this to 0.001ms with one
        // iteration, and an animation that ended on nothing would park the
        // drawer off screen for exactly the users who asked for less motion.
        "drawer-in": "drawer-in .18s cubic-bezier(.22,1,.36,1) both",
        spark: "spark .4s cubic-bezier(.22,1,.36,1) forwards",
        "pulse-glow": "pulse-glow 3s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        shimmer: "shimmer 1.6s infinite",
        // 3 breaths, starts once the result rows have settled, ends invisible.
        "kit-attract": "kit-attract 1.1s ease-in-out .6s 3 both",
      },
    },
  },
  plugins: [],
};
