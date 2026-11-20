"""Payment requests (Hotel Payment Transaction) and Razorpay Order creation.

Every payable amount is computed here from ERPNext / Hospitality Core data. A guest never supplies an
amount; staff may request *less* than the open balance, never more.
"""
import hashlib
import re
import secrets
import uuid

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, flt, get_datetime, get_url, getdate, now_datetime

from hospitality_core.constants import ReservationStatus
from hospitality_core.integrations.razorpay import client
from hospitality_core.integrations.razorpay.verification import to_paise

TXN = "Hotel Payment Transaction"
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,64}$")

# statuses in which the guest may still (re)try paying
PAYABLE = ("Initiated", "Order Created", "Payment Pending", "Failed")
# money is (or may be) with Razorpay but not yet in an ERPNext Payment Entry
IN_FLIGHT = ("Authorized", "Captured", "Reconciliation Pending")
PAID = ("Captured", "Reconciliation Pending", "Reconciled", "Refund Pending", "Partially Refunded", "Refunded")

SCENARIO_FLAG = {
    "Reservation Advance": "allow_website_advance",
    "Front Desk": "allow_front_desk",
    "Sales Invoice": "allow_invoice_payment",
}


# ----------------------------------------------------------------------------------- helpers
def hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def public_base_url(settings=None):
    s = settings or client.get_settings()
    return (s.public_base_url or get_url()).rstrip("/")


def pay_url(token, settings=None):
    return f"{public_base_url(settings)}/hotel-pay?token={token}"


def settings_currency(s):
    company = s.company or frappe.db.get_single_value("Hotel Settings", "company")
    return s.default_currency or frappe.db.get_value("Company", company, "default_currency") or "INR"


def require_scenario(scenario, settings):
    client.require_enabled(settings)
    flag = SCENARIO_FLAG.get(scenario)
    if flag and not cint(settings.get(flag)):
        frappe.throw(_("Online payment for {0} is disabled in Payment Gateway settings.").format(_(scenario)))


def _inflight_amount(reservation=None, sales_invoice=None, exclude=None):
    filters = {"status": ["in", IN_FLIGHT], "payment_entry": ["is", "not set"]}
    if reservation:
        filters["hotel_reservation"] = reservation
    if sales_invoice:
        filters["sales_invoice"] = sales_invoice
    if exclude:
        filters["name"] = ["!=", exclude]
    return flt(sum(flt(x) for x in frappe.get_all(TXN, filters=filters, pluck="amount")), 2)


# ------------------------------------------------------------------------ amount computation
def reservation_balance(reservation):
    """Full-stay amount still open on a Reserved / Checked In reservation.

    get_billing_summary() bills only up to *today* (a future booking shows one night), which is right
    for the console's running bill but not as a payment ceiling. The stay is therefore priced up to the
    check-out date with the same build_sales_invoice() used at checkout (rates, room-service drafts,
    taxes), minus submitted receipts and captured-but-not-yet-posted online payments."""
    from hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation import build_sales_invoice
    res = frappe.get_doc("Hotel Reservation", reservation)
    if res.status not in (ReservationStatus.RESERVED, ReservationStatus.CHECKED_IN):
        frappe.throw(_("Online payment is only possible for Reserved or Checked In reservations (reservation is {0}).").format(res.status))
    as_of = max(getdate(res.check_out_date), getdate())
    with client.as_system_user():  # ERPNext's invoice defaults need desk permissions a Guest lacks
        inv = build_sales_invoice(reservation, as_of=as_of)
    total = flt(inv.rounded_total or inv.grand_total, 2)
    paid = flt(frappe.db.sql("""SELECT SUM(paid_amount) FROM `tabPayment Entry`
        WHERE hotel_reservation=%s AND payment_type='Receive' AND docstatus=1""", reservation)[0][0])
    open_balance = flt(total - paid - _inflight_amount(reservation=reservation), 2)
    return res, {"estimated_total": total, "total_paid": paid}, max(open_balance, 0.0)


def advance_due(reservation, settings):
    """Advance still due on a reservation under the configured advance policy."""
    res, billing, balance = reservation_balance(reservation)
    total = flt(billing["estimated_total"])
    policy = settings.advance_type or "Percentage"
    if policy == "Full Amount":
        target = total
    elif policy == "Fixed Amount":
        target = flt(settings.advance_value)
    else:
        target = total * min(max(flt(settings.advance_value), 0), 100) / 100.0
    already = flt(billing["total_paid"]) + _inflight_amount(reservation=reservation)
    return res, flt(min(max(target - already, 0), balance), 2)


