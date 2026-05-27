import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: '0.8rem',
        md: 'calc(0.8rem - 2px)',
        sm: 'calc(0.8rem - 4px)',
      },
      boxShadow: {
        panel: '0 18px 50px rgba(7, 10, 17, 0.18)',
      },
      backgroundImage: {
        mesh:
          'radial-gradient(circle at top left, rgba(253, 186, 116, 0.16), transparent 28%), radial-gradient(circle at top right, rgba(56, 189, 248, 0.16), transparent 24%), radial-gradient(circle at bottom center, rgba(94, 234, 212, 0.12), transparent 30%)',
      },
    },
  },
  plugins: [],
}

export default config
