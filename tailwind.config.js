/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--color-background) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        "surface-elevated": "rgb(var(--color-surface-elevated) / <alpha-value>)",
        border: "rgb(var(--color-border) / <alpha-value>)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        primary: "rgb(var(--color-primary) / <alpha-value>)",
        divider: "rgb(var(--color-divider) / <alpha-value>)",
        destructive: "rgb(var(--color-destructive) / <alpha-value>)",
        "press-highlight": "rgb(var(--color-press-highlight) / <alpha-value>)",
      },
      borderRadius: {
        button: "8px",
        "section-card": "14px",
        "list-card": "10px",
        dialog: "16px",
        sheet: "16px",
        menu: "12px",
        input: "8px",
        pill: "20px",
        segment: "8px",
      },
      spacing: {
        xs: "4px",
        sm: "8px",
        md: "12px",
        base: "16px",
        lg: "20px",
        xl: "24px",
        "2xl": "32px",
        "3xl": "48px",
      },
    },
  },
  plugins: [],
};
