// Hotel Payment Gateway Settings: Razorpay gateway dashboard.
// All status shown here comes from hospitality_core.api.razorpay.get_gateway_status (backend state).
const HPG = "hospitality_core.api.razorpay.";

frappe.ui.form.on("Hotel Payment Gateway Settings", {
	setup(frm) {
		frm.set_query("clearing_account", () => ({
			filters: { company: frm.doc.company, is_group: 0, account_type: ["in", ["Bank", "Cash"]], disabled: 0 },
		}));
		frm.set_query("receivable_account", () => ({
			filters: { company: frm.doc.company, is_group: 0, account_type: "Receivable" },
		}));
		frm.set_query("mode_of_payment", () => ({ filters: { enabled: 1 } }));
	},

	refresh(frm) {
		// frm.disable_save(false);

		
		hpg_render_dashboard(frm);
		hpg_buttons(frm);
		if (frm.doc.environment !== "Live") {
			frm.set_intro(__("TEST MODE — payments use Razorpay test credentials; no real money moves."), "orange");
		}
	},

	company(frm) {
		if (!frm.doc.company) return;
		frappe.db.get_value("Company", frm.doc.company, "default_currency").then((r) => {
			if (r.message && r.message.default_currency) frm.set_value("default_currency", r.message.default_currency);
		});
	},

	environment(frm) {
		if (frm.doc.environment === "Live") {
			frappe.msgprint({
				title: __("Live Mode locked"),
				indicator: "red",
				message: __("Live Mode requires a separate, Administrator-approved activation process and is not available in this release."),
			});
			frm.set_value("environment", "Test");
		}
	},
});

function hpg_call(method, args = {}, opts = {}) {
	return frappe.call({ method: HPG + method, args, freeze: opts.freeze, freeze_message: opts.freeze_message, btn: opts.btn })
		.then((r) => r.message);
}

function hpg_buttons(frm) {
	const G = __("Gateway");
	const W = __("Webhook");
	const ensure_saved = (fn) => () => {
		if (frm.is_dirty()) {
			frappe.msgprint(__("Save the configuration first."));
			return;
		}
		fn();
	};
	frm.add_custom_button(__("Test Connection"), ensure_saved(() => {
		hpg_call("test_connection", {}, { freeze: true, freeze_message: __("Contacting Razorpay…") }).then((r) => {
			frappe.msgprint({ title: r.ok ? __("Connection successful") : __("Connection failed"), indicator: r.ok ? "green" : "red", message: frappe.utils.escape_html(r.message) });
			frm.reload_doc();
		});
	}), G);
	frm.add_custom_button(__("Verify Credentials"), ensure_saved(() => {
		hpg_call("verify_credentials").then((r) => {
			const rows = r.checks.map((c) => `<tr><td>${c.ok ? "✅" : "❌"}</td><td>${frappe.utils.escape_html(c.label)}${!c.ok && c.hint ? `<div class="text-muted small">${frappe.utils.escape_html(c.hint)}</div>` : ""}</td></tr>`).join("");
			frappe.msgprint({ title: __("Credential checks"), indicator: r.ok ? "green" : "orange", message: `<table class="table table-sm">${rows}</table><div class="text-muted small">${__("Secrets are never displayed. Use Test Connection to verify them with Razorpay.")}</div>` });
		});
	}), G);
	frm.add_custom_button(__("Generate Test Payment"), ensure_saved(() => {
		frappe.prompt([{ fieldname: "amount", fieldtype: "Currency", label: __("Amount (1 – 100)"), default: 1, reqd: 1 }], (v) => {
			hpg_call("generate_test_payment", { amount: v.amount }, { freeze: true }).then((r) => hpg_handoff_dialog(r, __("Test payment"), () => frm.reload_doc()));
		}, __("Generate Test Payment"), __("Create"));
	}), G);
	frm.add_custom_button(__("View Transaction History"), () => frappe.set_route("hotel-payment-dashboard"), G);
	if (frm.doc.enabled) {
		frm.add_custom_button(__("Disable Gateway"), () => {
			frappe.confirm(__("Disable online payments? Open payment links will stop working until the gateway is enabled again."), () => {
				hpg_call("disable_gateway").then(() => frm.reload_doc());
			});
		}, G);
	}
	frm.add_custom_button(__("Configure Webhook"), () => hpg_webhook_dialog(true), W);
	frm.add_custom_button(__("View Webhook Endpoint"), () => hpg_webhook_dialog(false), W);
	if (!frm.doc.clearing_account || !frm.doc.mode_of_payment) {
		frm.add_custom_button(__("Create Clearing Account & Mode of Payment"), () => {
			if (!frm.doc.company) { frappe.msgprint(__("Select the Company first.")); return; }
			frappe.confirm(__("Create a 'Razorpay Clearing' Bank ledger and a 'Razorpay' Mode of Payment for {0}? Existing records are not changed.", [frm.doc.company]), () => {
				hpg_call("setup_accounting_defaults", { company: frm.doc.company }, { freeze: true }).then((r) => {
					frm.set_value("clearing_account", r.clearing_account);
					frm.set_value("mode_of_payment", r.mode_of_payment);
					if (r.currency) frm.set_value("default_currency", r.currency);
					frappe.show_alert({ message: __("Created. Review and save."), indicator: "green" });
				});
			});
		}, __("Setup"));
	}
}

