/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcdaff',
          300: '#8ec4ff',
          400: '#59a3ff',
          500: '#3380fb',
          600: '#1c60f0',
          700: '#174cdc',
          800: '#193fb2',
          900: '#1a398c',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.06), 0 1px 3px rgba(16,24,40,0.1)',
        panel: '0 12px 32px rgba(16,24,40,0.12)',
      },
    },
  },
  plugins: [],
};
