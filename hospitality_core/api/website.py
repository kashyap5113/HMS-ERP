"""
Public website API for the hotel booking page (/home Web Page).

Read endpoints are guest-accessible but only return content explicitly marked public:
Hotel Settings (is_active + is_published) and Hotel Room Type (is_active + is_published).
No customer, reservation, staff or room-number data is ever returned.

Booking creates a genuine Hotel Reservation through the normal document lifecycle
(validate / availability check / on_update). Prices are always computed here, never
taken from the client.
"""
import json
import re

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit
from frappe.utils import add_days, cint, date_diff, flt, getdate, now_datetime, strip_html, validate_email_address

from hospitality_core.constants import ReservationStatus
from hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation import get_room_type_availability
from hospitality_core.utils import get_company, get_room_item

from hospitality_core.api.account import get_customer_for_user

MAX_NIGHTS = 30
MAX_ADVANCE_DAYS = 365
MAX_ROOMS = 5
ROOMS_LEFT_CAP = 5
STANDARD_RATE_LABEL = "Standard Rate"
TOKEN_RE = re.compile(r"^[A-Za-z0-9-]{16,64}$")
PHONE_RE = re.compile(r"^[0-9+()\-\s]{7,20}$")


class BookingUnavailable(frappe.ValidationError):
    http_status_code = 409


# ---------------------------------------------------------------- helpers
def _settings():
    return frappe.get_doc("Hotel Settings")


def _require_published():
    s = _settings()
    if not (cint(s.is_active) and cint(s.is_published)):
        frappe.throw(_("Online booking is not available at the moment."), frappe.DoesNotExistError)
    return s


def _public_url(url):
    return url if url and not url.startswith("/private/") else None


def _images(rows):
    rows = [r for r in rows or [] if cint(r.is_active) and _public_url(r.image)]
    rows.sort(key=lambda r: (-cint(r.is_primary_image), cint(r.display_order), r.idx))
    return [{"url": r.image, "caption": r.image_caption or "", "category": r.image_category or "",
             "is_primary": cint(r.is_primary_image)} for r in rows]


def _amenities(rows):
    return [{"name": r.amenity, "code": r.amenity_code or "", "category": r.category or "", "icon": r.icon_name or "",
             "available": cint(r.is_available), "info": r.additional_information or ""} for r in rows or []]


def _currency(settings):
    company = settings.company or get_company()
    return frappe.db.get_value("Company", company, "default_currency") or "INR"


def _published_room_type(name):
    if not name or not isinstance(name, str):
        frappe.throw(_("Please choose a room type."))
    rt = frappe.db.get_value("Hotel Room Type", {"name": name, "is_active": 1, "is_published": 1}, "name")
    if not rt:
        frappe.throw(_("This room type is not available for online booking."), frappe.DoesNotExistError)
    return frappe.get_doc("Hotel Room Type", rt)


def _room_type_public(rt):
    return {
        "name": rt.name,
        "title": rt.room_type_name,
        "code": rt.room_type_code or "",
        "description": rt.description or "",
        "detailed_description": rt.detailed_description or "",
        "highlights": [h.strip() for h in (rt.room_highlights or "").splitlines() if h.strip()],
        "occupancy_information": rt.occupancy_information or "",
        "additional_information": rt.additional_information or "",
        "room_area": flt(rt.room_area),
        "max_occupancy": cint(rt.max_occupancy),
        "max_adults": cint(rt.max_adults),
        "max_children": cint(rt.max_children),
        "bed_configuration": rt.bed_configuration or "",
        "room_view": rt.room_view if rt.room_view and rt.room_view != "No Specific View" else "",
        "primary_image": _public_url(rt.primary_image),
        "images": _images(rt.images),
        "amenities": _amenities(rt.amenities),
        "policies": {
            "smoking_policy": rt.smoking_policy or "",
            "pets_allowed": cint(rt.pets_allowed),
            "children_allowed": cint(rt.children_allowed),
            "extra_bed_allowed": cint(rt.extra_bed_allowed),
            "max_extra_beds": cint(rt.max_extra_beds),
            "check_in_instructions": rt.check_in_instructions or "",
            "check_out_instructions": rt.check_out_instructions or "",
            "room_restrictions": rt.room_restrictions or "",
        },
    }


