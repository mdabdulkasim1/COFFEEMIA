"use strict";
/**
 * Sales aggregation for the dashboard, the reports screen and the day-close
 * (Z) report. Everything is derived from the stored orders — no separate
 * counters to drift out of sync.
 */

/** Local YYYY-MM-DD for an ISO timestamp (server TZ, defaulted to Asia/Kolkata). */
function dateKey(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayKey() {
  return dateKey(new Date().toISOString());
}

/** Orders paid inside [from, to] inclusive, by local business date. */
function paidBetween(orders, from, to) {
  return orders.filter(
    (o) => o.status === "paid" && o.businessDate && o.businessDate >= from && o.businessDate <= to
  );
}

/**
 * Indian mobile numbers, stored as a bare 10 digits so the same guest is
 * recognised however they were typed in (+91, spaces, dashes, leading 0).
 * Returns "" for anything that is not a plausible mobile number.
 */
function normalisePhone(value) {
  let d = String(value === null || value === undefined ? "" : value).replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("91")) d = d.slice(-10);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function bump(map, key, amount, qty) {
  const row = map.get(key) || { key, amount: 0, qty: 0, orders: 0 };
  row.amount = round2(row.amount + (amount || 0));
  row.qty += qty || 0;
  row.orders += 1;
  map.set(key, row);
  return row;
}

function buildReport(data, from, to) {
  const orders = paidBetween(data.orders, from, to);
  // Merged tables are stored as cancelled source orders; they are bookkeeping,
  // not lost sales, so they stay out of the cancellation figures.
  const cancelled = data.orders.filter(
    (o) => o.status === "cancelled" && !o.merged && o.businessDate >= from && o.businessDate <= to
  );
  const open = data.orders.filter((o) => o.status === "open");

  const catById = new Map(data.categories.map((c) => [c.id, c]));
  const itemById = new Map(data.items.map((i) => [i.id, i]));

  const byPayment = new Map();
  const byMode = new Map();
  const byStaff = new Map();
  const byCategory = new Map();
  const byItem = new Map();
  const byDay = new Map();
  const byHour = new Map();
  const byWeekday = new Map();
  // date -> hour -> amount, the grid behind both the heatmap and the
  // day-against-day hourly comparison.
  const grid = new Map();
  // Item pairs that land on the same bill, and how many bills each item is on.
  const pairs = new Map();
  const itemBills = new Map();
  let drinksOnlyBills = 0;
  // A guest is counted once a day. "New" means the shop had never seen that
  // number before that day, judged against every order ever, not just this range.
  const firstSeen = new Map();
  for (const o of data.orders) {
    const ph = o.customer && o.customer.phone;
    if (!ph || o.status !== "paid" || !o.businessDate) continue;
    const prev = firstSeen.get(ph);
    if (!prev || o.businessDate < prev) firstSeen.set(ph, o.businessDate);
  }
  const dayGuests = new Map();

  let gross = 0;
  let discount = 0;
  let tax = 0;
  let taxableValue = 0;
  let serviceCharge = 0;
  let parcelCharge = 0;
  let itemsSold = 0;

  for (const o of orders) {
    const t = o.totals || {};
    gross = round2(gross + (t.total || 0));
    discount = round2(discount + (t.discount || 0));
    tax = round2(tax + (t.tax || 0));
    taxableValue = round2(taxableValue + (t.taxableValue !== undefined ? t.taxableValue : t.total || 0));
    serviceCharge = round2(serviceCharge + (t.serviceCharge || 0));
    parcelCharge = round2(parcelCharge + (t.parcelCharge || 0)); // historical bills only

    bump(byPayment, (o.payment && o.payment.mode) || "Cash", t.total, 0);
    bump(byMode, o.mode || "dine-in", t.total, 0);
    bump(byStaff, o.paidByName || o.createdByName || "—", t.total, 0);
    const lineQty = (o.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
    bump(byDay, o.businessDate, t.total, lineQty);
    const when = new Date(o.paidAt || o.createdAt);
    bump(byHour, String(when.getHours()).padStart(2, "0"), t.total, 0);
    bump(byWeekday, String(when.getDay()), t.total, 0);

    const hour = when.getHours();
    const row = grid.get(o.businessDate) || { date: o.businessDate, hours: {}, total: 0, orders: 0 };
    row.hours[hour] = round2((row.hours[hour] || 0) + (t.total || 0));
    row.total = round2(row.total + (t.total || 0));
    row.orders += 1;
    grid.set(o.businessDate, row);

    // One bill contributes each distinct item once, so a pair is "bills that
    // carried both", not "units sold together".
    const phone = o.customer && o.customer.phone;
    if (phone) {
      const g = dayGuests.get(o.businessDate) || { seen: new Set(), fresh: new Set() };
      g.seen.add(phone);
      if (firstSeen.get(phone) === o.businessDate) g.fresh.add(phone);
      dayGuests.set(o.businessDate, g);
    }

    const names = Array.from(new Set((o.lines || []).map((l) => l.name).filter(Boolean))).sort();
    for (const n of names) itemBills.set(n, (itemBills.get(n) || 0) + 1);
    for (let a = 0; a < names.length; a++) {
      for (let b = a + 1; b < names.length; b++) {
        const key = names[a] + " + " + names[b];
        const pr = pairs.get(key) || { key, a: names[a], b: names[b], orders: 0 };
        pr.orders += 1;
        pairs.set(key, pr);
      }
    }
    // A bill with nothing from the kitchen is a drink-only bill — the ones a
    // snack combo could grow.
    const anyFood = (o.lines || []).some((l) => {
      const it = itemById.get(l.itemId);
      const c = it ? catById.get(it.categoryId) : null;
      return (l.station || (c && c.station) || "Kitchen") === "Kitchen";
    });
    if ((o.lines || []).length && !anyFood) drinksOnlyBills += 1;

    for (const l of o.lines || []) {
      const qty = Number(l.qty) || 0;
      const amount = round2(qty * (Number(l.price) || 0));
      itemsSold += qty;

      const item = itemById.get(l.itemId);
      const cat = item ? catById.get(item.categoryId) : null;
      const catName = (l.categoryName || (cat && cat.name) || "Other");
      const c = byCategory.get(catName) || { key: catName, amount: 0, qty: 0, orders: 0 };
      c.amount = round2(c.amount + amount);
      c.qty += qty;
      byCategory.set(catName, c);

      const key = l.name;
      const i = byItem.get(key) || { key, amount: 0, qty: 0, orders: 0, category: catName };
      i.amount = round2(i.amount + amount);
      i.qty += qty;
      byItem.set(key, i);
    }
  }

  const list = (m) => Array.from(m.values()).sort((a, b) => b.amount - a.amount);
  const chronological = (m) => Array.from(m.values()).sort((a, b) => (a.key < b.key ? -1 : 1));

  /* ---- hour grid: every day in the range, every trading hour ---- */
  const days = Array.from(grid.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  // Only hours the shop actually traded in, so the chart is not mostly empty.
  let lowHour = 23, highHour = 0;
  for (const d of days) {
    for (const h of Object.keys(d.hours)) {
      const n = Number(h);
      if (d.hours[h] > 0) { if (n < lowHour) lowHour = n; if (n > highHour) highHour = n; }
    }
  }
  if (lowHour > highHour) { lowHour = 8; highHour = 21; }
  const hours = [];
  for (let h = lowHour; h <= highHour; h++) hours.push(h);

  const hourLabel = (h) => {
    const ampm = h < 12 ? "am" : "pm";
    const n = h % 12 === 0 ? 12 : h % 12;
    return n + ampm;
  };
  const dayCount = Math.max(1, days.length);
  const hourTotals = hours.map((h) => {
    let amount = 0, busiest = 0;
    for (const d of days) {
      const v = d.hours[h] || 0;
      amount = round2(amount + v);
      if (v > busiest) busiest = v;
    }
    return { hour: h, label: hourLabel(h), amount, avg: round2(amount / dayCount), busiest };
  });
  const peak = hourTotals.reduce((best, r) => (!best || r.amount > best.amount ? r : best), null);

  // The evening rush, as a share of the day. Tells the owner where the staff
  // and the stock need to be.
  const windowFrom = 16, windowTo = 19; // 4pm up to and including the 7pm hour
  const windowAmount = hourTotals
    .filter((r) => r.hour >= windowFrom && r.hour <= windowTo)
    .reduce((n, r) => round2(n + r.amount), 0);

  const perDay = days.map((d) => {
    const row = byDay.get(d.date) || { amount: 0, qty: 0, orders: 0 };
    const g = dayGuests.get(d.date);
    return {
      date: d.date,
      label: new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }),
      short: new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      weekday: new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short" }),
      bills: d.orders,
      amount: d.total,
      items: row.qty,
      average: d.orders ? round2(d.total / d.orders) : 0,
      guests: g ? g.seen.size : 0,
      newGuests: g ? g.fresh.size : 0,
    };
  });

  const dayGrid = days.map((d) => ({
    date: d.date,
    label: new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }),
    short: new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short" }),
    total: d.total,
    orders: d.orders,
    hours: hours.map((h) => round2(d.hours[h] || 0)),
  }));

  return {
    range: { from, to },
    totals: {
      orders: orders.length,
      gross,
      discount,
      tax,
      taxableValue,
      taxMode: orders.length ? (orders[orders.length - 1].totals || {}).taxMode || "none" : "none",
      serviceCharge,
      parcelCharge,
      itemsSold,
      average: orders.length ? round2(gross / orders.length) : 0,
      cancelledCount: cancelled.length,
      cancelledValue: round2(cancelled.reduce((s, o) => s + ((o.totals && o.totals.total) || 0), 0)),
      openCount: open.length,
      openValue: round2(open.reduce((s, o) => s + ((o.totals && o.totals.total) || 0), 0)),
    },
    byPayment: list(byPayment),
    byMode: list(byMode),
    byStaff: list(byStaff),
    byCategory: list(byCategory),
    topItems: Array.from(byItem.values()).sort((a, b) => b.qty - a.qty).slice(0, 12),
    items: Array.from(byItem.values())
      .map((i) => Object.assign({}, i, {
        bills: itemBills.get(i.key) || 0,
        price: i.qty ? round2(i.amount / i.qty) : 0,
        share: gross ? Math.round((i.amount / gross) * 1000) / 10 : 0,
        perDay: round2(i.qty / Math.max(1, new Set(orders.map((o) => o.businessDate)).size)),
      }))
      .sort((a, b) => b.amount - a.amount),
    byWeekday: [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const row = byWeekday.get(String(d));
      return { key: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d],
               amount: row ? row.amount : 0, orders: row ? row.orders : 0 };
    }),
    byDay: chronological(byDay),
    byHour: chronological(byHour),

    /* ---- hour-by-hour, day against day ---- */
    hourAxis: hours.map((h) => ({ hour: h, label: hourLabel(h) })),
    hourTotals,
    dayGrid,
    peakHour: peak
      ? { label: peak.label + " – " + hourLabel((peak.hour + 1) % 24), amount: peak.amount, avg: peak.avg }
      : null,
    rushWindow: {
      label: hourLabel(windowFrom) + " – " + hourLabel(windowTo + 1),
      amount: windowAmount,
      share: gross ? Math.round((windowAmount / gross) * 1000) / 10 : 0,
    },

    /* ---- what sells with what ---- */
    pairs: Array.from(pairs.values()).sort((a, b) => b.orders - a.orders).slice(0, 10),
    drinksOnly: {
      bills: drinksOnlyBills,
      share: orders.length ? Math.round((drinksOnlyBills / orders.length) * 1000) / 10 : 0,
    },

    /* ---- menu focus: units against price, bubble is sales value ---- */
    matrix: Array.from(byItem.values())
      .filter((i) => i.qty > 0)
      .map((i) => ({
        key: i.key,
        category: i.category,
        qty: i.qty,
        price: round2(i.amount / i.qty),
        amount: i.amount,
        bills: itemBills.get(i.key) || 0,
      }))
      .sort((a, b) => b.amount - a.amount),
    slowMovers: Array.from(byItem.values())
      .filter((i) => i.qty > 0 && i.qty <= 4)
      .map((i) => ({ key: i.key, qty: i.qty, amount: i.amount, category: i.category }))
      .sort((a, b) => a.qty - b.qty),
    perDay,
    daysCounted: dayCount,
  };
}

