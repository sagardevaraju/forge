import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Wire the design tokens defined in app/globals.css (:root) into
      // Tailwind so surfaces reference semantic names (`bg-surface`,
      // `text-ink-muted`, `ring-accent`) instead of hardcoded `zinc-*` /
      // `emerald-700`. The previous `background`/`foreground` mapping pointed
      // at `--background`/`--foreground` vars that were never defined — those
      // utilities resolved to nothing. `--accent` (#047857) is exactly
      // Tailwind's emerald-700, so swapping brand-accent usages to `accent`
      // is a zero-pixel change.
      colors: {
        canvas: "var(--bg)",
        surface: "var(--surface)",
        ink: {
          DEFAULT: "var(--ink)",
          muted: "var(--ink-muted)",
          faint: "var(--ink-faint)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
        },
        hairline: {
          DEFAULT: "var(--hairline)",
          strong: "var(--hairline-strong)",
        },
      },
    },
  },
  plugins: [],
};
export default config;