def invoice_outstanding(sales_invoice):
    inv = frappe.db.get_value("Sales Invoice", sales_invoice,
                              ["name", "docstatus", "customer", "company", "currency", "outstanding_amount", "is_return",
                               "hotel_reservation", "debit_to"], as_dict=True)
    if not inv or inv.docstatus != 1 or cint(inv.is_return):
        frappe.throw(_("Only submitted Sales Invoices (not returns) can be paid online."))
    outstanding = flt(flt(inv.outstanding_amount) - _inflight_amount(sales_invoice=sales_invoice), 2)
    if outstanding <= 0:
        frappe.throw(_("Sales Invoice {0} has no outstanding amount.").format(sales_invoice))
    return inv, outstanding


def _validate_requested(requested, ceiling, label):
    if requested in (None, ""):
        return ceiling
    amount = flt(requested, 2)
    if amount <= 0:
        frappe.throw(_("Payment amount must be greater than zero."))
    if amount > ceiling + 0.001:
        frappe.throw(_("Payment amount {0} exceeds the {1} {2}.").format(amount, label, ceiling))
    return amount


# ------------------------------------------------------------------------------- requests
def _new_txn(settings, scenario, source, amount, currency, customer=None, reservation=None, sales_invoice=None,
             company=None, idempotency_key=None, hold_minutes=None, description=None):
    if flt(amount) < 1:
        frappe.throw(_("The minimum online payment amount is 1.00 {0}.").format(currency))
    token = secrets.token_urlsafe(32)
    now = now_datetime()
    doc = frappe.get_doc({
        "doctype": TXN,
        "status": "Initiated",
        "scenario": scenario,
        "source": source,
        "environment": settings.environment or "Test",
        "amount": flt(amount, 2),
        "currency": currency,
        "customer": customer,
        "hotel_reservation": reservation,
        "sales_invoice": sales_invoice,
        "company": company or settings.company,
        "idempotency_key": idempotency_key or uuid.uuid4().hex,
        "description": (description or settings.default_description or _("Hotel payment"))[:140],
        "created_at": now,
        "expires_on": add_to_date(now, minutes=cint(settings.link_expiry_minutes) or 1440),
        "hold_expires_on": add_to_date(now, minutes=hold_minutes) if hold_minutes else None,
        "requested_by": frappe.session.user,
        "access_token_hash": hash_token(token),
    })
    doc.flags.ignore_permissions = True
    doc.insert()
    return doc, token


def _existing_by_key(idempotency_key):
    if not idempotency_key:
        return None
    name = frappe.db.get_value(TXN, {"idempotency_key": idempotency_key}, "name")
    return frappe.get_doc(TXN, name) if name else None


def rotate_token(txn):
    token = secrets.token_urlsafe(32)
    txn.db_set("access_token_hash", hash_token(token), update_modified=False)
    return token


def supersede_unpaid(reservation=None, sales_invoice=None, keep=None):
    """A new staff request replaces older unpaid requests for the same document. A guest who still
    pays an old order is recorded anyway (money received is never ignored) and flagged for review."""
    filters = {"status": ["in", ("Initiated", "Order Created", "Payment Pending", "Failed")]}
    if reservation:
        filters["hotel_reservation"] = reservation
    if sales_invoice:
        filters["sales_invoice"] = sales_invoice
    for name in frappe.get_all(TXN, filters=filters, pluck="name"):
        if name != keep:
            frappe.db.set_value(TXN, name, {"status": "Cancelled", "failure_reason": _("Superseded by a newer payment request")})


