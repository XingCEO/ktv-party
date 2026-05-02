/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      screens: {
        tv: '1280px',
      },
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
      spacing: {
        'safe-bottom': 'calc(env(safe-area-inset-bottom) + 16px)',
      },
      boxShadow: {
        glow: '0 0 32px rgba(255, 77, 141, 0.4)',
        neon: '0 0 15px rgba(255, 209, 102, 0.5), 0 0 30px rgba(255, 209, 102, 0.3)',
      },
      backgroundImage: {
        'stage': 'radial-gradient(ellipse at top, #1a1a2e 0%, #0a0a0f 70%)',
        'pink-gold': 'linear-gradient(135deg, #ff4d8d, #ffd166)',
      },
      animation: {
        "pulse-slow": "breathe 3s ease-in-out infinite",
        "marquee": "marquee 18s linear infinite",
        "shimmer": "shimmer 2.5s infinite linear",
        "fade-up": "fade-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "breathe": "breathe 3s ease-in-out infinite",
      },
      keyframes: {
        marquee: {
          "0%": { transform: "translateX(100%)" },
          "100%": { transform: "translateX(-100%)" },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "fade-up": {
          "0%": { opacity: 0, transform: "translateY(16px)" },
          "100%": { opacity: 1, transform: "translateY(0)" },
        },
        breathe: {
          "0%, 100%": { opacity: 0.6, transform: "scale(0.98)" },
          "50%": { opacity: 1, transform: "scale(1)" },
        },
      },
    },
  },
  plugins: [],
};
