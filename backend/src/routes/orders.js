import { Router } from "express";
import { query, pool } from "../db/pool.js";
import { requireVerifiedShopper } from "../middleware/auth.js";
import { upload } from "../upload.js";
import { calculateQuote } from "../quote.js";
import { getSetting, getFreightRates } from "../settings.js";
import { logActivity } from "../activityLog.js";

export const ordersRouter = Router();

// Groups req.files (from upload.any()) by the item index encoded in the field name (itemImages_0, itemImages_1, ...).
// The indexed-field-name approach (rather than one flat "itemImages" field + a separate counts array) is used
// because it's robust to reordering/removal in the frontend and avoids fragile count-matching between a JSON
// field and a flat file list.
function groupImagesByItemIndex(files) {
  const byIndex = new Map();
  for (const file of files || []) {
    const match = /^itemImages_(\d+)$/.exec(file.fieldname);
    if (!match) continue;
    const index = Number(match[1]);
    if (!byIndex.has(index)) byIndex.set(index, []);
    byIndex.get(index).push(file);
  }
  return byIndex;
}

function parseItemsField(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

ordersRouter.post("/", requireVerifiedShopper, upload.any(), async (req, res) => {
  const {
    speed, taxRate, freeStoreShipping, storeShipping, insurance, qualityInspection,
    recipientName, recipientPhone, shippingStreetAddress, shippingCity, shippingState
  } = req.body;
  const wantsQualityInspection = qualityInspection === "true" || qualityInspection === true;

  const rawItems = parseItemsField(req.body.items);
  if (!rawItems || rawItems.length === 0) {
    return res.status(400).json({ error: "At least one item is required." });
  }

  const items = rawItems.map((item) => ({
    productUrl: (item.productUrl || "").trim() || null,
    itemTitle: (item.itemTitle || "").trim() || null,
    price: Number(item.price),
    quantity: Number(item.quantity) || 1,
    weight: Number(item.weight) || 0.2,
    category: item.category,
    colorVariant: (item.colorVariant || "").trim() || null,
    description: (item.description || "").trim() || null
  }));

  for (const item of items) {
    if (!Number.isFinite(item.price) || item.price <= 0) {
      return res.status(400).json({ error: "Each item requires a valid price." });
    }
  }

  const imagesByIndex = groupImagesByItemIndex(req.files);

  const shopperResult = await query(
    "SELECT first_name, last_name, phone, street_address, city, state FROM shoppers WHERE id = $1",
    [req.session.shopperId]
  );
  const shopper = shopperResult.rows[0];

  // Recipient/shipping details default to the shopper's own registered info unless the order overrides them
  // (e.g. gifting to someone else at a different address).
  const resolvedRecipientName = (recipientName && recipientName.trim()) || `${shopper.first_name} ${shopper.last_name}`.trim();
  const resolvedRecipientPhone = (recipientPhone && recipientPhone.trim()) || shopper.phone || null;
  const resolvedStreetAddress = (shippingStreetAddress && shippingStreetAddress.trim()) || shopper.street_address || null;
  const resolvedCity = (shippingCity && shippingCity.trim()) || shopper.city || null;
  const resolvedState = (shippingState && shippingState.trim()) || shopper.state || null;

  let quote;
  try {
    const qualityInspectionFee = wantsQualityInspection ? Number(await getSetting("quality_inspection_fee_usd")) || 0 : 0;
    const freightRates = await getFreightRates();
    quote = calculateQuote({
      items: items.map((item) => ({ price: item.price, quantity: item.quantity, weight: item.weight, category: item.category })),
      speed,
      taxRate: Number(taxRate) || 0,
      freeStoreShipping: freeStoreShipping === "true" || freeStoreShipping === true,
      storeShipping: Number(storeShipping) || 0,
      insurance: insurance === "true" || insurance === true,
      qualityInspection: wantsQualityInspection,
      qualityInspectionFee,
      freightRates
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO orders (
         shopper_id, shipping_speed, quote_breakdown, quote_total_usd, quality_inspection_requested,
         items_subtotal_usd, items_tax_usd, items_duty_usd,
         recipient_name, recipient_phone, shipping_street_address, shipping_city, shipping_state
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, status, quote_total_usd, created_at`,
      [
        req.session.shopperId,
        speed,
        JSON.stringify(quote.breakdown),
        quote.total,
        wantsQualityInspection,
        quote.breakdown.itemsSubtotal,
        quote.breakdown.itemsTax,
        quote.breakdown.itemsDuty,
        resolvedRecipientName || null,
        resolvedRecipientPhone,
        resolvedStreetAddress,
        resolvedCity,
        resolvedState
      ]
    );
    order = inserted.rows[0];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const computed = quote.perItem[i];
      const itemInserted = await client.query(
        `INSERT INTO order_items (
           order_id, product_url, item_title, price_usd, quantity, weight_lb, category, color_variant, description,
           item_subtotal_usd, item_tax_usd, item_duty_usd
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          order.id, item.productUrl, item.itemTitle, item.price, item.quantity, item.weight, item.category,
          item.colorVariant, item.description, computed.subtotal, computed.tax, computed.duty
        ]
      );
      const orderItemId = itemInserted.rows[0].id;

      const files = imagesByIndex.get(i) || [];
      for (const file of files) {
        await client.query(
          "INSERT INTO order_item_images (order_item_id, file_path) VALUES ($1, $2)",
          [orderItemId, file.filename]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await logActivity({
    actorType: "shopper", actorId: req.session.shopperId, actorName: null,
    action: "shopper_submitted_order", targetType: "order", targetId: order.id
  });

  res.status(201).json({ order });
});

async function attachItemsToOrders(orders) {
  if (orders.length === 0) return orders;
  const orderIds = orders.map((o) => o.id);
  const itemsResult = await query(
    `SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY id ASC`,
    [orderIds]
  );
  const itemIds = itemsResult.rows.map((i) => i.id);
  const imagesResult = itemIds.length
    ? await query(`SELECT * FROM order_item_images WHERE order_item_id = ANY($1) ORDER BY id ASC`, [itemIds])
    : { rows: [] };

  const imagesByItem = new Map();
  for (const image of imagesResult.rows) {
    if (!imagesByItem.has(image.order_item_id)) imagesByItem.set(image.order_item_id, []);
    imagesByItem.get(image.order_item_id).push({
      id: image.id,
      url: `/api/account/order-items/${image.order_item_id}/image/${image.id}`
    });
  }

  const itemsByOrder = new Map();
  for (const item of itemsResult.rows) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    itemsByOrder.get(item.order_id).push({ ...item, images: imagesByItem.get(item.id) || [] });
  }

  return orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) || [] }));
}

ordersRouter.get("/mine", requireVerifiedShopper, async (req, res) => {
  const result = await query(
    `SELECT id, quote_total_usd, status, created_at,
            tracking_number, estimated_delivery_date, delivered_date, refund_status,
            recipient_name, recipient_phone, shipping_street_address, shipping_city, shipping_state,
            customs_fee_ngn, customs_fee_status
     FROM orders WHERE shopper_id = $1 ORDER BY created_at DESC`,
    [req.session.shopperId]
  );
  const orders = await attachItemsToOrders(result.rows);
  res.json({ orders });
});

ordersRouter.get("/:id", requireVerifiedShopper, async (req, res) => {
  const result = await query(
    "SELECT * FROM orders WHERE id = $1 AND shopper_id = $2",
    [req.params.id, req.session.shopperId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  const [order] = await attachItemsToOrders(result.rows);
  res.json({ order });
});

ordersRouter.get("/:id/updates", requireVerifiedShopper, async (req, res) => {
  const order = await query("SELECT id FROM orders WHERE id = $1 AND shopper_id = $2", [req.params.id, req.session.shopperId]);
  if (order.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  const result = await query(
    "SELECT id, message, author_type, created_at FROM order_updates WHERE order_id = $1 AND visible_to_shopper = true ORDER BY created_at ASC",
    [req.params.id]
  );
  res.json({ updates: result.rows });
});