def website_advance_request(reservation, amount=None):
    """Called by the public booking API after a single-room booking. Returns public payment info or None."""
    s = client.get_settings()
    if not (s.enabled and cint(s.allow_website_advance)):
        return None
    try:
        client.get_credentials(s)  # configured & test-mode keys, else no online payment offered
    except client.GatewayDisabled:
        return None
    res, calc_amount = advance_due(reservation, s)
    if amount is not None and flt(amount) > 0:
        # Allow user to specify custom advance amount up to the reservation estimated total
        total = flt(frappe.db.get_value("Hotel Reservation", reservation, "estimated_total"))
        amount = min(flt(amount), total)
    else:
        amount = calc_amount

    if amount <= 0:
        return None
    existing = frappe.get_all(TXN, filters={"hotel_reservation": reservation, "scenario": "Reservation Advance",
                                            "status": ["in", PAYABLE], "expires_on": [">", now_datetime()]},
                              pluck="name", limit=1)
    required = (s.website_payment_policy == "Required")
    if existing:
        txn = frappe.get_doc(TXN, existing[0])
        if flt(txn.amount) != flt(amount):
            txn.amount = amount
            txn.save(ignore_permissions=True)
        token = rotate_token(txn)
    else:
        txn, token = _new_txn(s, "Reservation Advance", "Website", amount, settings_currency(s), customer=res.customer,
                              reservation=reservation, company=res.company,
                              hold_minutes=(cint(s.pending_hold_minutes) or 30) if required else None,
                              description=_("Advance for reservation {0}").format(reservation))
    return {"url": pay_url(token, s), "amount": txn.amount, "currency": txn.currency, "required": required,
            "hold_minutes": cint(s.pending_hold_minutes) if required else 0, "transaction": txn.name}


def front_desk_request(reservation, amount=None, idempotency_key=None):
    s = client.get_settings()
    require_scenario("Front Desk", s)
    client.get_credentials(s)
    previous = _existing_by_key(idempotency_key)
    if previous:
        return previous, rotate_token(previous)
    frappe.db.get_value("Hotel Reservation", reservation, "status", for_update=True)
    res, billing, balance = reservation_balance(reservation)
    if balance <= 0:
        frappe.throw(_("Reservation {0} has no outstanding balance.").format(reservation))
    amount = _validate_requested(amount, balance, _("open balance"))
    supersede_unpaid(reservation=reservation)
    return _new_txn(s, "Front Desk", "Front Desk", amount, settings_currency(s), customer=res.customer,
                    reservation=reservation, company=res.company, idempotency_key=idempotency_key,
                    description=_("Payment for reservation {0}").format(reservation))


def invoice_request(sales_invoice, amount=None, idempotency_key=None, source="Desk"):
    s = client.get_settings()
    require_scenario("Sales Invoice", s)
    client.get_credentials(s)
    previous = _existing_by_key(idempotency_key)
    if previous:
        return previous, rotate_token(previous)
    frappe.db.get_value("Sales Invoice", sales_invoice, "name", for_update=True)
    inv, outstanding = invoice_outstanding(sales_invoice)
    if amount not in (None, "") and not cint(s.allow_partial_invoice_payment) and flt(amount) < outstanding:
        frappe.throw(_("Partial invoice payments are disabled. The full outstanding amount {0} must be paid.").format(outstanding))
    amount = _validate_requested(amount, outstanding, _("outstanding amount"))
    if inv.currency != settings_currency(s):
        frappe.throw(_("Invoice currency {0} differs from the gateway currency.").format(inv.currency))
    supersede_unpaid(sales_invoice=sales_invoice)
    return _new_txn(s, "Sales Invoice", source, amount, inv.currency, customer=inv.customer,
                    reservation=inv.hotel_reservation, sales_invoice=sales_invoice, company=inv.company,
                    idempotency_key=idempotency_key, description=_("Payment for invoice {0}").format(sales_invoice))


def gateway_test_request(amount=1):
    s = client.get_settings()
    client.get_credentials(s)
    if s.environment != "Test":
        frappe.throw(_("Test payments are only possible in Test Mode."))
    amount = min(max(flt(amount, 2), 1), 100)
    return _new_txn(s, "Gateway Test", "Desk", amount, settings_currency(s),
                    description=_("Gateway test payment (no accounting entry)"))


# --------------------------------------------------------------------------- token access
def get_txn_by_token(token, for_payment=False):
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        frappe.throw(_("This payment link is invalid."), frappe.PermissionError)
    name = frappe.db.get_value(TXN, {"access_token_hash": hash_token(token)}, "name")
    if not name:
        frappe.throw(_("This payment link is invalid."), frappe.PermissionError)
    txn = frappe.get_doc(TXN, name)
    if for_payment:
        if txn.status in PAID:
            return txn
        if txn.status in ("Cancelled", "Expired"):
            frappe.throw(_("This payment link is no longer active. Please contact the hotel."))
        if txn.expires_on and get_datetime(txn.expires_on) < now_datetime():
            frappe.throw(_("This payment link has expired. Please contact the hotel."))
    return txn


