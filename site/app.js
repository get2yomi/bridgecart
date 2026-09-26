import { createOrderForm } from "./order-form.js";

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/* ---------------------------------------------------------------------
   Multi-item order builder
   The actual item add/remove, Microlink auto-detect, image upload, and
   live price-breakdown logic lives in ./order-form.js (shared with
   account.html's embedded copy of this same calculator). This page's
   #quote-form/#items-container/quote-card markup is the "root" the
   shared engine is initialized against; everything below this line that
   isn't checkout/auth/payments is just wiring index.html-specific pieces
   (the checkout modal, login gating) on top of the `orderForm` handle.
------------------------------------------------------------------------ */

const orderForm = createOrderForm({ root: document });

function openModal(id) {
  const modal = $(id);
  modal.hidden = false;
  document.body.classList.add("modal-open");
  setTimeout(() => $("input", modal)?.focus(), 30);
}

function closeModals() {
  $$(".modal-backdrop").forEach((modal) => { modal.hidden = true; });
  document.body.classList.remove("modal-open");
  // Closing the auth modal mid-capture (e.g. Escape, backdrop click) must not leave the camera running.
  stopSelfieStream();
}

$$("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModals));
$$(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeModals(); }));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModals(); });

/* ---------------------------------------------------------------------
   Auth + order submission + payments
   The calculator above stays local-only; everything below wires the
   existing UI to the real backend (auth, orders, payments, subscriptions).
------------------------------------------------------------------------ */

const session = { shopper: null };

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

async function refreshSession() {
  try {
    session.shopper = await apiFetch("/api/auth/me");
  } catch {
    session.shopper = null;
  }
  updateAccountButton();
  return session.shopper;
}

function updateAccountButton() {
  const button = $("#account-button");
  if (session.shopper) {
    const firstName = session.shopper.fullName?.split(" ")[0] || session.shopper.shopperCode;
    button.textContent = `Hi, ${firstName}`;
    button.classList.add("logged-in");
  } else {
    button.textContent = "My account";
    button.classList.remove("logged-in");
  }
}

$("#checkout-button").addEventListener("click", () => {
  const firstInvalid = orderForm.firstBlockMissingImages();
  if (firstInvalid) {
    orderForm.flagMissingImages(firstInvalid);
    return;
  }
  handleCheckoutStart();
});

async function handleCheckoutStart() {
  await refreshSession();
  if (!session.shopper) {
    openAuthModal("login", "Log in or register to submit this order for review.");
    return;
  }
  if (session.shopper.verificationStatus !== "approved") {
    openAccountModal();
    return;
  }
  $("#modal-total").textContent = orderForm.money(orderForm.state.total);
  $("#checkout-error").hidden = true;
  $("#checkout-form").reset();
  $("#checkout-override-fields").hidden = true;
  openModal("#checkout-modal");
}

$("#ship-to-other").addEventListener("change", (event) => {
  $("#checkout-override-fields").hidden = !event.target.checked;
});

$("#checkout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type='submit']", event.currentTarget);
  const errorBox = $("#checkout-error");
  errorBox.hidden = true;

  const overrides = {};
  if ($("#ship-to-other").checked) {
    const firstName = $("#checkout-first-name").value.trim();
    const lastName = $("#checkout-last-name").value.trim();
    const recipientName = `${firstName} ${lastName}`.trim();
    if (recipientName) overrides.recipientName = recipientName;
    if ($("#checkout-phone").value.trim()) overrides.recipientPhone = $("#checkout-phone").value.trim();
    if ($("#checkout-address").value.trim()) overrides.shippingStreetAddress = $("#checkout-address").value.trim();
    if ($("#checkout-city").value.trim()) overrides.shippingCity = $("#checkout-city").value.trim();
    if ($("#checkout-state").value) overrides.shippingState = $("#checkout-state").value;
  }

  button.disabled = true;
  button.textContent = "Submitting order…";
  try {
    const order = await orderForm.submitOrder(overrides);
    closeModals();
    $("#order-success-id").textContent = `#${order.id}`;
    openModal("#order-success-modal");
  } catch (error) {
    errorBox.textContent = error.message.includes("not yet approved")
      ? "Your approval status changed since you logged in. Please log out and log back in, then try again."
      : error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Submit order for review";
  }
});

