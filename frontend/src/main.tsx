import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

declare global {
	interface Window {
		csrf_token?: string;
		frappe?: { boot?: Record<string, unknown> };
	}
}

async function bootstrapDevSession() {
	if (!import.meta.env.DEV) return;
	if (window.frappe?.boot) return;
	try {
		const res = await fetch("/api/method/company_dashboard.www.mis.get_context_for_dev", {
			credentials: "include",
		});
		if (!res.ok) return;
		const json = await res.json();
		const ctx = json.message ?? json;
		window.frappe = window.frappe ?? {};
		window.frappe.boot = ctx.boot;
		window.csrf_token = ctx.csrf_token;
	} catch (err) {
		// dev bootstrap failures are non-fatal — user can still hit the app
		console.warn("[MIS] dev boot fetch failed:", err);
	}
}

void bootstrapDevSession().finally(() => {
	ReactDOM.createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<App />
		</React.StrictMode>,
	);
});
