import type { Config } from "tailwindcss";

export default {
	content: ["./index.html", "./src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				bg: "var(--bg)",
				surface: "var(--surface)",
				"surface-2": "var(--surface2)",
				"surface-3": "var(--surface3)",
				border: "var(--border)",
				"border-md": "var(--border-md)",
				"border-strong": "var(--border-strong)",
				text: "var(--text)",
				"text-2": "var(--text2)",
				"text-3": "var(--text3)",
				"text-4": "var(--text4)",
				green: {
					DEFAULT: "var(--green)",
					bg: "var(--green-bg)",
					mid: "var(--green-mid)",
				},
				amber: { DEFAULT: "var(--amber)", bg: "var(--amber-bg)" },
				blue: { DEFAULT: "var(--blue)", bg: "var(--blue-bg)" },
				red: { DEFAULT: "var(--red)", bg: "var(--red-bg)" },
				purple: { DEFAULT: "var(--purple)", bg: "var(--purple-bg)" },
				teal: { DEFAULT: "var(--teal)", bg: "var(--teal-bg)" },
				"sidebar-bg": "#14231A",
			},
			fontFamily: {
				sans: ["DM Sans", "system-ui", "sans-serif"],
				serif: ["DM Serif Display", "Georgia", "serif"],
			},
			borderRadius: {
				DEFAULT: "12px",
				sm: "8px",
				xs: "6px",
			},
			fontSize: {
				"2xs": "10px",
				xs: "11px",
			},
		},
	},
	plugins: [],
} satisfies Config;
