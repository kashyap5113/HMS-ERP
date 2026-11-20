/**
 * Front Desk Console - operation dialogs. Mixed into FrontDeskConsole.prototype.
 * Every operation stays inside a popup; server methods enforce all validation.
 */
Object.assign(FrontDeskConsole.prototype, {

    // ---------------- ROOM ----------------
    show_room_dialog(room) {
        if (room.reservation) return this.dialog_reservation(room.reservation, room);
        const me = this;
        const d = FD.dialog({
            title: __("Room {0}", [room.room_number || room.name]),
            fields: [{ fieldtype: "HTML", fieldname: "body" }],
        });
        d.fields_dict.body.$wrapper.html(`
            <div class="fd-modal-head">${FD.room_pill(room.status)}<span class="text-muted">${FD.esc(room.room_type)}${room.floor ? ` · ${__("Floor")} ${FD.esc(room.floor)}` : ""}</span></div>
            ${room.notes ? `<div class="fd-note">${FD.esc(room.notes)}</div>` : ""}
            <div class="fd-modal-actions"></div>`);
        const $a = d.fields_dict.body.$wrapper.find(".fd-modal-actions");
        const add = (label, cls, fn) => $(`<button class="btn btn-sm ${cls}">${label}</button>`).appendTo($a).on("click", () => { d.hide(); fn(); });
        if (room.status === "Available") {
            add(__("Walk-in"), "btn-success", () => me.dialog_walkin(room.name, room.room_type));
            add(__("New Reservation"), "btn-primary", () => me.dialog_new_reservation(null, room.room_type));
            add(__("Mark Dirty"), "btn-default", () => me.set_room_housekeeping(room.name, "Dirty"));
            add(__("Report Issue"), "btn-danger-light", () => me.dialog_report_issue(room.name));
        } else if (room.status === "Dirty") {
            add(__("Mark Clean"), "btn-success", () => me.set_room_housekeeping(room.name, "Clean"));
            add(__("Report Issue"), "btn-danger-light", () => me.dialog_report_issue(room.name));
        } else if (room.status === "Out of Order") {
            add(__("View Maintenance"), "btn-default", () => me.switch_tab("maintenance"));
        } else {
            add(__("Report Issue"), "btn-danger-light", () => me.dialog_report_issue(room.name));
        }
        d.show();
    },

    set_room_housekeeping(room, action) {
        return FD.call("hospitality_core.api.console.set_housekeeping", { room_number: room, action })
            .then((r) => this.done(null, __("Room {0} is now {1}", [room, __(r.status)])));
    },

    // ---------------- RESERVATION / GUEST DETAIL ----------------
    dialog_reservation(name) {
        const me = this;
        FD.call("hospitality_core.api.console.get_reservation_details", { reservation_name: name }, { freeze: true }).then((data) => {
            const r = data.reservation, g = data.guest || {}, b = data.billing || {};
            const d = FD.dialog({
                title: `${g.customer_name || r.customer} · ${r.name}`,
                size: "large",
                fields: [{ fieldtype: "HTML", fieldname: "body" }],
            });
            const pay_rows = (data.payments || []).map((p) => `<tr>
                <td>${FD.date(p.posting_date)}</td><td>${fd_doc_link("Payment Entry", p.name)}</td>
                <td>${FD.esc(p.mode_of_payment)}</td><td>${FD.esc(p.reference_no || "")}</td><td class="text-right">${FD.money(p.paid_amount)}</td></tr>`).join("");
            const order_rows = (data.room_orders || []).map((o) => `<tr>
                <td>${FD.date(o.posting_date)}</td><td>${fd_doc_link("Sales Invoice", o.name)}</td>
                <td>${o.charge_to_room ? `<span class="indicator-pill orange">${__("Charged to room")}</span>` : `<span class="indicator-pill green">${__("Paid")}</span>`}</td>
                <td class="text-right">${FD.money(o.grand_total)}</td></tr>`).join("");
            const stays = data.stays.length > 1 ? `<div class="fd-sec-title">${__("Room History")}</div>
                <table class="table table-sm fd-mini"><tbody>${data.stays.map((s) => `<tr><td>${FD.esc(s.room)}</td><td>${FD.esc(s.room_type)}</td>
                <td>${FD.date(s.from_date)} → ${FD.date(s.to_date)}</td><td class="text-right">${FD.money(s.rate)}</td></tr>`).join("")}</tbody></table>` : "";
            d.fields_dict.body.$wrapper.html(`
                <div class="fd-modal-head">${FD.pill(r.status)}<span class="text-muted">${__("Room")} <b>${FD.esc(r.room || __("Not Assigned"))}</b> · ${FD.esc(r.room_type)}</span></div>
                <div class="fd-detail-grid">
                    <div class="fd-card-sm">
                        <div class="fd-sec-title">${__("Guest")}</div>
                        ${FD.kv([[__("Name"), g.customer_name || r.customer], [__("Mobile"), g.mobile_no], [__("Email"), g.email_id],
                            [__("ID"), g.guest_id_number ? `${g.guest_id_type || ""} ${g.guest_id_number}${g.id_document_attached ? " · " + __("document on file") : ""}` : ""], [__("Guests"), `${r.adults || 0} ${__("adults")}${r.children ? `, ${r.children} ${__("children")}` : ""}`]])}
                    </div>
                    <div class="fd-card-sm">
                        <div class="fd-sec-title">${__("Stay")}</div>
                        ${FD.kv([[__("Check-in"), FD.date(r.check_in_date)], [__("Check-out"), FD.date(r.check_out_date)], [__("Nights"), r.nights],
                            [__("Room Rate"), FD.money(r.rate)], [__("Invoice"), r.sales_invoice ? fd_doc_link("Sales Invoice", r.sales_invoice) : "", true]])}
                    </div>
                </div>
                ${b && b.estimated_total !== undefined ? `
                <div class="fd-money-row">
                    <div><span>${__("Total Stay")}</span><b>${FD.money(b.estimated_total)}</b></div>
                    <div><span>${__("Paid")}</span><b class="text-success">${FD.money(b.total_paid)}</b></div>
                    <div><span>${__("Room Service Pending")}</span><b class="text-warning">${FD.money(b.room_service_pending)}</b></div>
                    <div class="fd-money-due"><span>${__("Outstanding")}</span><b class="${b.balance > 0 ? "text-danger" : "text-success"}">${FD.money(b.balance)}</b></div>
                </div>` : ""}
                ${stays}
                <div class="fd-sec-title">${__("Payments")}</div>
                ${pay_rows ? `<table class="table table-sm fd-mini"><tbody>${pay_rows}</tbody></table>` : `<div class="text-muted small mb-3">${__("No payments yet.")}</div>`}
                <div class="fd-online-payments"></div>
                ${order_rows ? `<div class="fd-sec-title">${__("Room Service Orders")}</div><table class="table table-sm fd-mini"><tbody>${order_rows}</tbody></table>` : ""}
                <div class="fd-modal-actions"></div>`);
            me.render_online_payments(d.fields_dict.body.$wrapper.find(".fd-online-payments"), r.name);

            const $a = d.fields_dict.body.$wrapper.find(".fd-modal-actions");
            const add = (label, cls, fn) => $(`<button class="btn btn-sm ${cls}">${label}</button>`).appendTo($a).on("click", () => { d.hide(); fn(); });
            if (r.status === "Reserved") {
                add(__("Check In"), "btn-primary", () => me.dialog_checkin(r.name));
                add(__("Receive Advance"), "btn-default", () => me.dialog_receive_payment(r.name));
                add(__("Change Dates"), "btn-default", () => me.dialog_extend_stay(r.name));
                add(__("Cancel Reservation"), "btn-danger-light", () => me.dialog_cancel(r.name));
            } else if (r.status === "Checked In") {
                add(__("Receive Payment"), "btn-primary", () => me.dialog_receive_payment(r.name, b.balance));
                add(__("Room Service"), "btn-default", () => me.open_room_service_for(r.name, r.customer));
                add(__("Move Room"), "btn-default", () => me.dialog_move_room(r.name));
                add(__("Extend Stay"), "btn-default", () => me.dialog_extend_stay(r.name));
                add(__("View Bill"), "btn-default", () => me.dialog_bill_preview(r.name));
                if (r.room) add(__("Report Issue"), "btn-default", () => me.dialog_report_issue(r.room));
                add(__("Check Out"), "btn-dark", () => me.dialog_checkout(r.name));
            } else if (r.sales_invoice) {
                add(__("Print Invoice"), "btn-primary", () => fd_open_print_popup("Sales Invoice", r.sales_invoice));
                me.rzp_config().then((c) => {
                    if (!c.invoice) return;
                    frappe.db.get_value("Sales Invoice", r.sales_invoice, ["outstanding_amount", "docstatus"]).then((x) => {
                        const inv = x.message || {};
                        if (inv.docstatus === 1 && inv.outstanding_amount > 0) {
                            add(__("Collect Invoice Online ({0})", [FD.money(inv.outstanding_amount)]), "btn-default",
                                () => me.start_online_payment({ sales_invoice: r.sales_invoice }, inv.outstanding_amount, g.customer_name));
                        }
                    });
                });
            }
            d.show();
        });
    },

    dialog_guest(customer) {
        const me = this;
        Promise.all([
            frappe.db.get_value("Customer", customer, ["customer_name", "mobile_no", "email_id"]),
            FD.call("hospitality_core.api.console.get_reservations", { text: customer, limit: 20 }),
        ]).then(([c, rows]) => {
            const g = c.message || {};
            const d = FD.dialog({ title: g.customer_name || customer, fields: [{ fieldtype: "HTML", fieldname: "body" }] });
            d.fields_dict.body.$wrapper.html(`
                ${FD.kv([[__("Mobile"), g.mobile_no], [__("Email"), g.email_id]])}
                <div class="fd-sec-title">${__("Reservations")}</div>
                ${(rows || []).length ? `<table class="table table-sm fd-mini"><tbody>${rows.map((r) => `<tr class="fd-click" data-res="${FD.esc(r.name)}">
                    <td>${FD.esc(r.name)}</td><td>${FD.esc(r.room || __("Not Assigned"))}</td><td>${FD.date(r.check_in_date)} → ${FD.date(r.check_out_date)}</td><td>${FD.pill(r.status)}</td></tr>`).join("")}</tbody></table>`
                    : `<div class="text-muted small">${__("No reservations.")}</div>`}`);
            d.fields_dict.body.$wrapper.on("click", "[data-res]", function () { d.hide(); me.dialog_reservation($(this).data("res")); });
            d.set_primary_action(__("New Reservation"), () => { d.hide(); me.dialog_new_reservation(null, null, null, null, customer); });
            d.show();
        });
    },

    // ---------------- NEW RESERVATION / WALK-IN ----------------
    guest_fields(walkin) {
        return [
            { fieldtype: "HTML", fieldname: "guest_hint", options: `<div class="fd-sec-title">${__("Guest")}</div>` },
            { fieldtype: "Link", fieldname: "customer", label: __("Existing Guest"), options: "Customer",
              description: __("Search an existing guest, or fill the new guest fields below") },
            { fieldtype: "Data", fieldname: "guest_name", label: __("New Guest Name"), depends_on: "eval:!doc.customer" },
            { fieldtype: "Column Break" },
            { fieldtype: "Data", fieldname: "mobile_no", label: __("Mobile"), options: "Phone", depends_on: "eval:!doc.customer" },
            // Identity is verified only at check-in (walk-in = immediate check-in), never at booking.
            ...(walkin ? [
                { fieldtype: "Section Break", label: __("Identity Verification") },
                { fieldtype: "Select", fieldname: "guest_id_type", label: __("ID Type"), options: ["", "Aadhaar", "PAN", "Driving Licence", "Passport", "Voter ID", "Other"] },
                { fieldtype: "Column Break" },
                { fieldtype: "Password", fieldname: "guest_id_number", label: __("ID Number") },
            ] : []),
        ];
    },

    stay_fields(pre_room, pre_type, from, to, walkin) {
        const me = this;
        const today = frappe.datetime.get_today();
        return [
            { fieldtype: "Section Break", label: __("Stay") },
            { fieldtype: "Link", fieldname: "room_type", label: __("Room Type"), options: "Hotel Room Type", reqd: 1, default: pre_type,
              onchange: () => me._refresh_room_options() },
            { fieldtype: "Date", fieldname: "check_in_date", label: __("Check-in"), reqd: !walkin, read_only: walkin ? 1 : 0,
              default: walkin ? today : (from || me.current_date), onchange: () => me._refresh_room_options() },
            { fieldtype: "Date", fieldname: "check_out_date", label: __("Check-out"), reqd: 1,
              default: to || frappe.datetime.add_days(walkin ? today : (from || me.current_date), 1), onchange: () => me._refresh_room_options() },
            { fieldtype: "Column Break" },
            ...(walkin ? [{ fieldtype: "Select", fieldname: "room", label: __("Room"), reqd: 1, options: pre_room ? [pre_room] : [], default: pre_room,
              description: __("Only rooms free for the selected dates are listed") }] : []),
            { fieldtype: "Int", fieldname: "adults", label: __("Adults"), default: 1 },
            { fieldtype: "Int", fieldname: "children", label: __("Children"), default: 0 },
            { fieldtype: "HTML", fieldname: "rate_info" },
            { fieldtype: "Section Break", label: __("Advance Payment (optional)"), collapsible: 1 },
            { fieldtype: "Currency", fieldname: "advance_amount", label: __("Amount") },
            { fieldtype: "Column Break" },
            { fieldtype: "Link", fieldname: "advance_mode", label: __("Mode of Payment"), options: "Mode of Payment", default: me.state.settings.default_advance_mode },
            { fieldtype: "Data", fieldname: "advance_reference", label: __("Reference No") },
            { fieldtype: "Section Break" },
            { fieldtype: "Small Text", fieldname: "remarks", label: __("Remarks") },
        ];
    },

    _refresh_room_options() {
        const d = this._res_dialog;
        if (!d) return;
        const v = d.get_values(true);
        const field = d.fields_dict.room;
        if (!v.room_type || !v.check_in_date || !v.check_out_date || v.check_out_date <= v.check_in_date) {
            d.fields_dict.rate_info.$wrapper.html("");
            return;
        }
        if (!d.__walkin) {
            // Bookings hold room-type inventory; the physical room is allocated at check-in.
            return FD.call("hospitality_core.api.console.get_room_type_availability", {
                room_type: v.room_type, check_in_date: v.check_in_date, check_out_date: v.check_out_date,
            }).then((a) => {
                d.fields_dict.rate_info.$wrapper.html(a.available > 0
                    ? `<div class="fd-rate-box">${__("{0} of {1} rooms available", [a.available, a.total])} · ${FD.money(a.rate)} × ${a.nights} ${__("nights")} = <b>${FD.money(a.rate * a.nights)}</b></div>`
                    : `<div class="fd-rate-box fd-rate-none">${__("No {0} rooms available for these dates", [FD.esc(v.room_type)])}</div>`);
            }).catch(() => {});
        }
        FD.call("hospitality_core.api.console.get_available_rooms", {
            room_type: v.room_type, check_in_date: v.check_in_date, check_out_date: v.check_out_date,
        }).then((rooms) => {
            rooms = rooms || [];
            const keep = v.room && rooms.some((r) => r.name === v.room) ? v.room : (d.__pre_room && rooms.some((r) => r.name === d.__pre_room) ? d.__pre_room : "");
            field.df.options = [""].concat(rooms.map((r) => ({ value: r.name, label: `${r.room_number || r.name}${r.floor ? " · " + __("Floor") + " " + r.floor : ""}` })));
            field.refresh();
            field.set_value(keep || (d.__walkin && rooms[0] ? rooms[0].name : ""));
            const nights = frappe.datetime.get_diff(v.check_out_date, v.check_in_date);
            const rate = rooms[0] ? rooms[0].rate : 0;
            d.fields_dict.rate_info.$wrapper.html(rooms.length
                ? `<div class="fd-rate-box">${__("{0} rooms free", [rooms.length])} · ${FD.money(rate)} × ${nights} ${__("nights")} = <b>${FD.money(rate * nights)}</b></div>`
                : `<div class="fd-rate-box fd-rate-none">${__("No {0} rooms free for these dates", [FD.esc(v.room_type)])}</div>`);
        }).catch(() => {});
    },

    _reservation_dialog(walkin, pre_room, pre_type, from, to, customer) {
        const me = this;
        const d = FD.dialog({
            title: walkin ? __("Walk-in Check-in") : __("New Reservation"),
            size: "large",
            fields: [...this.guest_fields(walkin), ...this.stay_fields(pre_room, pre_type, from, to, walkin)],
            primary_action_label: walkin ? __("Check In Now") : __("Create Reservation"),
            primary_action(values) {
                if (!values.customer && !values.guest_name) {
                    frappe.msgprint(__("Select an existing guest or enter the new guest's name."));
                    return;
                }
                const data = {
                    customer: values.customer, guest_name: values.guest_name, mobile_no: values.mobile_no,
                    room_type: values.room_type, check_in_date: values.check_in_date,
                    check_out_date: values.check_out_date, adults: values.adults, children: values.children, remarks: values.remarks,
                };
                if (walkin) Object.assign(data, { room: values.room, guest_id_type: values.guest_id_type, guest_id_number: values.guest_id_number });
                const advance = values.advance_amount > 0 ? { amount: values.advance_amount, mode: values.advance_mode, reference_no: values.advance_reference } : null;
                return FD.call(`hospitality_core.api.console.${walkin ? "walk_in" : "create_reservation"}`, { data, advance }, { freeze: true })
                    .then((r) => {
                        me.done(d, walkin ? __("Guest checked in to room {0}", [r.reservation.room]) : __("Reservation {0} created", [r.reservation.name]));
                    });
            },
        });
        d.__pre_room = pre_room;
        d.__walkin = walkin;
        this._res_dialog = d;
        d.onhide = () => { if (me._res_dialog === d) me._res_dialog = null; };
        if (customer) d.set_value("customer", customer);
        d.show();
        this._refresh_room_options();
    },

    dialog_new_reservation(pre_room = null, pre_type = null, from = null, to = null, customer = null) {
        this._reservation_dialog(false, pre_room, pre_type, from, to, customer);
    },

    dialog_walkin(pre_room = null, pre_type = null) {
        this._reservation_dialog(true, pre_room, pre_type);
    },

    // ---------------- CHECK-IN ----------------
    dialog_checkin(res) {
        hospitality_core_checkin_dialog(res, (r) => this.done(null, __("Checked in to room {0}", [r.reservation.room])));
    },

    // ---------------- PAYMENT ----------------
    dialog_receive_payment(res, amount = null, after = null) {
        const me = this;
        const RECORD = __("Cash / Bank Transfer / Card (record payment)");
        const ONLINE = __("Razorpay Online Payment");
        const d = FD.dialog({
            title: __("Receive Payment · {0}", [res]),
            fields: [
                { fieldtype: "HTML", fieldname: "info" },
                { fieldtype: "Select", fieldname: "method", label: __("Payment Method"), options: [RECORD], default: RECORD, hidden: 1,
                  onchange() { d.get_primary_btn().text(d.get_value("method") === ONLINE ? __("Create Payment Request") : __("Receive")); } },
                { fieldtype: "Currency", fieldname: "amount", label: __("Amount"), reqd: 1, default: amount > 0 ? amount : null },
                { fieldtype: "Link", fieldname: "mode", label: __("Mode of Payment"), options: "Mode of Payment", default: me.state.settings.default_advance_mode,
                  depends_on: `eval:doc.method!=="${ONLINE}"`, mandatory_depends_on: `eval:doc.method!=="${ONLINE}"` },
                { fieldtype: "Data", fieldname: "reference", label: __("Reference No"), description: __("Card / UPI / cheque reference"), depends_on: `eval:doc.method!=="${ONLINE}"` },
                { fieldtype: "HTML", fieldname: "online_note", depends_on: `eval:doc.method==="${ONLINE}"`,
                  options: `<div class="fd-note">${__("A secure Razorpay checkout is created for this amount. The guest pays by QR code, link or on this screen; the payment is recorded automatically once Razorpay confirms it.")}</div>` },
            ],
            primary_action_label: __("Receive"),
            primary_action(v) {
                if (!(v.amount > 0)) { frappe.msgprint(__("Enter an amount greater than zero.")); return; }
                if (v.method === ONLINE) {
                    d.hide();
                    return me.start_online_payment({ reservation: res }, v.amount);
                }
                if (!v.mode) { frappe.msgprint(__("Select the Mode of Payment.")); return; }
                return FD.call("hospitality_core.api.console.receive_payment",
                    { reservation_name: res, mode: v.mode, amount: v.amount, reference: v.reference }, { freeze: true })
                    .then((r) => {
                        me.done(d, __("Payment {0} recorded. Balance {1}", [r.payment_entry, FD.money(r.billing.balance)]));
                        if (after) after(r);
                    });
            },
        });
        d.show();
        me.rzp_config().then((c) => {
            if (!c.front_desk) return;
            const f = d.fields_dict.method;
            f.df.options = [RECORD, ONLINE].join("\n");
            f.df.hidden = 0;
            f.refresh();
            d.fields_dict.mode.get_query = () => ({ filters: { enabled: 1, name: ["!=", c.mode_of_payment || ""] } });
        });
        FD.call("hospitality_core.api.console.get_bill_preview", { reservation_name: res }).then((b) => {
            d.fields_dict.info.$wrapper.html(`<div class="fd-money-row">
                <div><span>${__("Bill Total")}</span><b>${FD.money(b.grand_total)}</b></div>
                <div><span>${__("Paid")}</span><b class="text-success">${FD.money(b.total_paid)}</b></div>
                <div class="fd-money-due"><span>${__("Outstanding")}</span><b class="${b.balance > 0 ? "text-danger" : "text-success"}">${FD.money(b.balance)}</b></div></div>`);
            if (!d.get_value("amount") && b.balance > 0) d.set_value("amount", b.balance);
        }).catch(() => {});
    },

    // ---------------- BILL / CHECK-OUT ----------------
    bill_html(b) {
        return `
            <div class="fd-table-wrap"><table class="fd-table fd-bill">
                <thead><tr><th>${__("Description")}</th><th class="text-right">${__("Qty")}</th><th class="text-right">${__("Rate")}</th><th class="text-right">${__("Amount")}</th></tr></thead>
                <tbody>${(b.items || []).map((i) => `<tr>
                    <td>${FD.esc(i.description ? $("<div>").html(i.description).text() : i.item_name)}
                        ${i.source && i.source !== "Room Night" ? `<div class="small text-muted">${__("Room service")} · ${FD.esc(i.source)}</div>` : ""}</td>
                    <td class="text-right">${i.qty}</td><td class="text-right">${FD.money(i.rate)}</td><td class="text-right">${FD.money(i.amount)}</td></tr>`).join("")}
                    ${(b.taxes || []).map((t) => `<tr class="fd-bill-tax"><td colspan="3">${FD.esc(t.description)}</td><td class="text-right">${FD.money(t.tax_amount)}</td></tr>`).join("")}
                </tbody>
            </table></div>
            <div class="fd-money-row">
                <div><span>${__("Grand Total")}</span><b>${FD.money(b.grand_total)}</b></div>
                <div><span>${__("Paid / Advances")}</span><b class="text-success">${FD.money(b.total_paid)}</b></div>
                <div><span>${__("Room Service Paid at POS")}</span><b>${FD.money(b.room_service_paid)}</b><small class="text-muted">${__("not re-billed")}</small></div>
                <div class="fd-money-due"><span>${__("Outstanding")}</span><b class="${b.balance > 0 ? "text-danger" : "text-success"}">${FD.money(b.balance)}</b></div>
            </div>`;
    },

    dialog_bill_preview(res) {
        const me = this;
        FD.call("hospitality_core.api.console.get_bill_preview", { reservation_name: res }, { freeze: true }).then((b) => {
            const d = FD.dialog({
                title: __("Bill Preview · {0}", [res]), size: "large",
                fields: [{ fieldtype: "HTML", fieldname: "body" }],
                primary_action_label: __("Check Out"),
                primary_action: () => { d.hide(); me.dialog_checkout(res); },
            });
            d.fields_dict.body.$wrapper.html(me.bill_html(b));
            d.set_secondary_action_label(__("Receive Payment"));
            d.set_secondary_action(() => { d.hide(); me.dialog_receive_payment(res, b.balance); });
            d.show();
        });
    },

    dialog_checkout(res) {
        const me = this;
        const RECORD = __("Cash / Card / Bank");
        const ONLINE = __("Razorpay Online Checkout");

        FD.call("hospitality_core.api.console.get_bill_preview", { reservation_name: res }, { freeze: true }).then((b) => {
            const due = Math.max(b.balance || 0, 0);
            const d = FD.dialog({
                title: __("Check Out · {0}", [res]), size: "large",
                fields: [
                    { fieldtype: "HTML", fieldname: "bill" },
                    { fieldtype: "Section Break", label: due > 0 ? __("Settle Outstanding Now") : "" , hidden: due > 0 ? 0 : 1 },
                    { fieldtype: "Select", fieldname: "pay_method", label: __("Settlement Method"), options: [RECORD, ONLINE], default: RECORD,
                      onchange() {
                          const isOnline = d.get_value("pay_method") === ONLINE;
                          d.set_df_property("mode", "hidden", isOnline);
                          d.set_df_property("reference", "hidden", isOnline);
                          d.get_primary_btn().text(isOnline ? __("Initiate Razorpay & Check Out") : __("Confirm Check Out & Invoice"));
                      }
                    },
                    { fieldtype: "Currency", fieldname: "amount", label: __("Collect Amount"), default: due },
                    { fieldtype: "Column Break" },
                    { fieldtype: "Link", fieldname: "mode", label: __("Mode of Payment"), options: "Mode of Payment", default: me.state.settings.default_advance_mode },
                    { fieldtype: "Data", fieldname: "reference", label: __("Reference No") },
                ],
                primary_action_label: __("Confirm Check Out & Invoice"),
                primary_action(v) {
                    if (due > 0 && v.amount > 0 && v.pay_method === ONLINE) {
                        d.hide();
                        return me.start_online_payment({ reservation: res }, v.amount, b.customer_name).then(() => {
                            me.dialog_checkout(res);
                        });
                    }

                    const collect = due > 0 && v.amount > 0 ? { amount: v.amount, mode: v.mode, reference: v.reference } : null;
                    if (collect && !v.mode) { frappe.msgprint(__("Select the Mode of Payment.")); return; }
                    return FD.call("hospitality_core.api.console.check_out", { reservation_name: res, collect_payment: collect },
                        { freeze: true, freeze_message: __("Creating Sales Invoice…") })
                        .then((r) => {
                            me.done(d, __("Checked out. Invoice {0}", [r.sales_invoice]));
                            const s = FD.dialog({
                                title: __("Check-Out Completed"),
                                fields: [{ fieldtype: "HTML", fieldname: "b", options: `<div class="fd-success">${FD.icon("check", "lg")}
                                    <div>${__("Sales Invoice {0} submitted. The room is now marked Dirty for housekeeping.", [`<b>${FD.esc(r.sales_invoice)}</b>`])}</div></div>` }],
                                primary_action_label: __("Print Invoice"),
                                primary_action: () => fd_open_print_popup("Sales Invoice", r.sales_invoice),
                            });
                            s.show();
                        });
                },
            });
            d.fields_dict.bill.$wrapper.html(me.bill_html(b));
            d.show();
        });
    },

    // ---------------- ROOM CHANGES ----------------
    _room_select_dialog(title, res, method, note) {
        const me = this;
        FD.call("hospitality_core.api.console.get_reservation_details", { reservation_name: res }).then((data) => {
            const r = data.reservation;
            const from = r.status === "Checked In" ? frappe.datetime.get_today() : r.check_in_date;
            const d = FD.dialog({
                title, fields: [
                    { fieldtype: "HTML", fieldname: "info", options: `<div class="text-muted mb-2">${__("Current room")}: <b>${FD.esc(r.room || __("Not Assigned"))}</b> (${FD.esc(r.room_type)}) · ${FD.date(from)} → ${FD.date(r.check_out_date)}</div>` },
                    { fieldtype: "Link", fieldname: "room_type", label: __("Room Type"), options: "Hotel Room Type", reqd: 1, default: r.room_type, onchange: () => load() },
                    { fieldtype: "Select", fieldname: "room", label: __("New Room"), reqd: 1, options: [] },
                    ...(method === "move_room" ? [
                        { fieldtype: "Check", fieldname: "keep_rate", label: __("Keep current rate"), default: 1 },
                        { fieldtype: "Data", fieldname: "reason", label: __("Reason") },
                    ] : []),
                    ...(note ? [{ fieldtype: "HTML", fieldname: "note", options: `<div class="small text-muted">${note}</div>` }] : []),
                ],
                primary_action_label: __("Confirm"),
                primary_action(v) {
                    const args = method === "move_room"
                        ? { reservation_name: res, new_room: v.room, reason: v.reason, keep_rate: v.keep_rate }
                        : { reservation_name: res, new_room: v.room };
                    return FD.call(`hospitality_core.api.console.${method}`, args, { freeze: true })
                        .then(() => me.done(d, __("Room changed to {0}", [v.room])));
                },
            });
            const load = () => {
                const t = d.get_value("room_type");
                if (!t) return;
                FD.call("hospitality_core.api.console.get_available_rooms", {
                    room_type: t, check_in_date: from, check_out_date: r.check_out_date > from ? r.check_out_date : frappe.datetime.add_days(from, 1),
                    exclude_reservation: res,
                }).then((rooms) => {
                    const opts = (rooms || []).filter((x) => x.name !== r.room && (method !== "move_room" || x.status === "Available"));
                    d.fields_dict.room.df.options = [""].concat(opts.map((x) => ({ value: x.name, label: `${x.room_number || x.name} · ${FD.money(x.rate)}` })));
                    d.fields_dict.room.refresh();
                    if (!opts.length) d.fields_dict.room.set_description(__("No free rooms of this type for the remaining stay."));
                    else d.fields_dict.room.set_description("");
                });
            };
            d.show();
            load();
        });
    },

    dialog_move_room(res) {
        this._room_select_dialog(__("Move Room · {0}", [res]), res, "move_room",
            __("Nights so far stay billed on the old room; the old room goes to housekeeping (Dirty)."));
    },

    dialog_change_reserved_room(res) {
        this._room_select_dialog(__("Change Room · {0}", [res]), res, "change_reserved_room");
    },

    dialog_extend_stay(res) {
        const me = this;
        FD.call("hospitality_core.api.console.get_reservation_details", { reservation_name: res }).then((data) => {
            const r = data.reservation;
            const d = FD.dialog({
                title: r.status === "Checked In" ? __("Extend Stay · {0}", [res]) : __("Change Departure · {0}", [res]),
                fields: [
                    { fieldtype: "HTML", fieldname: "info", options: `<div class="text-muted mb-2">${__("Room")} <b>${FD.esc(r.room || __("Not Assigned"))}</b> · ${__("Current check-out")}: <b>${FD.date(r.check_out_date)}</b></div>` },
                    { fieldtype: "Date", fieldname: "new_date", label: __("New Check-out Date"), reqd: 1, default: frappe.datetime.add_days(r.check_out_date, 1) },
                ],
                primary_action_label: __("Update Stay"),
                primary_action(v) {
                    return FD.call("hospitality_core.api.console.extend_stay", { reservation_name: res, new_check_out_date: v.new_date }, { freeze: true })
                        .then((x) => me.done(d, __("Check-out moved to {0}. New total {1}", [FD.date(v.new_date), FD.money(x.billing.estimated_total)])));
                },
            });
            d.show();
        });
    },

    dialog_cancel(res) {
        const me = this;
        const d = FD.dialog({
            title: __("Cancel Reservation · {0}", [res]),
            fields: [
                { fieldtype: "HTML", fieldname: "w", options: `<div class="fd-note">${__("The room will be released. Any advance payment must be refunded with a standard Payment Entry (Pay).")}</div>` },
                { fieldtype: "Small Text", fieldname: "reason", label: __("Reason") },
            ],
            primary_action_label: __("Cancel Reservation"),
            primary_action(v) {
                return FD.call("hospitality_core.api.console.cancel_reservation", { reservation_name: res, reason: v.reason }, { freeze: true })
                    .then(() => me.done(d, __("Reservation {0} cancelled", [res]), "orange"));
            },
        });
        d.get_primary_btn().removeClass("btn-primary").addClass("btn-danger");
        d.show();
    },

    // ---------------- MAINTENANCE ----------------
    dialog_report_issue(pre_room = null) {
        const me = this;
        const d = FD.dialog({
            title: __("Report Maintenance Issue"),
            fields: [
                { fieldtype: "Link", fieldname: "room", label: __("Room"), options: "Hotel Room", reqd: 1, default: pre_room },
                { fieldtype: "Data", fieldname: "subject", label: __("Problem"), reqd: 1, placeholder: __("e.g. AC not cooling") },
                { fieldtype: "Select", fieldname: "priority", label: __("Priority"), options: "Low\nMedium\nHigh", default: "Medium" },
                { fieldtype: "Small Text", fieldname: "description", label: __("Details") },
            ],
            primary_action_label: __("Report"),
            primary_action(v) {
                return FD.call("hospitality_core.api.console.report_issue", v, { freeze: true })
                    .then((r) => me.done(d, __("Issue {0} reported", [r.issue]), "orange"));
            },
        });
        d.show();
    },

    dialog_resolve_issue(issue) {
        const me = this;
        const d = FD.dialog({
            title: __("Resolve Issue · {0}", [issue]),
            fields: [{ fieldtype: "Small Text", fieldname: "notes", label: __("Resolution Notes") }],
            primary_action_label: __("Mark Resolved"),
            primary_action(v) {
                return FD.call("hospitality_core.api.console.resolve_issue", { issue_name: issue, notes: v.notes }, { freeze: true })
                    .then((r) => me.done(d, __("Issue resolved. Room {0} released.", [r.room])));
            },
        });
        d.show();
    },

    // ---------------- SETTINGS ----------------
    dialog_hotel_settings() {
        const me = this;
        frappe.db.get_doc("Hotel Settings").then((s) => {
            const d = FD.dialog({
                title: __("Hotel Settings"), size: "large",
                fields: [
                    { fieldtype: "Link", fieldname: "company", label: __("Company"), options: "Company", default: s.company },
                    { fieldtype: "Link", fieldname: "default_room_item", label: __("Default Room Item"), options: "Item", default: s.default_room_item },
                    { fieldtype: "Link", fieldname: "sales_taxes_template", label: __("Sales Taxes Template"), options: "Sales Taxes and Charges Template", default: s.sales_taxes_template },
                    { fieldtype: "Column Break" },
                    { fieldtype: "Link", fieldname: "restaurant_pos_profile", label: __("Restaurant POS Profile"), options: "POS Profile", default: s.restaurant_pos_profile },
                    { fieldtype: "Link", fieldname: "room_pos_profile", label: __("Room Service POS Profile"), options: "POS Profile", default: s.room_pos_profile },
                    { fieldtype: "Link", fieldname: "default_advance_mode", label: __("Default Mode of Payment"), options: "Mode of Payment", default: s.default_advance_mode },
                    { fieldtype: "Section Break" },
                    { fieldtype: "Check", fieldname: "allow_checkin_before_arrival", label: __("Allow check-in before arrival date"), default: s.allow_checkin_before_arrival },
                    { fieldtype: "Check", fieldname: "block_checkout_if_balance", label: __("Block check-out if balance due"), default: s.block_checkout_if_balance },
                    { fieldtype: "Column Break" },
                    { fieldtype: "Currency", fieldname: "balance_tolerance", label: __("Balance Tolerance"), default: s.balance_tolerance },
                    { fieldtype: "Int", fieldname: "min_billable_nights", label: __("Minimum Billable Nights"), default: s.min_billable_nights || 1 },
                ],
                primary_action_label: __("Save"),
                primary_action(v) {
                    return frappe.call({ method: "frappe.client.set_value", args: { doctype: "Hotel Settings", name: "Hotel Settings", fieldname: v } })
                        .then((r) => { if (!r.exc) me.done(d, __("Settings saved")); });
                },
            });
            d.show();
        });
    },
});