def _parse_stay(check_in, check_out, adults, children, rooms):
    try:
        ci, co = getdate(check_in), getdate(check_out)
    except Exception:
        frappe.throw(_("Please enter valid check-in and check-out dates."))
    if not ci or not co:
        frappe.throw(_("Please enter valid check-in and check-out dates."))
    today = getdate()
    if ci < today:
        frappe.throw(_("Check-in date cannot be in the past."))
    if co <= ci:
        frappe.throw(_("Check-out date must be after check-in date."))
    if date_diff(co, ci) > MAX_NIGHTS:
        frappe.throw(_("Online bookings are limited to {0} nights.").format(MAX_NIGHTS))
    if date_diff(ci, today) > MAX_ADVANCE_DAYS:
        frappe.throw(_("Bookings can be made up to {0} days in advance.").format(MAX_ADVANCE_DAYS))
    try:
        adults = int(adults)
        children = int(children) if children not in (None, "") else 0
        rooms = int(rooms) if rooms not in (None, "") else 1
    except (TypeError, ValueError):
        frappe.throw(_("Please enter valid guest and room numbers."))
    if rooms < 1 or rooms > MAX_ROOMS:
        frappe.throw(_("You can book between 1 and {0} rooms online.").format(MAX_ROOMS))
    if adults < 1 or children < 0:
        frappe.throw(_("At least one adult is required."))
    if adults < rooms:
        frappe.throw(_("Each room needs at least one adult."))
    return frappe._dict(check_in=ci, check_out=co, nights=date_diff(co, ci), adults=adults, children=children, rooms=rooms)


def _split(total, parts):
    base, extra = divmod(total, parts)
    return [base + (1 if i < extra else 0) for i in range(parts)]


def _room_allocation(rt, stay):
    """Split guests evenly across rooms and check each room against the room type's capacity."""
    adults = _split(stay.adults, stay.rooms)
    children = list(reversed(_split(stay.children, stay.rooms)))  # children go to rooms with fewer adults
    if stay.children and not cint(rt.children_allowed):
        return None, _("Children are not allowed in this room type.")
    occupancy = cint(rt.max_occupancy) or cint(rt.max_adults) + cint(rt.max_children)
    for a, c in zip(adults, children):
        if a > cint(rt.max_adults) or c > cint(rt.max_children) or a + c > occupancy:
            return None, _("{0} can host up to {1} adults and {2} children (max {3} guests) per room.").format(
                rt.room_type_name, cint(rt.max_adults), cint(rt.max_children), occupancy)
    return list(zip(adults, children)), None


def _plans_for_stay(rt, stay):
    """Public rate plans valid for every night of the stay. Falls back to the room type's
    default rate exactly like the existing reservation rate resolution (get_room_rate)."""
    last_night = add_days(stay.check_out, -1)
    plans = frappe.get_all(
        "Room Rate Plan",
        filters={"room_type": rt.name, "active": 1, "valid_from": ["<=", stay.check_in],
                 "valid_to": [">=", last_night], "customer": ["is", "not set"], "customer_group": ["is", "not set"]},
        fields=["name", "plan_name", "rate", "meal_plan", "is_refundable", "free_cancellation", "free_cancellation_hours",
                "cancellation_policy", "rate_plan_description", "discount_percentage", "extra_adult_charge",
                "extra_child_charge", "included_adults", "included_children", "rate_includes_tax"],
        order_by="rate asc",
    )
    plans = [p for p in plans if flt(p.rate) > 0]
    if plans:
        return plans
    if flt(rt.default_rate) > 0:
        return [frappe._dict(name=None, plan_name=_(STANDARD_RATE_LABEL), rate=flt(rt.default_rate), meal_plan="Room Only",
                             is_refundable=1, free_cancellation=0, free_cancellation_hours=0, cancellation_policy="",
                             rate_plan_description="", discount_percentage=0, extra_adult_charge=0, extra_child_charge=0,
                             included_adults=0, included_children=0, rate_includes_tax=0)]
    return []


