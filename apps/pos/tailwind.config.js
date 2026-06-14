/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ─── Sabir Juice Corner brand palette (1973) ─────────────────────────
        // Primary identity: the warm sun-yellow of the juice glass logo.
        // Used for brand surfaces, headers, accents, and the login hero.
        sjc: {
          50:  "#fffbeb",
          100: "#fef3c7",
          200: "#fde68a",
          300: "#fcd34d",
          400: "#fbbf24",
          500: "#f59e0b",   // brand yellow
          600: "#d97706",
          700: "#b45309",
          800: "#92400e",
          900: "#78350f",
        },
        // CTA / attention color — the bold red of the brand's straw and "1973" mark.
        // Used for primary action buttons (Pay, Sign in, Add) and high-attention badges.
        accent: {
          50:  "#fef2f2",
          100: "#fee2e2",
          200: "#fecaca",
          300: "#fca5a5",
          400: "#f87171",
          500: "#ef4444",
          600: "#dc2626",   // brand red
          700: "#b91c1c",
          800: "#991b1b",
          900: "#7f1d1d",
        },
        // Leaf-green accent — used sparingly for the green sprig in the logo and small badges.
        leaf: {
          400: "#4ade80",
          500: "#22c55e",
          600: "#16a34a",
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
        // For brand wordmark display. Replace with a hosted brand-font @font-face if you license one.
        display: ['Georgia', 'ui-serif', 'serif'],
      },
    },
  },
  plugins: [],
};
