import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: Object.fromEntries([950, 900, 800, 700, 600, 500].map((k) => [k, `rgb(var(--ink-${k}) / <alpha-value>)`])),
        slate: { ...colors.slate, 500: "#d9a67a", 600: "#e8b98f", 700: "#f5cfa8", ...Object.fromEntries([100, 200, 300, 400].map((k) => [k, `rgb(var(--slate-${k}) / <alpha-value>)`])) },
        fg: "rgb(var(--fg) / <alpha-value>)",
        tier: { 0: "#7c8499", 1: "#38d6ff", 2: "#3dff9a", 3: "#ffc23d", 4: "#ff4fd8" },
        breach: "#ff3b4d",
        accent: "#ff6a1a",
        usdc: "#2775ca",
        leaf: { 50: "#150d07", 100: "#2a1a0d", 200: "#3d2512", 500: "#ff6a1a", 600: "#ff6a1a", 700: "#ff8a3d", 800: "#ffedd5", 900: "#ffd9b0", 950: "#ff8a3d" },
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        heading: ["var(--font-italic)", "Georgia", "serif"],
        italic: ["var(--font-italic)", "Georgia", "serif"],
      },
      keyframes: {
        pulseRing: { "0%": { transform: "scale(.9)", opacity: ".9" }, "100%": { transform: "scale(1.6)", opacity: "0" } },
        ticker: { "0%": { transform: "translateX(0)" }, "100%": { transform: "translateX(-50%)" } },
        rise: { "0%": { transform: "translateY(8px)", opacity: "0" }, "100%": { transform: "translateY(0)", opacity: "1" } },
        float: { "0%, 100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-14px)" } },
        breathe: { "0%, 100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.012) translateY(-2px)" } },
      },
      animation: {
        pulseRing: "pulseRing 1.6s ease-out infinite",
        ticker: "ticker 40s linear infinite",
        rise: "rise .35s ease-out both",
        float: "float 6s ease-in-out infinite",
        breathe: "breathe 5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