def _nightly_for_room(plan, adults, children):
    base = flt(plan.rate) * (1 - min(max(flt(plan.discount_percentage), 0), 100) / 100)
    extra_a = max(0, adults - cint(plan.included_adults)) if cint(plan.included_adults) else 0
    extra_c = max(0, children - cint(plan.included_children)) if cint(plan.included_children) else 0
    extras = extra_a * flt(plan.extra_adult_charge) + extra_c * flt(plan.extra_child_charge)
    return flt(base, 2), flt(extras, 2)


def _compute_taxes(rt_name, lines, settings):
    """Run the same Sales Taxes and Charges Template used at checkout through ERPNext's tax engine
    on an unsaved Sales Invoice. Returns (taxes, grand_total, breakdown)."""
    net = flt(sum(q * r for q, r in lines), 2)
    if not settings.sales_taxes_template:
        return 0.0, net, []
    inv = frappe.new_doc("Sales Invoice")
    inv.company = settings.company or get_company()
    inv.currency = _currency(settings)
    inv.conversion_rate = 1
    inv.plc_conversion_rate = 1
    inv.taxes_and_charges = settings.sales_taxes_template
    item_code = get_room_item(rt_name)
    for qty, rate in lines:
        inv.append("items", {"item_code": item_code, "qty": qty, "rate": rate, "price_list_rate": rate,
                             "conversion_factor": 1, "item_tax_rate": "{}"})
    # The template is fixed by Hotel Settings (never chosen by the client), so its rows are copied
    # directly; ERPNext's get_taxes_and_charges() would require a desk permission the Guest lacks.
    template = frappe.get_doc("Sales Taxes and Charges Template", settings.sales_taxes_template)
    for t in template.taxes:
        inv.append("taxes", {f: t.get(f) for f in ("charge_type", "account_head", "description", "rate", "row_id",
                                                   "included_in_print_rate", "cost_center", "tax_amount")})
    inv.calculate_taxes_and_totals()
    breakdown = [{"description": t.description or t.account_head, "amount": flt(t.base_tax_amount_after_discount_amount or t.tax_amount, 2)}
                 for t in inv.taxes if flt(t.tax_amount)]
    return flt(inv.total_taxes_and_charges, 2), flt(inv.grand_total, 2), breakdown


def _quote(rt, plan, stay, allocation, settings):
    billable = max(stay.nights, cint(settings.min_billable_nights) or 1)
    rooms, lines = [], []
    for adults, children in allocation:
        base, extras = _nightly_for_room(plan, adults, children)
        rooms.append({"adults": adults, "children": children, "nightly_rate": flt(base + extras, 2)})
        lines.append((billable, flt(base + extras, 2)))
    base_rate = _nightly_for_room(plan, 1, 0)[0]
    room_charges = flt(base_rate * billable * len(allocation), 2)
    net = flt(sum(q * r for q, r in lines), 2)
    taxes, total, tax_rows = _compute_taxes(rt.name, lines, settings)
    return {
        "rate_plan": plan.name,
        "plan_name": plan.plan_name or plan.name,
        "meal_plan": plan.meal_plan or "Room Only",
        "is_refundable": cint(plan.is_refundable),
        "free_cancellation": cint(plan.free_cancellation),
        "free_cancellation_hours": cint(plan.free_cancellation_hours),
        "cancellation_policy": plan.cancellation_policy or "",
        "description": plan.rate_plan_description or "",
        "list_rate": flt(plan.rate, 2),
        "discount_percentage": flt(plan.discount_percentage),
        "nightly_rate": base_rate,
        "nights": stay.nights,
        "billable_nights": billable,
        "rooms": rooms,
        "room_charges": room_charges,
        "extra_guest_charges": flt(net - room_charges, 2),
        "net_total": net,
        "taxes": taxes,
        "tax_breakdown": tax_rows,
        "taxes_configured": bool(settings.sales_taxes_template),
        "total": total,
        "currency": _currency(settings),
    }


