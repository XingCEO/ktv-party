/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ktv: {
          bg: "#0a0a0f",
          panel: "#15151f",
          accent: "#ff4d8d",
          gold: "#ffd166",
          mic: "#06d6a0",
        },
      },
      fontFamily: {
        sans: ["'Noto Sans TC'", "system-ui", "sans-serif"],
        karaoke: ["'Noto Sans TC'", "system-ui", "sans-serif"],
      },
      animation: {
        "pulse-slow": "pulse 2.5s ease-in-out infinite",
        "marquee": "marquee 18s linear infinite",
      },
      keyframes: {
        marquee: {
          "0%": { transform: "translateX(100%)" },
          "100%": { transform: "translateX(-100%)" },
        },
      },
    },
  },
  plugins: [],
};