/* ---- Auth modal ---- */

function setAuthTab(tab) {
  $$(".auth-tab").forEach((button) => button.classList.toggle("active", button.dataset.authTab === tab));
  $("#auth-panel-login").hidden = tab !== "login";
  $("#auth-panel-register").hidden = tab !== "register";
  $("#auth-panel-success").hidden = tab !== "success";
  $("#login-form").hidden = false;
  $("#forgot-password-form").hidden = true;
}

function openAuthModal(tab = "login", message) {
  setAuthTab(tab);
  if (message) {
    $("#login-error").textContent = message;
    $("#login-error").hidden = false;
  } else {
    $("#login-error").hidden = true;
  }
  openModal("#auth-modal");
}

$$("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => setAuthTab(button.dataset.authTab)));

$("#forgot-password-link").addEventListener("click", () => {
  $("#login-form").hidden = true;
  $("#forgot-password-form").hidden = false;
  $("#forgot-password-message").hidden = true;
});

$("#cancel-forgot-password").addEventListener("click", () => {
  $("#forgot-password-form").hidden = true;
  $("#login-form").hidden = false;
});

$("#forgot-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type='submit']", event.currentTarget);
  const messageBox = $("#forgot-password-message");
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const result = await apiFetch("/api/auth/forgot-password", {
      method: "POST",
      body: { email: $("#forgot-email").value.trim() }
    });
    messageBox.textContent = result.message;
    messageBox.hidden = false;
    event.currentTarget.reset();
  } catch (error) {
    messageBox.textContent = error.message;
    messageBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Send reset link";
  }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type='submit']", event.currentTarget);
  const errorBox = $("#login-error");
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "Logging in…";
  try {
    session.shopper = await apiFetch("/api/auth/login", {
      method: "POST",
      body: { email: $("#login-email").value.trim(), password: $("#login-password").value }
    });
    updateAccountButton();
    closeModals();
    openAccountModal();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Log in";
  }
});

const MAX_ID_DOC_BYTES = 8 * 1024 * 1024;
let idDocumentUrl = null;

$("#id-document-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    $("#register-error").textContent = "Please upload a PNG, JPG, or WEBP image.";
    $("#register-error").hidden = false;
    event.target.value = "";
    return;
  }
  if (file.size > MAX_ID_DOC_BYTES) {
    $("#register-error").textContent = "That file is too large. Please upload an image under 8MB.";
    $("#register-error").hidden = false;
    event.target.value = "";
    return;
  }
  if (idDocumentUrl) URL.revokeObjectURL(idDocumentUrl);
  idDocumentUrl = URL.createObjectURL(file);
  $("#id-document-preview-image").src = idDocumentUrl;
  $("#id-document-file-name").textContent = file.name;
  $("#id-document-preview").hidden = false;
});

$("#id-document-remove").addEventListener("click", () => {
  $("#id-document-file").value = "";
  $("#id-document-preview").hidden = true;
  if (idDocumentUrl) { URL.revokeObjectURL(idDocumentUrl); idDocumentUrl = null; }
});

/* ---- Live selfie capture (registration identity verification) ---- */

let selfieStream = null;
let selfieBlob = null;
let selfiePreviewUrl = null;

