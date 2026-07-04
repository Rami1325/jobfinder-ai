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
        sans: ['"Segoe UI"', "system-ui", "-apple-system", "sans-serif"],
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
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
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
      },
      animation: {
        "fade-up": "fade-up .5s cubic-bezier(.22,1,.36,1) both",
        "pulse-glow": "pulse-glow 3s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};
