import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fef3f0',
          100: '#fde4dc',
          200: '#fbc4b1',
          300: '#f79a7e',
          400: '#f17048',
          500: '#e95028',
          600: '#cf3b1b',
          700: '#a92e18',
          800: '#7d2412',
          900: '#561a0e'
        }
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif'
        ]
      }
    }
  },
  plugins: []
};

export default config;