function selfieError(message) {
  const errorEl = $("#selfie-error");
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearSelfieError() {
  $("#selfie-error").hidden = true;
}

function stopSelfieStream() {
  // Never leave the camera light on once we no longer need the live feed (after capture, or on retake/cleanup).
  if (selfieStream) {
    selfieStream.getTracks().forEach((track) => track.stop());
    selfieStream = null;
  }
}

$("#selfie-start").addEventListener("click", async () => {
  clearSelfieError();
  if (!navigator.mediaDevices?.getUserMedia) {
    selfieError("Camera access is not supported in this browser. Please try a different browser.");
    return;
  }
  try {
    selfieStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
  } catch (error) {
    selfieError("Camera access is required. Please allow camera permission and try again.");
    return;
  }
  const video = $("#selfie-video");
  video.srcObject = selfieStream;
  video.hidden = false;
  $("#selfie-start").hidden = true;
  $("#selfie-shoot").hidden = false;
});

$("#selfie-shoot").addEventListener("click", () => {
  const video = $("#selfie-video");
  const canvas = $("#selfie-canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob((blob) => {
    if (!blob) {
      selfieError("Could not capture a photo. Please try again.");
      return;
    }
    selfieBlob = blob;
    if (selfiePreviewUrl) URL.revokeObjectURL(selfiePreviewUrl);
    selfiePreviewUrl = URL.createObjectURL(blob);
    $("#selfie-preview-image").src = selfiePreviewUrl;
    $("#selfie-preview").hidden = false;
    clearSelfieError();

    stopSelfieStream();
    video.srcObject = null;
    video.hidden = true;
    $("#selfie-shoot").hidden = true;
    $("#selfie-retake").hidden = false;
  }, "image/jpeg", 0.9);
});

$("#selfie-retake").addEventListener("click", () => {
  selfieBlob = null;
  if (selfiePreviewUrl) { URL.revokeObjectURL(selfiePreviewUrl); selfiePreviewUrl = null; }
  $("#selfie-preview").hidden = true;
  $("#selfie-retake").hidden = true;
  $("#selfie-start").hidden = false;
});

$("#reg-same-address").addEventListener("change", (event) => {
  const checked = event.target.checked;
  $("#reg-physical-street-address").disabled = checked;
  $("#reg-physical-city").disabled = checked;
  $("#reg-physical-state").disabled = checked;
  $("#reg-physical-street-address").required = !checked;
  $("#reg-physical-city").required = !checked;
  $("#reg-physical-state").required = !checked;
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type='submit']", event.currentTarget);
  const errorBox = $("#register-error");
  errorBox.hidden = true;

  const idFile = $("#id-document-file").files?.[0];
  if (!idFile) {
    errorBox.textContent = "An identification document is required.";
    errorBox.hidden = false;
    return;
  }
  if (!selfieBlob) {
    errorBox.textContent = "Please take a live photo to verify your identity.";
    errorBox.hidden = false;
    return;
  }
  const nin = $("#reg-nin").value.trim();
  if (!/^\d{11}$/.test(nin)) {
    errorBox.textContent = "NIN must be exactly 11 digits.";
    errorBox.hidden = false;
    return;
  }

  const formData = new FormData();
  formData.append("nin", nin);
  formData.append("firstName", $("#reg-first-name").value.trim());
  formData.append("lastName", $("#reg-last-name").value.trim());
  formData.append("payerFirstName", $("#reg-payer-first-name").value.trim());
  formData.append("payerLastName", $("#reg-payer-last-name").value.trim());
  formData.append("username", $("#reg-username").value.trim());
  formData.append("email", $("#reg-email").value.trim());
  formData.append("password", $("#reg-password").value);
  formData.append("phone", $("#reg-phone").value.trim());
  formData.append("streetAddress", $("#reg-street-address").value.trim());
  formData.append("city", $("#reg-city").value.trim());
  formData.append("state", $("#reg-state").value);
  const sameAddress = $("#reg-same-address").checked;
  formData.append("physicalStreetAddress", sameAddress ? $("#reg-street-address").value.trim() : $("#reg-physical-street-address").value.trim());
  formData.append("physicalCity", sameAddress ? $("#reg-city").value.trim() : $("#reg-physical-city").value.trim());
  formData.append("physicalState", sameAddress ? $("#reg-state").value : $("#reg-physical-state").value);
  formData.append("idType", $("#reg-id-type").value);
  formData.append("idNumber", $("#reg-id-number").value.trim());
  formData.append("idDocument", idFile);
  formData.append("selfie", selfieBlob, "selfie.jpg");

  button.disabled = true;
  button.textContent = "Creating account…";
  try {
    const result = await apiFetch("/api/auth/register", { method: "POST", body: formData });
    $("#shopper-code-display").textContent = result.shopperCode;
    setAuthTab("success");
    event.currentTarget.reset();
    $("#id-document-preview").hidden = true;
    stopSelfieStream();
    selfieBlob = null;
    if (selfiePreviewUrl) { URL.revokeObjectURL(selfiePreviewUrl); selfiePreviewUrl = null; }
    $("#selfie-preview").hidden = true;
    $("#selfie-video").hidden = true;
    $("#selfie-retake").hidden = true;
    $("#selfie-shoot").hidden = true;
    $("#selfie-start").hidden = false;
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Create account";
  }
});

