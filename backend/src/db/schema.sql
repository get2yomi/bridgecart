-- NaijaBridge backend schema

CREATE TABLE IF NOT EXISTS shoppers (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  payer_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone TEXT,
  shopper_code TEXT NOT NULL UNIQUE,
  id_type TEXT NOT NULL,
  id_number TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'approved', 'rejected')),
  verification_notes TEXT,
  verified_at TIMESTAMPTZ,
  verified_by TEXT,
  us_address_line TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS id_documents (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  product_url TEXT,
  screenshot_path TEXT NOT NULL,
  item_title TEXT,
  item_price_usd NUMERIC(12,2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  weight_lb NUMERIC(10,2) NOT NULL,
  category TEXT NOT NULL,
  shipping_speed TEXT NOT NULL,
  quote_breakdown JSONB NOT NULL,
  quote_total_usd NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_confirmation'
    CHECK (status IN ('pending_confirmation', 'confirmed', 'awaiting_payment', 'paid', 'purchased', 'shipped', 'delivered', 'rejected', 'cancelled')),
  admin_notes TEXT,
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  subscription_id INTEGER,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('card', 'bank_transfer')),
  amount_usd NUMERIC(12,2) NOT NULL,
  exchange_rate NUMERIC(12,4) NOT NULL,
  amount_ngn NUMERIC(14,2) NOT NULL,
  reference_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected')),
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  plan_price_usd NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'active', 'expired', 'cancelled')),
  current_period_start DATE,
  current_period_end DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_subscription_fk'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_subscription_fk FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('usd_to_ngn_rate', '1650'),
  ('address_subscription_price_usd', '100'),
  ('bank_transfer_account_name', 'NaijaBridge Ltd'),
  ('bank_transfer_account_number', '0000000000'),
  ('bank_transfer_bank_name', 'Sample Bank'),
  ('quality_inspection_fee_usd', '15')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'owner';
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES admin_users(id);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE admin_users SET role = 'owner' WHERE role IS NULL;
UPDATE admin_users SET full_name = email WHERE full_name IS NULL;
ALTER TABLE admin_users ALTER COLUMN role SET DEFAULT 'staff';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_role_check'
  ) THEN
    ALTER TABLE admin_users
      ADD CONSTRAINT admin_users_role_check CHECK (role IN ('owner', 'supervisor', 'staff'));
  END IF;
END $$;

