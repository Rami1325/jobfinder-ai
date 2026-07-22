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
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
      },
      borderRadius: {
        xl2: "14px",
      },
      boxShadow: {
        // Per-theme shadow strings live in styles.css (glows in dark,
        // soft neutral shadows in light).
        glow: "var(--shadow-glow)",
        "glow-mint": "var(--shadow-glow-mint)",
        panel: "var(--shadow-panel)",
        card: "var(--shadow-card)",
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
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
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
        "fade-up": "fade-up .5s cubic-bezier(.22,1,.36,1) both",
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