/* ---- Account modal ---- */

function accountStatusLabel(status) {
  if (status === "approved") return { className: "approved", text: "Approved" };
  if (status === "rejected") return { className: "rejected", text: "Rejected" };
  return { className: "pending", text: "Pending review" };
}

async function openAccountModal() {
  await refreshSession();
  if (!session.shopper) {
    openAuthModal("login");
    return;
  }
  renderAccountLoading();
  openModal("#account-modal");
  try {
    const [ordersResult, subsResult, paymentsResult] = await Promise.all([
      apiFetch("/api/orders/mine"),
      apiFetch("/api/subscriptions/mine"),
      apiFetch("/api/payments/mine")
    ]);
    renderAccount(ordersResult.orders, subsResult.subscriptions, paymentsResult.payments);
  } catch (error) {
    $("#account-body").innerHTML = `<p class="account-notice rejected">${error.message}</p>`;
  }
}

function renderAccountLoading() {
  const status = accountStatusLabel(session.shopper.verificationStatus);
  $("#account-body").innerHTML = `
    <div class="account-summary">
      <div><small>Shopper code</small><div class="shopper-code">${session.shopper.shopperCode}</div></div>
      <span class="account-status ${status.className}">${status.text}</span>
    </div>
    <p class="account-empty">Loading your orders…</p>
  `;
}

function renderAccount(orders, subscriptions, payments = []) {
  const shopper = session.shopper;
  const status = accountStatusLabel(shopper.verificationStatus);
  let notice = "";
  if (shopper.verificationStatus === "pending") {
    notice = `<div class="account-notice">Your account is pending identity verification. You can browse quotes now, but you'll need to be approved before submitting orders.</div>`;
  } else if (shopper.verificationStatus === "rejected") {
    notice = `<div class="account-notice rejected">Your registration was not approved. Please contact support for details.</div>`;
  }

  // Most recent payment per order, so a superseded one can override the plain "confirmed" order status in the row.
  const latestPaymentByOrder = new Map();
  // Separately, any still-pending follow-up charge for the order (a second payment created after the main
  // order payment is confirmed) — kept distinct so it renders as its own line rather than replacing the order's status.
  const pendingFollowUpByOrder = new Map();
  for (const payment of payments) {
    if (!payment.order_id) continue;
    const existing = latestPaymentByOrder.get(payment.order_id);
    if (!existing || new Date(payment.created_at) > new Date(existing.created_at)) {
      latestPaymentByOrder.set(payment.order_id, payment);
    }
    if (payment.charge_type === "follow_up_charge" && payment.status === "pending") {
      pendingFollowUpByOrder.set(payment.order_id, payment);
    }
  }

  const ordersHtml = orders.length === 0
    ? `<p class="account-empty">You haven't submitted any orders yet.</p>`
    : `<div class="account-orders">${orders.map((order) => renderOrderRow(order, latestPaymentByOrder.get(order.id), pendingFollowUpByOrder.get(order.id))).join("")}</div>`;

  const activeSub = subscriptions.find((sub) => ["pending_payment", "active"].includes(sub.status));
  const subscriptionHtml = activeSub
    ? `<div class="subscription-card">
        <div><strong>Dedicated U.S. address</strong><p>${activeSub.status === "active" ? "Active" : "Pending payment"} · $${Number(activeSub.plan_price_usd).toFixed(2)}/month</p></div>
        ${activeSub.status === "pending_payment" ? `<button class="small-button" data-pay-subscription="${activeSub.id}">Pay now</button>` : `<span class="account-status approved">Active</span>`}
      </div>`
    : `<div class="subscription-card">
        <div><strong>Dedicated U.S. address</strong><p>Get a personal U.S. shipping address for $100/month.</p></div>
        <button class="small-button" id="subscribe-button">Subscribe</button>
      </div>`;

  $("#account-body").innerHTML = `
    <div class="account-summary">
      <div><small>Shopper code</small><div class="shopper-code">${shopper.shopperCode}</div></div>
      <span class="account-status ${status.className}">${status.text}</span>
    </div>
    ${notice}
    <div class="account-section-title">Your orders</div>
    ${ordersHtml}
    <div class="account-section-title">Dedicated address</div>
    ${subscriptionHtml}
    <div class="logout-row"><button type="button" id="account-logout">Log out</button></div>
  `;

  $$("[data-pay-order]", $("#account-body")).forEach((button) =>
    button.addEventListener("click", () => openPaymentModal("order", button.dataset.payOrder)));
  $$("[data-view-updates]", $("#account-body")).forEach((button) =>
    button.addEventListener("click", () => openOrderUpdatesModal(button.dataset.viewUpdates)));
  $$("[data-attach-receipt]", $("#account-body")).forEach((button) =>
    button.addEventListener("click", () => attachReceiptViaFilePicker(button.dataset.attachReceipt)));
  $$("[data-view-receipt]", $("#account-body")).forEach((button) =>
    button.addEventListener("click", () => window.open(`/api/account/payments/${button.dataset.viewReceipt}/receipt`, "_blank")));
  const payButton = $("[data-pay-subscription]", $("#account-body"));
  if (payButton) payButton.addEventListener("click", () => openPaymentModal("subscription", payButton.dataset.paySubscription));
  const subscribeButton = $("#subscribe-button");
  if (subscribeButton) subscribeButton.addEventListener("click", createSubscription);
  $("#account-logout").addEventListener("click", async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    session.shopper = null;
    updateAccountButton();
    closeModals();
  });
}

