import json

import frappe
from frappe import _

from company_dashboard.api.mis import _require_dashboard_access

no_cache = 1


def get_context(context):
	"""Render the Biz Dashboard SPA shell."""
	if frappe.session.user == "Guest":
		frappe.throw(_("Please log in to access the dashboard."), frappe.PermissionError)
	_require_dashboard_access()

	boot = frappe.sessions.get()
	context.update(
		{
			"boot": json.dumps(boot, default=str),
			"csrf_token": frappe.sessions.get_csrf_token(),
			"app_name": "Biz Dashboard",
		}
	)
	return context


@frappe.whitelist()
def get_context_for_dev():
	"""Returns boot + csrf for the Vite dev server (it can't render the Jinja template)."""
	_require_dashboard_access()
	return {
		"boot": frappe.sessions.get(),
		"csrf_token": frappe.sessions.get_csrf_token(),
	}
