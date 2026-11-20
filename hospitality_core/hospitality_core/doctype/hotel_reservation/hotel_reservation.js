{% include "hospitality_core/public/js/checkin_dialog.js" %}

frappe.ui.form.on("Hotel Reservation", {
    refresh(frm) {
        // A booking holds room-type inventory; the physical room is allocated at check-in.
        frm.set_df_property("room", "read_only", frm.doc.status === "Checked In" || frm.doc.status === "Reserved" || frm.is_new() ? 1 : 0);
        frm.trigger("show_availability");
        frm.trigger("render_buttons");
        if (!frm.is_new()) {
            frm.trigger("refresh_billing_summary");
        }
    },

    customer(frm) {
        if (frm.doc.customer && frm.doc.room_type && frm.doc.check_in_date) {
            frm.trigger("update_rate_and_stays");
        }
    },

    room_type(frm) {
        if (frm.doc.status !== "Checked In") frm.set_value("room", "");
        frm.trigger("show_availability");
        if (frm.doc.room_type && frm.doc.check_in_date && frm.doc.check_out_date) {
            frm.trigger("update_rate_and_stays");
        }
    },

    show_availability(frm) {
        frm.dashboard.clear_headline();
        if (frm.doc.status !== "Reserved" || !frm.doc.room_type || !frm.doc.check_in_date || !frm.doc.check_out_date
            || frm.doc.check_out_date <= frm.doc.check_in_date) return;
        frappe.call({
            method: "hospitality_core.api.console.get_room_type_availability",
            args: { room_type: frm.doc.room_type, check_in_date: frm.doc.check_in_date,
                    check_out_date: frm.doc.check_out_date, exclude_reservation: frm.is_new() ? null : frm.doc.name },
        }).then((r) => {
            const a = r.message;
            if (!a) return;
            frm.dashboard.set_headline(a.available > 0
                ? __("{0} of {1} {2} rooms available for these dates", [a.available, a.total, frappe.utils.escape_html(a.room_type)])
                : `<span class="text-danger">${__("No {0} rooms available for these dates", [frappe.utils.escape_html(a.room_type)])}</span>`);
        });
    },

    room(frm) {
        if (frm.doc.stays && frm.doc.stays.length === 1) {
            frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "room", frm.doc.room);
            frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "room_type", frm.doc.room_type);
            frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "from_date", frm.doc.check_in_date);
            frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "to_date", frm.doc.check_out_date);
            let diff = frappe.datetime.get_diff(frm.doc.check_out_date, frm.doc.check_in_date) || 1;
            frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "nights", diff);
            frm.refresh_field("stays");
        }
    },

    check_in_date(frm) {
        frm.trigger("show_availability");
        if (frm.doc.room_type && frm.doc.check_in_date && frm.doc.check_out_date) {
            frm.trigger("update_rate_and_stays");
        }
    },

    check_out_date(frm) {
        frm.trigger("show_availability");
        if (frm.doc.room_type && frm.doc.check_in_date && frm.doc.check_out_date) {
            frm.trigger("update_rate_and_stays");
        }
    },

    update_rate_and_stays(frm) {
        if (!frm.doc.room_type || !frm.doc.check_in_date || !frm.doc.check_out_date) return;
        frappe.call({
            method: "hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation.get_room_rate",
            args: {
                room_type: frm.doc.room_type,
                date: frm.doc.check_in_date,
                customer: frm.doc.customer
            },
            callback: (r) => {
                const rate = r.message || 0;
                let diff = frappe.datetime.get_diff(frm.doc.check_out_date, frm.doc.check_in_date) || 1;
                if (!frm.doc.stays || frm.doc.stays.length === 0) {
                    frm.clear_table("stays");
                    const row = frm.add_child("stays");
                    row.room = frm.doc.room;
                    row.room_type = frm.doc.room_type;
                    row.from_date = frm.doc.check_in_date;
                    row.to_date = frm.doc.check_out_date;
                    row.rate = rate;
                    row.nights = diff;
                    frm.refresh_field("stays");
                } else if (frm.doc.stays.length === 1) {
                    frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "room", frm.doc.room);
                    frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "room_type", frm.doc.room_type);
                    frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "from_date", frm.doc.check_in_date);
                    frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "to_date", frm.doc.check_out_date);
                    frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "rate", rate);
                    frappe.model.set_value(frm.doc.stays[0].doctype, frm.doc.stays[0].name, "nights", diff);
                    frm.refresh_field("stays");
                }
            }
        });
    },

    refresh_billing_summary(frm) {
        frappe.call({
            method: "hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation.get_billing_summary",
            args: { reservation_name: frm.doc.name },
            callback: (r) => {
                if (r.message) {
                    frm.set_value("estimated_total", r.message.estimated_total);
                    frm.set_value("total_paid", r.message.total_paid);
                    frm.set_value("balance", r.message.balance);
                }
            }
        });
    },

    render_buttons(frm) {
        if (frm.is_new()) return;

        // Razorpay Payment Button for Desk staff
        if (frm.doc.status === "Reserved" || frm.doc.status === "Checked In") {
            frappe.call({
                method: "hospitality_core.api.razorpay.get_front_desk_config",
                silent: true
            }).then((r) => {
                const c = r.message || {};
                if (!c.front_desk) return;
                frm.add_custom_button(__("Pay via Razorpay"), () => {
                    frm.trigger("show_razorpay_dialog");
                }, __("Payment"));
            }).catch(() => {});
        }

        if (frm.doc.status === "Reserved") {
            frm.add_custom_button(__("Check In"), () => {
                hospitality_core_checkin_dialog(frm.doc.name, () => frm.reload_doc());
            }).addClass("btn-primary");

            frm.add_custom_button(__("Cancel Reservation"), () => {
                frappe.confirm(__("Are you sure you want to cancel this reservation?"), () => {
                    frappe.call({
                        method: "hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation.cancel_reservation",
                        args: { reservation_name: frm.doc.name },
                        callback: () => {
                            frm.reload_doc();
                        }
                    });
                });
            });
        } else if (frm.doc.status === "Checked In") {
            frm.add_custom_button(__("Move Room"), () => {
                frm.trigger("show_move_room_dialog");
            });

            frm.add_custom_button(__("Receive Payment"), () => {
                frappe.new_doc("Payment Entry", {
                    payment_type: "Receive",
                    party_type: "Customer",
                    party: frm.doc.customer,
                    company: frm.doc.company,
                    hotel_reservation: frm.doc.name
                });
            });

            frm.add_custom_button(__("Check Out"), () => {
                frappe.confirm(__("Are you sure you want to check out this guest and finalize billing?"), () => {
                    frappe.call({
                        method: "hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation.check_out",
                        args: { reservation_name: frm.doc.name },
                        callback: (r) => {
                            if (r.message && r.message.sales_invoice) {
                                frappe.show_alert({
                                    message: __("Check-out complete. Sales Invoice {0} created.", [r.message.sales_invoice]),
                                    indicator: "green"
                                });
                            }
                            frm.reload_doc();
                        }
                    });
                });
            }).addClass("btn-primary");
        } else if (frm.doc.status === "Checked Out" && frm.doc.sales_invoice) {
            frm.add_custom_button(__("View Sales Invoice"), () => {
                frappe.set_route("Form", "Sales Invoice", frm.doc.sales_invoice);
            });
        }
    },

    show_move_room_dialog(frm) {
        const today = frappe.datetime.get_today();
        frappe.call({
            method: "hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation.get_available_rooms",
            args: {
                room_type: frm.doc.room_type,
                check_in_date: today,
                check_out_date: frm.doc.check_out_date,
                exclude_reservation: frm.doc.name
            },
            callback: (r) => {
                const rooms = (r.message || []).map((x) => ({ label: `${x.room_number} (${x.status})`, value: x.name }));
                const d = new frappe.ui.Dialog({
                    title: __("Move Room for Reservation {0}", [frm.doc.name]),
                    fields: [
                        {
                            label: __("New Room"),
                            fieldname: "new_room",
                            fieldtype: "Select",
                            options: rooms,
                            reqd: 1
                        },
                        {
                            label: __("Keep Current Rate"),
                            fieldname: "keep_rate",
                            fieldtype: "Check",
                            default: 1
                        },
                        {
                            label: __("Move Reason"),
                            fieldname: "reason",
                            fieldtype: "Small Text"
                        }
                    ],
                    primary_action_label: __("Move Room"),
                    primary_action(values) {
                        d.hide();
                        frappe.call({
                            method: "hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation.move_room",
                            args: {
                                reservation_name: frm.doc.name,
                                new_room: values.new_room,
                                reason: values.reason,
                                keep_rate: values.keep_rate ? 1 : 0
                            },
                            callback: () => {
                                frm.reload_doc();
                            }
                        });
                    }
                });
                d.show();
            }
        });
    },

    show_razorpay_dialog(frm) {
        frappe.call({
            method: "hospitality_core.hospitality_core.doctype.hotel_reservation.hotel_reservation.get_billing_summary",
            args: { reservation_name: frm.doc.name }
        }).then((b) => {
            const summary = b.message || {};
            const def_amount = summary.balance > 0 ? summary.balance : summary.estimated_total;
            const d = new frappe.ui.Dialog({
                title: __("Razorpay Payment · {0}", [frm.doc.name]),
                fields: [
                    { fieldtype: "Data", fieldname: "customer", label: __("Customer"), default: frm.doc.customer, read_only: 1 },
                    { fieldtype: "Currency", fieldname: "amount", label: __("Amount"), reqd: 1, default: def_amount },
                ],
                primary_action_label: __("Create Payment Request"),
                primary_action(v) {
                    if (!(v.amount > 0)) {
                        frappe.msgprint(__("Please enter an amount greater than zero."));
                        return;
                    }
                    const key = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
                    frappe.call({
                        method: "hospitality_core.api.razorpay.create_reservation_payment_request",
                        args: { reservation: frm.doc.name, amount: v.amount, idempotency_key: key },
                        freeze: true
                    }).then((r) => {
                        d.hide();
                        frm.trigger("show_razorpay_checkout_modal", r.message);
                    });
                }
            });
            d.show();
        });
    },

    show_razorpay_checkout_modal(frm, r) {
        const t = r.transaction;
        const esc = frappe.utils.escape_html;
        let done = false;
        const d = new frappe.ui.Dialog({
            title: __("Razorpay Payment · {0}", [t.name]),
            fields: [{ fieldtype: "HTML", fieldname: "h" }],
            primary_action_label: __("Open Checkout"),
            primary_action: () => window.open(r.pay_url, "hc_rzp_checkout", "popup,width=520,height=760"),
            secondary_action_label: __("Cancel Request"),
            secondary_action: () => {
                frappe.confirm(__("Cancel this payment request?"), () => {
                    frappe.call({
                        method: "hospitality_core.api.razorpay.cancel_payment_request",
                        args: { name: t.name }
                    }).then(() => {
                        d.hide();
                        frm.reload_doc();
                    });
                });
            }
        });

        d.fields_dict.h.$wrapper.html(`
            <div class="text-center">${r.qr_svg ? `<div style="display:inline-block;background:#fff;padding:8px;border-radius:8px">${r.qr_svg}</div>` : ""}</div>
            <div class="input-group mt-3">
                <input class="form-control" readonly value="${esc(r.pay_url)}">
                <button class="btn btn-default hc-copy">${__("Copy Link")}</button>
            </div>
            <div class="mt-3 text-center">
                <span class="indicator-pill blue hc-status">${__("Waiting for payment…")}</span>
            </div>
        `);

        d.$wrapper.find(".hc-copy").on("click", () => frappe.utils.copy_to_clipboard(r.pay_url));

        const timer = setInterval(() => {
            frappe.call({
                method: "hospitality_core.api.razorpay.get_transaction_status",
                args: { name: t.name },
                silent: true
            }).then((s) => {
                const st = s.message.status;
                d.$wrapper.find(".hc-status").text(__(st))
                    .toggleClass("green", st === "Reconciled")
                    .toggleClass("red", st === "Failed");
                if (st === "Reconciled" && !done) {
                    done = true;
                    clearInterval(timer);
                    frappe.show_alert({ message: __("Payment confirmed and recorded!"), indicator: "green" });
                    frm.reload_doc();
                }
            });
        }, 4000);

        d.onhide = () => clearInterval(timer);
        d.show();
    }
});