function orderItemsSummaryClient(items) {
  if (!items || items.length === 0) return "Untitled item";
  const first = items[0].item_title || "Untitled item";
  if (items.length === 1) return first;
  return `${first} and ${items.length - 1} more item${items.length - 1 === 1 ? "" : "s"}`;
}

function renderOrderRow(order, latestPayment, pendingFollowUp) {
  const isSuperseded = latestPayment && latestPayment.status === "superseded";
  const canPay = order.status === "confirmed" || isSuperseded;
  const statusText = order.status.replace(/_/g, " ");
  const extras = [];
  if (order.tracking_number) extras.push(`<span>Tracking: <strong>${order.tracking_number}</strong></span>`);
  if (order.estimated_delivery_date) extras.push(`<span>Est. delivery: ${new Date(order.estimated_delivery_date).toLocaleDateString()}</span>`);
  if (order.delivered_date) extras.push(`<span>Delivered: ${new Date(order.delivered_date).toLocaleDateString()}</span>`);
  if (order.refund_status && order.refund_status !== "none") extras.push(`<span>Refund: ${order.refund_status.replace(/_/g, " ")}</span>`);
  if (order.shipping_street_address) extras.push(`<span>Ship to: ${escapeHtmlSite(order.recipient_name || "")}, ${escapeHtmlSite(order.shipping_street_address)}, ${escapeHtmlSite(order.shipping_city || "")}, ${escapeHtmlSite(order.shipping_state || "")}</span>`);
  if (order.customs_fee_status === "due") extras.push(`<span class="superseded-note">Customs fee due before collection: ₦${Number(order.customs_fee_ngn || 0).toLocaleString()}</span>`);
  if (order.customs_fee_status === "paid") extras.push(`<span>Customs fee paid${order.customs_fee_ngn ? `: ₦${Number(order.customs_fee_ngn).toLocaleString()}` : ""}</span>`);
  if (isSuperseded) extras.push(`<span class="superseded-note">Superseded — please pay again</span>`);

  // A follow-up charge is a second, separate payment (not a replacement of the main order payment), so it
  // gets its own labeled line + "Pay now" rather than reusing the order's primary pay/status affordance.
  const followUpHtml = pendingFollowUp ? `
    <div class="order-extras"><span class="superseded-note">Additional charge (% of item cost) due: $${Number(pendingFollowUp.amount_usd).toFixed(2)}</span></div>
  ` : "";

  // A receipt attaches to a specific payment row, not the order — only offered once one exists, and never
  // for a superseded payment (that payment is dead; a fresh one is created on "Pay now" instead).
  const receiptButton = latestPayment && !isSuperseded
    ? (latestPayment.receipt_file_path
        ? `<button class="small-button ghost" data-view-receipt="${latestPayment.id}">View receipt</button>`
        : `<button class="small-button ghost" data-attach-receipt="${latestPayment.id}">Attach receipt</button>`)
    : "";

  return `
    <div class="account-order-row">
      <div class="order-meta">
        <strong>${escapeHtmlSite(orderItemsSummaryClient(order.items))} — #${order.id}</strong>
        <small>${statusText} · $${Number(order.quote_total_usd).toFixed(2)}</small>
        ${extras.length ? `<div class="order-extras">${extras.join(" · ")}</div>` : ""}
        ${followUpHtml}
      </div>
      <div class="order-actions">
        <span class="account-status ${isSuperseded ? "rejected" : order.status === "paid" || order.status === "delivered" ? "approved" : order.status === "rejected" || order.status === "cancelled" ? "rejected" : "pending"}">${isSuperseded ? "Payment superseded" : statusText}</span>
        ${canPay ? `<button class="small-button" data-pay-order="${order.id}">Pay now</button>` : ""}
        ${pendingFollowUp ? `<button class="small-button" data-pay-order="${order.id}">Pay additional charge</button>` : ""}
        ${receiptButton}
        <button class="small-button ghost" data-view-updates="${order.id}">Updates</button>
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
        <div class="order-update-meta">${new Date(update.created_at).toLocaleString()}</div>
        <div>${escapeHtmlSite(update.message)}</div>
      </div>
    `).join("");
  } catch (error) {
    $("#order-updates-body").innerHTML = `<p class="account-notice rejected">${error.message}</p>`;
  }
}

