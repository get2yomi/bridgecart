import { createOrderForm } from "./order-form.js";

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

let overview = null;

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value) || 0);
}

function nairaAmount(value) {
  return `₦${Number(value || 0).toLocaleString()}`;
}

function formatDate(value, withTime = false) {
  if (!value) return null;
  const date = new Date(value);
  return withTime
    ? date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function statusLabel(status) {
  return String(status || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusPillClass(status) {
  if (["approved", "confirmed", "paid", "delivered", "active", "refunded"].includes(status)) return "approved";
  if (["rejected", "cancelled", "denied", "superseded"].includes(status)) return "rejected";
  return "pending";
}

function maskNin(nin) {
  if (!nin) return null;
  const digits = String(nin);
  if (digits.length <= 4) return digits;
  return `${"•".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function openModal(id) {
  const modal = $(id);
  modal.hidden = false;
  document.body.classList.add("modal-open");
}
function closeModals() {
  $$(".modal-backdrop").forEach((modal) => { modal.hidden = true; });
  document.body.classList.remove("modal-open");
}
$$("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModals));
$$(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeModals(); }));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModals(); });

function showFlash(message, isError = false) {
  const flash = $("#dash-flash");
  flash.textContent = message;
  flash.hidden = false;
  flash.classList.toggle("dash-flash-error", isError);
  flash.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---- Boot ---- */

async function boot() {
  try {
    overview = await apiFetch("/api/account/overview");
  } catch {
    $("#dash-guard").hidden = false;
    return;
  }
  $("#dash-main").hidden = false;
  renderHeader();
  renderStats();
  renderKyc();
  renderRegisteredAddress();
  renderPhysicalAddress();
  renderProfileForm();
  renderMessages();
  renderOrders();
  renderPayments();
  renderSubscription();
}

function renderMessages() {
  const messages = overview.messages || [];
  $("#messages-count").textContent = overview.unreadMessageCount
    ? `${overview.unreadMessageCount} unread`
    : `${messages.length} message${messages.length === 1 ? "" : "s"}`;

  const list = $("#messages-list");
  if (messages.length === 0) {
    list.innerHTML = `<p class="account-empty">No messages yet.</p>`;
    return;
  }

  list.innerHTML = messages.map((m) => `
    <div class="dash-message ${m.sender_type === "admin" && !m.read_at ? "unread" : ""}" data-message-id="${m.id}">
      <div class="dash-message-head">
        <strong>${escapeHtml(m.subject)}</strong>
        <span>${new Date(m.created_at).toLocaleString()}</span>
      </div>
      <p>${escapeHtml(m.body)}</p>
      <small class="muted">${m.sender_type === "admin" ? `From ${escapeHtml(m.sender_name || "NaijaBridge support")}` : "NaijaBridge"}</small>
    </div>
  `).join("");

  $$("[data-message-id]", list).forEach((el) => {
    const message = messages.find((m) => String(m.id) === el.dataset.messageId);
    if (message?.sender_type === "admin" && !message.read_at) {
      apiFetch(`/api/account/messages/${message.id}/read`, { method: "POST" }).catch(() => {});
    }
  });
}

function renderHeader() {
  const p = overview.profile;
  $("#dash-name").textContent = `${p.firstName || ""} ${p.lastName || ""}`.trim() || p.username;
  $("#dash-shopper-code").textContent = p.shopperCode;
  $("#account-button").textContent = `Hi, ${p.firstName || p.shopperCode}`;
  const status = overview.kyc.verificationStatus;
  const pill = $("#dash-status-pill");
  pill.textContent = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Pending review";
  pill.className = `account-status ${statusPillClass(status)}`;
}

function renderStats() {
  const s = overview.stats;
  $("#stat-total-orders").textContent = s.totalOrders;
  $("#stat-total-paid").textContent = money(s.totalPaidUsd);
  $("#stat-pending-due").textContent = money(s.pendingDueUsd);
  $("#stat-member-since").textContent = formatDate(s.memberSince) || "—";
}

function renderKyc() {
  const k = overview.kyc;
  const noteHtml = k.verificationNotes
    ? `<div class="dash-kyc-note">${escapeHtml(k.verificationNotes)}</div>` : "";
  const docHtml = k.hasIdDocument
    ? `<div class="dash-id-thumb"><img src="/api/account/id-document" alt="Your uploaded identification document" loading="lazy" /></div>`
    : `<p class="account-empty">No identification document on file.</p>`;
  const selfieHtml = k.hasSelfie
    ? `<div class="dash-id-thumb"><img src="/api/account/selfie" alt="Your live identity photo" loading="lazy" /></div>`
    : `<p class="account-empty">No live photo on file.</p>`;

  $("#kyc-body").innerHTML = `
    <dl class="dash-fact-list">
      <div><dt>ID type</dt><dd>${escapeHtml(k.idType || "—")}</dd></div>
      <div><dt>ID number</dt><dd>${escapeHtml(k.idNumber || "—")}</dd></div>
      <div><dt>NIN</dt><dd>${escapeHtml(maskNin(k.nin) || "—")}</dd></div>
    </dl>
    ${noteHtml}
    <div class="dash-kyc-media">
      <div><span class="dash-kyc-media-label">Identification document</span>${docHtml}</div>
      <div><span class="dash-kyc-media-label">Live identity photo</span>${selfieHtml}</div>
    </div>
    <p class="dash-kyc-footnote">To update your identification details, please contact support.</p>
  `;
}

function renderRegisteredAddress() {
  const p = overview.profile;
  $("#registered-address-body").innerHTML = `
    <dl class="dash-fact-list">
      <div><dt>Street address</dt><dd>${escapeHtml(p.streetAddress || "—")}</dd></div>
      <div><dt>City</dt><dd>${escapeHtml(p.city || "—")}</dd></div>
      <div><dt>State</dt><dd>${escapeHtml(p.state || "—")}</dd></div>
      <div><dt>Phone</dt><dd>${escapeHtml(p.phone || "—")}</dd></div>
    </dl>
    <p class="dash-kyc-footnote">Orders ship here by default. Individual orders may use a different delivery destination — see that order's details below.</p>
  `;
}

function renderPhysicalAddress() {
  const p = overview.profile;
  $("#physical-address-body").innerHTML = `
    <dl class="dash-fact-list">
      <div><dt>Street address</dt><dd>${escapeHtml(p.physicalStreetAddress || "—")}</dd></div>
      <div><dt>City</dt><dd>${escapeHtml(p.physicalCity || "—")}</dd></div>
      <div><dt>State</dt><dd>${escapeHtml(p.physicalState || "—")}</dd></div>
    </dl>
    <p class="dash-kyc-footnote">Your actual residence, used for identity purposes. This does not affect where orders are delivered.</p>
  `;
}

function renderProfileForm() {
  const p = overview.profile;
  $("#profile-email").value = p.email || "";
  $("#profile-username").value = p.username || "";
  $("#profile-phone").value = p.phone || "";
  $("#profile-street").value = p.streetAddress || "";
  $("#profile-city").value = p.city || "";
  $("#profile-state").value = p.state || "";
  $("#profile-physical-street").value = p.physicalStreetAddress || "";
  $("#profile-physical-city").value = p.physicalCity || "";
  $("#profile-physical-state").value = p.physicalState || "";
}

function renderOrders() {
  const orders = overview.orders;
  $("#orders-count").textContent = `${orders.length} order${orders.length === 1 ? "" : "s"}`;
  if (orders.length === 0) {
    $("#orders-list").innerHTML = `<p class="account-empty">You haven't submitted any orders yet.</p>`;
    return;
  }
  $("#orders-list").innerHTML = orders.map(renderOrderCard).join("");

  $$("[data-pay-order]", $("#orders-list")).forEach((button) =>
    button.addEventListener("click", () => payNow("order", button.dataset.payOrder)));
  $$("[data-view-updates]", $("#orders-list")).forEach((button) =>
    button.addEventListener("click", () => openOrderUpdatesModal(button.dataset.viewUpdates)));
}

function payNow(kind, id) {
  window.location.href = `index.html?pay=${kind}:${id}`;
}

/* ---- Embedded "Submit a new order" form (site/order-form.js, shared with index.html's calculator) ----
   The shopper is already logged in and verified to reach this page (boot() already gated on
   /api/account/overview succeeding), so this skips index.html's login/verification gate entirely and
   submits straight to POST /api/orders. Initialized lazily on first expand so an account page visit that
   never opens the form never fires its Microlink/quality-inspection-fee network calls. */
let newOrderForm = null;

function initNewOrderForm() {
  if (newOrderForm) return newOrderForm;
  newOrderForm = createOrderForm({
    root: $("#new-order-form-wrap"),
    onSubmitSuccess: () => {}
  });
  return newOrderForm;
}

$("#new-order-toggle").addEventListener("click", () => {
  const wrap = $("#new-order-form-wrap");
  const opening = wrap.hidden;
  if (opening) initNewOrderForm();
  wrap.hidden = !opening;
  $("#new-order-toggle").textContent = opening ? "Cancel new order" : "Submit a new order";
  if (opening) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
});

function collapseNewOrderForm() {
  $("#new-order-form-wrap").hidden = true;
  $("#new-order-toggle").textContent = "Submit a new order";
}

$("#submit-new-order-button").addEventListener("click", async () => {
  const form = initNewOrderForm();
  const errorBox = $("#new-order-error");
  const successBox = $("#new-order-success");
  errorBox.hidden = true;
  successBox.hidden = true;

  const button = $("#submit-new-order-button");
  button.disabled = true;
  button.textContent = "Submitting order…";
  try {
    const order = await form.submitOrder();
    successBox.textContent = `Order #${order.id} submitted for review. It now appears in your order history below.`;
    successBox.hidden = false;
    form.resetForm();
    overview = await apiFetch("/api/account/overview");
    renderStats();
    renderOrders();
    setTimeout(() => { collapseNewOrderForm(); }, 1400);
    showFlash(`Order #${order.id} submitted for review.`);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Submit order for review";
  }
});

function renderOrderCard(order) {
  const latestPayment = overview.payments
    .filter((payment) => payment.order_id === order.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const isSuperseded = latestPayment && latestPayment.status === "superseded";
  const canPay = order.status === "confirmed" || isSuperseded;
  const pendingFollowUp = overview.payments.find((payment) =>
    payment.order_id === order.id && payment.charge_type === "follow_up_charge" && payment.status === "pending");

  const breakdown = order.quote_breakdown && typeof order.quote_breakdown === "object" ? order.quote_breakdown : {};
  const breakdownRows = Object.entries(breakdown)
    .filter(([, value]) => typeof value === "number")
    .map(([key, value]) => `<div><span>${escapeHtml(statusLabel(key))}</span><b>${money(value)}</b></div>`)
    .join("");

  const items = Array.isArray(order.items) ? order.items : [];
  const itemsHtml = items.map((item) => renderOrderItemRow(item)).join("");

  const facts = [];
  if (order.shipping_speed) facts.push(`<div><span>Shipping speed</span><b>${escapeHtml(statusLabel(order.shipping_speed))}</b></div>`);
  if (order.tracking_number) facts.push(`<div><span>Tracking number</span><b>${escapeHtml(order.tracking_number)}</b></div>`);
  if (order.estimated_delivery_date) facts.push(`<div><span>Est. delivery</span><b>${formatDate(order.estimated_delivery_date)}</b></div>`);
  if (order.delivered_date) facts.push(`<div><span>Delivered</span><b>${formatDate(order.delivered_date)}</b></div>`);

  let refundHtml = "";
  if (order.refund_status && order.refund_status !== "none") {
    refundHtml = `<div class="dash-order-banner">Refund ${escapeHtml(statusLabel(order.refund_status))}${order.refund_amount_usd ? ` — ${money(order.refund_amount_usd)}` : ""}${order.refund_reason ? `: ${escapeHtml(order.refund_reason)}` : ""}</div>`;
  }
  let customsHtml = "";
  if (order.customs_fee_status === "due") {
    customsHtml = `<div class="dash-order-banner dash-order-banner-warn">Customs fee due before collection: ${nairaAmount(order.customs_fee_ngn)}</div>`;
  } else if (order.customs_fee_status === "paid") {
    customsHtml = `<div class="dash-order-banner dash-order-banner-ok">Customs fee paid${order.customs_fee_ngn ? `: ${nairaAmount(order.customs_fee_ngn)}` : ""}</div>`;
  }
  let followUpHtml = "";
  if (pendingFollowUp) {
    followUpHtml = `<div class="dash-order-banner dash-order-banner-warn">Additional charge due: ${money(pendingFollowUp.amount_usd)} <button class="small-button" data-pay-order="${order.id}">Pay additional charge</button></div>`;
  }

  const shipTo = order.shipping_street_address
    ? `${escapeHtml(order.recipient_name || "")}, ${escapeHtml(order.shipping_street_address)}, ${escapeHtml(order.shipping_city || "")}, ${escapeHtml(order.shipping_state || "")}${order.recipient_phone ? ` · ${escapeHtml(order.recipient_phone)}` : ""}`
    : "—";

  const orderTitle = items.length === 0
    ? "Untitled order"
    : items.length === 1
      ? (items[0].item_title || "Untitled item")
      : `${items[0].item_title || "Untitled item"} and ${items.length - 1} more item${items.length - 1 === 1 ? "" : "s"}`;

  return `
    <article class="dash-order-card">
      <div class="dash-order-content dash-order-content-full">
        <div class="dash-order-top">
          <div class="dash-order-title-block">
            <strong>${escapeHtml(orderTitle)}</strong>
            <span class="dash-order-id">Order #${order.id} · ${formatDate(order.created_at)}</span>
          </div>
          <span class="account-status ${isSuperseded ? "rejected" : statusPillClass(order.status)}">${isSuperseded ? "Payment superseded" : statusLabel(order.status)}</span>
        </div>

        ${refundHtml}${customsHtml}${followUpHtml}

        <div class="dash-order-items">${itemsHtml}</div>

        <div class="dash-order-facts">${facts.join("")}</div>

        ${breakdownRows ? `<details class="dash-breakdown"><summary>Quote breakdown — total ${money(order.quote_total_usd)}</summary><div class="dash-breakdown-grid">${breakdownRows}</div></details>` : `<div class="dash-order-total">Total: <b>${money(order.quote_total_usd)}</b></div>`}

        <div class="dash-fact-list dash-ship-to"><div><dt>Ship to</dt><dd>${shipTo}</dd></div></div>

        <div class="dash-order-actions">
          ${canPay ? `<button class="small-button" data-pay-order="${order.id}">Pay now</button>` : ""}
          <button class="small-button ghost" data-view-updates="${order.id}">View updates</button>
        </div>
      </div>
    </article>
  `;
}

function renderOrderItemRow(item) {
  const images = Array.isArray(item.images) ? item.images : [];
  const thumbsHtml = images.length > 0
    ? `<div class="dash-item-thumbs">${images.map((img) => `<img src="${escapeHtml(img.url)}" alt="Photo of ${escapeHtml(item.item_title || "item")}" loading="lazy" />`).join("")}</div>`
    : `<div class="dash-item-thumbs dash-item-thumbs-empty">No photo</div>`;

  const details = [];
  details.push(`<span>Qty ${item.quantity ?? 1}</span>`);
  if (item.category) details.push(`<span>${escapeHtml(statusLabel(item.category))}</span>`);
  if (item.weight_lb) details.push(`<span>${Number(item.weight_lb)} lb</span>`);
  if (item.color_variant) details.push(`<span>${escapeHtml(item.color_variant)}</span>`);

  return `
    <div class="dash-item-row">
      ${thumbsHtml}
      <div class="dash-item-info">
        <strong>${escapeHtml(item.item_title || "Untitled item")}</strong>
        <div class="dash-item-meta">${details.join(" · ")} · ${money(item.price_usd)} each</div>
        ${item.description ? `<div class="dash-item-description">${escapeHtml(item.description)}</div>` : ""}
        ${item.product_url ? `<a href="${escapeHtml(item.product_url)}" target="_blank" rel="noopener noreferrer" class="dash-product-link">View original listing ↗</a>` : ""}
      </div>
    </div>
  `;
}

async function openOrderUpdatesModal(orderId) {
  $("#order-updates-body").innerHTML = "<p>Loading updates…</p>";
  openModal("#order-updates-modal");
  try {
    const { updates } = await apiFetch(`/api/orders/${orderId}/updates`);
    if (updates.length === 0) {
      $("#order-updates-body").innerHTML = `<p class="account-empty">No updates yet for this order.</p>`;
      return;
    }
    $("#order-updates-body").innerHTML = updates.map((update) => `
      <div class="order-update-entry">
        <div class="order-update-meta">${formatDate(update.created_at, true)}</div>
        <div>${escapeHtml(update.message)}</div>
      </div>
    `).join("");
  } catch (error) {
    $("#order-updates-body").innerHTML = `<p class="account-notice rejected">${escapeHtml(error.message)}</p>`;
  }
}

function paymentPurposeLabel(payment) {
  if (payment.subscription_id) return "Dedicated address subscription";
  if (payment.charge_type === "follow_up_charge") return `Order #${payment.order_id} — additional charge`;
  if (payment.charge_type === "refund") return `Order #${payment.order_id} — refund`;
  return `Order #${payment.order_id}`;
}

function renderPayments() {
  const payments = overview.payments;
  if (payments.length === 0) {
    $("#payments-table-wrap").innerHTML = `<p class="account-empty">No payments recorded yet.</p>`;
    return;
  }
  $("#payments-tbody").innerHTML = payments.map((payment) => `
    <tr>
      <td data-label="Reference"><span class="dash-ref-code">${escapeHtml(payment.reference_code)}</span></td>
      <td data-label="For">${escapeHtml(paymentPurposeLabel(payment))}</td>
      <td data-label="Method">${payment.method === "bank_transfer" ? "Bank transfer" : "Card"}</td>
      <td data-label="Amount"><b>${money(payment.amount_usd)}</b><br><small>${nairaAmount(payment.amount_ngn)}</small></td>
      <td data-label="Status">
        <span class="account-status ${statusPillClass(payment.status)}">${statusLabel(payment.status)}</span>
        ${payment.decision_reason ? `<div class="dash-decision-reason">${escapeHtml(payment.decision_reason)}</div>` : ""}
      </td>
      <td data-label="Date">${formatDate(payment.created_at)}</td>
      <td data-label="Receipt">
        ${payment.receipt_file_path
          ? `<button class="small-button ghost" data-view-receipt="${payment.id}">View</button> <button class="small-button ghost" data-attach-receipt="${payment.id}">Replace</button>`
          : `<button class="small-button ghost" data-attach-receipt="${payment.id}">Attach</button>`}
      </td>
    </tr>
  `).join("");

  $$("[data-view-receipt]", $("#payments-tbody")).forEach((button) =>
    button.addEventListener("click", () => window.open(`/api/account/payments/${button.dataset.viewReceipt}/receipt`, "_blank")));
  $$("[data-attach-receipt]", $("#payments-tbody")).forEach((button) =>
    button.addEventListener("click", () => attachReceipt(button.dataset.attachReceipt)));
}

// Opens a native file picker directly (no dedicated upload modal on this page) and posts straight to the
// existing receipt route, then refreshes so the row reflects the newly attached file.
function attachReceipt(paymentId) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,image/png,image/jpeg,image/webp";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("receipt", file);
    try {
      await apiFetch(`/api/payments/${paymentId}/receipt`, { method: "POST", body: formData });
      overview = await apiFetch("/api/account/overview");
      renderPayments();
      showFlash("Receipt attached.");
    } catch (error) {
      showFlash(error.message, true);
    }
  });
  input.click();
}

