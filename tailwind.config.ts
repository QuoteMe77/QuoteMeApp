import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "#EFEAE0",
        "paper-raised": "#FBF8F3",
        ink: "#241E17",
        "ink-soft": "#6B6053",
        line: "#D9CFBE",
        "line-strong": "#B9AC94",
        brass: "#9C6B2E",
        "brass-deep": "#7C5423",
        spruce: "#445E52",
        brick: "#96422F",
      },
      fontFamily: {
        display: ["Fraunces", "Georgia", "serif"],
        body: ["Inter", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
