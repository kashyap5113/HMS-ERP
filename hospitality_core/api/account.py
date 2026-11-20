import re

import frappe
from frappe import _
from frappe.utils import strip_html

PHONE_RE = re.compile(r"^[0-9+()\-\s]{7,20}$")


def _require_login():
    if frappe.session.user == "Guest":
        frappe.throw(_("Please log in to continue."), frappe.PermissionError)


def get_customer_for_user(user=None, create=False):
    """Logged-in user no Customer. create=True hoy to na hoy to banave (ke email thi jaoona Customer ne link kare)."""
    user = user or frappe.session.user
    if user == "Guest":
        frappe.throw(_("Please log in to continue."), frappe.PermissionError)

    name = frappe.db.get_value("Portal User", {"user": user, "parenttype": "Customer"}, "parent")
    if name or not create:
        return name

    u = frappe.db.get_value("User", user, ["email", "full_name", "mobile_no"], as_dict=True)
    s = frappe.get_cached_doc("Hotel Settings")

    # Pehla front-desk/guest booking thi bani hoy tevi Customer same email ni hoy to link karo
    existing = frappe.db.get_value("Customer", {"email_id": u.email, "is_hotel_guest": 1, "disabled": 0}, "name")
    if existing:
        cust = frappe.get_doc("Customer", existing)
        cust.append("portal_users", {"user": user})
        cust.flags.ignore_permissions = True
        cust.save()
        return cust.name

    cust = frappe.get_doc({
        "doctype": "Customer",
        "customer_name": u.full_name,
        "customer_type": "Individual",
        "is_hotel_guest": 1,
        "email_id": u.email,
        "mobile_no": u.mobile_no,
        "customer_group": s.guest_customer_group or None,
        "territory": s.guest_territory or None,
        "portal_users": [{"user": user}],
    })
    cust.insert(ignore_permissions=True)
    return cust.name


@frappe.whitelist(allow_guest=True, methods=["GET"])
def get_session():
    """Header / booking form mate: kon login chhe."""
    if frappe.session.user == "Guest":
        return {"logged_in": 0}
    u = frappe.db.get_value("User", frappe.session.user, ["email", "full_name", "mobile_no"], as_dict=True)
    return {"logged_in": 1, "email": u.email, "full_name": u.full_name, "phone": u.mobile_no or ""}


@frappe.whitelist(methods=["POST"])
def update_profile(full_name, phone):
    _require_login()
    name = re.sub(r"\s+", " ", strip_html(full_name or "")).strip()
    phone = (phone or "").strip()
    if len(name) < 2 or len(name) > 140 or re.search(r"[<>{}]", name):
        frappe.throw(_("Please enter your full name."))
    if not PHONE_RE.match(phone):
        frappe.throw(_("Please enter a valid contact number."))

    user = frappe.get_doc("User", frappe.session.user)
    user.first_name, user.last_name, user.mobile_no = name, "", phone
    user.save(ignore_permissions=True)

    cust = get_customer_for_user()
    if cust:
        frappe.db.set_value("Customer", cust, {"customer_name": name, "mobile_no": phone})
    return {"full_name": name, "phone": phone}


@frappe.whitelist()
def get_my_bookings():
    _require_login()
    cust = get_customer_for_user()
    if not cust:
        return []
    return frappe.get_all(
        "Hotel Reservation",
        filters={"customer": cust},
        fields=["name", "room_type", "check_in_date", "check_out_date", "adults", "children",
                "status", "estimated_total", "total_paid", "balance"],
        order_by="creation desc",
        limit=100,
    )