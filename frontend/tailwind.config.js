/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Heebo', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          900: '#1e3a8a',
        },
      },
      animation: {
        // Pick-by-Light: green pulse to draw the picker's eye.
        'pickbylight': 'pickbylight 1.4s ease-in-out infinite',
      },
      keyframes: {
        pickbylight: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(34, 197, 94, 0.6)' },
          '50%':       { boxShadow: '0 0 0 12px rgba(34, 197, 94, 0)' },
        },
      },
    },
  },
  plugins: [],
};
