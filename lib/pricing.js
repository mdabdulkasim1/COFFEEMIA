"use strict";
/**
 * Single source of truth for money. The browser shows a live preview using the
 * same rules, but every stored total is recomputed here so a tampered or stale
 * client can never decide what a bill is worth.
 *
 * GST works either way round:
 *   inclusive (the default, and how most cafes here price)  — the menu rate
 *     already contains GST, so nothing is added at the bottom of the bill and
 *     the tax is shown as a breakup of the total.
 *   exclusive — GST is calculated on top of the menu rate.
 */

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function clampQty(q) {
  const n = Math.floor(Number(q) || 0);
  return Math.min(Math.max(n, 0), 999);
}

/**
 * @param {Array} lines  [{ price, qty }]
 * @param {Object} order { discountType:'amount'|'percent', discountValue }
 * @param {Object} settings
 */
function computeTotals(lines, order, settings) {
  const s = settings || {};
  const subtotal = money(
    (lines || []).reduce((sum, l) => sum + (Number(l.price) || 0) * clampQty(l.qty), 0)
  );

  const type = order && order.discountType === "percent" ? "percent" : "amount";
  const value = Math.max(0, Number((order && order.discountValue) || 0));
  let discount = type === "percent" ? (subtotal * Math.min(value, 100)) / 100 : value;
  discount = money(Math.min(discount, subtotal));

  const afterDiscount = money(subtotal - discount);

  const scPercent = s.serviceChargeEnabled ? Math.max(0, Number(s.serviceChargePercent) || 0) : 0;
  const serviceCharge = money((afterDiscount * scPercent) / 100);

  const taxPercent = s.taxEnabled ? Math.max(0, Number(s.taxPercent) || 0) : 0;
  const inclusive = s.taxMode !== "exclusive";
  const rounding = s.roundOff === false ? (n) => money(n) : (n) => Math.round(n);

  let tax, total, roundOff, taxableValue;

  if (!taxPercent) {
    const gross = money(afterDiscount + serviceCharge);
    total = money(rounding(gross));
    tax = 0;
    taxableValue = total;
    roundOff = money(total - gross);
  } else if (inclusive) {
    // The rate already carries GST. Round first, then split the rounded total,
    // so the breakup printed on the bill adds back up to what the guest pays.
    const gross = money(afterDiscount + serviceCharge);
    total = money(rounding(gross));
    tax = money(total - total / (1 + taxPercent / 100));
    taxableValue = money(total - tax);
    roundOff = money(total - gross);
  } else {
    taxableValue = money(afterDiscount + serviceCharge);
    tax = money((taxableValue * taxPercent) / 100);
    const gross = money(taxableValue + tax);
    total = money(rounding(gross));
    roundOff = money(total - gross);
  }

  // CGST and SGST are half each, with any stray paisa left on the second half
  // so the two always add up to the GST shown.
  const cgst = money(tax / 2);
  const sgst = money(tax - cgst);

  return {
    subtotal,
    discountType: type,
    discountValue: value,
    discount,
    serviceChargePercent: scPercent,
    serviceCharge,
    taxName: s.taxName || "GST",
    taxPercent,
    taxMode: taxPercent ? (inclusive ? "inclusive" : "exclusive") : "none",
    tax,
    taxableValue,
    cgst,
    sgst,
    roundOff,
    total,
    itemCount: (lines || []).reduce((n, l) => n + clampQty(l.qty), 0),
  };
}

module.exports = { computeTotals, money, clampQty };
