/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        'ak-bg': 'var(--ak-bg)',
        'ak-primary': 'var(--ak-primary)',
        'ak-primary-soft': 'var(--ak-primary-soft)',
        'ak-surface': 'var(--ak-surface)',
        'ak-surface-2': 'var(--ak-surface-2)',
        'ak-surface-3': 'var(--ak-surface-3)',
        'ak-text-primary': 'var(--ak-text-primary)',
        'ak-text-secondary': 'var(--ak-text-secondary)',
        'ak-text-tertiary': 'var(--ak-text-tertiary)',
        'ak-border': 'var(--ak-border)',
        'ak-border-subtle': 'var(--ak-border-subtle)',
        'ak-border-default': 'var(--ak-border-default)',
        'ak-border-strong': 'var(--ak-border-strong)',
        'ak-danger': 'var(--ak-danger)',
        'ak-hover': 'var(--ak-hover-surface)',
        'ak-active': 'var(--ak-active-surface)',
        'ak-bg-sidebar': 'var(--ak-bg-sidebar)',
        'ak-bg-chat': 'var(--ak-bg-chat)',
        'ak-bg-input': 'var(--ak-bg-input)',
        'ak-bg-bubble-user': 'var(--ak-bg-bubble-user)',
        'ak-bg-panel': 'var(--ak-bg-panel)',
        'ak-scribe': '#38bdf8',
        'ak-proto': '#f59e0b',
        'ak-trace': '#a78bfa',
      },
      fontFamily: {
        sans: ["'DM Sans'", 'system-ui', 'sans-serif'],
        mono: ["'JetBrains Mono'", 'monospace'],
      },
      fontSize: {
        'display': ['var(--ak-text-display)', { lineHeight: '1.2', fontWeight: '700' }],
        'heading': ['var(--ak-text-heading)', { lineHeight: '1.4', fontWeight: '600' }],
        'body': ['var(--ak-text-body)', { lineHeight: '1.5' }],
        'caption': ['var(--ak-text-caption)', { lineHeight: '1.5' }],
        'micro': ['var(--ak-text-micro)', { lineHeight: '1.4' }],
      },
      // Glow shadows (Liquid Neon)
      boxShadow: {
        'ak-glow': 'var(--ak-glow-accent)',
        'ak-glow-sm': 'var(--ak-glow-subtle)',
        'ak-glow-lg': '0 0 40px rgba(7, 209, 175, 0.3)',
        'ak-sm': '0 2px 8px rgba(0, 0, 0, 0.4)',
        'ak-md': '0 4px 16px rgba(0, 0, 0, 0.5)',
        'ak-lg': '0 8px 32px rgba(0, 0, 0, 0.6)',
        'ak-elevation-1': 'var(--ak-elevation-1)',
        'ak-elevation-2': 'var(--ak-elevation-2)',
        'ak-elevation-3': 'var(--ak-elevation-3)',
      },
      borderRadius: {
        'ak-card': 'var(--ak-card-radius)',
      },
      spacing: {
        'ak-section': 'var(--ak-section-gap)',
        'ak-card': 'var(--ak-card-padding)',
      },
      // Motion durations
      transitionDuration: {
        'fast': 'var(--ak-motion-fast)',
        'base': 'var(--ak-motion-base)',
        'slow': 'var(--ak-motion-slow)',
      },
      // Blur values
      blur: {
        'backdrop': 'var(--ak-blur-backdrop)',
        'card': 'var(--ak-blur-card)',
        'blob': 'var(--ak-blur-blob)',
      },
      // Animation keyframes for liquid background
      keyframes: {
        'blob-drift': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)', opacity: '0.15' },
          '25%': { transform: 'translate(20px, -15px) scale(1.05)', opacity: '0.18' },
          '50%': { transform: 'translate(-10px, 10px) scale(0.95)', opacity: '0.12' },
          '75%': { transform: 'translate(15px, 20px) scale(1.02)', opacity: '0.16' },
        },
        'blob-drift-alt': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)', opacity: '0.12' },
          '33%': { transform: 'translate(-25px, 10px) scale(1.08)', opacity: '0.15' },
          '66%': { transform: 'translate(15px, -20px) scale(0.92)', opacity: '0.10' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'thinking': {
          '0%, 100%': { opacity: '0.2' },
          '50%': { opacity: '1' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.92)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'float-gentle': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'draw-line': {
          '0%': { width: '0%' },
          '100%': { width: '100%' },
        },
        'shake-subtle': {
          '0%, 100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-3px)' },
          '75%': { transform: 'translateX(3px)' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.8' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'border-glow': {
          '0%, 100%': { borderColor: 'rgba(7, 209, 175, 0.15)' },
          '50%': { borderColor: 'rgba(7, 209, 175, 0.4)' },
        },
        'progress-fill': {
          '0%': { width: '0%', opacity: '0.6' },
          '100%': { width: '100%', opacity: '1' },
        },
        'slide-in-left': {
          '0%': { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'blob-drift': 'blob-drift 20s ease-in-out infinite',
        'blob-drift-alt': 'blob-drift-alt 25s ease-in-out infinite',
        'slide-in-right': 'slide-in-right 200ms ease-out',
        'fade-in': 'fade-in 300ms ease-out',
        'thinking': 'thinking 1.4s infinite',
        'scale-in': 'scale-in 300ms ease-out',
        'float-gentle': 'float-gentle 3s ease-in-out infinite',
        'slide-up': 'slide-up 300ms ease-out',
        'draw-line': 'draw-line 600ms ease-out forwards',
        'shake-subtle': 'shake-subtle 300ms ease-in-out',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'shimmer': 'shimmer 1.5s ease-in-out infinite',
        'border-glow': 'border-glow 2s ease-in-out infinite',
        'progress-fill': 'progress-fill 600ms ease-out forwards',
        'slide-in-left': 'slide-in-left 200ms ease-out',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