-- ---- Order tracking, delivery, and refund fields ----

ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_delivery_date DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_date DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount_usd NUMERIC(12,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_refund_status_check'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_refund_status_check CHECK (refund_status IN ('none', 'requested', 'approved', 'denied', 'refunded'));
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
  ALTER TABLE orders
    ADD CONSTRAINT orders_status_check CHECK (status IN (
      'pending_confirmation', 'confirmed', 'awaiting_payment', 'paid', 'purchased',
      'shipped', 'delivered', 'rejected', 'cancelled', 'refund_requested', 'refunded'
    ));
END $$;

CREATE TABLE IF NOT EXISTS order_updates (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('staff', 'system')),
  author_id INTEGER,
  author_name TEXT,
  message TEXT NOT NULL,
  visible_to_shopper BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id SERIAL PRIMARY KEY,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('shopper', 'order')),
  target_id INTEGER NOT NULL,
  requested_by INTEGER REFERENCES admin_users(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by INTEGER REFERENCES admin_users(id),
  decision_reason TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES admin_users(id),
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Per-section staff permissions ----

CREATE TABLE IF NOT EXISTS staff_permissions (
  staff_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  can_access BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (staff_id, section)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_permissions_section_check'
  ) THEN
    ALTER TABLE staff_permissions
      ADD CONSTRAINT staff_permissions_section_check CHECK (section IN (
        'verifications', 'orders', 'payments', 'subscriptions', 'settings', 'staff', 'approvals', 'activity_log'
      ));
  END IF;
END $$;

-- ---- First/last name split (shoppers + admin_users) ----
-- full_name/payer_name columns are kept in sync as a display-safety-net; the split columns are the source of truth going forward.

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS payer_first_name TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS payer_last_name TEXT;

UPDATE shoppers SET
  first_name = split_part(full_name, ' ', 1),
  last_name = CASE WHEN position(' ' in full_name) = 0 THEN '' ELSE trim(substring(full_name from position(' ' in full_name))) END
WHERE first_name IS NULL;

UPDATE shoppers SET
  payer_first_name = split_part(payer_name, ' ', 1),
  payer_last_name = CASE WHEN position(' ' in payer_name) = 0 THEN '' ELSE trim(substring(payer_name from position(' ' in payer_name))) END
WHERE payer_first_name IS NULL;

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_name TEXT;

UPDATE admin_users SET
  first_name = split_part(full_name, ' ', 1),
  last_name = CASE WHEN position(' ' in full_name) = 0 THEN '' ELSE trim(substring(full_name from position(' ' in full_name))) END
WHERE first_name IS NULL;

-- ---- Shopper verification comment history (auditable, non-destructive alongside verification_notes) ----

CREATE TABLE IF NOT EXISTS shopper_verification_notes (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES admin_users(id),
  author_name TEXT,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Payment supersession (stale pending payments after an order recalculation) ----

DO $$
BEGIN
  ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
  ALTER TABLE payments
    ADD CONSTRAINT payments_status_check CHECK (status IN ('pending', 'confirmed', 'rejected', 'superseded'));
END $$;

-- ---- Quality inspection add-on + owner-approval workflow ----

ALTER TABLE orders ADD COLUMN IF NOT EXISTS quality_inspection_requested BOOLEAN NOT NULL DEFAULT false;

-- Owner's own contact details for SLA notifications (nullable — set via the Staff tab's self-profile edit).
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS phone_carrier TEXT;

-- One row per order; UNIQUE kept because a rejected inspection is expected to be resolved via the return flow
-- rather than re-inspected in place. If re-inspection after rejection becomes common, drop the UNIQUE constraint
-- and have callers look up the latest row by order_id + created_at instead.
CREATE TABLE IF NOT EXISTS quality_inspections (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_photos'
    CHECK (status IN ('pending_photos', 'pending_approval', 'approved', 'rejected')),
  submitted_by INTEGER REFERENCES admin_users(id),
  submitted_at TIMESTAMPTZ,
  decided_by INTEGER REFERENCES admin_users(id),
  decision_reason TEXT,
  decided_at TIMESTAMPTZ,
  sla_deadline TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quality_inspection_photos (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Gated return workflow (only reachable after a failed quality inspection) ----

CREATE TABLE IF NOT EXISTS return_requests (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  inspection_id INTEGER REFERENCES quality_inspections(id),
  requested_by INTEGER REFERENCES admin_users(id),
  item_still_at_origin BOOLEAN NOT NULL,
  seller_accepts_return BOOLEAN NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'completed')),
  decided_by INTEGER REFERENCES admin_users(id),
  decision_reason TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Staff usernames + reported-account flag ----

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS username TEXT;

-- Backfill existing rows from the email local-part, deduplicated by appending the row's id on collision.
UPDATE admin_users SET username = split_part(email, '@', 1) WHERE username IS NULL;

DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT id, username FROM admin_users a
    WHERE EXISTS (
      SELECT 1 FROM admin_users b WHERE b.username = a.username AND b.id <> a.id
    )
  LOOP
    UPDATE admin_users SET username = dup.username || '_' || dup.id WHERE id = dup.id;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_username_key'
  ) THEN
    ALTER TABLE admin_users ADD CONSTRAINT admin_users_username_key UNIQUE (username);
  END IF;
END $$;

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reported BOOLEAN DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS report_reason TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reported_by INTEGER REFERENCES admin_users(id);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ;

-- ---- activity_log: actor_type so shopper/system actions can share the table with staff actions ----
-- actor_id previously FK'd to admin_users(id) only; that constraint is dropped so shopper ids can be logged too.
-- Existing rows are historical staff actions and are migrated to actor_type = 'staff'.

ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS actor_type TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_actor_id_fkey'
  ) THEN
    ALTER TABLE activity_log DROP CONSTRAINT activity_log_actor_id_fkey;
  END IF;
END $$;

UPDATE activity_log SET actor_type = 'staff' WHERE actor_type IS NULL;

ALTER TABLE activity_log ALTER COLUMN actor_type SET DEFAULT 'staff';
ALTER TABLE activity_log ALTER COLUMN actor_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_actor_type_check'
  ) THEN
    ALTER TABLE activity_log
      ADD CONSTRAINT activity_log_actor_type_check CHECK (actor_type IN ('staff', 'shopper', 'system'));
  END IF;
END $$;