/**
 * One row per guest who left a number, newest visit first. Built from the
 * bills themselves, so it always reflects what was actually sold.
 */
function buildCustomers(data) {
  const byPhone = new Map();
  for (const o of data.orders) {
    if (o.status !== "paid") continue;
    const phone = normalisePhone(o.customer && o.customer.phone);
    if (!phone) continue;
    const when = o.paidAt || o.createdAt;
    const row = byPhone.get(phone) || {
      phone, name: "", visits: 0, spent: 0, firstVisit: when, lastVisit: when, items: new Map(),
    };
    row.visits += 1;
    row.spent = round2(row.spent + ((o.totals && o.totals.total) || 0));
    if (when < row.firstVisit) row.firstVisit = when;
    if (when > row.lastVisit) row.lastVisit = when;
    // Keep the most recently given name — people correct their spelling.
    const name = (o.customer && String(o.customer.name || "").trim()) || "";
    if (name && when >= row.lastVisit) row.name = name;
    for (const l of o.lines || []) {
      row.items.set(l.name, (row.items.get(l.name) || 0) + (Number(l.qty) || 0));
    }
    byPhone.set(phone, row);
  }

  return Array.from(byPhone.values())
    .map((r) => {
      const favourite = Array.from(r.items.entries()).sort((a, b) => b[1] - a[1])[0];
      return {
        phone: r.phone,
        name: r.name,
        visits: r.visits,
        spent: r.spent,
        average: r.visits ? round2(r.spent / r.visits) : 0,
        firstVisit: dateKey(r.firstVisit),
        lastVisit: dateKey(r.lastVisit),
        favourite: favourite ? favourite[0] : "",
      };
    })
    .sort((a, b) => (a.lastVisit < b.lastVisit ? 1 : a.lastVisit > b.lastVisit ? -1 : b.spent - a.spent));
}

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Guest list for the marketing export — one row per mobile number. */
function customersToCsv(rows) {
  const header = ["Mobile", "Name", "Visits", "Total Spent", "Average Bill", "First Visit", "Last Visit", "Usual Order"];
  const body = rows.map((r) =>
    [r.phone, r.name, r.visits, r.spent, r.average, r.firstVisit, r.lastVisit, r.favourite].map(csvCell).join(",")
  );
  return "\ufeff" + [header.join(","), ...body].join("\n");
}

