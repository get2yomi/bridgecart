const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const CATEGORIES = ["electronics", "fashion", "beauty", "home", "auto", "other"];
const SPEEDS = ["air", "express", "sea"];
const ORDER_ADVANCE_STATUSES = ["purchased", "shipped", "delivered", "cancelled"];

const state = { tab: "verifications", role: null, fullName: null, permissions: null };

const TAB_SECTION = {
  verifications: "verifications",
  shoppers: "shoppers",
  orders: "orders",
  payments: "payments",
  subscriptions: "subscriptions",
  approvals: "approvals",
  staff: "staff",
  activity: "activity_log",
  settings: "settings"
};

function money(value, currency = "USD") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function dateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function statusPill(status) {
  return `<span class="status-pill status-${status}">${status.replace(/_/g, " ")}</span>`;
}

function displayName(entity) {
  return `${entity.first_name || ""} ${entity.last_name || ""}`.trim();
}

function showToast(message, type = "") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast${type ? ` ${type}` : ""}`;
  toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.hidden = true; }, 3800);
}

// A 401 mid-session (deactivation or expiry) is handled in one place so every tab gets the same behavior.
function handleUnauthorized(data) {
  showToast(data.error || "Your session has ended. Please log in again.", "error");
  showLogin();
}

async function api(path, options = {}) {
  const response = await fetch(`/api/admin${path}`, {
    method: options.method || "GET",
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { handleUnauthorized(data); throw new Error(data.error || "Please log in again."); }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

// Like api(), but treats 202 (submitted for approval) as a success case the caller can branch on.
async function apiRaw(path, options = {}) {
  const response = await fetch(`/api/admin${path}`, {
    method: options.method || "GET",
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { handleUnauthorized(data); throw new Error(data.error || "Please log in again."); }
  if (!response.ok && response.status !== 202) throw new Error(data.error || "Request failed.");
  return { status: response.status, data };
}

async function authApi(path, options = {}) {
  const response = await fetch(`/api/admin/auth${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function openModal(html) {
  $("#modal-body").innerHTML = html;
  $("#detail-modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#detail-modal").hidden = true;
  $("#modal-body").innerHTML = "";
  document.body.style.overflow = "";
}

$$("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
$("#detail-modal").addEventListener("click", (event) => { if (event.target === $("#detail-modal")) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

// ---- Auth ----

async function checkSession() {
  try {
    const me = await authApi("/me");
    state.role = me.role;
    state.fullName = me.fullName;
    sessionStorage.setItem("nb_admin_role", me.role || "");
    sessionStorage.setItem("nb_admin_name", me.fullName || "");
    $("#admin-email").textContent = me.fullName || `Admin #${me.id}`;
    $("#admin-role").textContent = me.role || "";
    await loadMyPermissions();
    applyRoleVisibility();
    showApp();
    loadTab(state.tab);
  } catch {
    showLogin();
  }
}

async function loadMyPermissions() {
  try {
    const { sections } = await api("/me/permissions");
    state.permissions = sections;
  } catch {
    state.permissions = null;
  }
}

function applyRoleVisibility() {
  const canApprove = state.role === "owner" || state.role === "supervisor";
  $("#nav-approvals").hidden = !canApprove;
  $("#nav-staff").hidden = state.role !== "owner";

  // Section access narrows visibility further, on top of the role-based hiding above.
  $$(".nav-item[data-tab]").forEach((button) => {
    const section = TAB_SECTION[button.dataset.tab];
    if (!section || !state.permissions) return;
    if (state.permissions[section] === false) button.hidden = true;
  });
}

function showLogin() {
  $("#login-screen").hidden = false;
  $("#app-screen").hidden = true;
}

function showApp() {
  $("#login-screen").hidden = true;
  $("#app-screen").hidden = false;
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type='submit']", event.currentTarget);
  const errorBox = $("#login-error");
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    const result = await authApi("/login", {
      method: "POST",
      body: { email: $("#login-email").value.trim(), password: $("#login-password").value }
    });
    state.role = result.role;
    state.fullName = result.fullName;
    sessionStorage.setItem("nb_admin_role", result.role || "");
    sessionStorage.setItem("nb_admin_name", result.fullName || "");
    $("#admin-email").textContent = result.fullName || `Admin #${result.id}`;
    $("#admin-role").textContent = result.role || "";
    await loadMyPermissions();
    applyRoleVisibility();
    showApp();
    loadTab(state.tab);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
});

$("#logout-button").addEventListener("click", async () => {
  await authApi("/logout", { method: "POST" });
  showLogin();
});

// ---- Tabs ----

$$(".nav-item").forEach((button) => button.addEventListener("click", () => {
  state.tab = button.dataset.tab;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
  $$(".tab-panel").forEach((panel) => { panel.hidden = panel.id !== `tab-${state.tab}`; });
  loadTab(state.tab);
}));

function loadTab(tab) {
  if (tab === "verifications") return loadVerifications();
  if (tab === "shoppers") return loadShopperDirectory();
  if (tab === "orders") return loadOrders();
  if (tab === "payments") return loadPayments();
  if (tab === "subscriptions") return loadSubscriptions();
  if (tab === "approvals") return loadApprovals();
  if (tab === "staff") return loadStaff();
  if (tab === "activity") return loadActivity();
  if (tab === "settings") return loadSettings();
}

async function refreshBadges() {
  try {
    const calls = [
      api("/shoppers?status=pending"),
      api("/orders?status=pending_confirmation"),
      api("/payments?status=pending")
    ];
    const canApprove = state.role === "owner" || state.role === "supervisor";
    if (canApprove) calls.push(api("/approval-requests?status=pending"));
    const results = await Promise.all(calls);
    setBadge("#badge-verifications", results[0].shoppers.length);
    setBadge("#badge-orders", results[1].orders.length);
    setBadge("#badge-payments", results[2].payments.length);
    if (canApprove) setBadge("#badge-approvals", results[3].approvalRequests.length);
  } catch {
    /* badges are best-effort */
  }
}

function setBadge(selector, count) {
  const badge = $(selector);
  badge.textContent = count;
  badge.hidden = count === 0;
}

// ---- Verifications ----

let verificationsSearchTimer;
$("#verifications-search").addEventListener("input", () => {
  clearTimeout(verificationsSearchTimer);
  verificationsSearchTimer = setTimeout(loadVerifications, 300);
});
$("#verifications-filter").addEventListener("change", loadVerifications);
$("#verifications-refresh").addEventListener("click", loadVerifications);

async function loadVerifications() {
  const status = $("#verifications-filter").value;
  const search = $("#verifications-search").value.trim();
  const body = $("#verifications-body");
  body.innerHTML = `<tr><td colspan="10">Loading…</td></tr>`;
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  try {
    const { shoppers } = await api(`/shoppers${params.toString() ? `?${params}` : ""}`);
    if (shoppers.length === 0) {
      body.innerHTML = "";
      $("#verifications-empty").hidden = false;
      return;
    }
    $("#verifications-empty").hidden = true;
    body.innerHTML = shoppers.map((shopper) => `
      <tr>
        <td class="cell-strong">${escapeHtml(displayName(shopper))}</td>
        <td>${escapeHtml(shopper.shopper_code)}</td>
        <td>${escapeHtml(shopper.email)}</td>
        <td class="cell-strong">${escapeHtml(shopper.nin || "-")}</td>
        <td>${escapeHtml(shopper.id_type)}</td>
        <td>${escapeHtml(shopper.id_number)}</td>
        <td>${dateTime(shopper.created_at)}</td>
        <td>${statusPill(shopper.verification_status)}</td>
        <td class="comment-cell">
          <textarea class="comment-input" data-comment-input="${shopper.id}" placeholder="Add a note…" rows="1"></textarea>
          <button class="ghost-button" data-add-comment="${shopper.id}">Save note</button>
        </td>
        <td>
          <div class="row-actions">
            <button class="ghost-button" data-view-shopper="${shopper.id}">Review</button>
            <button class="ghost-button" data-quick-message="${shopper.id}" title="Send a message to this shopper">Message</button>
          </div>
        </td>
      </tr>
    `).join("");
    $$("[data-view-shopper]", body).forEach((button) =>
      button.addEventListener("click", () => viewShopper(button.dataset.viewShopper)));
    $$("[data-add-comment]", body).forEach((button) =>
      button.addEventListener("click", () => addShopperComment(button.dataset.addComment)));
    $$("[data-quick-message]", body).forEach((button) =>
      button.addEventListener("click", () => quickMessageShopper(button.dataset.quickMessage)));
  } catch (error) {
    body.innerHTML = `<tr><td colspan="10">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
  refreshBadges();
}

async function viewShopper(id) {
  const { shopper, documents, selfie } = await api(`/shoppers/${id}`);
  const doc = documents[0];
  const nameMatch = `${shopper.first_name} ${shopper.last_name}`.trim().toLowerCase()
    === `${shopper.payer_first_name} ${shopper.payer_last_name}`.trim().toLowerCase();
  let comments = [];
  try {
    ({ comments } = await api(`/shoppers/${id}/comments`));
  } catch { /* best effort */ }
  let orders = [], summary = { order_count: 0, total_spend_usd: 0, paid_total_usd: 0 };
  try {
    ({ orders, summary } = await api(`/shoppers/${id}/orders`));
  } catch { /* best effort */ }
  let messages = [];
  try {
    ({ messages } = await api(`/shoppers/${id}/messages`));
  } catch { /* best effort */ }
  let activity = [];
  try {
    ({ activity } = await api(`/shoppers/${id}/activity`));
  } catch { /* best effort */ }
  openModal(`
    <h3>${escapeHtml(displayName(shopper))}</h3>
    <p class="muted">${escapeHtml(shopper.shopper_code)} · ${escapeHtml(shopper.email)}</p>
    <div class="detail-grid">
      <div class="detail-item"><span>Shopper ID</span><b>${shopper.id}</b></div>
      <div class="detail-item"><span>Full name</span><b>${escapeHtml(displayName(shopper))}</b></div>
      <div class="detail-item"><span>Payer name ${nameMatch ? "✓ matches" : "⚠ mismatch"}</span><b>${escapeHtml(`${shopper.payer_first_name} ${shopper.payer_last_name}`)}</b></div>
      <div class="detail-item"><span>Phone</span><b>${escapeHtml(shopper.phone || "-")}</b></div>
      <div class="detail-item"><span>Status</span><b>${statusPill(shopper.verification_status)}</b></div>
      <div class="detail-item"><span>NIN</span><b>${escapeHtml(shopper.nin || "-")}</b></div>
      <div class="detail-item"><span>ID type</span><b>${escapeHtml(shopper.id_type)}</b></div>
      <div class="detail-item"><span>ID number</span><b>${escapeHtml(shopper.id_number)}</b></div>
      <div class="detail-item full"><span>Shipping address</span><b>${escapeHtml([shopper.street_address, shopper.city, shopper.state].filter(Boolean).join(", ") || "-")} <button class="text-button" id="edit-shipping-address" type="button">Edit</button></b></div>
      <div class="detail-item full"><span>Physical (home) address</span><b>${escapeHtml([shopper.physical_street_address, shopper.physical_city, shopper.physical_state].filter(Boolean).join(", ") || "-")} <button class="text-button" id="edit-physical-address" type="button">Edit</button></b></div>
      <div class="detail-item full"><span>Submitted</span><b>${dateTime(shopper.created_at)}</b></div>
      ${shopper.verification_notes ? `<div class="detail-item full"><span>Previous notes</span><b>${escapeHtml(shopper.verification_notes)}</b></div>` : ""}
    </div>
    <div class="section-label">Identification document</div>
    ${doc
      ? `<img class="detail-image" src="/uploads/id-documents/${encodeURIComponent(doc.file_path)}" alt="ID document" />
         <a class="detail-image-link" href="/uploads/id-documents/${encodeURIComponent(doc.file_path)}" target="_blank" rel="noopener">Open full size</a>`
      : `<p class="muted">No document on file.</p>`}
    <div class="section-label">Live identity photo</div>
    ${selfie
      ? `<img class="detail-image" src="/uploads/selfie-photos/${encodeURIComponent(selfie.file_path)}" alt="Live identity photo" />
         <a class="detail-image-link" href="/uploads/selfie-photos/${encodeURIComponent(selfie.file_path)}" target="_blank" rel="noopener">Open full size</a>`
      : `<p class="muted">No live photo on file.</p>`}
    <label class="field full"><span>Notes (optional)</span><textarea id="shopper-notes" placeholder="Visible to the shopper if rejected">${escapeHtml(shopper.verification_notes || "")}</textarea></label>
    <div class="modal-actions">
      <button class="primary-button" id="approve-shopper">Approve</button>
      <button class="danger-button" id="reject-shopper">Reject</button>
      <button class="ghost-button" data-close-modal>Close</button>
    </div>
    <div class="section-label">Order history</div>
    <div class="detail-grid">
      <div class="detail-item"><span>Total orders</span><b>${summary.order_count}</b></div>
      <div class="detail-item"><span>Total quoted</span><b>${money(summary.total_spend_usd)}</b></div>
      <div class="detail-item"><span>Paid / purchased / shipped / delivered</span><b>${money(summary.paid_total_usd)}</b></div>
    </div>
    ${orders.length === 0 ? `<p class="muted">No orders yet.</p>` : `
      <div class="table-wrap"><table>
        <thead><tr><th>Order</th><th>Item</th><th>Total</th><th>Status</th><th>Tracking</th><th>Created</th></tr></thead>
        <tbody>
          ${orders.map((o) => `
            <tr>
              <td class="cell-strong">#${o.id}</td>
              <td>${escapeHtml(o.item_title || "Untitled item")}</td>
              <td>${money(o.quote_total_usd)}</td>
              <td>${statusPill(o.status)}</td>
              <td>${escapeHtml(o.tracking_number || "-")}</td>
              <td>${dateTime(o.created_at)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table></div>
    `}
    <div class="section-label">Verification comments</div>
    <div class="update-thread">
      ${comments.length === 0 ? `<p class="muted">No comments yet.</p>` : comments.map((c) => `
        <div class="update-entry">
          <div class="update-meta"><span>${escapeHtml(c.author_name || "Staff")}</span><span>${dateTime(c.created_at)}</span></div>
          <div>${escapeHtml(c.note)}</div>
        </div>
      `).join("")}
    </div>
    <div class="update-form">
      <textarea id="new-comment" placeholder="Add a running note about this shopper's verification…"></textarea>
      <button class="ghost-button" id="post-comment">Save note</button>
    </div>

    <div class="section-label">Messages to this shopper</div>
    <p class="muted" style="margin-top:-8px;">Sent directly to their registered email and shown in their account.</p>
    <div class="update-thread">
      ${messages.length === 0 ? `<p class="muted">No messages sent yet.</p>` : messages.map((m) => `
        <div class="update-entry ${m.sender_type === "system" ? "system" : ""}">
          <div class="update-meta"><span>${escapeHtml(m.sender_type === "admin" ? (m.sender_name || "Staff") : "System")} · ${escapeHtml(m.subject)}</span><span>${dateTime(m.created_at)}${m.read_at ? " · Read" : ""}</span></div>
          <div>${escapeHtml(m.body)}</div>
        </div>
      `).join("")}
    </div>
    <div class="update-form">
      <input id="new-message-subject" placeholder="Subject" />
      <textarea id="new-message-body" placeholder="Write a message to this shopper…"></textarea>
      <button class="primary-button" id="send-message">Send message</button>
    </div>

    <div class="section-label">Activity history</div>
    <div class="update-thread">
      ${activity.length === 0 ? `<p class="muted">No activity recorded yet.</p>` : activity.map((a) => `
        <div class="update-entry">
          <div class="update-meta">
            <span>${escapeHtml(a.actor_type === "shopper" ? "Shopper" : (a.actor_name || "System"))} · ${escapeHtml(a.action.replace(/_/g, " "))}</span>
            <span>${dateTime(a.created_at)}</span>
          </div>
          <div>${a.target_type ? `${escapeHtml(a.target_type)}${a.target_id ? ` #${a.target_id}` : ""}` : ""}</div>
        </div>
      `).join("")}
    </div>
  `);
  $("#approve-shopper").addEventListener("click", () => decideShopper(id, "approve"));
  $("#reject-shopper").addEventListener("click", () => decideShopper(id, "reject"));
  $("#edit-shipping-address").addEventListener("click", async () => {
    const streetAddress = window.prompt("Street address:", shopper.street_address || "");
    if (streetAddress === null) return;
    const city = window.prompt("City:", shopper.city || "");
    if (city === null) return;
    const shopperState = window.prompt("State:", shopper.state || "");
    if (shopperState === null) return;
    try {
      await api(`/shoppers/${id}/shipping-address`, { method: "PUT", body: { streetAddress, city, state: shopperState } });
      showToast("Shipping address updated.", "success");
      viewShopper(id);
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  $("#edit-physical-address").addEventListener("click", async () => {
    const streetAddress = window.prompt("Street address:", shopper.physical_street_address || "");
    if (streetAddress === null) return;
    const city = window.prompt("City:", shopper.physical_city || "");
    if (city === null) return;
    const shopperState = window.prompt("State:", shopper.physical_state || "");
    if (shopperState === null) return;
    try {
      await api(`/shoppers/${id}/physical-address`, { method: "PUT", body: { streetAddress, city, state: shopperState } });
      showToast("Physical address updated.", "success");
      viewShopper(id);
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  $("#send-message").addEventListener("click", async () => {
    const subject = $("#new-message-subject").value.trim();
    const message = $("#new-message-body").value.trim();
    if (!subject || !message) { showToast("Write a subject and message first.", "error"); return; }
    try {
      await api(`/shoppers/${id}/message`, { method: "POST", body: { subject, message } });
      showToast("Message sent.", "success");
      viewShopper(id);
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  $("#post-comment").addEventListener("click", async () => {
    const note = $("#new-comment").value.trim();
    if (!note) { showToast("Write a note first.", "error"); return; }
    try {
      await api(`/shoppers/${id}/comment`, { method: "POST", body: { note } });
      showToast("Note saved.", "success");
      viewShopper(id);
    } catch (error) {
      showToast(error.message, "error");
    }
  });
}

// Lightweight compose used wherever a shopper needs to be messaged without opening the full detail modal
// (verifications row, shopper directory row, order detail modal) — reuses the existing message route rather
// than building a parallel messaging surface. Two prompts mirror the existing reject-reason style elsewhere.
async function quickMessageShopper(shopperId) {
  const subject = window.prompt("Subject for this message:", "");
  if (subject === null) return;
  if (!subject.trim()) { showToast("A subject is required.", "error"); return; }
  const message = window.prompt("Message body:", "");
  if (message === null) return;
  if (!message.trim()) { showToast("A message is required.", "error"); return; }
  try {
    await api(`/shoppers/${shopperId}/message`, { method: "POST", body: { subject: subject.trim(), message: message.trim() } });
    showToast("Message sent.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function addShopperComment(id) {
  const input = $(`[data-comment-input="${id}"]`);
  const note = input.value.trim();
  if (!note) { showToast("Write a note first.", "error"); return; }
  try {
    await api(`/shoppers/${id}/comment`, { method: "POST", body: { note } });
    input.value = "";
    showToast("Note saved.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function decideShopper(id, decision) {
  const notes = window.prompt(`Reason for ${decision === "approve" ? "approving" : "rejecting"} this shopper (visible to the shopper if rejected):`, $("#shopper-notes")?.value.trim() || "");
  if (notes === null) return;
  try {
    const response = await apiRaw(`/shoppers/${id}/${decision}`, { method: "POST", body: { notes } });
    if (response.status === 202) {
      showToast(response.data.message || "Submitted for supervisor approval.", "");
      closeModal();
      loadVerifications();
      return;
    }
    showToast(`Shopper ${decision}d.`, "success");
    closeModal();
    loadVerifications();
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---- Shopper directory ----

let shopperSearchTimer;
$("#shoppers-search").addEventListener("input", () => {
  clearTimeout(shopperSearchTimer);
  shopperSearchTimer = setTimeout(loadShopperDirectory, 300);
});
$("#shoppers-status-filter").addEventListener("change", loadShopperDirectory);
$("#shoppers-refresh").addEventListener("click", loadShopperDirectory);

async function loadShopperDirectory() {
  const body = $("#shoppers-body");
  body.innerHTML = `<tr><td colspan="10">Loading…</td></tr>`;
  const params = new URLSearchParams();
  const search = $("#shoppers-search").value.trim();
  const status = $("#shoppers-status-filter").value;
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  try {
    const { shoppers } = await api(`/shopper-directory${params.toString() ? `?${params}` : ""}`);
    if (shoppers.length === 0) {
      body.innerHTML = "";
      $("#shoppers-empty").hidden = false;
      return;
    }
    $("#shoppers-empty").hidden = true;
    body.innerHTML = shoppers.map((shopper) => `
      <tr>
        <td class="cell-strong">${escapeHtml(displayName(shopper))}</td>
        <td>${escapeHtml(shopper.shopper_code)}</td>
        <td>${escapeHtml(shopper.email)}</td>
        <td>${escapeHtml(shopper.username || "-")}</td>
        <td>${escapeHtml(shopper.phone || "-")}</td>
        <td>${escapeHtml([shopper.city, shopper.state].filter(Boolean).join(", ") || "-")}</td>
        <td>${shopper.order_count}</td>
        <td>${statusPill(shopper.verification_status)}</td>
        <td>${dateTime(shopper.created_at)}</td>
        <td>
          <div class="row-actions">
            <button class="ghost-button" data-view-shopper-directory="${shopper.id}">View</button>
            <button class="ghost-button" data-quick-message="${shopper.id}" title="Send a message to this shopper">Message</button>
          </div>
        </td>
      </tr>
    `).join("");
    $$("[data-view-shopper-directory]", body).forEach((button) =>
      button.addEventListener("click", () => viewShopper(button.dataset.viewShopperDirectory)));
    $$("[data-quick-message]", body).forEach((button) =>
      button.addEventListener("click", () => quickMessageShopper(button.dataset.quickMessage)));
  } catch (error) {
    body.innerHTML = `<tr><td colspan="10">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
}

// ---- Orders ----

let ordersSearchTimer;
$("#orders-search").addEventListener("input", () => {
  clearTimeout(ordersSearchTimer);
  ordersSearchTimer = setTimeout(loadOrders, 300);
});
$("#orders-filter").addEventListener("change", loadOrders);
$("#orders-refresh").addEventListener("click", loadOrders);

async function loadOrders() {
  const status = $("#orders-filter").value;
  const search = $("#orders-search").value.trim();
  const body = $("#orders-body");
  body.innerHTML = `<tr><td colspan="9">Loading…</td></tr>`;
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  try {
    const { orders } = await api(`/orders${params.toString() ? `?${params}` : ""}`);
    if (orders.length === 0) {
      body.innerHTML = "";
      $("#orders-empty").hidden = false;
      return;
    }
    $("#orders-empty").hidden = true;
    body.innerHTML = orders.map((order) => `
      <tr>
        <td class="cell-strong">#${order.id}</td>
        <td>${order.id}</td>
        <td>${order.shopper_id}</td>
        <td>${escapeHtml(displayName(order))}<br><small class="muted">${escapeHtml(order.shopper_code)}</small></td>
        <td>${escapeHtml(order.item_title || "Untitled item")}</td>
        <td>${money(order.quote_total_usd)}</td>
        <td>${statusPill(order.status)}</td>
        <td>${dateTime(order.created_at)}</td>
        <td><button class="ghost-button" data-view-order="${order.id}">Review</button></td>
      </tr>
    `).join("");
    $$("[data-view-order]", body).forEach((button) =>
      button.addEventListener("click", () => viewOrder(button.dataset.viewOrder)));
  } catch (error) {
    body.innerHTML = `<tr><td colspan="9">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
  refreshBadges();
}

async function viewOrder(id) {
  const { order } = await api(`/orders/${id}`);
  await renderOrderModal(order);
}

async function renderOrderModal(order) {
  const rawBreakdown = typeof order.quote_breakdown === "string" ? JSON.parse(order.quote_breakdown) : order.quote_breakdown;
  // Orders created before this multi-item change (and never since recalculated) still carry the old
  // single-item breakdown key names (subtotal/tax/duty) instead of the new aggregate ones
  // (itemsSubtotal/itemsTax/itemsDuty) — read either so the modal displays correctly for both.
  const breakdown = {
    ...rawBreakdown,
    itemsSubtotal: rawBreakdown.itemsSubtotal ?? rawBreakdown.subtotal,
    itemsTax: rawBreakdown.itemsTax ?? rawBreakdown.tax,
    itemsDuty: rawBreakdown.itemsDuty ?? rawBreakdown.duty
  };
  const canEdit = ["pending_confirmation", "confirmed"].includes(order.status);
  const derivedTaxRate = breakdown.itemsSubtotal ? Math.round((breakdown.itemsTax / breakdown.itemsSubtotal) * 10000) / 100 : 7;
  const items = Array.isArray(order.items) ? order.items : [];
  let updates = [];
  try {
    ({ updates } = await api(`/orders/${order.id}/updates`));
  } catch { /* best effort */ }

  let inspection = null;
  let inspectionPhotos = [];
  let returnRequest = null;
  if (order.quality_inspection_requested) {
    try {
      ({ inspection, photos: inspectionPhotos } = await api(`/orders/${order.id}/inspection`));
    } catch { /* best effort */ }
    if (inspection && inspection.status === "rejected") {
      try {
        ({ returnRequest } = await api(`/orders/${order.id}/return-request`));
      } catch { /* best effort */ }
    }
  }

  openModal(`
    <h3>Order #${order.id}</h3>
    <p class="muted">${escapeHtml(displayName(order))} · ${escapeHtml(order.shopper_code)} · ${escapeHtml(order.email)}</p>
    <div class="detail-grid">
      <div class="detail-item"><span>Item ID</span><b>${order.id}</b></div>
      <div class="detail-item"><span>Shopper ID</span><b>${order.shopper_id}</b></div>
      <div class="detail-item full"><span>Product link</span><b>${order.product_url ? `<a href="${escapeAttr(order.product_url)}" target="_blank" rel="noopener">${escapeHtml(order.product_url)}</a>` : "-"}</b></div>
      <div class="detail-item"><span>Status</span><b>${statusPill(order.status)}</b></div>
      <div class="detail-item"><span>Created</span><b>${dateTime(order.created_at)}</b></div>
      <div class="detail-item"><span>Tracking number</span><b>${escapeHtml(order.tracking_number || "Not yet assigned")}</b></div>
      ${order.warehouse_received_at ? `<div class="detail-item"><span>Received at warehouse</span><b>${dateTime(order.warehouse_received_at)}</b></div>` : ""}
      ${order.refund_status && order.refund_status !== "none" ? `<div class="detail-item"><span>Refund status</span><b>${statusPill(order.refund_status)}</b></div>` : ""}
    </div>

    <div class="section-label">Shipping address</div>
    <div class="detail-grid">
      <div class="detail-item"><span>Recipient</span><b>${escapeHtml(order.recipient_name || displayName(order))}</b></div>
      <div class="detail-item"><span>Phone</span><b>${escapeHtml(order.recipient_phone || "-")}</b></div>
      <div class="detail-item full"><span>Address</span><b>${escapeHtml([order.shipping_street_address, order.shipping_city, order.shipping_state].filter(Boolean).join(", ") || "-")}</b></div>
    </div>
    <button class="ghost-button" id="print-label">Print shipping label</button>

    <div class="section-label">Items (${items.length})</div>
    <div class="item-list">
      ${items.map((item) => renderItemViewCard(item)).join("") || `<p class="muted">No items on this order.</p>`}
    </div>

    <div class="section-label">Quote breakdown</div>
    <div class="breakdown-list">
      <div><span>Items subtotal</span><b>${money(breakdown.itemsSubtotal)}</b></div>
      <div><span>Items tax</span><b>${money(breakdown.itemsTax)}</b></div>
      <div><span>US delivery</span><b>${money(breakdown.usDelivery)}</b></div>
      <div><span>Shipping (once, on total weight)</span><b>${money(breakdown.shipping)}</b></div>
      <div><span>Items duty</span><b>${money(breakdown.itemsDuty)}</b></div>
      <div><span>Insurance</span><b>${money(breakdown.insurance)}</b></div>
      <div><span>Quality inspection</span><b>${money(breakdown.qualityInspection)}</b></div>
      <div><span>Service fee</span><b>${money(breakdown.service)}</b></div>
      <div><span><strong>Total</strong></span><b><strong>${money(order.quote_total_usd)}</strong></b></div>
    </div>

    ${order.quality_inspection_requested ? renderInspectionSection(order, inspection, inspectionPhotos, returnRequest) : ""}

    ${canEdit ? `
    <div class="section-label">Edit &amp; recalculate</div>
    <div class="edit-item-list" id="edit-item-list">
      ${items.map((item, index) => renderItemEditCard(item, index)).join("")}
    </div>
    <button class="ghost-button" id="add-edit-item">Add another item</button>
    <div class="edit-grid" style="margin-top:14px;">
      <label class="field"><span>Shipping speed</span>
        <select id="edit-speed">${SPEEDS.map((s) => `<option value="${s}" ${s === order.shipping_speed ? "selected" : ""}>${s}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Tax rate (%)</span><input id="edit-tax-rate" type="number" min="0" max="20" step="0.01" value="${derivedTaxRate}" /></label>
      <label class="field"><span>Store shipping (USD)</span><input id="edit-store-shipping" type="number" min="0" step="0.01" value="${breakdown.usDelivery || 0}" /></label>
      <label class="field"><span><input id="edit-free-shipping" type="checkbox" ${breakdown.usDelivery === 0 ? "checked" : ""} /> Free store shipping</span></label>
      <label class="field"><span><input id="edit-insurance" type="checkbox" ${breakdown.insurance > 0 ? "checked" : ""} /> Purchase protection</span></label>
      <label class="field"><span><input id="edit-quality-inspection" type="checkbox" ${order.quality_inspection_requested ? "checked" : ""} /> Quality inspection</span></label>
    </div>
    <button class="ghost-button" id="recalculate-order">Recalculate</button>
    ` : ""}

    <label class="field full" style="margin-top:16px;"><span>Admin notes (optional)</span><textarea id="order-notes" placeholder="Visible to the shopper if rejected">${escapeHtml(order.admin_notes || "")}</textarea></label>

    <div class="modal-actions">
      ${order.status === "pending_confirmation" ? `
        <button class="primary-button" id="confirm-order">Confirm order</button>
        <button class="danger-button" id="reject-order">Reject</button>
      ` : ""}
      ${ORDER_ADVANCE_STATUSES.map((s) => `<button class="ghost-button" data-advance="${s}">Mark ${s}</button>`).join("")}
      <button class="ghost-button" id="message-shopper-from-order">Send message</button>
      <button class="ghost-button" data-close-modal>Close</button>
    </div>

    <div class="section-label">Delivery</div>
    <div class="edit-grid">
      <label class="field"><span>Estimated delivery date</span><input id="edit-eta" type="date" value="${order.estimated_delivery_date ? String(order.estimated_delivery_date).slice(0, 10) : ""}" /></label>
      <label class="field"><span>Delivered date</span><input id="edit-delivered" type="date" value="${order.delivered_date ? String(order.delivered_date).slice(0, 10) : ""}" /></label>
    </div>
    <button class="ghost-button" id="save-delivery">Save delivery info</button>

    <div class="section-label">Order updates</div>
    <button class="ghost-button" id="mark-warehouse-received">Mark received at warehouse</button>
    <div class="update-thread">
      ${updates.length === 0 ? `<p class="muted">No updates yet.</p>` : updates.map((u) => `
        <div class="update-entry ${u.author_type === "system" ? "system" : ""} ${u.visible_to_shopper === false ? "hidden-note" : ""}">
          <div class="update-meta"><span>${escapeHtml(u.author_name || u.author_type)}${u.visible_to_shopper === false ? " · internal only" : ""}</span><span>${dateTime(u.created_at)}</span></div>
          <div>${escapeHtml(u.message)}</div>
        </div>
      `).join("")}
    </div>
    <div class="update-form">
      <textarea id="update-message" placeholder="Write an update for this order…"></textarea>
      <label class="checkbox-row"><input id="update-visible" type="checkbox" checked /> Visible to shopper (sends an email)</label>
      <button class="ghost-button" id="post-update">Post update</button>
    </div>

    <div class="section-label">Refund</div>
    <div class="refund-grid">
      <label class="field"><span>Reason</span><input id="refund-reason" placeholder="Reason for refund" /></label>
      <label class="field"><span>Amount (USD)</span><input id="refund-amount" type="number" min="0" step="0.01" value="${order.refund_amount_usd || ""}" /></label>
    </div>
    <div class="modal-actions">
      <button class="ghost-button" data-refund="request">Request refund</button>
      <button class="primary-button" data-refund="approve">Approve refund</button>
      <button class="danger-button" data-refund="deny">Deny refund</button>
      <button class="ghost-button" data-refund="complete">Mark refunded</button>
    </div>
  `);

  $("#print-label")?.addEventListener("click", () => window.open(`/api/admin/orders/${order.id}/label`, "_blank"));
  $("#recalculate-order")?.addEventListener("click", () => recalculateOrder(order.id));
  $("#add-edit-item")?.addEventListener("click", () => {
    $("#edit-item-list").insertAdjacentHTML("beforeend", renderItemEditCard(null, $$("[data-edit-item]", $("#edit-item-list")).length));
    wireEditItemCards();
  });
  wireEditItemCards();
  $("#confirm-order")?.addEventListener("click", () => decideOrder(order.id, "confirm"));
  $("#reject-order")?.addEventListener("click", () => decideOrder(order.id, "reject"));
  $("#message-shopper-from-order")?.addEventListener("click", () => quickMessageShopper(order.shopper_id));
  $$("[data-advance]").forEach((button) =>
    button.addEventListener("click", () => advanceOrder(order.id, button.dataset.advance)));
  $("#save-delivery").addEventListener("click", () => saveDelivery(order.id));
  $("#post-update").addEventListener("click", () => postOrderUpdate(order.id));
  $("#mark-warehouse-received").addEventListener("click", () => markWarehouseReceived(order.id));
  $$("[data-refund]").forEach((button) =>
    button.addEventListener("click", () => actOnRefund(order.id, button.dataset.refund)));

  if (order.quality_inspection_requested) wireInspectionSection(order.id);
}

// ---- Multi-item read-only + editable cards (embedded in the order detail modal) ----

function renderItemViewCard(item) {
  const images = Array.isArray(item.images) ? item.images : [];
  const imagesHtml = images.length > 0 ? `
    <div class="inspection-photo-grid">
      ${images.map((img) => `
        <a href="/uploads/order-item-images/${encodeURIComponent(img.filePath)}" target="_blank" rel="noopener">
          <img class="detail-image" src="/uploads/order-item-images/${encodeURIComponent(img.filePath)}" alt="Item photo" />
        </a>
      `).join("")}
    </div>` : `<p class="muted">No photos uploaded for this item.</p>`;

  return `
    <div class="item-view-card">
      <div class="detail-grid">
        <div class="detail-item"><span>Title</span><b>${escapeHtml(item.item_title || "Untitled item")}</b></div>
        <div class="detail-item"><span>Category</span><b>${escapeHtml(item.category)}</b></div>
        <div class="detail-item"><span>Price</span><b>${money(item.price_usd)}</b></div>
        <div class="detail-item"><span>Quantity</span><b>${item.quantity}</b></div>
        <div class="detail-item"><span>Weight</span><b>${item.weight_lb} lb</b></div>
        <div class="detail-item"><span>Color / variant</span><b>${escapeHtml(item.color_variant || "-")}</b></div>
        <div class="detail-item full"><span>Product link</span><b>${item.product_url ? `<a href="${escapeAttr(item.product_url)}" target="_blank" rel="noopener">${escapeHtml(item.product_url)}</a>` : "-"}</b></div>
        ${item.description ? `<div class="detail-item full"><span>Description</span><b>${escapeHtml(item.description)}</b></div>` : ""}
        <div class="detail-item"><span>Item subtotal</span><b>${money(item.item_subtotal_usd)}</b></div>
        <div class="detail-item"><span>Item tax</span><b>${money(item.item_tax_usd)}</b></div>
        <div class="detail-item"><span>Item duty</span><b>${money(item.item_duty_usd)}</b></div>
      </div>
      ${imagesHtml}
    </div>
  `;
}

// Recalculation contract: each edit card optionally carries a data-existing-item-id (the order_items row it
// came from). On submit, cards WITH that id are sent with `id` in the payload (admin.js's recalculate route
// UPDATEs those rows in place, so their existing images are preserved); a card with no id (added via "Add
// another item") is sent without `id` and is INSERTed as a brand-new order_items row with no images. Any
// existing order_items row whose id is not present in the submitted set is DELETEd (cascading its images) —
// so removing a card and recalculating permanently drops that item and its photos.
function renderItemEditCard(item, index) {
  const existingId = item?.id ?? "";
  return `
    <div class="item-view-card" data-edit-item data-existing-item-id="${escapeAttr(existingId)}">
      <div class="edit-grid">
        <label class="field"><span>Item title</span><input data-edit-field="itemTitle" value="${escapeAttr(item?.item_title || "")}" /></label>
        <label class="field"><span>Product link</span><input data-edit-field="productUrl" value="${escapeAttr(item?.product_url || "")}" /></label>
        <label class="field"><span>Price (USD)</span><input data-edit-field="price" type="number" min="0.01" step="0.01" value="${item?.price_usd ?? ""}" /></label>
        <label class="field"><span>Quantity</span><input data-edit-field="quantity" type="number" min="1" step="1" value="${item?.quantity ?? 1}" /></label>
        <label class="field"><span>Weight (lb)</span><input data-edit-field="weight" type="number" min="0.2" step="0.1" value="${item?.weight_lb ?? 0.2}" /></label>
        <label class="field"><span>Category</span>
          <select data-edit-field="category">${CATEGORIES.map((c) => `<option value="${c}" ${c === item?.category ? "selected" : ""}>${c}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Color / variant</span><input data-edit-field="colorVariant" value="${escapeAttr(item?.color_variant || "")}" /></label>
        <label class="field full"><span>Description</span><input data-edit-field="description" value="${escapeAttr(item?.description || "")}" /></label>
      </div>
      <button class="ghost-button" type="button" data-remove-edit-item>Remove this item</button>
    </div>
  `;
}

function wireEditItemCards() {
  $$("[data-remove-edit-item]", $("#edit-item-list")).forEach((button) => {
    button.onclick = () => {
      const cards = $$("[data-edit-item]", $("#edit-item-list"));
      if (cards.length <= 1) { showToast("An order must have at least one item.", "error"); return; }
      button.closest("[data-edit-item]").remove();
    };
  });
}

// ---- Quality inspection + return workflow (embedded in the order detail modal) ----

function renderInspectionSection(order, inspection, photos, returnRequest) {
  const status = inspection?.status;
  const canUploadPhotos = !status || status === "pending_photos";
  const canDecide = status === "pending_approval";
  const isOwner = state.role === "owner";

  const photoGallery = photos && photos.length > 0 ? `
    <div class="inspection-photo-grid">
      ${photos.map((p) => `
        <a href="/uploads/inspection-photos/${encodeURIComponent(p.file_path)}" target="_blank" rel="noopener">
          <img class="detail-image" src="/uploads/inspection-photos/${encodeURIComponent(p.file_path)}" alt="Inspection photo" />
        </a>
      `).join("")}
    </div>` : "";

  const uploadForm = canUploadPhotos ? `
    <div class="update-form">
      <input id="inspection-photos-input" type="file" accept="image/png,image/jpeg,image/webp" multiple />
      <small class="muted">Up to 6 photos (PNG/JPG/WEBP).</small>
      <button class="ghost-button" id="upload-inspection-photos">Upload photos</button>
    </div>` : "";

  const decisionButtons = canDecide
    ? (isOwner
        ? `<div class="modal-actions">
             <button class="primary-button" id="approve-inspection">Approve inspection</button>
             <button class="danger-button" id="reject-inspection">Reject inspection</button>
           </div>`
        : `<p class="muted">Only the owner can approve quality inspections.</p>`)
    : "";

  const returnSection = (status === "rejected" && !returnRequest) ? `
    <div class="section-label">Request return</div>
    <p class="muted">A return can only be requested if the item is confirmed still at origin and the seller has accepted the return.</p>
    <label class="checkbox-row"><input id="return-item-at-origin" type="checkbox" /> Item confirmed still at origin</label>
    <label class="checkbox-row"><input id="return-seller-accepts" type="checkbox" /> Seller has accepted the return</label>
    <label class="field full"><span>Reason</span><textarea id="return-reason" placeholder="Details for this return request…"></textarea></label>
    <button class="ghost-button" id="submit-return-request" disabled>Request return</button>
  ` : returnRequest ? `
    <div class="section-label">Return request</div>
    <div class="detail-grid">
      <div class="detail-item"><span>Status</span><b>${statusPill(returnRequest.status)}</b></div>
      <div class="detail-item"><span>Requested</span><b>${dateTime(returnRequest.created_at)}</b></div>
      ${returnRequest.reason ? `<div class="detail-item full"><span>Reason</span><b>${escapeHtml(returnRequest.reason)}</b></div>` : ""}
    </div>
    ${returnRequest.status === "pending" ? `
      <div class="modal-actions">
        <button class="primary-button" id="approve-return">Approve return</button>
        <button class="danger-button" id="deny-return" data-return-id="${returnRequest.id}">Deny return</button>
      </div>` : ""}
  ` : "";

  return `
    <div class="section-label">Quality inspection</div>
    <div class="detail-grid">
      <div class="detail-item"><span>Status</span><b>${status ? statusPill(status) : "Not started"}</b></div>
      ${inspection?.submitted_at ? `<div class="detail-item"><span>Submitted</span><b>${dateTime(inspection.submitted_at)}</b></div>` : ""}
      ${inspection?.sla_deadline ? `<div class="detail-item"><span>SLA deadline</span><b>${dateTime(inspection.sla_deadline)}</b></div>` : ""}
      ${inspection?.decided_at ? `<div class="detail-item"><span>Decided</span><b>${dateTime(inspection.decided_at)}</b></div>` : ""}
      ${inspection?.decision_reason ? `<div class="detail-item full"><span>Decision reason</span><b>${escapeHtml(inspection.decision_reason)}</b></div>` : ""}
    </div>
    ${photoGallery}
    ${uploadForm}
    ${decisionButtons}
    ${returnSection}
  `;
}

function wireInspectionSection(orderId) {
  $("#upload-inspection-photos")?.addEventListener("click", () => uploadInspectionPhotos(orderId));
  $("#approve-inspection")?.addEventListener("click", () => decideInspection(orderId, "approve"));
  $("#reject-inspection")?.addEventListener("click", () => decideInspection(orderId, "reject"));
  $("#approve-return")?.addEventListener("click", () => decideReturnRequest(orderId, "approve"));
  $("#deny-return")?.addEventListener("click", () => decideReturnRequest(orderId, "deny"));

  const originBox = $("#return-item-at-origin");
  const acceptsBox = $("#return-seller-accepts");
  const submitButton = $("#submit-return-request");
  if (originBox && acceptsBox && submitButton) {
    const syncEnabled = () => { submitButton.disabled = !(originBox.checked && acceptsBox.checked); };
    originBox.addEventListener("change", syncEnabled);
    acceptsBox.addEventListener("change", syncEnabled);
    submitButton.addEventListener("click", () => submitReturnRequest(orderId));
  }
}

async function uploadInspectionPhotos(orderId) {
  const input = $("#inspection-photos-input");
  const files = input?.files;
  if (!files || files.length === 0) { showToast("Select at least one photo first.", "error"); return; }
  const formData = new FormData();
  [...files].forEach((file) => formData.append("photos", file));
  try {
    await api(`/orders/${orderId}/inspection/photos`, { method: "POST", body: formData });
    showToast("Inspection photos uploaded.", "success");
    const { order } = await api(`/orders/${orderId}`);
    await renderOrderModal(order);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function decideInspection(orderId, decision) {
  let reason;
  if (decision === "reject") {
    reason = window.prompt("Reason the item failed quality inspection (visible to the shopper in general terms):", "");
    if (reason === null) return;
    if (!reason.trim()) { showToast("A reason is required to reject an inspection.", "error"); return; }
  }
  try {
    // The inspection id isn't on the order row directly, so fetch it first.
    const { inspection } = await api(`/orders/${orderId}/inspection`);
    if (!inspection) { showToast("No inspection found for this order.", "error"); return; }
    await api(`/inspections/${inspection.id}/${decision}`, { method: "POST", body: decision === "reject" ? { reason } : {} });
    showToast(`Inspection ${decision}d.`, "success");
    const { order } = await api(`/orders/${orderId}`);
    await renderOrderModal(order);
    loadOrders();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function submitReturnRequest(orderId) {
  const itemStillAtOrigin = $("#return-item-at-origin").checked;
  const sellerAcceptsReturn = $("#return-seller-accepts").checked;
  const reason = $("#return-reason").value.trim();
  if (!itemStillAtOrigin || !sellerAcceptsReturn) {
    showToast("Both conditions must be confirmed before requesting a return.", "error");
    return;
  }
  try {
    await api(`/orders/${orderId}/return-request`, { method: "POST", body: { itemStillAtOrigin, sellerAcceptsReturn, reason } });
    showToast("Return request submitted.", "success");
    const { order } = await api(`/orders/${orderId}`);
    await renderOrderModal(order);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function decideReturnRequest(orderId, decision) {
  const reason = window.prompt(decision === "deny" ? "Reason for denying this return (required):" : "Optional note for this approval:", "");
  if (reason === null) return;
  if (decision === "deny" && !reason.trim()) { showToast("A reason is required to deny a return.", "error"); return; }
  try {
    const { returnRequest } = await api(`/orders/${orderId}/return-request`);
    if (!returnRequest) { showToast("No return request found for this order.", "error"); return; }
    const response = await apiRaw(`/return-requests/${returnRequest.id}/${decision}`, { method: "POST", body: { reason } });
    if (response.status === 202) {
      showToast(response.data.message || "Submitted for supervisor approval.", "");
      closeModal();
      loadOrders();
      return;
    }
    showToast(`Return ${decision === "approve" ? "approved" : "denied"}.`, "success");
    const { order } = await api(`/orders/${orderId}`);
    await renderOrderModal(order);
    loadOrders();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function collectEditItems() {
  return $$("[data-edit-item]", $("#edit-item-list")).map((card) => {
    const field = (name) => $(`[data-edit-field="${name}"]`, card).value;
    const existingId = card.dataset.existingItemId;
    return {
      id: existingId ? Number(existingId) : undefined,
      itemTitle: field("itemTitle").trim() || null,
      productUrl: field("productUrl").trim() || null,
      price: Number(field("price")),
      quantity: Number(field("quantity")),
      weight: Number(field("weight")),
      category: field("category"),
      colorVariant: field("colorVariant").trim() || null,
      description: field("description").trim() || null
    };
  });
}

async function recalculateOrder(id) {
  const items = collectEditItems();
  if (items.length === 0) { showToast("At least one item is required.", "error"); return; }
  try {
    const { order } = await api(`/orders/${id}/recalculate`, {
      method: "POST",
      body: {
        items,
        speed: $("#edit-speed").value,
        taxRate: Number($("#edit-tax-rate").value),
        freeStoreShipping: $("#edit-free-shipping").checked,
        storeShipping: Number($("#edit-store-shipping").value),
        insurance: $("#edit-insurance").checked,
        qualityInspection: $("#edit-quality-inspection").checked
      }
    });
    showToast("Order recalculated.", "success");
    await renderOrderModal(order);
    loadOrders();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function decideOrder(id, decision) {
  const notes = window.prompt(`Reason for ${decision === "confirm" ? "confirming" : "rejecting"} this order (visible to the shopper if rejected):`, $("#order-notes")?.value.trim() || "");
  if (notes === null) return;
  try {
    const response = await apiRaw(`/orders/${id}/${decision}`, { method: "POST", body: { notes } });
    if (response.status === 202) {
      showToast(response.data.message || "Submitted for supervisor approval.", "");
      closeModal();
      loadOrders();
      return;
    }
    showToast(`Order ${decision}ed.`, "success");
    closeModal();
    loadOrders();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function advanceOrder(id, status) {
  try {
    await api(`/orders/${id}/status`, { method: "POST", body: { status } });
    showToast(`Order marked ${status}.`, "success");
    closeModal();
    loadOrders();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveDelivery(id) {
  try {
    const { order } = await api(`/orders/${id}/delivery`, {
      method: "PUT",
      body: { estimatedDeliveryDate: $("#edit-eta").value || null, deliveredDate: $("#edit-delivered").value || null }
    });
    showToast("Delivery info saved.", "success");
    await renderOrderModal(order);
    loadOrders();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function postOrderUpdate(id) {
  const message = $("#update-message").value.trim();
  if (!message) { showToast("Write a message first.", "error"); return; }
  const visibleToShopper = $("#update-visible").checked;
  try {
    await api(`/orders/${id}/updates`, { method: "POST", body: { message, visibleToShopper } });
    showToast("Update posted.", "success");
    const { order } = await api(`/orders/${id}`);
    await renderOrderModal(order);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function markWarehouseReceived(id) {
  try {
    await api(`/orders/${id}/warehouse-received`, { method: "POST", body: {} });
    showToast("Marked received at warehouse.", "success");
    const { order } = await api(`/orders/${id}`);
    await renderOrderModal(order);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function actOnRefund(id, action) {
  const reason = $("#refund-reason").value.trim() || undefined;
  const amountRaw = $("#refund-amount").value;
  const amountUsd = amountRaw ? Number(amountRaw) : undefined;
  if ((action === "deny" || action === "request") && !reason) {
    showToast("A reason is required for this action.", "error");
    return;
  }
  try {
    const response = await apiRaw(`/orders/${id}/refund`, { method: "POST", body: { action, reason, amountUsd } });
    if (response.status === 202) {
      showToast(response.data.message || "Submitted for supervisor approval.", "");
      closeModal();
      loadOrders();
      return;
    }
    showToast(`Refund ${action === "complete" ? "marked as refunded" : action + "ed"}.`, "success");
    const { order } = await api(`/orders/${id}`);
    await renderOrderModal(order);
    loadOrders();
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---- Payments ----

let paymentsSearchTimer;
$("#payments-search").addEventListener("input", () => {
  clearTimeout(paymentsSearchTimer);
  paymentsSearchTimer = setTimeout(loadPayments, 300);
});
$("#payments-filter").addEventListener("change", loadPayments);
$("#payments-refresh").addEventListener("click", loadPayments);
$("#payments-export-all").addEventListener("click", () => downloadPaymentsReport());
$("#payments-export-shopper").addEventListener("click", () => {
  const shopperId = $("#payments-report-shopper-id").value.trim();
  if (!shopperId) { showToast("Enter a shopper ID first.", "error"); return; }
  downloadPaymentsReport(shopperId);
});

async function loadPayments() {
  const status = $("#payments-filter").value;
  const search = $("#payments-search").value.trim();
  const body = $("#payments-body");
  body.innerHTML = `<tr><td colspan="9">Loading…</td></tr>`;
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  try {
    const { payments } = await api(`/payments${params.toString() ? `?${params}` : ""}`);
    if (payments.length === 0) {
      body.innerHTML = "";
      $("#payments-empty").hidden = false;
      return;
    }
    $("#payments-empty").hidden = true;
    body.innerHTML = payments.map((payment) => `
      <tr>
        <td class="cell-strong">${escapeHtml(payment.reference_code)}</td>
        <td>${payment.shopper_id}</td>
        <td>${payment.order_id ? `Order #${payment.order_id}` : payment.subscription_id ? `Subscription #${payment.subscription_id}` : "-"}</td>
        <td>${escapeHtml(payment.email)}<br><small class="muted">${escapeHtml(displayName(payment))} · ${escapeHtml(payment.shopper_code)}</small></td>
        <td>${payment.method === "bank_transfer" ? "Bank transfer" : "Credit card"}</td>
        <td>
          ${money(payment.amount_usd)}<br><small class="muted">₦${Number(payment.amount_ngn).toLocaleString()}</small>
          ${payment.original_amount_usd ? `<br><small class="muted">Originally ${money(payment.original_amount_usd)}</small>` : ""}
        </td>
        <td>${statusPill(payment.status)}${payment.decision_reason ? `<br><small class="muted">${escapeHtml(payment.decision_reason)}</small>` : ""}</td>
        <td>${dateTime(payment.created_at)}</td>
        <td>
          <div class="row-actions">
            ${payment.status === "pending" ? `
              <button class="primary-button" data-confirm-payment="${payment.id}">Confirm</button>
              <button class="danger-button" data-reject-payment="${payment.id}">Reject</button>
            ` : ""}
            ${payment.status === "rejected" ? `
              <button class="primary-button" data-confirm-payment="${payment.id}">Approve</button>
            ` : ""}
            ${payment.status === "confirmed" && (state.role === "owner" || state.role === "supervisor") ? `
              <button class="ghost-button" data-reverse-payment="${payment.id}">Reverse</button>
            ` : ""}
            <button class="ghost-button" data-edit-payment-amount="${payment.id}" data-current-amount="${payment.amount_usd}">Edit amount</button>
            <button class="ghost-button" data-comment-payment="${payment.id}" data-current-comment="${escapeAttr(payment.admin_comment || "")}">${payment.admin_comment ? "Edit comment" : "Add comment"}</button>
            ${payment.receipt_file_path ? `<a class="ghost-button" href="/uploads/payment-receipts/${encodeURIComponent(payment.receipt_file_path)}" target="_blank" rel="noopener">View receipt</a>` : ""}
          </div>
          ${payment.admin_comment ? `<div class="payment-comment"><small class="muted">Note: ${escapeHtml(payment.admin_comment)}</small></div>` : ""}
        </td>
      </tr>
    `).join("");
    $$("[data-confirm-payment]", body).forEach((button) =>
      button.addEventListener("click", () => decidePayment(button.dataset.confirmPayment, "confirm")));
    $$("[data-reject-payment]", body).forEach((button) =>
      button.addEventListener("click", () => decidePayment(button.dataset.rejectPayment, "reject")));
    $$("[data-reverse-payment]", body).forEach((button) =>
      button.addEventListener("click", () => reversePayment(button.dataset.reversePayment)));
    $$("[data-edit-payment-amount]", body).forEach((button) =>
      button.addEventListener("click", () => editPaymentAmount(button.dataset.editPaymentAmount, button.dataset.currentAmount)));
    $$("[data-comment-payment]", body).forEach((button) =>
      button.addEventListener("click", () => commentOnPayment(button.dataset.commentPayment, button.dataset.currentComment)));
  } catch (error) {
    body.innerHTML = `<tr><td colspan="9">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
  refreshBadges();
}

async function decidePayment(id, decision) {
  let reason;
  if (decision === "reject") {
    reason = window.prompt("Reason for rejecting this payment (shown to the shopper):", "");
    if (reason === null) return;
    if (!reason.trim()) { showToast("A reason is required to reject a payment.", "error"); return; }
  }
  try {
    const response = await apiRaw(`/payments/${id}/${decision}`, { method: "POST", body: decision === "reject" ? { reason } : undefined });
    if (response.status === 202) {
      showToast(response.data.message || "Submitted for supervisor approval.", "");
      loadPayments();
      return;
    }
    showToast(`Payment ${decision}ed.`, "success");
    loadPayments();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function editPaymentAmount(id, currentAmount) {
  const input = window.prompt("New payment amount in USD:", currentAmount);
  if (input === null) return;
  const amountUsd = Number(input);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    showToast("Enter a valid amount greater than 0.", "error");
    return;
  }
  try {
    await api(`/payments/${id}/amount`, { method: "PUT", body: { amountUsd } });
    showToast("Payment amount updated.", "success");
    loadPayments();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function commentOnPayment(id, currentComment) {
  const comment = window.prompt("Comment on this payment (visible to staff only):", currentComment || "");
  if (comment === null) return;
  try {
    await api(`/payments/${id}/comment`, { method: "PUT", body: { comment } });
    showToast("Comment saved.", "success");
    loadPayments();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function reversePayment(id) {
  const reason = window.prompt("Reason for reversing this confirmed payment (shown to the shopper):", "");
  if (reason === null) return;
  if (!reason.trim()) { showToast("A reason is required to reverse a payment.", "error"); return; }
  try {
    await api(`/payments/${id}/reverse`, { method: "POST", body: { reason } });
    showToast("Payment reversed.", "success");
    loadPayments();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function downloadPaymentsReport(shopperId) {
  const params = shopperId ? `?shopperId=${encodeURIComponent(shopperId)}` : "";
  window.open(`/api/admin/payments/report.csv${params}`, "_blank");
}

// ---- Subscriptions ----

let subscriptionsSearchTimer;
$("#subscriptions-search").addEventListener("input", () => {
  clearTimeout(subscriptionsSearchTimer);
  subscriptionsSearchTimer = setTimeout(loadSubscriptions, 300);
});
$("#subscriptions-filter").addEventListener("change", loadSubscriptions);
$("#subscriptions-refresh").addEventListener("click", loadSubscriptions);

async function loadSubscriptions() {
  const status = $("#subscriptions-filter").value;
  const search = $("#subscriptions-search").value.trim();
  const body = $("#subscriptions-body");
  body.innerHTML = `<tr><td colspan="5">Loading…</td></tr>`;
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  try {
    const { subscriptions } = await api(`/subscriptions${params.toString() ? `?${params}` : ""}`);
    if (subscriptions.length === 0) {
      body.innerHTML = "";
      $("#subscriptions-empty").hidden = false;
      return;
    }
    $("#subscriptions-empty").hidden = true;
    body.innerHTML = subscriptions.map((sub) => `
      <tr>
        <td class="cell-strong">${escapeHtml(displayName(sub))}<br><small class="muted">${escapeHtml(sub.shopper_code)}</small></td>
        <td>${money(sub.plan_price_usd)}</td>
        <td>${statusPill(sub.status)}</td>
        <td>${sub.current_period_start ? `${dateTime(sub.current_period_start)} - ${dateTime(sub.current_period_end)}` : "-"}</td>
        <td>${dateTime(sub.created_at)}</td>
      </tr>
    `).join("");
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
}

// ---- Approvals ----

let approvalsSearchTimer;
$("#approvals-search").addEventListener("input", () => {
  clearTimeout(approvalsSearchTimer);
  approvalsSearchTimer = setTimeout(loadApprovals, 300);
});
$("#approvals-filter").addEventListener("change", loadApprovals);
$("#approvals-refresh").addEventListener("click", loadApprovals);

async function loadApprovals() {
  const status = $("#approvals-filter").value;
  const search = $("#approvals-search").value.trim();
  const body = $("#approvals-body");
  body.innerHTML = `<tr><td colspan="6">Loading…</td></tr>`;
  const params = new URLSearchParams();
  params.set("status", status || "");
  if (search) params.set("search", search);
  try {
    const { approvalRequests } = await api(`/approval-requests?${params}`);
    if (approvalRequests.length === 0) {
      body.innerHTML = "";
      $("#approvals-empty").hidden = false;
      return;
    }
    $("#approvals-empty").hidden = true;
    body.innerHTML = approvalRequests.map((req) => `
      <tr>
        <td>${dateTime(req.created_at)}</td>
        <td class="cell-strong">${escapeHtml(req.action_type.replace(/_/g, " "))}</td>
        <td>${escapeHtml(req.requested_by_name || `Admin #${req.requested_by}`)}</td>
        <td>${req.target ? `${escapeHtml(req.target_type)} #${req.target_id}${req.target.full_name ? ` · ${escapeHtml(req.target.full_name)}` : ""}${req.target.item_title ? ` · ${escapeHtml(req.target.item_title)}` : ""}` : `${escapeHtml(req.target_type)} #${req.target_id}`}</td>
        <td>${escapeHtml(req.reason || "-")}</td>
        <td>
          <div class="row-actions">
            <button class="primary-button" data-approve-request="${req.id}">Approve</button>
            <button class="danger-button" data-deny-request="${req.id}">Deny</button>
          </div>
        </td>
      </tr>
    `).join("");
    $$("[data-approve-request]", body).forEach((button) =>
      button.addEventListener("click", () => decideApprovalRequest(button.dataset.approveRequest, "approve")));
    $$("[data-deny-request]", body).forEach((button) =>
      button.addEventListener("click", () => decideApprovalRequest(button.dataset.denyRequest, "deny")));
  } catch (error) {
    body.innerHTML = `<tr><td colspan="6">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
  refreshBadges();
}

async function decideApprovalRequest(id, decision) {
  const reason = window.prompt(decision === "deny" ? "Reason for denying this request (required):" : "Optional note for this approval:", "");
  if (reason === null) return;
  if (decision === "deny" && !reason.trim()) {
    showToast("A reason is required to deny a request.", "error");
    return;
  }
  try {
    await api(`/approval-requests/${id}/${decision}`, { method: "POST", body: { reason } });
    showToast(`Request ${decision}d.`, "success");
    loadApprovals();
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---- Staff ----

$("#staff-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type='submit']", event.currentTarget);
  button.disabled = true;
  try {
    await api("/staff", {
      method: "POST",
      body: {
        firstName: $("#staff-first-name").value.trim(),
        lastName: $("#staff-last-name").value.trim(),
        username: $("#staff-username").value.trim(),
        email: $("#staff-email").value.trim(),
        password: $("#staff-password").value,
        role: $("#staff-role").value
      }
    });
    showToast("Staff account created.", "success");
    event.currentTarget.reset();
    loadStaff();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

let staffSearchTimer;
$("#staff-search").addEventListener("input", () => {
  clearTimeout(staffSearchTimer);
  staffSearchTimer = setTimeout(loadStaff, 300);
});
$("#staff-role-filter").addEventListener("change", loadStaff);
$("#staff-active-filter").addEventListener("change", loadStaff);
$("#staff-refresh").addEventListener("click", loadStaff);

async function loadStaff() {
  const body = $("#staff-body");
  body.innerHTML = `<tr><td colspan="7">Loading…</td></tr>`;
  const params = new URLSearchParams();
  const role = $("#staff-role-filter").value;
  const isActive = $("#staff-active-filter").value;
  const search = $("#staff-search").value.trim();
  if (role) params.set("role", role);
  if (isActive) params.set("isActive", isActive);
  if (search) params.set("search", search);
  try {
    const { staff } = await api(`/staff${params.toString() ? `?${params}` : ""}`);
    const canManage = state.role === "owner" || state.role === "supervisor";
    const isOwner = state.role === "owner";
    body.innerHTML = staff.map((member) => `
      <tr>
        <td class="cell-strong"><button class="text-button" data-view-staff="${member.id}">${escapeHtml(displayName(member))}</button>${member.reported ? ` <span class="status-pill status-reported" title="${escapeAttr(member.report_reason || "")}">🚩 Reported</span>` : ""}</td>
        <td>${escapeHtml(member.username || "-")}</td>
        <td>${escapeHtml(member.email)}</td>
        <td>${escapeHtml(member.role)}</td>
        <td>${member.is_active ? statusPill("active") : statusPill("cancelled")}</td>
        <td>${dateTime(member.created_at)}</td>
        <td>
          <div class="row-actions">
            <button class="ghost-button" data-view-staff="${member.id}">View profile</button>
            ${canManage && (isOwner || member.role !== "owner") ? `<button class="ghost-button" data-toggle-active="${member.id}" data-current="${member.is_active}">${member.is_active ? "Deactivate" : "Activate"}</button>` : ""}
            ${canManage && member.role !== "owner" && !member.reported ? `<button class="ghost-button" data-report-staff="${member.id}" data-name="${escapeAttr(displayName(member))}">Report</button>` : ""}
          </div>
        </td>
      </tr>
    `).join("");
    $$("[data-view-staff]", body).forEach((button) =>
      button.addEventListener("click", () => viewStaff(button.dataset.viewStaff)));
    $$("[data-toggle-active]", body).forEach((button) =>
      button.addEventListener("click", () => toggleStaffActive(button.dataset.toggleActive, button.dataset.current === "true")));
    $$("[data-report-staff]", body).forEach((button) =>
      button.addEventListener("click", () => reportStaff(button.dataset.reportStaff, button.dataset.name)));
  } catch (error) {
    body.innerHTML = `<tr><td colspan="7">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
}

// Full staff profile detail view — mirrors viewShopper()'s shape (detail-grid + editable form + activity
// thread), but the editable fields/actions here map onto staff.js's existing routes rather than new ones.
// Row-level buttons above keep fast access to the two most common actions (deactivate, report); every other
// action (edit profile, set password, permissions, unreport, delete) now lives only in this modal, since the
// old sequential window.prompt() edit flow duplicated fields this modal now presents as real inputs.
async function viewStaff(id) {
  const { staff: member } = await api(`/staff/${id}`);
  let activity = [];
  try {
    ({ activity } = await api(`/staff/${id}/activity`));
  } catch { /* best effort */ }

  const isOwner = state.role === "owner";
  const canManage = isOwner || state.role === "supervisor";
  const targetIsOwner = member.role === "owner";

  openModal(`
    <h3>${escapeHtml(displayName(member))}</h3>
    <p class="muted">${escapeHtml(member.username || "-")} · ${escapeHtml(member.email)}${member.reported ? ` · <span class="status-pill status-reported">🚩 Reported</span>` : ""}</p>
    <div class="detail-grid">
      <div class="detail-item"><span>Staff ID</span><b>${member.id}</b></div>
      <div class="detail-item"><span>Role</span><b>${escapeHtml(member.role)}</b></div>
      <div class="detail-item"><span>Status</span><b>${member.is_active ? statusPill("active") : statusPill("cancelled")}</b></div>
      <div class="detail-item"><span>Phone</span><b>${escapeHtml(member.phone || "-")}</b></div>
      <div class="detail-item"><span>Phone carrier</span><b>${escapeHtml(member.phone_carrier || "-")}</b></div>
      <div class="detail-item"><span>Created</span><b>${dateTime(member.created_at)}</b></div>
      ${member.reported ? `<div class="detail-item full"><span>Report reason</span><b>${escapeHtml(member.report_reason || "-")}</b></div>` : ""}
    </div>

    ${isOwner ? `
    <div class="section-label">Edit profile</div>
    <div class="edit-grid">
      <label class="field"><span>First name</span><input id="staff-edit-first-name" value="${escapeAttr(member.first_name)}" /></label>
      <label class="field"><span>Last name</span><input id="staff-edit-last-name" value="${escapeAttr(member.last_name)}" /></label>
      <label class="field"><span>Email</span><input id="staff-edit-email" type="email" value="${escapeAttr(member.email)}" /></label>
      <label class="field"><span>Username</span><input id="staff-edit-username" value="${escapeAttr(member.username || "")}" disabled title="Username is not editable via this route" /></label>
      <label class="field"><span>Phone</span><input id="staff-edit-phone" value="${escapeAttr(member.phone || "")}" /></label>
      <label class="field"><span>Phone carrier</span><input id="staff-edit-phone-carrier" value="${escapeAttr(member.phone_carrier || "")}" placeholder="att, verizon, tmobile, sprint" /></label>
    </div>
    <button class="primary-button" id="save-staff-profile">Save changes</button>
    ` : ""}

    ${canManage && (isOwner || !targetIsOwner) ? `
    <div class="section-label">Role &amp; status</div>
    <div class="edit-grid">
      ${isOwner ? `
      <label class="field"><span>Role</span>
        <select id="staff-edit-role">
          ${["staff", "supervisor", "owner"].map((r) => `<option value="${r}" ${r === member.role ? "selected" : ""}>${r}</option>`).join("")}
        </select>
      </label>` : `<div class="detail-item"><span>Role</span><b>${escapeHtml(member.role)} (owner only can change)</b></div>`}
      <label class="field"><span>Active</span>
        <select id="staff-edit-active">
          <option value="true" ${member.is_active ? "selected" : ""}>Active</option>
          <option value="false" ${!member.is_active ? "selected" : ""}>Inactive</option>
        </select>
      </label>
    </div>
    <button class="ghost-button" id="save-staff-role-status">Save role &amp; status</button>
    ` : ""}

    <div class="modal-actions">
      ${isOwner ? `<button class="ghost-button" id="staff-set-password">Set new password</button>` : ""}
      ${isOwner && !targetIsOwner ? `<button class="ghost-button" id="staff-open-permissions">Permissions</button>` : ""}
      ${canManage && !targetIsOwner && !member.reported ? `<button class="ghost-button" id="staff-report">Report</button>` : ""}
      ${isOwner && member.reported ? `<button class="ghost-button" id="staff-unreport">Unreport</button>` : ""}
      ${isOwner ? `<button class="danger-button" id="staff-delete">Delete</button>` : ""}
      <button class="ghost-button" data-close-modal>Close</button>
    </div>

    <div class="section-label">Activity history</div>
    <div class="update-thread">
      ${activity.length === 0 ? `<p class="muted">No activity recorded yet.</p>` : activity.map((a) => `
        <div class="update-entry">
          <div class="update-meta">
            <span>${escapeHtml(a.actor_type === "staff" && Number(a.actor_id) === member.id ? displayName(member) || "This staff member" : (a.actor_name || "System"))} · ${escapeHtml(a.action.replace(/_/g, " "))}</span>
            <span>${dateTime(a.created_at)}</span>
          </div>
          <div>${a.target_type ? `${escapeHtml(a.target_type)}${a.target_id ? ` #${a.target_id}` : ""}` : ""}</div>
        </div>
      `).join("")}
    </div>
  `);

  $("#save-staff-profile")?.addEventListener("click", async () => {
    const firstName = $("#staff-edit-first-name").value.trim();
    const lastName = $("#staff-edit-last-name").value.trim();
    const email = $("#staff-edit-email").value.trim();
    const phone = $("#staff-edit-phone").value.trim();
    const phoneCarrier = $("#staff-edit-phone-carrier").value.trim();
    if (!firstName || !lastName || !email) { showToast("First name, last name, and email are required.", "error"); return; }
    try {
      await api(`/staff/${id}/profile`, { method: "PUT", body: { firstName, lastName, email, phone, phoneCarrier } });
      showToast("Staff profile updated.", "success");
      viewStaff(id);
      loadStaff();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#save-staff-role-status")?.addEventListener("click", async () => {
    const body = {};
    const roleSelect = $("#staff-edit-role");
    if (roleSelect) body.role = roleSelect.value;
    body.isActive = $("#staff-edit-active").value === "true";
    try {
      await api(`/staff/${id}`, { method: "PUT", body });
      showToast("Staff role/status updated.", "success");
      viewStaff(id);
      loadStaff();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#staff-set-password")?.addEventListener("click", () => resetStaffPassword(id));
  $("#staff-open-permissions")?.addEventListener("click", () => openPermissionsModal(id, displayName(member)));
  $("#staff-report")?.addEventListener("click", async () => {
    const reason = window.prompt(`Reason for reporting ${displayName(member)}:`, "");
    if (reason === null) return;
    if (!reason.trim()) { showToast("A reason is required to report a staff account.", "error"); return; }
    try {
      await api(`/staff/${id}/report`, { method: "PUT", body: { reason: reason.trim() } });
      showToast("Staff account reported.", "success");
      viewStaff(id);
      loadStaff();
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  $("#staff-unreport")?.addEventListener("click", async () => {
    try {
      await api(`/staff/${id}/unreport`, { method: "PUT" });
      showToast("Report cleared.", "success");
      viewStaff(id);
      loadStaff();
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  $("#staff-delete")?.addEventListener("click", async () => {
    if (!window.confirm(`Delete ${displayName(member)}'s account? This cannot be undone.`)) return;
    try {
      await api(`/staff/${id}`, { method: "DELETE" });
      showToast("Staff account deleted.", "success");
      closeModal();
      loadStaff();
    } catch (error) {
      showToast(error.message, "error");
    }
  });
}

async function toggleStaffActive(id, currentlyActive) {
  try {
    await api(`/staff/${id}`, { method: "PUT", body: { isActive: !currentlyActive } });
    showToast(`Staff account ${currentlyActive ? "deactivated" : "activated"}.`, "success");
    loadStaff();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function reportStaff(id, name) {
  const reason = window.prompt(`Reason for reporting ${name}:`, "");
  if (reason === null) return;
  if (!reason.trim()) { showToast("A reason is required to report a staff account.", "error"); return; }
  try {
    await api(`/staff/${id}/report`, { method: "PUT", body: { reason: reason.trim() } });
    showToast("Staff account reported.", "success");
    loadStaff();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function unreportStaff(id) {
  try {
    await api(`/staff/${id}/unreport`, { method: "PUT" });
    showToast("Report cleared.", "success");
    loadStaff();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function resetStaffPassword(id) {
  const newPassword = window.prompt("New password (min 8 characters):");
  if (newPassword === null) return;
  if (newPassword.length < 8) {
    showToast("Password must be at least 8 characters.", "error");
    return;
  }
  try {
    await api(`/staff/${id}/password`, { method: "PUT", body: { newPassword } });
    showToast("Password updated.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteStaff(id, name) {
  if (!window.confirm(`Delete ${name}'s account? This cannot be undone.`)) return;
  try {
    await api(`/staff/${id}`, { method: "DELETE" });
    showToast("Staff account deleted.", "success");
    loadStaff();
  } catch (error) {
    showToast(error.message, "error");
  }
}

const SECTION_LABELS = {
  verifications: "Shopper verifications",
  orders: "Orders",
  payments: "Payments",
  subscriptions: "Subscriptions",
  settings: "Settings",
  staff: "Staff",
  approvals: "Approvals",
  activity_log: "Activity report"
};

async function openPermissionsModal(id, name) {
  const { sections } = await api(`/staff/${id}/permissions`);
  openModal(`
    <h3>Permissions</h3>
    <p class="muted">Sections ${escapeHtml(name)} can access.</p>
    <div class="permissions-grid">
      ${Object.keys(SECTION_LABELS).map((section) => `
        <label class="checkbox-row"><input type="checkbox" data-permission="${section}" ${sections[section] ? "checked" : ""} /> ${escapeHtml(SECTION_LABELS[section])}</label>
      `).join("")}
    </div>
    <div class="modal-actions">
      <button class="primary-button" id="save-permissions">Save</button>
      <button class="ghost-button" data-close-modal>Cancel</button>
    </div>
  `);
  $("#save-permissions").addEventListener("click", () => savePermissions(id));
}

async function savePermissions(id) {
  const sections = {};
  $$("[data-permission]").forEach((input) => { sections[input.dataset.permission] = input.checked; });
  try {
    await api(`/staff/${id}/permissions`, { method: "PUT", body: { sections } });
    showToast("Permissions updated.", "success");
    closeModal();
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---- Activity report ----

let loadedActivity = [];

let activitySearchTimer;
$("#activity-search").addEventListener("input", () => {
  clearTimeout(activitySearchTimer);
  activitySearchTimer = setTimeout(loadActivity, 300);
});
$("#activity-filter-apply").addEventListener("click", loadActivity);
$("#activity-refresh").addEventListener("click", loadActivity);
$("#activity-actor-type").addEventListener("change", loadActivity);
$("#activity-export-csv").addEventListener("click", exportActivityCsv);
$("#activity-print").addEventListener("click", () => window.print());

async function loadActivity() {
  const body = $("#activity-body");
  body.innerHTML = `<tr><td colspan="5">Loading…</td></tr>`;
  const params = new URLSearchParams();
  const search = $("#activity-search").value.trim();
  const actor = $("#activity-actor").value.trim();
  const action = $("#activity-action").value.trim();
  const from = $("#activity-from").value;
  const to = $("#activity-to").value;
  const actorType = $("#activity-actor-type").value;
  if (search) params.set("search", search);
  if (actor) params.set("actor", actor);
  if (action) params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (actorType) params.set("actorType", actorType);
  try {
    const { activity } = await api(`/activity-log${params.toString() ? `?${params}` : ""}`);
    loadedActivity = activity;
    if (activity.length === 0) {
      body.innerHTML = "";
      $("#activity-empty").hidden = false;
      return;
    }
    $("#activity-empty").hidden = true;
    body.innerHTML = activity.map((entry) => `
      <tr>
        <td>${dateTime(entry.created_at)}</td>
        <td class="cell-strong">${escapeHtml(entry.actor_name || "System")} <span class="status-pill status-${entry.actor_type || "staff"}">${escapeHtml(entry.actor_type || "staff")}</span></td>
        <td>${escapeHtml(entry.action.replace(/_/g, " "))}</td>
        <td>${entry.target_type ? `${escapeHtml(entry.target_type)}${entry.target_id ? ` #${entry.target_id}` : ""}` : "-"}</td>
        <td class="activity-details">${entry.details ? escapeHtml(JSON.stringify(entry.details)) : "-"}</td>
      </tr>
    `).join("");
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
}

function exportActivityCsv() {
  if (loadedActivity.length === 0) { showToast("Nothing to export — load some activity first.", "error"); return; }
  const header = ["timestamp", "actor", "action", "target", "details"];
  const csvEscape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = loadedActivity.map((entry) => [
    entry.created_at ? new Date(entry.created_at).toISOString() : "",
    entry.actor_name || "System",
    entry.action,
    entry.target_type ? `${entry.target_type}${entry.target_id ? ` #${entry.target_id}` : ""}` : "",
    entry.details ? JSON.stringify(entry.details) : ""
  ].map(csvEscape).join(","));
  const csv = [header.join(","), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---- Settings ----

const SETTINGS_META = {
  usd_to_ngn_rate: { label: "USD to NGN exchange rate", hint: "Used for bank transfer conversion." },
  address_subscription_price_usd: { label: "Address subscription price (USD/month)", hint: "Monthly price for the dedicated U.S. address plan." },
  bank_transfer_account_name: { label: "Bank account name", hint: "Shown to shoppers paying by bank transfer." },
  bank_transfer_account_number: { label: "Bank account number", hint: "Shown to shoppers paying by bank transfer." },
  bank_transfer_bank_name: { label: "Bank name", hint: "Shown to shoppers paying by bank transfer." },
  quality_inspection_fee_usd: { label: "Quality inspection fee (USD)", hint: "Flat fee charged when a shopper opts into the photo-verified quality check." },
  follow_up_charge_percent: { label: "Follow-up charge (% of item cost)", hint: "Automatically charged as a second payment once an order's main payment is confirmed." },
  freight_air_rate_per_lb: { label: "Standard air rate (USD/lb)", hint: "Drives the order calculator's Standard air shipping option." },
  freight_air_min_usd: { label: "Standard air minimum charge (USD)", hint: "Floor applied when weight-based cost falls below this." },
  freight_express_rate_per_lb: { label: "Express air rate (USD/lb)", hint: "Drives the order calculator's Express air shipping option." },
  freight_express_min_usd: { label: "Express air minimum charge (USD)", hint: "Floor applied when weight-based cost falls below this." },
  freight_sea_rate_per_lb: { label: "Sea freight rate (USD/lb)", hint: "Drives the order calculator's Sea freight shipping option." },
  freight_sea_min_usd: { label: "Sea freight minimum charge (USD)", hint: "Floor applied when weight-based cost falls below this." }
};

async function loadSettings() {
  const grid = $("#settings-grid");
  grid.innerHTML = "Loading…";
  try {
    const { settings } = await api("/settings");
    grid.innerHTML = settings.map((setting) => {
      const meta = SETTINGS_META[setting.key] || { label: setting.key, hint: "" };
      return `
        <div class="setting-card">
          <label for="setting-${setting.key}">${escapeHtml(meta.label)}</label>
          <div class="setting-row">
            <input id="setting-${setting.key}" value="${escapeAttr(setting.value)}" />
            <button class="ghost-button" data-save-setting="${setting.key}">Save</button>
          </div>
          ${meta.hint ? `<small>${escapeHtml(meta.hint)}</small>` : ""}
        </div>
      `;
    }).join("");
    $$("[data-save-setting]", grid).forEach((button) =>
      button.addEventListener("click", () => saveSetting(button.dataset.saveSetting)));
  } catch (error) {
    grid.innerHTML = `<p>Failed to load settings: ${escapeHtml(error.message)}</p>`;
  }
}

async function saveSetting(key) {
  const value = $(`#setting-${key}`).value.trim();
  try {
    await api(`/settings/${key}`, { method: "PUT", body: { value } });
    showToast("Setting saved.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---- Utilities ----

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

checkSession();
