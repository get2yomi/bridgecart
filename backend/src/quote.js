const categoryDuty = { electronics: 0.095, fashion: 0.14, beauty: 0.16, home: 0.11, auto: 0.12, other: 0.13 };

// Defaults used if the admin-configured settings (see settings.js FREIGHT_SETTING_KEYS) are missing/unset.
export const DEFAULT_FREIGHT_RATES = {
  air: { rate: 8.75, min: 25 },
  express: { rate: 13.5, min: 38 },
  sea: { rate: 2.8, min: 18 }
};

// Multi-item quote: one order (shipment) can contain several line items, each with its own price/qty/weight/category.
// Money rules (confirmed with the business owner — do not change without re-deriving all of this):
//  - Freight/shipping: computed ONCE per order on the sum of every item's (weight * quantity), using the
//    per-lb rate + minimum-charge logic below.
//  - Duty: computed PER ITEM on that item's own (subtotal + tax + its proportional share of usDelivery),
//    using that item's own category rate, then summed. The "proportional share of usDelivery" is each item's
//    share of the combined items subtotal — this is what makes the 1-item case collapse exactly to the legacy
//    single-item formula (`duty = (subtotal + tax + usDelivery) * categoryDuty[category]`), since a single
//    item's share of usDelivery is 100% of it.
//  - Tax: one shopper-entered rate, applied per item to that item's own subtotal, then summed.
//  - Service fee, insurance, quality inspection, US delivery: all computed ONCE per order (order-level, not
//    per item) — insurance and service are on the combined items subtotal; quality inspection is a flat fee;
//    US delivery is a single entered value.
export function calculateQuote({
  items, taxRate, freeStoreShipping, storeShipping, insurance, qualityInspection, qualityInspectionFee = 0,
  speed, freightRates = DEFAULT_FREIGHT_RATES
}) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("At least one item is required.");
  if (!freightRates[speed]) throw new Error("Invalid shipping speed.");

  const safeTaxRate = Math.max(0, Number(taxRate) || 0);
  const usDelivery = freeStoreShipping ? 0 : Math.max(0, Number(storeShipping) || 0);

  const normalizedItems = items.map((item) => {
    const category = item.category;
    if (!categoryDuty[category]) throw new Error("Invalid category.");
    const price = Math.max(0, Number(item.price) || 0);
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
    const weight = Math.max(0.2, Number(item.weight) || 0.2);
    if (price <= 0) throw new Error("Each item requires a valid price.");
    return { price, quantity, weight, category };
  });

  const itemsSubtotal = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalWeight = normalizedItems.reduce((sum, item) => sum + item.weight * item.quantity, 0);
  const shipping = Math.max(totalWeight * freightRates[speed].rate, freightRates[speed].min);

  const perItem = normalizedItems.map((item) => {
    const subtotal = item.price * item.quantity;
    const tax = subtotal * (safeTaxRate / 100);
    const usDeliveryShare = itemsSubtotal > 0 ? usDelivery * (subtotal / itemsSubtotal) : 0;
    const duty = (subtotal + tax + usDeliveryShare) * categoryDuty[item.category];
    return { subtotal, tax, duty };
  });

  const itemsTax = perItem.reduce((sum, item) => sum + item.tax, 0);
  const itemsDuty = perItem.reduce((sum, item) => sum + item.duty, 0);

  const insuranceAmount = insurance ? itemsSubtotal * 0.015 : 0;
  const qualityInspectionAmount = qualityInspection ? Math.max(0, qualityInspectionFee) : 0;
  const service = Math.max(itemsSubtotal * 0.075, 10);

  const total = itemsSubtotal + itemsTax + usDelivery + shipping + itemsDuty + insuranceAmount + qualityInspectionAmount + service;

  return {
    perItem,
    breakdown: {
      itemsSubtotal, itemsTax, usDelivery, shipping, itemsDuty,
      insurance: insuranceAmount, qualityInspection: qualityInspectionAmount, service
    },
    total
  };
}
