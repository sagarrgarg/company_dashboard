import json

import frappe
from frappe import _

from company_dashboard.api.mis import _require_mis_access

no_cache = 1


def get_context(context):
	"""Render the MIS SPA shell.

	Adds ``boot`` and ``csrf_token`` to the Jinja context; the Vite-built ``mis.html``
	template reads them into ``window.frappe.boot`` / ``window.csrf_token`` before the
	bundle runs.

	Access is gated by :func:`company_dashboard.api.mis._require_mis_access`. Users
	without one of the configured MIS roles get a 403 Forbidden, not a redirect to
	login (logged-in users without role would otherwise loop on /login).
	"""
	if frappe.session.user == "Guest":
		frappe.throw(_("Please log in to access the MIS dashboard."), frappe.PermissionError)
	_require_mis_access()

	boot = frappe.sessions.get()
	context.update(
		{
			"boot": json.dumps(boot, default=str),
			"csrf_token": frappe.sessions.get_csrf_token(),
			"app_name": "Company Dashboard MIS",
		}
	)
	return context


@frappe.whitelist()
def get_context_for_dev():
	"""Returns boot + csrf for the Vite dev server (it can't render the Jinja template)."""
	_require_mis_access()
	return {
		"boot": frappe.sessions.get(),
		"csrf_token": frappe.sessions.get_csrf_token(),
	}
