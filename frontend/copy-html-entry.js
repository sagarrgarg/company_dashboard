import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const src = resolve("../company_dashboard/public/company_dashboard/index.html");
const dest = resolve("../company_dashboard/www/bizdashboard.html");

const boot = `
<script>
	window.csrf_token = "{{ csrf_token }}";
	window.frappe = window.frappe || {};
	window.frappe.boot = {{ boot }};
</script>
`;

let html = readFileSync(src, "utf-8");
// inject boot/csrf before </head>
html = html.replace(/<\/head>/i, `${boot}</head>`);

mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, html);
console.log(`[build] wrote ${dest}`);