def _free_inventory(rt_name, check_in, check_out, for_update=False):
    """Shared room-type inventory (same function the Front Desk and the reservation form use).
    Out-of-order rooms are excluded there; no physical room is ever chosen for a web booking."""
    return get_room_type_availability(rt_name, check_in, check_out, for_update=for_update)["available"]


def _starting_price(rt):
    today = getdate()
    rate = frappe.db.sql("""
        SELECT MIN(rate * (1 - LEAST(GREATEST(IFNULL(discount_percentage, 0), 0), 100) / 100))
        FROM `tabRoom Rate Plan`
        WHERE room_type = %s AND active = 1 AND rate > 0 AND valid_to >= %s
          AND IFNULL(customer, '') = '' AND IFNULL(customer_group, '') = ''
    """, (rt.name, today))[0][0]
    return flt(rate or rt.default_rate, 2) or None


# ---------------------------------------------------------------- public read API
@frappe.whitelist(allow_guest=True, methods=["GET"])
@rate_limit(limit=300, seconds=60)
def get_site_data():
    """Hotel profile, property photos/amenities and all published room types."""
    s = _require_published()
    names = frappe.get_all("Hotel Room Type", filters={"is_active": 1, "is_published": 1}, pluck="name", order_by="default_rate asc")
    room_types = []
    for name in names:
        rt = frappe.get_doc("Hotel Room Type", name)
        data = _room_type_public(rt)
        data["starting_price"] = _starting_price(rt)
        room_types.append(data)
    return {
        "hotel": {
            "name": s.hotel_name or "",
            "short_description": s.property_short_description or "",
            "description": s.property_description or "",
            "logo": _public_url(s.hotel_logo),
            "cover_image": _public_url(s.cover_image),
            "star_rating": cint(s.star_rating),
            "contact_number": s.contact_number or "",
            "email": s.email_address or "",
            "website": s.website or "",
            "address_line": s.address_line or "",
            "city": s.city or "",
            "state": s.state or "",
            "country": s.country or "",
            "postal_code": s.postal_code or "",
            "latitude": flt(s.latitude) or None,
            "longitude": flt(s.longitude) or None,
            "google_maps_url": s.google_maps_url or "",
            "slug": s.website_slug or "",
            "images": _images(s.property_images),
            "amenities": _amenities(s.property_amenities),
        },
        "room_types": room_types,
        "currency": _currency(s),
        "limits": {"max_nights": MAX_NIGHTS, "max_advance_days": MAX_ADVANCE_DAYS, "max_rooms": MAX_ROOMS,
                   "min_billable_nights": cint(s.min_billable_nights) or 1},
    }


@frappe.whitelist(allow_guest=True, methods=["GET"])
@rate_limit(limit=300, seconds=60)
def get_room_type(room_type):
    _require_published()
    rt = _published_room_type(room_type)
    data = _room_type_public(rt)
    data["starting_price"] = _starting_price(rt)
    return data