function hpg_webhook_dialog(full) {
	hpg_call("get_webhook_info").then((w) => {
		const esc = frappe.utils.escape_html;
		const steps = full ? `
			<ol class="small" style="padding-left:18px">
				<li>${__("Razorpay Dashboard (Test Mode) → Account & Settings → Webhooks → Add New Webhook.")}</li>
				<li>${__("Webhook URL")}: ${__("the URL above.")}</li>
				<li>${__("Secret")}: ${__("a new random secret; store the same value in Webhook Secret here. Do not reuse the API Key Secret.")}</li>
				<li>${__("Active events")}: <code>${w.events.map(esc).join("</code>, <code>")}</code></li>
				<li>${__("Save. The setup step completes when the first valid, signed webhook arrives.")}</li>
			</ol>` : "";
		const d = new frappe.ui.Dialog({
			title: full ? __("Configure Razorpay Webhook") : __("Webhook Endpoint"),
			fields: [{ fieldtype: "HTML", fieldname: "h" }],
		});
		d.fields_dict.h.$wrapper.html(`
			<div class="form-group"><label class="control-label">${__("Webhook URL")}</label>
				<div class="input-group"><input class="form-control" readonly value="${esc(w.url)}">
				<button class="btn btn-default hpg-copy">${__("Copy")}</button></div></div>
			${w.https ? "" : `<div class="alert alert-warning small">${__("This URL is not HTTPS. Razorpay needs a public HTTPS URL: set Public Base URL to your public https domain.")}</div>`}
			<div class="small mb-2">${__("Webhook secret")}: <b>${w.secret_configured ? __("configured") : __("not configured")}</b> ·
				${__("Last valid webhook")}: <b>${w.last_received ? esc(frappe.datetime.str_to_user(w.last_received)) : __("never")}</b></div>
			${steps}`);
		d.$wrapper.find(".hpg-copy").on("click", () => frappe.utils.copy_to_clipboard(w.url));
		d.show();
	});
}

function hpg_handoff_dialog(r, title, on_close) {
	const esc = frappe.utils.escape_html;
	const t = r.transaction;
	const d = new frappe.ui.Dialog({ title, fields: [{ fieldtype: "HTML", fieldname: "h" }], primary_action_label: __("Open checkout"), primary_action: () => window.open(r.pay_url, "_blank", "noopener") });
	d.fields_dict.h.$wrapper.html(`
		<div class="text-center">${r.qr_svg ? `<div style="display:inline-block;background:#fff;padding:8px;border-radius:8px">${r.qr_svg}</div>` : ""}</div>
		<div class="form-group mt-3"><div class="input-group"><input class="form-control" readonly value="${esc(r.pay_url)}">
			<button class="btn btn-default hpg-copy">${__("Copy")}</button></div></div>
		<div class="small text-muted">${esc(t.name)} · ${format_currency(t.amount, t.currency)} · <span class="hpg-status">${esc(t.status)}</span></div>`);
	d.$wrapper.find(".hpg-copy").on("click", () => frappe.utils.copy_to_clipboard(r.pay_url));
	const timer = setInterval(() => {
		hpg_call("get_transaction_status", { name: t.name }).then((s) => d.$wrapper.find(".hpg-status").text(s.status));
	}, 5000);
	d.onhide = () => { clearInterval(timer); on_close && on_close(); };
	d.show();
}