function renderSubscription() {
  const subs = overview.subscriptions;
  const activeSub = subs.find((sub) => ["pending_payment", "active"].includes(sub.status));
  if (!activeSub) return;
  $("#subscription-panel").hidden = false;
  const periodHtml = activeSub.current_period_start
    ? `<div><dt>Current period</dt><dd>${formatDate(activeSub.current_period_start)} – ${formatDate(activeSub.current_period_end) || "—"}</dd></div>`
    : "";
  $("#subscription-body").innerHTML = `
    <dl class="dash-fact-list">
      <div><dt>Status</dt><dd><span class="account-status ${statusPillClass(activeSub.status)}">${statusLabel(activeSub.status)}</span></dd></div>
      <div><dt>Price</dt><dd>${money(activeSub.plan_price_usd)}/month</dd></div>
      ${periodHtml}
    </dl>
    ${activeSub.status === "pending_payment" ? `<button class="small-button" id="dash-pay-subscription">Pay now</button>` : ""}
  `;
  const payButton = $("#dash-pay-subscription");
  if (payButton) payButton.addEventListener("click", () => payNow("subscription", activeSub.id));
}

/* ---- Profile + password forms ---- */

$("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type='submit']", event.currentTarget);
  const messageBox = $("#profile-message");
  messageBox.hidden = true;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await apiFetch("/api/account/profile", {
      method: "PUT",
      body: {
        email: $("#profile-email").value.trim(),
        username: $("#profile-username").value.trim(),
        phone: $("#profile-phone").value.trim(),
        streetAddress: $("#profile-street").value.trim(),
        city: $("#profile-city").value.trim(),
        state: $("#profile-state").value.trim(),
        physicalStreetAddress: $("#profile-physical-street").value.trim(),
        physicalCity: $("#profile-physical-city").value.trim(),
        physicalState: $("#profile-physical-state").value.trim()
      }
    });
    overview = await apiFetch("/api/account/overview");
    renderHeader();
    renderRegisteredAddress();
    renderPhysicalAddress();
    renderProfileForm();
    showFlash("Your account details were updated.");
  } catch (error) {
    messageBox.textContent = error.message;
    messageBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Save changes";
  }
});

$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type='submit']", event.currentTarget);
  const messageBox = $("#password-message");
  messageBox.hidden = true;

  const newPassword = $("#password-new").value;
  const confirmPassword = $("#password-confirm").value;
  if (newPassword !== confirmPassword) {
    messageBox.textContent = "New password and confirmation do not match.";
    messageBox.hidden = false;
    return;
  }

  button.disabled = true;
  button.textContent = "Updating…";
  try {
    await apiFetch("/api/account/password", {
      method: "PUT",
      body: { currentPassword: $("#password-current").value, newPassword }
    });
    event.currentTarget.reset();
    showFlash("Your password was updated.");
  } catch (error) {
    messageBox.textContent = error.message;
    messageBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Update password";
  }
});

$("#dash-logout").addEventListener("click", async () => {
  await apiFetch("/api/auth/logout", { method: "POST" });
  window.location.href = "index.html";
});

$("#account-button").addEventListener("click", () => {
  window.location.reload();
});

boot();