@frappe.whitelist(allow_guest=True, methods=["GET"])
@rate_limit(limit=120, seconds=60)
def search_availability(check_in, check_out, adults, children=0, rooms=1, room_type=None):
    """Room types with enough free rooms for the dates, each with server-priced rate plans."""
    s = _require_published()
    stay = _parse_stay(check_in, check_out, adults, children, rooms)
    if room_type:
        names = [_published_room_type(room_type).name]
    else:
        names = frappe.get_all("Hotel Room Type", filters={"is_active": 1, "is_published": 1}, pluck="name")
    results = []
    for name in names:
        rt = frappe.get_doc("Hotel Room Type", name)
        allocation, capacity_error = _room_allocation(rt, stay)
        free = _free_inventory(name, stay.check_in, stay.check_out)
        offers = [_quote(rt, p, stay, allocation, s) for p in _plans_for_stay(rt, stay)] if allocation else []
        results.append({
            "room_type": name,
            "available": bool(allocation) and free >= stay.rooms and bool(offers),
            "rooms_left": min(free, ROOMS_LEFT_CAP) if free < ROOMS_LEFT_CAP else None,
            "reason": capacity_error or (None if free >= stay.rooms else _("Not enough rooms available for these dates."))
                      or (None if offers else _("No online rate is available for these dates.")),
            "offers": offers,
        })
    return {
        "check_in": str(stay.check_in), "check_out": str(stay.check_out), "nights": stay.nights,
        "adults": stay.adults, "children": stay.children, "rooms": stay.rooms,
        "currency": _currency(s), "results": results,
    }


def _select_plan(rt, stay, rate_plan):
    plans = _plans_for_stay(rt, stay)
    for p in plans:
        if (p.name or "") == (rate_plan or ""):
            return p
    frappe.throw(_("The selected rate is not available for these dates. Please search again."), BookingUnavailable)


@frappe.whitelist(allow_guest=True, methods=["GET", "POST"])
@rate_limit(limit=120, seconds=60)
def get_quote(room_type, check_in, check_out, adults, children=0, rooms=1, rate_plan=None):
    """Authoritative server-side price for one room type + rate plan."""
    s = _require_published()
    rt = _published_room_type(room_type)
    stay = _parse_stay(check_in, check_out, adults, children, rooms)
    allocation, error = _room_allocation(rt, stay)
    if error:
        frappe.throw(error)
    plan = _select_plan(rt, stay, rate_plan)
    quote = _quote(rt, plan, stay, allocation, s)
    free = _free_inventory(rt.name, stay.check_in, stay.check_out)
    quote.update({"room_type": rt.name, "room_type_title": rt.room_type_name, "check_in": str(stay.check_in),
                  "check_out": str(stay.check_out), "adults": stay.adults, "children": stay.children,
                  "room_count": stay.rooms, "available": free >= stay.rooms})
    return quote


# ---------------------------------------------------------------- booking
def _clean_guest(guest_name, email, phone, special_requests):
    name = re.sub(r"\s+", " ", strip_html(guest_name or "")).strip()
    if len(name) < 2 or len(name) > 140 or re.search(r"[<>{}]", name):
        frappe.throw(_("Please enter the guest's full name."))
    email = (email or "").strip().lower()
    if not email or not validate_email_address(email):
        frappe.throw(_("Please enter a valid email address."))
    phone = (phone or "").strip()
    if not PHONE_RE.match(phone):
        frappe.throw(_("Please enter a valid contact number."))
    notes = strip_html(special_requests or "").strip()[:500]
    return name, email, phone, notes


def _get_or_create_customer(name, email, phone, settings):
    """Reuse an existing hotel-guest Customer with the same email (never modified from the public
    site); otherwise create one the same way the Front Desk console does."""
    existing = frappe.db.get_value("Customer", {"email_id": email, "is_hotel_guest": 1, "disabled": 0}, "name")
    if existing:
        return existing
    doc = frappe.get_doc({
        "doctype": "Customer",
        "customer_name": name,
        "customer_type": "Individual",
        "is_hotel_guest": 1,
        "email_id": email,
        "mobile_no": phone,
        "customer_group": settings.guest_customer_group or None,
        "territory": settings.guest_territory or None,
    })
    doc.insert(ignore_permissions=True)
    return doc.name


def _cache_key(token):
    return frappe.cache.make_key(f"hotel_web_booking:{token}")


