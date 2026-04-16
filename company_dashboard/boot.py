import frappe


def boot_session(bootinfo):
	"""Attach MIS-specific fields to the session boot payload.

	The web controller for ``/mis`` serialises ``bootinfo`` into the HTML template so the
	SPA can read ``window.frappe.boot`` without an extra round trip.
	"""
	bootinfo["company_dashboard"] = {
		"default_company": frappe.defaults.get_global_default("company"),
		"has_erpnext": "erpnext" in frappe.get_installed_apps(),
		"user_roles": frappe.get_roles(frappe.session.user),
	}