function escapeHtmlSite(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

async function createSubscription() {
  try {
    await apiFetch("/api/subscriptions", { method: "POST" });
    await openAccountModal();
  } catch (error) {
    $("#account-body").insertAdjacentHTML("afterbegin", `<p class="account-notice rejected">${error.message}</p>`);
  }
}

/* ---- Payment modal ---- */

async function openPaymentModal(kind, id) {
  $("#payment-body").innerHTML = "<p>Loading payment options…</p>";
  openModal("#payment-modal");
  let bankDetails;
  try {
    bankDetails = await apiFetch("/api/payments/bank-details");
  } catch (error) {
    $("#payment-body").innerHTML = `<p class="form-error">${error.message}</p>`;
    return;
  }

  $("#payment-body").innerHTML = `
    <p>Choose how you'd like to pay. An admin confirms payment manually before your ${kind === "order" ? "order" : "subscription"} is marked paid.</p>
    <div class="payment-method-grid">
      <button type="button" class="payment-method-option active" data-method="bank_transfer">
        <strong>Bank transfer</strong><small>Pay in Naira via local transfer</small>
      </button>
      <button type="button" class="payment-method-option" data-method="card">
        <strong>Credit card</strong><small>Processed manually — we'll contact you</small>
      </button>
    </div>
    <div id="payment-method-detail"></div>
    <button class="primary-button" id="submit-payment" style="margin-top:14px;width:100%;">Confirm payment method <span aria-hidden="true">→</span></button>
    <p id="payment-error" class="form-error" hidden></p>
  `;

  let selectedMethod = "bank_transfer";
  function renderMethodDetail() {
    if (selectedMethod === "bank_transfer") {
      $("#payment-method-detail").innerHTML = `
        <div class="bank-details-box">
          <div><span>Bank name</span><b>${bankDetails.bankName}</b></div>
          <div><span>Account name</span><b>${bankDetails.accountName}</b></div>
          <div><span>Account number</span><b>${bankDetails.accountNumber}</b></div>
          <div><span>Exchange rate</span><b>$1 = ₦${Number(bankDetails.exchangeRate).toLocaleString()}</b></div>
        </div>
      `;
    } else {
      $("#payment-method-detail").innerHTML = `<div class="bank-details-box"><div>Card payments are processed manually. After you confirm, our team will contact you to complete the charge.</div></div>`;
    }
  }
  renderMethodDetail();

  $$(".payment-method-option", $("#payment-body")).forEach((button) => button.addEventListener("click", () => {
    selectedMethod = button.dataset.method;
    $$(".payment-method-option", $("#payment-body")).forEach((item) => item.classList.toggle("active", item === button));
    renderMethodDetail();
  }));

  $("#submit-payment").addEventListener("click", async () => {
    const errorBox = $("#payment-error");
    errorBox.hidden = true;
    const button = $("#submit-payment");
    button.disabled = true;
    button.textContent = "Submitting…";
    try {
      const body = { method: selectedMethod };
      if (kind === "order") body.orderId = id; else body.subscriptionId = id;
      const { payment } = await apiFetch("/api/payments", { method: "POST", body });
      renderPaymentDoneWithReceipt(payment, selectedMethod);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = "Confirm payment method";
    }
  });
}

// Shown right after a payment record is created — a receipt can only be attached to a payment that already
// exists, so this step necessarily comes after submit rather than being part of the initial form.
function renderPaymentDoneWithReceipt(payment, selectedMethod) {
  $("#payment-body").innerHTML = `
    <div class="reference-callout">
      Payment reference <strong>${payment.reference_code}</strong> created for $${Number(payment.amount_usd).toFixed(2)} (₦${Number(payment.amount_ngn).toLocaleString()}).<br>
      ${selectedMethod === "bank_transfer" ? "Complete the bank transfer and our team will confirm it shortly." : "We'll contact you shortly to process your card payment."}
    </div>
    <div class="receipt-attach-box" style="margin-top:14px;">
      <label class="field"><span>Attach payment receipt (optional)</span>
        <input id="receipt-file-input" type="file" accept=".pdf,image/png,image/jpeg,image/webp" />
      </label>
      <button class="small-button" type="button" id="receipt-upload-button">Attach receipt</button>
      <p id="receipt-upload-status" class="muted" style="margin-top:6px;"></p>
    </div>
    <button class="primary-button" type="button" data-close-modal style="margin-top:14px;width:100%;">Done</button>
  `;
  $("[data-close-modal]", $("#payment-body")).addEventListener("click", closeModals);
  $("#receipt-upload-button").addEventListener("click", () => uploadPaymentReceipt(payment.id));
}

async function uploadPaymentReceipt(paymentId) {
  const input = $("#receipt-file-input");
  const status = $("#receipt-upload-status");
  const file = input?.files?.[0];
  if (!file) { status.textContent = "Choose a file first."; return; }
  const formData = new FormData();
  formData.append("receipt", file);
  status.textContent = "Uploading…";
  try {
    await apiFetch(`/api/payments/${paymentId}/receipt`, { method: "POST", body: formData });
    status.textContent = "Receipt attached. Thank you.";
  } catch (error) {
    status.textContent = error.message;
  }
}

// The legacy account modal (this file) has no dedicated payments panel/table to embed a file input into like
// site/account.html does, so "Attach receipt" here opens a native file picker directly via a throwaway
// off-DOM input, matching the lightweight, no-extra-modal style already used for this view.
function attachReceiptViaFilePicker(paymentId) {
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
      await openAccountModal();
    } catch (error) {
      $("#account-body").insertAdjacentHTML("afterbegin", `<p class="account-notice rejected">${error.message}</p>`);
    }
  });
  input.click();
}

/* ---- Account button + init ---- */

$("#account-button").addEventListener("click", () => {
  if (session.shopper) window.location.href = "account.html";
  else openAuthModal("login");
});

/* ---- Deep-linked payment (e.g. index.html?pay=order:14 from account.html "Pay now") ---- */

async function handlePayDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const pay = params.get("pay");
  if (!pay) return;
  const [kind, id] = pay.split(":");
  if ((kind !== "order" && kind !== "subscription") || !id) return;

  await refreshSession();
  if (session.shopper) openPaymentModal(kind, id);

  params.delete("pay");
  const query = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
}

refreshSession();
handlePayDeepLink();
