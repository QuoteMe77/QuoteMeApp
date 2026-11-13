import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "#EDF1F6",
        "paper-raised": "#FFFFFF",
        ink: "#0B1B33",
        "ink-soft": "#5A6B82",
        line: "#DCE3EC",
        "line-strong": "#B8C4D3",
        brass: "#1A7FC4",
        "brass-deep": "#0B1B33",
        spruce: "#1F7A55",
        brick: "#B3392B",
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
        body: ["Inter", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
