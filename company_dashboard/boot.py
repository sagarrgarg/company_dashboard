import frappe

from company_dashboard.api.mis import MIS_ACCESS_ROLES, WC_ACCESS_ROLES
from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
	get_coming_soon_tiles,
)


def boot_session(bootinfo):
	"""Attach dashboard-specific fields to the session boot payload."""
	user = frappe.session.user
	roles = set(frappe.get_roles(user))
	is_admin = user == "Administrator"
	bootinfo["company_dashboard"] = {
		"default_company": frappe.defaults.get_global_default("company"),
		"has_erpnext": "erpnext" in frappe.get_installed_apps(),
		"user_roles": list(roles),
		"sections": {
			"mis": is_admin or bool(roles & MIS_ACCESS_ROLES),
			"wc": is_admin or bool(roles & WC_ACCESS_ROLES),
		},
		"coming_soon_tiles": get_coming_soon_tiles(),
	}
