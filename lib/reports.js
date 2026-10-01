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

function getOrderBusinessDate(o) {
  if (o && o.businessDate) return o.businessDate;
  return dateKey((o && (o.paidAt || o.createdAt)) || new Date().toISOString());
}

/** Orders paid inside [from, to] inclusive, by local business date. */
function paidBetween(orders, from, to) {
  return orders.filter(
    (o) => o.status === "paid" && getOrderBusinessDate(o) >= from && getOrderBusinessDate(o) <= to
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
    (o) => o.status === "cancelled" && !o.merged && getOrderBusinessDate(o) >= from && getOrderBusinessDate(o) <= to
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
  const pairMap = new Map();

  let gross = 0;
  let discount = 0;
  let tax = 0;
  let taxableValue = 0;
  let serviceCharge = 0;
  let parcelCharge = 0;
  let itemsSold = 0;
  let takings4to8 = 0;
  let noKitchenBillsCount = 0;

  for (const o of orders) {
    const t = o.totals || {};
    const orderTotal = t.total || 0;
    gross = round2(gross + orderTotal);
    discount = round2(discount + (t.discount || 0));
    tax = round2(tax + (t.tax || 0));
    taxableValue = round2(taxableValue + (t.taxableValue !== undefined ? t.taxableValue : orderTotal));
    serviceCharge = round2(serviceCharge + (t.serviceCharge || 0));
    parcelCharge = round2(parcelCharge + (t.parcelCharge || 0)); // historical bills only

    bump(byPayment, (o.payment && o.payment.mode) || "Cash", orderTotal, 0);
    bump(byMode, o.mode || "dine-in", orderTotal, 0);
    bump(byStaff, o.paidByName || o.createdByName || "—", orderTotal, 0);
    const lineQty = (o.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
    bump(byDay, getOrderBusinessDate(o), orderTotal, lineQty);
    
    const when = new Date(o.paidAt || o.createdAt);
    const hourNum = when.getHours();
    bump(byHour, String(hourNum).padStart(2, "0"), orderTotal, 0);
    bump(byWeekday, String(when.getDay()), orderTotal, 0);

    if (hourNum >= 16 && hourNum < 20) {
      takings4to8 = round2(takings4to8 + orderTotal);
    }

    let hasKitchenItem = false;
    const uniqueOrderItems = new Set();
    const orderItemPrices = new Map();
    const orderItemCats = new Map();

    for (const l of o.lines || []) {
      const qty = Number(l.qty) || 0;
      const price = Math.max(0, Number(l.price) || 0);
      const amount = round2(qty * price);
      itemsSold += qty;

      const item = itemById.get(l.itemId);
      const cat = item ? catById.get(item.categoryId) : null;
      const catName = (l.categoryName || (cat && cat.name) || "Other");
      const station = l.station || (cat && cat.station) || "Kitchen";
      if (station === "Kitchen") {
        hasKitchenItem = true;
      }

      const c = byCategory.get(catName) || { key: catName, amount: 0, qty: 0, orders: 0 };
      c.amount = round2(c.amount + amount);
      c.qty += qty;
      byCategory.set(catName, c);

      const key = l.name;
      uniqueOrderItems.add(key);
      orderItemPrices.set(key, price);
      orderItemCats.set(key, catName);

      const i = byItem.get(key) || { key, amount: 0, qty: 0, orders: 0, category: catName, price };
      i.amount = round2(i.amount + amount);
      i.qty += qty;
      i.price = price || i.price;
      byItem.set(key, i);
    }

    if (!hasKitchenItem) {
      noKitchenBillsCount += 1;
    }

    // Increment bill count (orders) for each item present on this bill
    for (const itemName of uniqueOrderItems) {
      const i = byItem.get(itemName);
      if (i) i.orders += 1;
    }

    // Item pairs per bill (Bought together)
    const itemList = Array.from(uniqueOrderItems).sort();
    for (let a = 0; a < itemList.length; a++) {
      for (let b = a + 1; b < itemList.length; b++) {
        const itemA = itemList[a];
        const itemB = itemList[b];
        const pairKey = `${itemA} + ${itemB}`;
        const p = pairMap.get(pairKey) || { itemA, itemB, label: pairKey, count: 0 };
        p.count += 1;
        pairMap.set(pairKey, p);
      }
    }
  }

  // Calculate Days in selected range
  const daysInPeriod = new Set(orders.map((o) => getOrderBusinessDate(o)));
  const numDays = Math.max(1, daysInPeriod.size);

  // Peak hour
  let peakHourH = 16;
  let peakHourSales = 0;
  for (let h = 0; h < 24; h++) {
    const hKey = String(h).padStart(2, "0");
    const hRow = byHour.get(hKey);
    const amt = hRow ? hRow.amount : 0;
    if (amt > peakHourSales) {
      peakHourSales = amt;
      peakHourH = h;
    }
  }
  const peakH12 = peakHourH % 12 === 0 ? 12 : peakHourH % 12;
  const peakAmpm = peakHourH < 12 ? "am" : "pm";
  const peakNextH = (peakHourH + 1) % 24;
  const peakNextH12 = peakNextH % 12 === 0 ? 12 : peakNextH % 12;
  const peakNextAmpm = peakNextH < 12 ? "am" : "pm";
  const peakHourLabel = `${peakH12}${peakAmpm} – ${peakNextH12}${peakNextAmpm}`;

  // Bought together ranking
  const boughtTogether = Array.from(pairMap.values())
    .map((p) => {
      const itemAObj = byItem.get(p.itemA);
      const itemBObj = byItem.get(p.itemB);
      return {
        itemA: p.itemA,
        itemB: p.itemB,
        label: p.label,
        count: p.count,
        itemACount: itemAObj ? itemAObj.orders : 0,
        itemBCount: itemBObj ? itemBObj.orders : 0,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // Slow movers (4 or fewer sold in period)
  const slowMovers = Array.from(byItem.values())
    .filter((i) => i.qty <= 4)
    .sort((a, b) => a.qty - b.qty || a.amount - b.amount)
    .map((i) => ({ key: i.key, qty: i.qty, amount: i.amount, price: i.price, category: i.category }));

  // Day x Hour Heatmap Grid (reconciles rupee for rupee with net sales)
  const dateList = [];
  const currD = new Date(from);
  const endD = new Date(to);
  while (currD <= endD) {
    const dStr = dateKey(currD.toISOString());
    dateList.push(dStr);
    currD.setDate(currD.getDate() + 1);
  }

  function formatDateLabel(dStr) {
    if (!dStr) return "";
    const parts = dStr.split("-");
    if (parts.length < 3) return dStr;
    const day = parseInt(parts[2], 10);
    const mIdx = parseInt(parts[1], 10) - 1;
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day} ${MONTHS[mIdx] || ""}`;
  }

  // Global earliest visit map for all customer mobile numbers ever recorded in data.orders
  const firstVisitByPhone = new Map();
  for (const o of data.orders || []) {
    if (o.status !== "paid") continue;
    const phone = normalisePhone(o.customer && o.customer.phone);
    if (!phone) continue;
    const dStr = getOrderBusinessDate(o);
    const prev = firstVisitByPhone.get(phone);
    if (!prev || dStr < prev) {
      firstVisitByPhone.set(phone, dStr);
    }
  }

  // Customers, day by day calculation
  const customerDayRows = dateList.map((dStr) => {
    const dayOrders = orders.filter((o) => getOrderBusinessDate(o) === dStr);
    const customers = dayOrders.length; // every settled bill = 1 customer/group
    const itemsCount = dayOrders.reduce((s, o) => s + (o.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0), 0);
    const takings = round2(dayOrders.reduce((s, o) => s + ((o.totals && o.totals.total) || 0), 0));
    const avgBill = customers ? round2(takings / customers) : 0;

    const phonesOnDay = new Set();
    const newPhonesOnDay = new Set();
    for (const o of dayOrders) {
      const phone = normalisePhone(o.customer && o.customer.phone);
      if (!phone) continue;
      phonesOnDay.add(phone);
      if (firstVisitByPhone.get(phone) === dStr) {
        newPhonesOnDay.add(phone);
      }
    }

    return {
      date: dStr,
      label: formatDateLabel(dStr),
      customers,
      items: itemsCount,
      avgBill,
      takings,
      mobileCount: phonesOnDay.size,
      newCustomers: newPhonesOnDay.size,
    };
  });

  let customerMoveSummary = "";
  if (customerDayRows.length >= 2) {
    const latest = customerDayRows[customerDayRows.length - 1];
    const prev = customerDayRows[customerDayRows.length - 2];
    const diff = latest.customers - prev.customers;
    if (diff > 0) customerMoveSummary = `+${diff} customers vs yesterday (${latest.customers} vs ${prev.customers})`;
    else if (diff < 0) customerMoveSummary = `${diff} customers vs yesterday (${latest.customers} vs ${prev.customers})`;
    else customerMoveSummary = `Same customer count as yesterday (${latest.customers})`;
  } else if (customerDayRows.length === 1) {
    customerMoveSummary = `${customerDayRows[0].customers} customers on ${customerDayRows[0].label}`;
  }

  const dayByHourGrid = dateList.map((dStr) => {
    const dayOrders = orders.filter((o) => getOrderBusinessDate(o) === dStr);
    const dayTotal = round2(dayOrders.reduce((s, o) => s + ((o.totals && o.totals.total) || 0), 0));
    const hours = {};
    for (const o of dayOrders) {
      const when = new Date(o.paidAt || o.createdAt);
      const hStr = String(when.getHours()).padStart(2, "0");
      hours[hStr] = round2((hours[hStr] || 0) + ((o.totals && o.totals.total) || 0));
    }
    return {
      date: dStr,
      label: formatDateLabel(dStr),
      total: dayTotal,
      hours,
    };
  });

  // Multi-day Hour-by-Hour comparison across all dates in dateList (newest first)
  const comparisonDays = [];
  const activeHoursSet = new Set();
  const sumHoursMap = new Map();

  for (let i = dateList.length - 1; i >= 0; i--) {
    const dStr = dateList[i];
    const dayOrders = paidBetween(data.orders, dStr, dStr);
    const dayTotal = round2(dayOrders.reduce((s, o) => s + ((o.totals && o.totals.total) || 0), 0));
    const hours = {};
    for (const o of dayOrders) {
      const when = new Date(o.paidAt || o.createdAt);
      if (isNaN(when)) continue;
      const hNum = when.getHours();
      const hStr = String(hNum).padStart(2, "0");
      const orderTotal = (o.totals && o.totals.total) || 0;
      hours[hStr] = round2((hours[hStr] || 0) + orderTotal);
      sumHoursMap.set(hStr, round2((sumHoursMap.get(hStr) || 0) + orderTotal));
      if (Number.isFinite(hNum)) activeHoursSet.add(hNum);
    }
    comparisonDays.push({
      date: dStr,
      label: dStr === to ? "Today (" + formatDateLabel(dStr) + ")" : formatDateLabel(dStr),
      isCurrent: dStr === to,
      total: dayTotal,
      hours,
    });
  }

  // Calculate period average shape per hour
  const periodAvgHours = {};
  for (let h = 0; h < 24; h++) {
    const hStr = String(h).padStart(2, "0");
    const tot = sumHoursMap.get(hStr) || 0;
    periodAvgHours[hStr] = round2(tot / Math.max(1, dateList.length));
  }

  // Active trading hours (hours that actually saw a sale across comparison days or period)
  for (const hRow of byHour.values()) {
    const hNum = Number(hRow.key);
    if (hRow.amount > 0 && Number.isFinite(hNum)) activeHoursSet.add(hNum);
  }
  const activeHoursArray = Array.from(activeHoursSet).filter(Number.isFinite).sort((a, b) => a - b);
  const startHour = activeHoursArray.length ? Math.min.apply(null, activeHoursArray) : 8;
  const endHour = activeHoursArray.length ? Math.max.apply(null, activeHoursArray) : 22;
  const tradingHours = [];
  for (let h = startHour; h <= endHour; h++) {
    tradingHours.push(String(h).padStart(2, "0"));
  }

  // Menu Focus scatter items
  const allItemsList = Array.from(byItem.values());
  const rates = allItemsList.map((i) => i.price);
  const quantities = allItemsList.map((i) => i.qty);
  const medianRate = rates.length ? rates.slice().sort((a, b) => a - b)[Math.floor(rates.length / 2)] : 30;
  const medianQty = quantities.length ? quantities.slice().sort((a, b) => a - b)[Math.floor(quantities.length / 2)] : 5;

  const menuFocus = allItemsList.map((i) => {
    const isHighRate = i.price >= medianRate;
    const isHighQty = i.qty >= medianQty;
    let quadrant = "review";
    if (isHighRate && isHighQty) quadrant = "core";
    else if (isHighRate && !isHighQty) quadrant = "push";
    else if (!isHighRate && isHighQty) quadrant = "volume";

    return {
      name: i.key,
      category: i.category,
      qty: i.qty,
      logQty: round2(Math.log10(Math.max(1, i.qty)) + 1),
      price: i.price,
      amount: i.amount,
      orders: i.orders,
      quadrant,
    };
  });

  const list = (m) => Array.from(m.values()).sort((a, b) => b.amount - a.amount);
  const chronological = (m) => Array.from(m.values()).sort((a, b) => (a.key < b.key ? -1 : 1));

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
      peakHour: {
        label: peakHourLabel,
        amount: peakHourSales,
        perDayAvg: round2(peakHourSales / numDays),
      },
      takings4to8Share: gross ? round2((takings4to8 / gross) * 100) : 0,
      noKitchenShare: orders.length ? round2((noKitchenBillsCount / orders.length) * 100) : 0,
    },
    byPayment: list(byPayment),
    byMode: list(byMode),
    byStaff: list(byStaff),
    byCategory: list(byCategory),
    topItems: Array.from(byItem.values()).sort((a, b) => b.qty - a.qty).slice(0, 12),
    items: Array.from(byItem.values())
      .map((i) => Object.assign({}, i, {
        price: i.price,
        orders: i.orders,
        share: gross ? Math.round((i.amount / gross) * 1000) / 10 : 0,
        perDay: round2(i.qty / numDays),
      }))
      .sort((a, b) => b.amount - a.amount),
    byWeekday: [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const row = byWeekday.get(String(d));
      return { key: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d],
               amount: row ? row.amount : 0, orders: row ? row.orders : 0 };
    }),
    byDay: chronological(byDay),
    byHour: chronological(byHour),
    boughtTogether,
    slowMovers,
    dayByHourGrid,
    multiDayComparison: {
      days: comparisonDays,
      tradingHours,
      periodAvgHours,
    },
    customersDayByDay: {
      rows: customerDayRows,
      summary: customerMoveSummary,
    },
    menuFocus,
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
      o.no, getOrderBusinessDate(o), when.toLocaleTimeString(), o.tableName || "-", o.mode, o.status, detail,
      t.subtotal, t.discount, t.parcelCharge || 0, t.serviceCharge, t.tax, t.roundOff, t.total,
      (o.payment && o.payment.mode) || "", o.createdByName || "", o.paidByName || "",
      (o.customer && o.customer.name) || "", (o.customer && o.customer.phone) || "", o.note || "",
    ].map(esc).join(",");
  });
  return "\ufeff" + [header.join(","), ...rows].join("\n");
}

module.exports = {
  buildReport, ordersToCsv, buildCustomers, customersToCsv,
  normalisePhone, dateKey, todayKey, getOrderBusinessDate, paidBetween,
};
