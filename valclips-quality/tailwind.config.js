/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07090d',
          900: '#0a0d12',
          850: '#0e1219',
          800: '#131826',
          700: '#1b2233',
          600: '#273049'
        },
        accent: {
          DEFAULT: '#ff4655',
          soft: '#ff8791'
        },
        teal: {
          DEFAULT: '#18e0c8',
          soft: '#7ff0e2'
        },
        warn: '#ffb24d',
        ok: '#3ddc84'
      },
      fontFamily: {
        sans: ['"Segoe UI Variable Display"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Mono"', 'Consolas', 'monospace']
      },
      borderRadius: {
        card: '14px'
      },
      boxShadow: {
        glow: '0 0 24px rgba(255,70,85,0.25)',
        'glow-teal': '0 0 24px rgba(24,224,200,0.2)',
        card: '0 8px 32px rgba(0,0,0,0.45)'
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      },
      animation: {
        'fade-up': 'fade-up 240ms cubic-bezier(0.22,1,0.36,1) both',
        shimmer: 'shimmer 2.4s linear infinite'
      }
    }
  },
  plugins: []
}
