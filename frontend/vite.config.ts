import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

const resolveBenchPort = () => {
	try {
		const cfg = JSON.parse(
			readFileSync("../../../sites/common_site_config.json", "utf-8"),
		);
		return cfg.webserver_port ?? 8000;
	} catch {
		return 8000;
	}
};

const benchPort = resolveBenchPort();

export default defineConfig({
	plugins: [react()],
	server: {
		port: 8082,
		proxy: {
			"^/(app|api|assets|files|private|method)": {
				target: `http://127.0.0.1:${benchPort}`,
				changeOrigin: true,
				secure: false,
				ws: true,
			},
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	build: {
		outDir: "../company_dashboard/public/company_dashboard",
		emptyOutDir: true,
		sourcemap: false,
		rollupOptions: {
			output: {
				manualChunks: {
					"vendor-react": ["react", "react-dom", "react-router-dom"],
					"vendor-charts": ["recharts"],
				},
			},
		},
	},
});
