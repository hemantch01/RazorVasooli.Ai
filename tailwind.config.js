/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: {
          light: '#f8fafc',
          DEFAULT: '#f8fafc',
          dark: '#0f0e17',
        },
        surface: {
          card: '#ffffff',
          DEFAULT: '#ffffff',
          subtle: '#f1f5f9',
          border: '#e2e8f0',
        },
        brand: {
          orange: '#ff8906',
          peach: '#f5b771',
          pink: '#e53170',
          violet: '#8b5cf6',
          emerald: '#10b981',
          crimson: '#ef4444',
        },
        headline: '#0f172a',
        paragraph: '#64748b',
        subtext: '#94a3b8',
      },
      fontFamily: {
        heading: ['Outfit', 'system-ui', 'sans-serif'],
        body: ['Sora', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05)',
        'card-hover': '0 10px 15px -3px rgba(0, 0, 0, 0.07), 0 4px 6px -4px rgba(0, 0, 0, 0.05)',
        'glow-orange': '0 4px 20px rgba(255, 137, 6, 0.25)',
        'glow-pink': '0 4px 20px rgba(229, 49, 112, 0.25)',
        'glow-violet': '0 4px 20px rgba(139, 92, 246, 0.25)',
        'glow-emerald': '0 4px 20px rgba(16, 185, 129, 0.25)',
      },
      animation: {
        'spin-slow': 'spin 2s linear infinite',
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.35s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};