def _current_ceiling(txn):
    """What may still be collected for this transaction's document right now."""
    if txn.scenario == "Gateway Test":
        return txn.amount
    if txn.scenario == "Sales Invoice":
        return invoice_outstanding(txn.sales_invoice)[1]  # in-flight sum excludes this unpaid txn
    _res, _billing, balance = reservation_balance(txn.hotel_reservation)
    return balance


def ensure_order(txn):
    """Create the Razorpay Order once. The network call happens before the row lock is taken."""
    if txn.razorpay_order_id:
        return txn
    if txn.status != "Initiated":
        frappe.throw(_("This payment can no longer be started."))
    s = client.require_enabled()
    if (txn.environment or "Test") != (s.environment or "Test"):
        frappe.throw(_("This payment link belongs to a different gateway environment."))
    creds = client.get_credentials(s)
    if flt(txn.amount) > flt(_current_ceiling(txn)) + 0.001:
        frappe.throw(_("The amount due has changed. Please ask the hotel for a new payment link."))
    notes = {"hotel_payment_transaction": txn.name, "scenario": txn.scenario,
             "hotel_reservation": txn.hotel_reservation or "", "sales_invoice": txn.sales_invoice or ""}
    order = client.create_order(to_paise(txn.amount), txn.currency, txn.name, notes, creds=creds)
    if int(order.get("amount") or 0) != to_paise(txn.amount) or not order.get("id"):
        frappe.throw(_("Razorpay returned an unexpected order."))

    frappe.db.sql("SELECT name FROM `tabHotel Payment Transaction` WHERE name=%s FOR UPDATE", txn.name)
    current = frappe.db.get_value(TXN, txn.name, ["razorpay_order_id", "status"], as_dict=True)
    if not current.razorpay_order_id:  # a concurrent request may have won the race: keep its order
        frappe.db.set_value(TXN, txn.name, {"razorpay_order_id": order["id"], "status": "Order Created"})
    client.commit()
    return frappe.get_doc(TXN, txn.name)


# --------------------------------------------------------------------------- public views
def public_status(status):
    if status in PAID:
        return "paid"
    if status == "Authorized":
        return "processing"
    if status in ("Cancelled", "Expired"):
        return status.lower()
    if status == "Failed":
        return "failed"
    return "pending"


def public_context(txn, include_checkout=False):
    """Data the guest checkout page may see. No internal ids beyond the reservation/invoice number."""
    s = client.get_settings()
    hotel = frappe.get_cached_doc("Hotel Settings")
    customer = frappe.db.get_value("Customer", txn.customer, ["customer_name", "email_id", "mobile_no"], as_dict=True) \
        if txn.customer else None
    ctx = {
        "status": public_status(txn.status),
        "scenario": txn.scenario,
        "reference": txn.hotel_reservation or txn.sales_invoice or txn.name,
        "reservation": txn.hotel_reservation,
        "sales_invoice": txn.sales_invoice,
        "guest_name": customer.customer_name if customer else "",
        "amount": flt(txn.amount, 2),
        "currency": txn.currency,
        "description": txn.description,
        "test_mode": (txn.environment or "Test") == "Test",
        "hotel_name": hotel.hotel_name or "",
        "hotel_logo": hotel.hotel_logo if hotel.hotel_logo and not hotel.hotel_logo.startswith("/private/") else None,
        "payment_id": txn.razorpay_payment_id if txn.status in PAID else None,
        "failure_reason": txn.failure_reason if txn.status == "Failed" else None,
    }
    if txn.hotel_reservation:
        ctx.update(frappe.db.get_value("Hotel Reservation", txn.hotel_reservation,
                                       ["check_in_date", "check_out_date", "room_type"], as_dict=True) or {})
    if include_checkout:
        ctx["checkout"] = {
            "key": client.get_credentials(s).key_id,  # public Key ID only
            "order_id": txn.razorpay_order_id,
            "amount": to_paise(txn.amount),
            "currency": txn.currency,
            "name": hotel.hotel_name or "Hotel",
            "description": txn.description,
            "image": ctx["hotel_logo"],
            "prefill": {"name": ctx["guest_name"], "email": (customer or {}).get("email_id") or "",
                        "contact": (customer or {}).get("mobile_no") or ""},
            "notes": {"reference": ctx["reference"]},
        }
    return ctx
