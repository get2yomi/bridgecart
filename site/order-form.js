/* ---------------------------------------------------------------------
   Shared multi-item order calculator + submission engine.

   Both site/index.html (public quote calculator) and site/account.html
   (logged-in shopper's embedded "submit a new order" form) render their
   own copy of the calculator markup (the item-block template, the
   items-container, the shipping-level fields, and the quote breakdown
   card) — a calculator needs its inputs to exist in the DOM of whichever
   page hosts it. This module is the ONE place the behavior behind that
   markup lives: item add/remove, per-item Microlink auto-detect, per-item
   multi-image upload, live price-breakdown math, and building the
   multipart FormData submitted to POST /api/orders. Both pages call
   createOrderForm() against their own container/element ids; a bug fix
   here fixes both pages at once.

   createOrderForm() does NOT own "what happens when the shopper wants to
   check out" — index.html needs a login/verification gate + a separate
   delivery-address modal before submitting, while account.html (shopper
   already logged in and on their own dashboard) submits directly. That
   difference stays in each page's own script; this module just exposes
   submitOrder() for the caller to invoke once it's decided the shopper
   may proceed, plus hooks for validation/success/error.
------------------------------------------------------------------------ */

function $(selector, scope = document) { return scope.querySelector(selector); }
function $$(selector, scope = document) { return [...scope.querySelectorAll(selector)]; }