-- ---- Shopper's own registered address (required going forward at the application layer) ----

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS street_address TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS state TEXT;

-- ---- Per-order shipping/recipient details (defaults to the shopper's own info; overridable per order) ----

ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_street_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_city TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_state TEXT;

-- ---- Shopper username (backfilled from email local-part) + password reset ----

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS username TEXT;

UPDATE shoppers SET username = lower(split_part(email, '@', 1)) WHERE username IS NULL;

DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT id, username FROM shoppers a
    WHERE EXISTS (
      SELECT 1 FROM shoppers b WHERE b.username = a.username AND b.id <> a.id
    )
  LOOP
    UPDATE shoppers SET username = dup.username || '_' || dup.id WHERE id = dup.id;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shoppers_username_key'
  ) THEN
    ALTER TABLE shoppers ADD CONSTRAINT shoppers_username_key UNIQUE (username);
  END IF;
END $$;

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

-- ---- Nigeria customs fee (pay before collection) ----

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customs_fee_ngn NUMERIC(14,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customs_fee_status TEXT DEFAULT 'not_applicable';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_customs_fee_status_check'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_customs_fee_status_check CHECK (customs_fee_status IN ('not_applicable', 'due', 'paid'));
  END IF;
END $$;

-- ---- Warehouse-arrival marker (uses the existing order_updates timeline; this column just records the first timestamp) ----

ALTER TABLE orders ADD COLUMN IF NOT EXISTS warehouse_received_at TIMESTAMPTZ;

-- ---- Automatic follow-up charge (% of item cost) on order-payment confirmation ----

INSERT INTO settings (key, value) VALUES
  ('follow_up_charge_percent', '20')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS charge_type TEXT DEFAULT 'order_total';

UPDATE payments SET charge_type = 'subscription' WHERE charge_type IS NULL AND subscription_id IS NOT NULL;
UPDATE payments SET charge_type = 'order_total' WHERE charge_type IS NULL AND order_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_charge_type_check'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_charge_type_check CHECK (charge_type IN ('order_total', 'follow_up_charge', 'subscription', 'refund'));
  END IF;
END $$;

-- ---- Dedicated NIN field, required for every shopper regardless of chosen ID type ----

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS nin TEXT;
UPDATE shoppers SET nin = id_number WHERE nin IS NULL AND id_type = 'NIN';

-- ---- Payment rejection reason + supervisor/owner reversal of a mistaken confirm ----

ALTER TABLE payments ADD COLUMN IF NOT EXISTS decision_reason TEXT;

-- ---- New "shoppers" permission section for the full shopper directory tab ----

ALTER TABLE staff_permissions DROP CONSTRAINT IF EXISTS staff_permissions_section_check;
ALTER TABLE staff_permissions
  ADD CONSTRAINT staff_permissions_section_check CHECK (section IN (
    'verifications', 'orders', 'payments', 'subscriptions', 'settings', 'staff', 'approvals', 'activity_log', 'shoppers'
  ));

-- ---- Live camera selfie captured at registration (identity verification) ----
-- Kept as its own table rather than a `type` column on id_documents: a selfie is a distinct kind of evidence
-- (live-captured, no original_name/uploaded file) from an uploaded ID document, and a dedicated table avoids
-- scattering type-discrimination logic (WHERE type = ...) across every call site that reads id_documents today.
-- No UNIQUE(shopper_id) — a future "retake" flow can insert again; readers just take the most recent row.

CREATE TABLE IF NOT EXISTS selfie_photos (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Admin-configurable shipping/freight rates (drive the order calculator directly) ----

INSERT INTO settings (key, value) VALUES
  ('freight_air_rate_per_lb', '8.75'),
  ('freight_air_min_usd', '25'),
  ('freight_express_rate_per_lb', '13.50'),
  ('freight_express_min_usd', '38'),
  ('freight_sea_rate_per_lb', '2.80'),
  ('freight_sea_min_usd', '18')
ON CONFLICT (key) DO NOTHING;

-- ---- Multi-item orders: one order (shipment) now holds many line items ----
-- The old per-item columns on `orders` (item_price_usd, quantity, weight_lb, category, product_url,
-- screenshot_path, item_title) are kept for backward-compat/history but are no longer written by new code —
-- they're relaxed to nullable below and all new reads/writes go through order_items. Freight is computed once
-- per order on total weight; duty is computed per item and summed; tax/service/insurance/quality-inspection
-- follow the rules documented in quote.js.

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_url TEXT,
  item_title TEXT,
  price_usd NUMERIC(12,2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  weight_lb NUMERIC(10,2) NOT NULL,
  category TEXT NOT NULL,
  color_variant TEXT,
  description TEXT,
  item_subtotal_usd NUMERIC(12,2),
  item_tax_usd NUMERIC(12,2),
  item_duty_usd NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_item_images (
  id SERIAL PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_item_images_order_item_id_idx ON order_item_images(order_item_id);

-- New per-order columns holding sums across order_items (fast reads without re-joining every time).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_subtotal_usd NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_tax_usd NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_duty_usd NUMERIC(12,2);

-- New orders no longer populate the legacy single-item columns, so they must become nullable.
ALTER TABLE orders ALTER COLUMN screenshot_path DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN item_price_usd DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN weight_lb DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN category DROP NOT NULL;

-- One-time backfill: every pre-existing order becomes an order with exactly one order_items row, built from
-- its legacy columns. Guarded by NOT EXISTS so this is safe to re-run (only orders with zero order_items rows
-- are touched — an order that already has line items, i.e. every order created after this migration, is skipped).
INSERT INTO order_items (order_id, product_url, item_title, price_usd, quantity, weight_lb, category,
                          item_subtotal_usd, item_tax_usd, item_duty_usd, created_at)
SELECT
  o.id, o.product_url, o.item_title, o.item_price_usd, o.quantity, o.weight_lb, o.category,
  COALESCE((o.quote_breakdown->>'subtotal')::numeric, o.item_price_usd * o.quantity),
  COALESCE((o.quote_breakdown->>'tax')::numeric, 0),
  COALESCE((o.quote_breakdown->>'duty')::numeric, 0),
  o.created_at
FROM orders o
WHERE o.item_price_usd IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id);

-- Backfill items_subtotal_usd/items_tax_usd/items_duty_usd on the order itself from the same legacy breakdown,
-- for orders that don't have it set yet (post-migration orders set these directly at insert time).
UPDATE orders o SET
  items_subtotal_usd = COALESCE((o.quote_breakdown->>'subtotal')::numeric, o.item_price_usd * o.quantity),
  items_tax_usd = COALESCE((o.quote_breakdown->>'tax')::numeric, 0),
  items_duty_usd = COALESCE((o.quote_breakdown->>'duty')::numeric, 0)
WHERE o.items_subtotal_usd IS NULL AND o.item_price_usd IS NOT NULL;

-- Each legacy order's single screenshot is migrated into order_item_images by a separate one-off script
-- (backend/scripts/migrateOrderImages.mjs, run once after `npm run migrate`) rather than here in SQL: it needs
-- to copy the physical file into the new order-item-images upload directory (not just insert a row) so that
-- file_path means "look in order-item-images" uniformly for both migrated and newly-uploaded images.

-- ---- Direct admin-to-shopper messages (distinct from automatic system notifications) ----

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sender_type TEXT NOT NULL DEFAULT 'system';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sender_id INTEGER REFERENCES admin_users(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sender_name TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_sender_type_check'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_sender_type_check CHECK (sender_type IN ('system', 'admin'));
  END IF;
END $$;

-- ---- Shopper-attached payment receipts (PDF or photo of a bank transfer receipt) ----

ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_file_path TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_mime_type TEXT;

-- ---- Admin comment on a payment, and payment amount edits become auditable ----

ALTER TABLE payments ADD COLUMN IF NOT EXISTS admin_comment TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS original_amount_usd NUMERIC(12,2);

-- ---- Payment confirmation joins the existing supervisor/owner approval-gate system ----

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_target_type_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_target_type_check CHECK (target_type IN ('shopper', 'order', 'payment'));

-- ---- Physical/home address, distinct from the shipping address (street_address/city/state) ----
-- street_address/city/state remains the shopper's shipping address (used to default order delivery, as before).
-- This is their real residence, for identity purposes, and does not affect order shipping.

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS physical_street_address TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS physical_city TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS physical_state TEXT;

-- Existing shoppers registered before this field existed: default their physical address to match their
-- shipping address (best available guess) rather than leaving it blank.
UPDATE shoppers SET
  physical_street_address = street_address,
  physical_city = city,
  physical_state = state
WHERE physical_street_address IS NULL AND street_address IS NOT NULL;
