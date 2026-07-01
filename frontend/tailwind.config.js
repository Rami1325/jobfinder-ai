/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Seeded from the original styles.css design tokens, extended for depth.
        bg: {
          DEFAULT: "#0f1420",
          soft: "#0c1019",
          elevated: "#131a28",
        },
        panel: {
          DEFAULT: "#18202f",
          2: "#1f2a3d",
        },
        line: "#2b3850",
        ink: {
          DEFAULT: "#e6ecf5",
          muted: "#9aa7bd",
          faint: "#6b7891",
        },
        accent: {
          DEFAULT: "#4f8cff",
          soft: "#6ea0ff",
          deep: "#2f6bdc",
        },
        mint: "#2bd4a0",
        warn: "#ffc96b",
        danger: "#ff6b6b",
      },
      fontFamily: {
        sans: ['"Segoe UI"', "system-ui", "-apple-system", "sans-serif"],
      },
      borderRadius: {
        xl2: "14px",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(79,140,255,.25), 0 8px 40px -8px rgba(79,140,255,.45)",
        "glow-mint": "0 0 0 1px rgba(43,212,160,.25), 0 8px 40px -8px rgba(43,212,160,.4)",
        panel: "0 20px 60px -20px rgba(0,0,0,.6)",
        card: "0 1px 0 rgba(255,255,255,.03) inset, 0 12px 30px -18px rgba(0,0,0,.7)",
      },
      backgroundImage: {
        "grid-faint":
          "linear-gradient(to right, rgba(79,140,255,.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(79,140,255,.06) 1px, transparent 1px)",
        "accent-gradient": "linear-gradient(135deg, #4f8cff 0%, #2bd4a0 100%)",
        "hero-glow":
          "radial-gradient(60% 50% at 50% 0%, rgba(79,140,255,.18) 0%, rgba(15,20,32,0) 70%)",
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