const CATEGORY_DUTY = { electronics: 0.095, fashion: 0.14, beauty: 0.16, home: 0.11, auto: 0.12, other: 0.13 };
const FREIGHT = {
  air: { rate: 8.75, min: 25, window: "7–12 business days" },
  express: { rate: 13.5, min: 38, window: "3–6 business days" },
  sea: { rate: 2.8, min: 18, window: "4–8 weeks" }
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_ITEM = 6;

function number(el, fallback = 0) {
  const value = Number(el?.value);
  return Number.isFinite(value) ? value : fallback;
}

// Mirrors backend/src/quote.js exactly (client-side duplicate for instant feedback; the server recomputes
// authoritatively on submit).
function calculateQuoteClient({ items, taxRate, freeStoreShipping, storeShipping, insurance, qualityInspection, qualityInspectionFee, speed }) {
  const safeTaxRate = Math.max(0, taxRate || 0);
  const usDelivery = freeStoreShipping ? 0 : Math.max(0, storeShipping || 0);

  const itemsSubtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalWeight = items.reduce((sum, item) => sum + item.weight * item.quantity, 0);
  const shipping = Math.max(totalWeight * FREIGHT[speed].rate, FREIGHT[speed].min);

  const perItem = items.map((item) => {
    const subtotal = item.price * item.quantity;
    const tax = subtotal * (safeTaxRate / 100);
    const usDeliveryShare = itemsSubtotal > 0 ? usDelivery * (subtotal / itemsSubtotal) : 0;
    const duty = (subtotal + tax + usDeliveryShare) * (CATEGORY_DUTY[item.category] || 0);
    return { subtotal, tax, duty };
  });

  const itemsTax = perItem.reduce((sum, item) => sum + item.tax, 0);
  const itemsDuty = perItem.reduce((sum, item) => sum + item.duty, 0);
  const insuranceAmount = insurance ? itemsSubtotal * 0.015 : 0;
  const qualityInspectionAmount = qualityInspection ? qualityInspectionFee : 0;
  const service = Math.max(itemsSubtotal * 0.075, 10);
  const total = itemsSubtotal + itemsTax + usDelivery + shipping + itemsDuty + insuranceAmount + qualityInspectionAmount + service;

  return {
    perItem,
    breakdown: { itemsSubtotal, itemsTax, usDelivery, shipping, itemsDuty, insurance: insuranceAmount, qualityInspection: qualityInspectionAmount, service },
    total
  };
}

/**
 * @param {Object} config
 * @param {HTMLElement} config.root - container that holds #quote-form, #items-container, the item-block
 *   <template>, and the quote-card breakdown elements, all scoped under this root.
 * @param {() => void} [config.onChange] - called after every recalculation (state.total/state.lines updated).
 * @param {(message: string) => void} [config.onSubmitError]
 * @param {(order: object) => void} [config.onSubmitSuccess]
 */
export function createOrderForm(config) {
  const root = config.root;
  const state = { currency: "usd", fx: 1650, total: 0, lines: {}, qualityInspectionFee: 15 };
  const itemImageFiles = new Map(); // item block element -> File[]

  function q(selector) { return $(selector, root); }
  function qq(selector) { return $$(selector, root); }

  function money(value) {
    if (state.currency === "ngn") {
      return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(value * state.fx);
    }
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  }

  function itemBlocks() {
    return $$("[data-item-block]", q("#items-container"));
  }

  function readItem(block) {
    return {
      productUrl: $("[data-field='productUrl']", block).value.trim(),
      itemTitle: block.dataset.itemTitle || "",
      price: Math.max(0, number($("[data-field='price']", block))),
      quantity: Math.max(1, number($("[data-field='quantity']", block), 1)),
      weight: Math.max(0.2, number($("[data-field='weight']", block), 0.2)),
      category: $("[data-field='category']", block).value,
      colorVariant: $("[data-field='colorVariant']", block).value.trim(),
      description: $("[data-field='description']", block).value.trim()
    };
  }

  function calculate() {
    const items = itemBlocks().map(readItem);
    const speed = q("input[name='speed']:checked").value;
    const freeStoreShipping = q("#free-store-shipping").checked;

    const quote = calculateQuoteClient({
      items,
      taxRate: number(q("#tax-rate"), 7),
      freeStoreShipping,
      storeShipping: number(q("#store-shipping")),
      insurance: q("#insurance").checked,
      qualityInspection: q("#quality-inspection").checked,
      qualityInspectionFee: state.qualityInspectionFee,
      speed
    });

    state.total = quote.total;
    state.lines = quote.breakdown;
    const deliveryWindowEl = q("#delivery-window");
    if (deliveryWindowEl) deliveryWindowEl.textContent = `Arrives in Nigeria in ${FREIGHT[speed].window}`;
    render();
    if (config.onChange) config.onChange();
  }

  function render() {
    const l = state.lines;
    q("#grand-total").textContent = money(state.total);
    const modalTotal = q("#modal-total");
    if (modalTotal) modalTotal.textContent = money(state.total);
    q("#subtotal-line").textContent = money(l.itemsSubtotal || 0);
    q("#tax-line").textContent = money(l.itemsTax || 0);
    const deliveryLine = q("#us-delivery-line");
    deliveryLine.textContent = q("#free-store-shipping").checked ? "FREE" : money(l.usDelivery || 0);
    deliveryLine.classList.toggle("free-value", q("#free-store-shipping").checked);
    q("#shipping-line").textContent = money(l.shipping || 0);
    q("#duty-line").textContent = money(l.itemsDuty || 0);
    q("#insurance-line").textContent = money(l.insurance || 0);
    q("#quality-inspection-line").textContent = money(l.qualityInspection || 0);
    q("#service-line").textContent = money(l.service || 0);
  }

  function detectStore(block, rawUrl) {
    const box = $("[data-detected-store]", block);
    const message = $("[data-url-message]", block);
    if (!rawUrl) { box.hidden = true; message.textContent = "Links from any online store are accepted. Some stores may require manual verification."; return false; }
    try {
      const url = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
      const host = url.hostname.replace("www.", "");
      const stores = [
        ["amazon", "Amazon", "A"], ["walmart", "Walmart", "W"], ["ebay", "eBay", "e"],
        ["bestbuy", "Best Buy", "B"], ["apple", "Apple", "A"], ["nike", "Nike", "N"]
      ];
      const match = stores.find(([key]) => host.includes(key));
      $("[data-store-name]", block).textContent = match ? `${match[1]} detected` : `${host} detected`;
      $("[data-store-icon]", block).textContent = match ? match[2] : host.charAt(0).toUpperCase();
      box.hidden = false;
      message.textContent = "Link accepted. Select “Get item details” to check the retailer.";
      return true;
    } catch {
      box.hidden = true;
      message.textContent = "Please enter a complete product link.";
      return false;
    }
  }

  function renumberItemBlocks() {
    const blocks = itemBlocks();
    blocks.forEach((block, index) => {
      $("[data-item-number]", block).textContent = `Item ${index + 1}`;
      const removeButton = $("[data-remove-item]", block);
      removeButton.hidden = blocks.length <= 1;
    });
  }

  function setImageInvalid(block, isInvalid) {
    $("[data-image-upload]", block).classList.toggle("invalid", isInvalid);
    $("[data-image-message]", block).hidden = !isInvalid;
  }

  function hasRequiredImages(block) {
    return (itemImageFiles.get(block) || []).length > 0;
  }

  function renderImagePreviews(block) {
    const files = itemImageFiles.get(block) || [];
    const grid = $("[data-image-preview-grid]", block);
    grid.innerHTML = "";
    grid.hidden = files.length === 0;
    files.forEach((file, index) => {
      const tile = document.createElement("div");
      tile.className = "screenshot-preview-tile";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.setAttribute("aria-label", "Remove this photo");
      removeButton.textContent = "×";
      removeButton.addEventListener("click", () => {
        const current = itemImageFiles.get(block) || [];
        current.splice(index, 1);
        itemImageFiles.set(block, current);
        renderImagePreviews(block);
        if (current.length === 0) setImageInvalid(block, false);
      });
      tile.appendChild(img);
      tile.appendChild(removeButton);
      grid.appendChild(tile);
    });
  }

  function wireItemBlock(block) {
    $$("input, select", block).forEach((control) => control.addEventListener("input", calculate));

    const urlInput = $("[data-field='productUrl']", block);
    urlInput.addEventListener("input", (event) => detectStore(block, event.target.value.trim()));

    $("[data-paste-button]", block).addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        urlInput.value = text;
        detectStore(block, text.trim());
      } catch {
        urlInput.focus();
        $("[data-url-message]", block).textContent = "Paste the product link here.";
      }
    });

    $("[data-analyze-link]", block).addEventListener("click", async () => {
      const rawUrl = urlInput.value.trim();
      if (!detectStore(block, rawUrl)) { urlInput.focus(); return; }
      const button = $("[data-analyze-link]", block);
      button.disabled = true;
      button.textContent = "Checking retailer…";
      $("[data-store-status]", block).textContent = "Checking public product information and delivery terms…";
      try {
        const response = await fetch(`/api/product?url=${encodeURIComponent(rawUrl)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to retrieve this product");

        if (Number.isFinite(data.price) && data.price > 0) {
          $("[data-field='price']", block).value = data.price.toFixed(2);
        }
        if (data.freeShipping === true) {
          q("#free-store-shipping").checked = true;
          q("#store-shipping").value = "0.00";
          q("#store-shipping").disabled = true;
        } else if (Number.isFinite(data.shippingCost)) {
          q("#free-store-shipping").checked = false;
          q("#store-shipping").disabled = false;
          q("#store-shipping").value = data.shippingCost.toFixed(2);
        }
        calculate();

        const found = Number.isFinite(data.price) && data.price > 0;
        const preview = $("[data-product-preview]", block);
        preview.hidden = false;
        block.dataset.itemTitle = data.title || "";
        $("[data-product-title]", block).textContent = data.title || "Product title unavailable";
        $("[data-product-price]", block).textContent = found ? `${data.currency || "USD"} ${data.price.toFixed(2)}` : "Enter manually";
        $("[data-product-delivery]", block).textContent = data.freeShipping === true
          ? "FREE"
          : Number.isFinite(data.shippingCost) ? `${data.currency || "USD"} ${data.shippingCost.toFixed(2)}` : "Confirm at checkout";
        const image = $("[data-product-image]", block);
        if (data.image) {
          image.src = data.image;
          image.alt = data.title ? `${data.title} product image` : "Retrieved product image";
          image.onerror = () => { image.removeAttribute("src"); };
        } else {
          image.removeAttribute("src");
        }
        $("[data-store-status]", block).textContent = found
          ? `${data.title || "Product"} — price retrieved${data.freeShipping === true ? ", with free store shipping" : ""}.`
          : `${data.title || "Product found"} — image and title retrieved through Microlink; enter the store price manually.`;
        $("[data-url-message]", block).textContent = found
          ? "Live item details retrieved. Please verify before payment."
          : "Microlink found the product, but this retailer did not expose its current price.";
      } catch (error) {
        $("[data-product-preview]", block).hidden = true;
        $("[data-store-status]", block).textContent = error.message || "This retailer blocked automatic access. Enter the item details manually.";
        $("[data-url-message]", block).textContent = "The link is valid, but manual price confirmation is required.";
      } finally {
        button.disabled = false;
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></svg> Check again';
      }
    });

    const imageInput = $("[data-image-input]", block);
    imageInput.addEventListener("change", (event) => {
      const incoming = [...(event.target.files || [])];
      event.target.value = "";
      if (incoming.length === 0) return;

      const current = itemImageFiles.get(block) || [];
      for (const file of incoming) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
          $("[data-url-message]", block).textContent = "Please upload PNG, JPG, or WEBP images only.";
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          $("[data-url-message]", block).textContent = "One of those images is too large. Please upload files under 8MB.";
          continue;
        }
        if (current.length >= MAX_IMAGES_PER_ITEM) {
          $("[data-url-message]", block).textContent = `You can attach up to ${MAX_IMAGES_PER_ITEM} photos per item.`;
          break;
        }
        current.push(file);
      }
      itemImageFiles.set(block, current);
      renderImagePreviews(block);
      if (current.length > 0) setImageInvalid(block, false);
    });

    $("[data-remove-item]", block).addEventListener("click", () => {
      if (itemBlocks().length <= 1) return;
      itemImageFiles.delete(block);
      block.remove();
      renumberItemBlocks();
      calculate();
    });
  }

  function addItemBlock() {
    const template = q("#item-block-template");
    const fragment = template.content.cloneNode(true);
    const block = fragment.querySelector("[data-item-block]");
    itemImageFiles.set(block, []);
    q("#items-container").appendChild(block);
    wireItemBlock(block);
    renumberItemBlocks();
    return block;
  }

  // ---- Validation + payload building (shared submission contract with backend/src/routes/orders.js) ----

  function firstBlockMissingImages() {
    return itemBlocks().find((block) => !hasRequiredImages(block));
  }

  function flagMissingImages(block) {
    setImageInvalid(block, true);
    $("[data-image-upload]", block).scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function currentItemsPayload() {
    return itemBlocks().map((block) => {
      const item = readItem(block);
      return {
        productUrl: item.productUrl || null,
        itemTitle: item.itemTitle || null,
        price: item.price,
        quantity: item.quantity,
        weight: item.weight,
        category: item.category,
        colorVariant: item.colorVariant || null,
        description: item.description || null
      };
    });
  }

  function currentShippingPayload() {
    return {
      speed: q("input[name='speed']:checked").value,
      taxRate: Math.max(0, number(q("#tax-rate"), 7)),
      freeStoreShipping: q("#free-store-shipping").checked,
      storeShipping: Math.max(0, number(q("#store-shipping"))),
      insurance: q("#insurance").checked,
      qualityInspection: q("#quality-inspection").checked
    };
  }

  // Builds the exact multipart contract backend/src/routes/orders.js's POST / expects: a JSON `items` field,
  // shipping-level scalar fields, per-item image files under itemImages_<index> (see upload.js's
  // ITEM_IMAGES_FIELD_PREFIX), and optional recipient/shipping override fields.
  function buildOrderFormData(overrides = {}) {
    const formData = new FormData();
    const shipping = currentShippingPayload();
    Object.entries(shipping).forEach(([key, value]) => formData.append(key, value));
    formData.append("items", JSON.stringify(currentItemsPayload()));
    itemBlocks().forEach((block, index) => {
      const files = itemImageFiles.get(block) || [];
      files.forEach((file) => formData.append(`itemImages_${index}`, file));
    });
    Object.entries(overrides).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") formData.append(key, value);
    });
    return formData;
  }

  async function submitOrder(overrides = {}) {
    const missingImages = firstBlockMissingImages();
    if (missingImages) {
      flagMissingImages(missingImages);
      throw new Error("Please attach at least one photo for every item before submitting.");
    }
    const formData = buildOrderFormData(overrides);
    const response = await fetch("/api/orders", { method: "POST", body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    if (config.onSubmitSuccess) config.onSubmitSuccess(data.order);
    return data.order;
  }

  // Removes every item block's images and resets the form back to a single blank item — used after a
  // successful inline submission (account.html) so the collapsed form is clean if reopened.
  function resetForm() {
    q("#quote-form").reset();
    itemBlocks().forEach((block) => itemImageFiles.delete(block));
    q("#items-container").innerHTML = "";
    addItemBlock();
    q("#free-store-shipping").checked = true;
    q("#store-shipping").disabled = true;
    q("#store-shipping").value = "0.00";
    qq(".shipping-option").forEach((option, index) => option.classList.toggle("active", index === 0));
    calculate();
  }

  // ---- Wiring (page-independent controls that live inside root) ----

  q("#add-item-button").addEventListener("click", () => {
    addItemBlock();
    calculate();
  });

  // Every order must have at least one item.
  addItemBlock();

  qq(".shipping-option input").forEach((radio) => radio.addEventListener("change", () => {
    qq(".shipping-option").forEach((option) => option.classList.toggle("active", option.contains(radio)));
    calculate();
  }));
  $$("#quote-form > .form-grid input, #quote-form > .form-grid select, #insurance, #quality-inspection", root).forEach((control) =>
    control.addEventListener("input", calculate));

  q("#free-store-shipping").addEventListener("change", (event) => {
    q("#store-shipping").disabled = event.target.checked;
    if (event.target.checked) q("#store-shipping").value = "0.00";
    calculate();
  });

  qq("[data-currency]").forEach((button) => button.addEventListener("click", () => {
    state.currency = button.dataset.currency;
    qq("[data-currency]").forEach((item) => item.classList.toggle("active", item === button));
    render();
  }));

  calculate();

  async function loadQualityInspectionFee() {
    try {
      const response = await fetch("/api/settings/quality-inspection-fee");
      const data = await response.json();
      if (Number.isFinite(data.qualityInspectionFeeUsd)) {
        state.qualityInspectionFee = data.qualityInspectionFeeUsd;
        const label = q("#quality-inspection-fee-label");
        if (label) label.textContent = `$${data.qualityInspectionFeeUsd.toFixed(2).replace(/\.00$/, "")}`;
        calculate();
      }
    } catch {
      /* keep the default fee shown if this fails */
    }
  }
  loadQualityInspectionFee();

  return {
    state,
    calculate,
    money,
    itemBlocks,
    hasRequiredImages,
    firstBlockMissingImages,
    flagMissingImages,
    currentItemsPayload,
    currentShippingPayload,
    buildOrderFormData,
    submitOrder,
    resetForm
  };
}