def _recent_duplicate(customer, room_type, stay):
    return frappe.get_all("Hotel Reservation", filters={
        "customer": customer, "room_type": room_type, "check_in_date": stay.check_in, "check_out_date": stay.check_out,
        "status": ReservationStatus.RESERVED, "creation": [">=", add_days(now_datetime(), -1)],
    }, pluck="name", order_by="creation asc")


def _booking_response(names, guest_name, rt, stay, plan_name, total, currency, duplicate=False):
    statuses = {frappe.db.get_value("Hotel Reservation", n, "status") for n in names}
    return {
        "booking_references": names,
        "status": statuses.pop() if len(statuses) == 1 else ", ".join(sorted(statuses)),
        "guest_name": guest_name,
        "room_type": rt.name,
        "room_type_title": rt.room_type_name,
        "rate_plan": plan_name,
        "check_in": str(stay.check_in),
        "check_out": str(stay.check_out),
        "nights": stay.nights,
        "adults": stay.adults,
        "children": stay.children,
        "rooms": len(names),
        "total": total,
        "currency": currency,
        "duplicate": duplicate,
    }


# @frappe.whitelist(allow_guest=True, methods=["POST"])
# @rate_limit(limit=10, seconds=60 * 60)
# def create_booking(room_type, check_in, check_out, adults, guest_name, email, phone, booking_token,
#                    children=0, rooms=1, rate_plan=None, special_requests=None, **kwargs):
#     """Create real Hotel Reservation(s). Any client-supplied price is ignored."""
#     if not isinstance(booking_token, str) or not TOKEN_RE.match(booking_token):

@frappe.whitelist(methods=["POST"])          # allow_guest hatavyu
@rate_limit(limit=1000, seconds=60)
def create_booking(room_type, check_in, check_out, adults, guest_name, email, phone, booking_token,
                   children=0, rooms=1, rate_plan=None, special_requests=None, custom_payment_amount=None, **kwargs):
    """Create real Hotel Reservation(s). Login required; identity comes from the session, never the client."""
    if frappe.session.user == "Guest":
        frappe.throw(_("Please log in to book."), frappe.PermissionError)

    u = frappe.db.get_value("User", frappe.session.user, ["email", "full_name", "mobile_no"], as_dict=True)
    guest_name, email = u.full_name, u.email            # client ni value ignore
    phone = (phone or u.mobile_no or "").strip()
    if phone and not u.mobile_no:
        try:
            frappe.db.set_value("User", frappe.session.user, "mobile_no", phone)
        except Exception:
            pass  # Avoid failing booking if mobile_no already exists on another User

    if not isinstance(booking_token, str) or not TOKEN_RE.match(booking_token):
        frappe.throw(_("Invalid booking request. Please reload the page and try again."))
    key = _cache_key(booking_token)
    previous = frappe.cache.get(key)
    if previous:
        previous = previous.decode() if isinstance(previous, bytes) else previous
        if previous == "pending":
            frappe.throw(_("This booking is already being processed. Please wait."), BookingUnavailable)
        return json.loads(previous)
    if not frappe.cache.set(key, "pending", nx=True, ex=600):
        frappe.throw(_("This booking is already being processed. Please wait."), BookingUnavailable)

    # the token is released if the transaction rolls back, and marked done only once committed
    frappe.db.after_rollback.add(lambda: frappe.cache.delete(key))
    try:
        result = _create_booking(room_type, check_in, check_out, adults, children, rooms, rate_plan,
                                 guest_name, email, phone, special_requests)
        result["payment"] = _online_payment_offer(result, custom_amount=custom_payment_amount)
    except frappe.ValidationError:
        frappe.cache.delete(key)
        raise
    except Exception:
        frappe.cache.delete(key)
        frappe.log_error(title="Website booking failed")
        frappe.throw(_("We could not complete your booking. Please try again or contact the hotel."))
    payload = json.dumps(result, default=str)
    frappe.db.after_commit.add(lambda: frappe.cache.set(key, payload, ex=24 * 60 * 60))
    return result