/** Rows for the CSV export — one line per order. */
function ordersToCsv(data, orders) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = [
    "Bill No", "Date", "Time", "Table", "Mode", "Status", "Items",
    "Subtotal", "Discount", "Parcel Charge", "Service Charge", "Tax", "Round Off", "Total",
    "Payment", "Taken By", "Settled By", "Customer", "Mobile", "Notes",
  ];
  const rows = orders.map((o) => {
    const t = o.totals || {};
    const when = new Date(o.paidAt || o.createdAt);
    const detail = (o.lines || []).map((l) => `${l.name} x${l.qty}`).join("; ");
    return [
      o.no, o.businessDate, when.toLocaleTimeString(), o.tableName || "-", o.mode, o.status, detail,
      t.subtotal, t.discount, t.parcelCharge || 0, t.serviceCharge, t.tax, t.roundOff, t.total,
      (o.payment && o.payment.mode) || "", o.createdByName || "", o.paidByName || "",
      (o.customer && o.customer.name) || "", (o.customer && o.customer.phone) || "", o.note || "",
    ].map(esc).join(",");
  });
  return "﻿" + [header.join(","), ...rows].join("\n");
}

module.exports = {
  buildReport, ordersToCsv, buildCustomers, customersToCsv,
  normalisePhone, dateKey, todayKey, paidBetween,
};