function hpg_render_dashboard(frm) {
	const $w = frm.get_field("gateway_dashboard").$wrapper;
	$w.html(`<div class="text-muted small p-3">${__("Loading gateway status…")}</div>`);
	hpg_call("get_gateway_status").then((s) => {
		const esc = frappe.utils.escape_html;
		const dt = (v) => (v ? frappe.datetime.prettyDate(v) : __("never"));
		const pill = (ok, yes, no) => `<span class="indicator-pill ${ok ? "green" : "gray"}">${ok ? yes : no}</span>`;
		const stat = (label, value, hint = "") => `
			<div class="hpg-stat"><div class="hpg-stat-v">${value}</div><div class="hpg-stat-l">${label}</div>${hint ? `<div class="hpg-stat-h">${hint}</div>` : ""}</div>`;
		const steps = s.steps.map((x) => `<li class="${x.done ? "done" : ""}"><span class="hpg-dot">${x.done ? "✓" : ""}</span>${esc(x.label)}</li>`).join("");
		$w.html(`
			<style>
				.hpg{border:1px solid var(--border-color);border-radius:12px;padding:18px;margin-bottom:8px;background:var(--card-bg)}
				.hpg-top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
				.hpg-logo{height:30px;width:auto}
				.hpg-name{font-size:18px;font-weight:600}
				.hpg-env{font-size:11px;font-weight:700;letter-spacing:.06em;padding:3px 8px;border-radius:6px;background:var(--bg-orange);color:var(--text-on-orange)}
				.hpg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
				.hpg-stat{border:1px solid var(--border-color);border-radius:10px;padding:10px 12px}
				.hpg-stat-v{font-size:16px;font-weight:600}
				.hpg-stat-l{font-size:12px;color:var(--text-muted)}
				.hpg-stat-h{font-size:11px;color:var(--text-light)}
				.hpg-prog{height:8px;border-radius:4px;background:var(--gray-100);overflow:hidden;margin:6px 0 10px}
				.hpg-prog>div{height:100%;background:var(--green-500)}
				.hpg-steps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:6px 18px;font-size:13px}
				.hpg-steps li{display:flex;align-items:center;gap:8px;color:var(--text-muted)}
				.hpg-steps li.done{color:var(--text-color)}
				.hpg-dot{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--gray-400);display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:none}
				.hpg-steps li.done .hpg-dot{background:var(--green-500);border-color:var(--green-500);color:#fff}
			</style>
			<div class="hpg">
				<div class="hpg-top">
					<svg class="hpg-logo" viewBox="0 0 120 30" role="img" aria-label="Razorpay"><path d="M14 3 7 27h5l7-24z" fill="#3395FF"/><path d="M19 9l-3 10 9-10z" fill="#072654"/><text x="30" y="21" font-size="16" font-family="Arial,Helvetica,sans-serif" font-weight="700" fill="currentColor">Razorpay</text></svg>
					<span class="hpg-env">${esc(s.environment.toUpperCase())} MODE</span>
					${pill(s.enabled, __("Enabled"), __("Disabled"))}
					${pill(s.connection_status && s.connection_status.startsWith(__("Connected")), __("Connected"), esc(s.connection_status || __("Not tested")))}
					<span class="text-muted small ml-auto">${s.key_id_masked ? __("Key") + " " + esc(s.key_id_masked) : __("No API key")}</span>
				</div>
				<div class="hpg-grid">
					${stat(__("API keys"), s.key_configured ? __("Configured") : __("Missing"))}
					${stat(__("Webhook"), s.webhook_secret_configured ? __("Secret set") : __("Not set"), __("last") + ": " + dt(s.last_webhook_received_on))}
					${stat(__("Accounting"), s.accounting_configured ? __("Ready") : __("Incomplete"))}
					${stat(__("Last successful payment"), dt(s.last_successful_payment_on))}
					${stat(__("Test transactions"), s.total_transactions, s.captured_transactions + " " + __("paid"))}
					${stat(__("Failed"), s.failed_transactions, s.pending_reconciliation ? s.pending_reconciliation + " " + __("awaiting reconciliation") : "")}
				</div>
				<div class="d-flex justify-content-between small"><b>${__("Setup progress")}</b><span>${s.progress}%</span></div>
				<div class="hpg-prog"><div style="width:${s.progress}%"></div></div>
				<ul class="hpg-steps">${steps}</ul>
				${s.https ? "" : `<div class="text-muted small mt-3">⚠ ${__("The public URL is not HTTPS. Checkout pages and webhooks must be served over HTTPS before Live Mode.")}</div>`}
			</div>`);
	}).catch(() => $w.empty());
}