def _online_payment_offer(result, custom_amount=None):
    """Razorpay advance for a single-reservation booking (one payment -> one Payment Entry -> one
    reservation). Never lets a gateway problem fail the booking itself."""
    refs = result.get("booking_references") or []
    if len(refs) != 1 or result.get("status") != ReservationStatus.RESERVED:
        return None
    frappe.db.savepoint("hc_web_payment_offer")
    try:
        from hospitality_core.integrations.razorpay.client import as_system_user
        from hospitality_core.integrations.razorpay.orders import website_advance_request
        with as_system_user():
            return website_advance_request(refs[0], amount=custom_amount)
    except Exception:
        frappe.db.rollback(save_point="hc_web_payment_offer")
        frappe.log_error(title="Website booking: online payment offer failed")
        return None


def _create_booking(room_type, check_in, check_out, adults, children, rooms, rate_plan,
                    guest_name, email, phone, special_requests):
    settings = _require_published()
    rt = _published_room_type(room_type)
    stay = _parse_stay(check_in, check_out, adults, children, rooms)
    allocation, error = _room_allocation(rt, stay)
    if error:
        frappe.throw(error)
    name, email, phone, notes = _clean_guest(guest_name, email, phone, special_requests)
    plan = _select_plan(rt, stay, rate_plan)
    quote = _quote(rt, plan, stay, allocation, settings)

    # customer = _get_or_create_customer(name, email, phone, settings)
    customer = get_customer_for_user(create=True)
    duplicates = _recent_duplicate(customer, rt.name, stay)
    if len(duplicates) >= stay.rooms:
        return _booking_response(duplicates[:stay.rooms], name, rt, stay, quote["plan_name"], quote["total"],
                                 quote["currency"], duplicate=True)

    # Serialise bookings of this room type (row locks on its rooms) and re-count with a locking read.
    if _free_inventory(rt.name, stay.check_in, stay.check_out, for_update=True) < stay.rooms:
        frappe.throw(_("Sorry, {0} is no longer available for these dates.").format(rt.room_type_name), BookingUnavailable)

    net = quote["net_total"] or 1
    remarks = "\n".join(filter(None, [
        _("Online booking from website."),
        _("Guest: {0} | {1} | {2}").format(name, phone, email),
        _("Rate: {0} ({1})").format(quote["plan_name"], quote["meal_plan"]),
        _("Special requests: {0}").format(notes) if notes else None,
    ]))
    names = []
    for (a, c), priced in zip(allocation, quote["rooms"]):
        res = frappe.get_doc({
            "doctype": "Hotel Reservation",
            "customer": customer,
            "room_type": rt.name,
            "rate_plan": plan.name,
            "status": ReservationStatus.RESERVED,
            "check_in_date": stay.check_in,
            "check_out_date": stay.check_out,
            "adults": a,
            "children": c,
            "remarks": remarks,
            # this room's share of the quoted grand total (taxes are proportional to room charges)
            "estimated_total": flt(quote["total"] * priced["nightly_rate"] * quote["billable_nights"] / net, 2),
            "balance": flt(quote["total"] * priced["nightly_rate"] * quote["billable_nights"] / net, 2),
        })
        # server-computed nightly rate for this room (plan rate, discount, extra guests)
        res.append("stays", {"room_type": rt.name, "from_date": stay.check_in,
                             "to_date": stay.check_out, "rate": priced["nightly_rate"], "nights": stay.nights})
        res.flags.ignore_permissions = True  # guest booking: permissions bypassed, validations are not
        res.insert()
        names.append(res.name)

    try:
        from hospitality_core.api.console import emit_console_update
        for n in names:
            emit_console_update("reservation_created", {"reservation": n, "room": None, "source": "website"})
    except Exception:
        pass
    return _booking_response(names, name, rt, stay, quote["plan_name"], quote["total"], quote["currency"])
