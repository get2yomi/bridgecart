// One-off script: copies each legacy order's single screenshot into the new order-item-images upload
// directory (preserving the original filename) and records it as that order's first order_items row's first
// order_item_images row. Safe to re-run — every order/screenshot pair is skipped if an order_item_images row
// for that order_item already exists, and the file copy is skipped if the destination file already exists.
//
// Run once after `npm run migrate`:
//   node scripts/migrateOrderImages.mjs
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.join(__dirname, "..", "uploads");
const SCREENSHOTS_DIR = path.join(UPLOAD_ROOT, "screenshots");
const ITEM_IMAGES_DIR = path.join(UPLOAD_ROOT, "order-item-images");

async function main() {
  await fs.mkdir(ITEM_IMAGES_DIR, { recursive: true });

  const { rows: orders } = await pool.query(
    `SELECT o.id AS order_id, o.screenshot_path
     FROM orders o
     WHERE o.screenshot_path IS NOT NULL`
  );

  let copied = 0;
  let skippedNoFile = 0;
  let skippedAlreadyMigrated = 0;
  let skippedNoOrderItem = 0;

  for (const order of orders) {
    const filename = path.basename(order.screenshot_path);
    const sourcePath = path.join(SCREENSHOTS_DIR, filename);

    // The order's first (oldest) order_items row is the one the legacy single-item columns became.
    const { rows: itemRows } = await pool.query(
      "SELECT id FROM order_items WHERE order_id = $1 ORDER BY id ASC LIMIT 1",
      [order.order_id]
    );
    const orderItemId = itemRows[0]?.id;
    if (!orderItemId) {
      skippedNoOrderItem++;
      continue;
    }

    const { rows: existingImages } = await pool.query(
      "SELECT 1 FROM order_item_images WHERE order_item_id = $1 AND file_path = $2",
      [orderItemId, filename]
    );
    if (existingImages.length > 0) {
      skippedAlreadyMigrated++;
      continue;
    }

    try {
      await fs.access(sourcePath);
    } catch {
      console.warn(`Order #${order.order_id}: screenshot file not found on disk (${sourcePath}) — skipping.`);
      skippedNoFile++;
      continue;
    }

    const destPath = path.join(ITEM_IMAGES_DIR, filename);
    try {
      await fs.access(destPath);
    } catch {
      await fs.copyFile(sourcePath, destPath);
    }

    await pool.query(
      "INSERT INTO order_item_images (order_item_id, file_path) VALUES ($1, $2)",
      [orderItemId, filename]
    );
    copied++;
  }

  console.log(`Image migration complete. Copied: ${copied}, already migrated: ${skippedAlreadyMigrated}, missing source file: ${skippedNoFile}, no order_items row: ${skippedNoOrderItem}.`);
  await pool.end();
}

main().catch((error) => {
  console.error("Image migration failed:", error);
  process.exit(1);
});
