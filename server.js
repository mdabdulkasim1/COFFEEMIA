"use strict";
/**
 * Coffeemia POS — counter server.
 * Zero external dependencies: Node built-in http/fs/crypto only.
 *
 * Roles:
 *   admin    — dashboard, full reports, menu + rates, tables, staff, settings,
 *              cancel/refund, day close.
 *   cashier   (user-1, user-2) — take orders on tables, print KOT and bills,
 *              settle payments, see today's own counter summary.
 */
process.env.TZ = process.env.TZ || "Asia/Kolkata";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const db = require("./lib/db");
const auth = require("./lib/auth");
const { seedIfEmpty, warnIfDefaultPasswords } = require("./lib/seed");
const { computeTotals, money, clampQty } = require("./lib/pricing");
const { buildReport, ordersToCsv, dateKey, todayKey } = require("./lib/reports");
const gstin = require("./lib/gstin");

const PORT = process.env.PORT || 3100;
const PUBLIC_DIR = path.join(__dirname, "public");

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                       */
/* ------------------------------------------------------------------ */
function send(res, status, body, headers) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}));
  res.end(payload);
}
function sendError(res, status, message) {
  send(res, status, { error: message });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error("Payload too large")); req.destroy(); return; }
      data += c;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function currentUser(req) {
  const s = auth.getSession(auth.tokenFromReq(req));
  if (!s) return null;
  const data = db.load();
  const u = data.users.find((x) => x.id === s.userId);
  return u && u.active ? u : null;
}
function publicUser(u) {
  return u && {
    id: u.id, username: u.username, name: u.name, role: u.role,
    active: !!u.active, hasPin: !!u.pinHash, createdAt: u.createdAt,
  };
}
function str(v, max) {
  return String(v === undefined || v === null ? "" : v).trim().slice(0, max || 120);
}
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback || 0);
}

/* ------------------------------------------------------------------ */
/* Static files                                                       */
/* ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 403, "Forbidden");
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // Unknown path: hand back the shell so client-side routing works.
      return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, shell) => {
        if (e2) return sendError(res, 404, "Not found");
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(shell);
      });
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Order helpers                                                      */
/* ------------------------------------------------------------------ */
function nextBillNo(data) {
  data.counters.bill = (data.counters.bill || 0) + 1;
  return data.counters.bill;
}
function nextToken(data) {
  const today = todayKey();
  if (data.counters.tokenDay !== today) {
    data.counters.tokenDay = today;
    data.counters.token = 0;
  }
  data.counters.token = (data.counters.token || 0) + 1;
  return data.counters.token;
}

/**
 * Normalise the lines a client sent against the live menu. Prices always come
 * from the menu (so a stale tab cannot bill yesterday's rate); "open items"
 * with no itemId carry their own name and price for one-off sales.
 * Existing lines are matched by id so kitchen-printed quantities survive edits.
 */
function normaliseLines(data, incoming, existing) {
  const prev = new Map((existing || []).map((l) => [l.id, l]));
  const catById = new Map(data.categories.map((c) => [c.id, c]));
  const out = [];
  for (const raw of incoming || []) {
    const qty = clampQty(raw.qty);
    if (qty <= 0) continue;
    const old = prev.get(raw.id);
    const item = raw.itemId ? data.items.find((i) => i.id === raw.itemId) : null;
    if (raw.itemId && !item) continue; // item deleted from the menu mid-order
    const cat = item ? catById.get(item.categoryId) : null;
    out.push({
      id: old ? old.id : db.id(),
      itemId: item ? item.id : null,
      name: item ? item.name : str(raw.name, 80) || "Item",
      localName: item ? item.localName || "" : str(raw.localName, 80),
      categoryName: cat ? cat.name : str(raw.categoryName, 60) || "Other",
      station: cat ? cat.station || "Kitchen" : "Kitchen",
      price: money(item ? item.price : Math.max(0, num(raw.price, 0))),
      qty,
      note: str(raw.note, 120),
      printedQty: old ? Math.min(old.printedQty || 0, qty) : 0,
    });
  }
  return out;
}

/** Anything taken off the bill after the kitchen already had it is logged. */
function recordVoids(order, before, after, user) {
  const afterById = new Map(after.map((l) => [l.id, l]));
  const log = order.voidLog || [];
  for (const old of before) {
    const now = afterById.get(old.id);
    const nowQty = now ? now.qty : 0;
    const printed = old.printedQty || 0;
    if (printed > 0 && nowQty < printed) {
      log.push({
        at: new Date().toISOString(),
        by: user.name,
        name: old.name,
        qty: printed - nowQty,
        amount: money((printed - nowQty) * old.price),
      });
    }
  }
  order.voidLog = log;
}

function applyTotals(data, order) {
  order.totals = computeTotals(order.lines, order, data.settings);
  return order;
}

function orderSummary(o) {
  return {
    id: o.id, no: o.no, token: o.token, tableId: o.tableId, tableName: o.tableName,
    mode: o.mode, status: o.status, total: (o.totals || {}).total || 0,
    itemCount: (o.totals || {}).itemCount || 0, createdAt: o.createdAt,
    createdByName: o.createdByName, kotCount: o.kotCount || 0,
    pendingKot: (o.lines || []).some((l) => l.qty > (l.printedQty || 0)),
  };
}

/* ------------------------------------------------------------------ */
/* Route handlers                                                     */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();
  const data = db.load();
  const seg = pathname.split("/").filter(Boolean); // ["api", ...]
  const route = seg.slice(1);

  /* ---------- open endpoints ---------- */
  if (route[0] === "login" && method === "POST") {
    const body = await readBody(req);
    let user = null;
    if (route[1] === "pin") {
      const pin = str(body.pin, 12);
      user = data.users.find((u) => u.active && u.pinHash && auth.verifySecret(pin, u.pinHash)) || null;
    } else {
      const username = str(body.username, 40).toLowerCase();
      user = data.users.find((u) => u.username.toLowerCase() === username) || null;
      if (user && !(user.active && auth.verifySecret(str(body.password, 200), user.passwordHash))) user = null;
    }
    if (!user) return sendError(res, 401, "Wrong login details. Please try again.");
    auth.setSessionCookie(res, auth.createSession(user.id));
    user.lastLoginAt = new Date().toISOString();
    db.save();
    return send(res, 200, { user: publicUser(user) });
  }

  if (route[0] === "branding" && method === "GET") {
    const b = data.settings || {};
    return send(res, 200, {
      settings: {
        cafeName: b.cafeName, cafeNameLocal: b.cafeNameLocal,
        tagline: b.tagline, currency: b.currency,
      },
    });
  }

  if (route[0] === "logout" && method === "POST") {
    auth.destroySession(auth.tokenFromReq(req));
    auth.clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  /* ---------- everything below needs a session ---------- */
  const me = currentUser(req);
  if (!me) return sendError(res, 401, "Please sign in.");
  const isAdmin = me.role === "admin";
  const needAdmin = () => {
    if (!isAdmin) { sendError(res, 403, "Only the admin can do this."); return true; }
    return false;
  };

  if (route[0] === "me") {
    if (route[1] === "password" && method === "POST") {
      const body = await readBody(req);
      if (!auth.verifySecret(str(body.current, 200), me.passwordHash)) {
        return sendError(res, 400, "Current password is not correct.");
      }
      const next = str(body.password, 200);
      if (next.length < 6) return sendError(res, 400, "New password must be at least 6 characters.");
      me.passwordHash = auth.hashSecret(next);
      if (body.pin !== undefined && str(body.pin, 12)) {
        const pin = str(body.pin, 12);
        if (!/^\d{4,6}$/.test(pin)) return sendError(res, 400, "PIN must be 4 to 6 digits.");
        me.pinHash = auth.hashSecret(pin);
      }
      db.save();
      return send(res, 200, { ok: true });
    }
    if (method === "GET") return send(res, 200, { user: publicUser(me) });
  }

  /* ---------- bootstrap ---------- */
  if (route[0] === "bootstrap" && method === "GET") {
    return send(res, 200, {
      user: publicUser(me),
      settings: data.settings,
      gstinInfo: gstin.validate(data.settings.gstin),
      categories: data.categories.slice().sort((a, b) => a.sort - b.sort),
      items: data.items.slice().sort((a, b) => a.sort - b.sort),
      tables: data.tables.slice().sort((a, b) => a.sort - b.sort),
      openOrders: data.orders.filter((o) => o.status === "open").map(orderSummary),
      today: todayKey(),
    });
  }

  /* ---------- settings ---------- */
  if (route[0] === "settings") {
    if (method === "GET") {
      return send(res, 200, { settings: data.settings, gstinInfo: gstin.validate(data.settings.gstin) });
    }
    if (method === "PUT") {
      if (needAdmin()) return;
      const body = await readBody(req);
      const s = data.settings;
      const textKeys = ["cafeName", "cafeNameLocal", "tagline", "address", "phone", "currency", "taxName", "footerNote", "printWidth"];
      for (const k of textKeys) if (k in body) s[k] = str(body[k], k === "footerNote" ? 200 : 120);
      if ("gstNote" in body) s.gstNote = str(body.gstNote, 200);
      let gstinCheck = gstin.validate(s.gstin);
      if ("gstin" in body) {
        gstinCheck = gstin.validate(body.gstin);
        if (!gstinCheck.ok) return sendError(res, 400, gstinCheck.error);
        s.gstin = gstinCheck.value;
      }
      if ("taxMode" in body) s.taxMode = body.taxMode === "exclusive" ? "exclusive" : "inclusive";
      for (const k of ["taxEnabled", "serviceChargeEnabled", "roundOff", "showLocalNames", "printKotOnSave", "splitGst"]) {
        if (k in body) s[k] = !!body[k];
      }
      for (const k of ["taxPercent", "serviceChargePercent"]) {
        if (k in body) s[k] = Math.min(Math.max(num(body[k], 0), 0), 100);
      }
      if (Array.isArray(body.paymentModes)) {
        const modes = body.paymentModes.map((m) => str(m, 20)).filter(Boolean).slice(0, 8);
        if (modes.length) s.paymentModes = modes;
      }
      if (s.printWidth !== "58mm") s.printWidth = "80mm";
      db.save();
      return send(res, 200, { settings: s, gstinInfo: gstinCheck });
    }
  }

  /* ---------- categories ---------- */
  if (route[0] === "categories") {
    if (method === "GET") return send(res, 200, { categories: data.categories });
    if (needAdmin()) return;
    const body = method === "DELETE" ? {} : await readBody(req);
    if (method === "POST") {
      const cat = {
        id: db.id(),
        name: str(body.name, 60),
        localName: str(body.localName, 60),
        station: body.station === "Beverages" ? "Beverages" : "Kitchen",
        sort: num(body.sort, data.categories.length),
        active: body.active === undefined ? true : !!body.active,
      };
      if (!cat.name) return sendError(res, 400, "Category name is required.");
      data.categories.push(cat);
      db.save();
      return send(res, 201, { category: cat });
    }
    const cat = data.categories.find((c) => c.id === route[1]);
    if (!cat) return sendError(res, 404, "Category not found.");
    if (method === "PUT") {
      if ("name" in body) cat.name = str(body.name, 60) || cat.name;
      if ("localName" in body) cat.localName = str(body.localName, 60);
      if ("station" in body) cat.station = body.station === "Beverages" ? "Beverages" : "Kitchen";
      if ("sort" in body) cat.sort = num(body.sort, cat.sort);
      if ("active" in body) cat.active = !!body.active;
      db.save();
      return send(res, 200, { category: cat });
    }
    if (method === "DELETE") {
      if (data.items.some((i) => i.categoryId === cat.id)) {
        return sendError(res, 400, "Move or delete this category's items first.");
      }
      data.categories = data.categories.filter((c) => c.id !== cat.id);
      db.save();
      return send(res, 200, { ok: true });
    }
  }

  /* ---------- menu items ---------- */
  if (route[0] === "items") {
    if (method === "GET") return send(res, 200, { items: data.items });
    if (needAdmin()) return;

    if (route[1] === "prices" && method === "PUT") {
      // Bulk rate update from the rate editor.
      const body = await readBody(req);
      let n = 0;
      for (const row of body.prices || []) {
        const item = data.items.find((i) => i.id === row.id);
        if (!item) continue;
        const price = Math.max(0, num(row.price, item.price));
        if (price !== item.price) {
          item.priceHistory = (item.priceHistory || []).concat({
            at: new Date().toISOString(), by: me.name, from: item.price, to: money(price),
          }).slice(-20);
          item.price = money(price);
          n++;
        }
      }
      db.save();
      return send(res, 200, { updated: n, items: data.items });
    }

    const body = method === "DELETE" ? {} : await readBody(req);
    if (method === "POST") {
      const cat = data.categories.find((c) => c.id === body.categoryId);
      if (!cat) return sendError(res, 400, "Pick a valid category.");
      const item = {
        id: db.id(),
        categoryId: cat.id,
        name: str(body.name, 80),
        localName: str(body.localName, 80),
        code: str(body.code, 8).toUpperCase(),
        price: money(Math.max(0, num(body.price, 0))),
        available: body.available === undefined ? true : !!body.available,
        sort: num(body.sort, data.items.filter((i) => i.categoryId === cat.id).length),
      };
      if (!item.name) return sendError(res, 400, "Item name is required.");
      data.items.push(item);
      db.save();
      return send(res, 201, { item });
    }
    const item = data.items.find((i) => i.id === route[1]);
    if (!item) return sendError(res, 404, "Item not found.");
    if (method === "PUT") {
      if ("name" in body) item.name = str(body.name, 80) || item.name;
      if ("localName" in body) item.localName = str(body.localName, 80);
      if ("code" in body) item.code = str(body.code, 8).toUpperCase();
      if ("categoryId" in body && data.categories.some((c) => c.id === body.categoryId)) {
        item.categoryId = body.categoryId;
      }
      if ("price" in body) {
        const price = money(Math.max(0, num(body.price, item.price)));
        if (price !== item.price) {
          item.priceHistory = (item.priceHistory || []).concat({
            at: new Date().toISOString(), by: me.name, from: item.price, to: price,
          }).slice(-20);
          item.price = price;
        }
      }
      if ("available" in body) item.available = !!body.available;
      if ("sort" in body) item.sort = num(body.sort, item.sort);
      db.save();
      return send(res, 200, { item });
    }
    if (method === "DELETE") {
      // Kept out of the picker but retained if it appears on past bills.
      const used = data.orders.some((o) => (o.lines || []).some((l) => l.itemId === item.id));
      if (used) { item.available = false; item.archived = true; }
      else data.items = data.items.filter((i) => i.id !== item.id);
      db.save();
      return send(res, 200, { ok: true, archived: used });
    }
  }

  /* ---------- tables ---------- */
  if (route[0] === "tables") {
    if (method === "GET") return send(res, 200, { tables: data.tables });
    if (needAdmin()) return;
    const body = method === "DELETE" ? {} : await readBody(req);

    if (route[1] === "generate" && method === "POST") {
      const count = Math.min(Math.max(num(body.count, 0), 0), 60);
      const zone = str(body.zone, 40) || "Main";
      const prefix = str(body.prefix, 20) || "Table";
      const start = data.tables.length;
      for (let i = 1; i <= count; i++) {
        data.tables.push({
          id: db.id(), name: `${prefix} ${start + i}`, zone,
          seats: Math.max(1, num(body.seats, 4)), sort: start + i, active: true,
        });
      }
      db.save();
      return send(res, 200, { tables: data.tables });
    }

    if (method === "POST") {
      const table = {
        id: db.id(),
        name: str(body.name, 40),
        zone: str(body.zone, 40) || "Main",
        seats: Math.max(1, num(body.seats, 4)),
        sort: num(body.sort, data.tables.length + 1),
        active: true,
      };
      if (!table.name) return sendError(res, 400, "Table name is required.");
      data.tables.push(table);
      db.save();
      return send(res, 201, { table });
    }
    const table = data.tables.find((t) => t.id === route[1]);
    if (!table) return sendError(res, 404, "Table not found.");
    if (method === "PUT") {
      if ("name" in body) table.name = str(body.name, 40) || table.name;
      if ("zone" in body) table.zone = str(body.zone, 40) || table.zone;
      if ("seats" in body) table.seats = Math.max(1, num(body.seats, table.seats));
      if ("sort" in body) table.sort = num(body.sort, table.sort);
      if ("active" in body) table.active = !!body.active;
      db.save();
      return send(res, 200, { table });
    }
    if (method === "DELETE") {
      if (data.orders.some((o) => o.status === "open" && o.tableId === table.id)) {
        return sendError(res, 400, "Settle this table's running bill first.");
      }
      data.tables = data.tables.filter((t) => t.id !== table.id);
      db.save();
      return send(res, 200, { ok: true });
    }
  }

  /* ---------- staff ---------- */
  if (route[0] === "users") {
    if (needAdmin()) return;
    if (method === "GET") return send(res, 200, { users: data.users.map(publicUser) });
    const body = method === "DELETE" ? {} : await readBody(req);

    if (method === "POST" && !route[1]) {
      const username = str(body.username, 40).toLowerCase();
      if (!/^[a-z0-9_.-]{3,40}$/.test(username)) {
        return sendError(res, 400, "Username: 3+ characters, letters/numbers only.");
      }
      if (data.users.some((u) => u.username.toLowerCase() === username)) {
        return sendError(res, 400, "That username is already taken.");
      }
      const password = str(body.password, 200);
      if (password.length < 6) return sendError(res, 400, "Password must be at least 6 characters.");
      const user = {
        id: db.id(),
        username,
        name: str(body.name, 60) || username,
        role: body.role === "admin" ? "admin" : "cashier",
        passwordHash: auth.hashSecret(password),
        pinHash: /^\d{4,6}$/.test(str(body.pin, 12)) ? auth.hashSecret(str(body.pin, 12)) : null,
        active: true,
        createdAt: new Date().toISOString(),
      };
      data.users.push(user);
      db.save();
      return send(res, 201, { user: publicUser(user) });
    }

    const user = data.users.find((u) => u.id === route[1]);
    if (!user) return sendError(res, 404, "Staff member not found.");

    if (route[2] === "password" && method === "POST") {
      const password = str(body.password, 200);
      if (password.length < 6) return sendError(res, 400, "Password must be at least 6 characters.");
      user.passwordHash = auth.hashSecret(password);
      if (str(body.pin, 12)) {
        if (!/^\d{4,6}$/.test(str(body.pin, 12))) return sendError(res, 400, "PIN must be 4 to 6 digits.");
        user.pinHash = auth.hashSecret(str(body.pin, 12));
      }
      auth.destroyUserSessions(user.id);
      db.save();
      return send(res, 200, { ok: true });
    }
    if (method === "PUT") {
      if ("name" in body) user.name = str(body.name, 60) || user.name;
      if ("role" in body && user.id !== me.id) user.role = body.role === "admin" ? "admin" : "cashier";
      if ("active" in body && user.id !== me.id) {
        user.active = !!body.active;
        if (!user.active) auth.destroyUserSessions(user.id);
      }
      db.save();
      return send(res, 200, { user: publicUser(user) });
    }
    if (method === "DELETE") {
      if (user.id === me.id) return sendError(res, 400, "You cannot remove your own login.");
      if (data.users.filter((u) => u.role === "admin" && u.active).length <= 1 && user.role === "admin") {
        return sendError(res, 400, "Keep at least one active admin.");
      }
      auth.destroyUserSessions(user.id);
      data.users = data.users.filter((u) => u.id !== user.id);
      db.save();
      return send(res, 200, { ok: true });
    }
  }

  /* ---------- orders ---------- */
  if (route[0] === "orders") {
    if (method === "GET" && !route[1]) {
      const from = str(query.from, 10) || todayKey();
      const to = str(query.to, 10) || from;
      const status = str(query.status, 20);
      let list = data.orders.filter((o) => {
        if (status && o.status !== status) return false;
        if (o.status === "open") return true;
        return o.businessDate >= from && o.businessDate <= to;
      });
      if (!isAdmin) list = list.filter((o) => o.businessDate === todayKey() || o.status === "open");
      list = list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, Math.min(num(query.limit, 300), 1000));
      return send(res, 200, { orders: list });
    }

    if (method === "POST" && !route[1]) {
      const body = await readBody(req);
      const table = data.tables.find((t) => t.id === body.tableId) || null;
      const mode = ["dine-in", "takeaway", "parcel"].includes(body.mode) ? body.mode : (table ? "dine-in" : "takeaway");
      if (mode === "dine-in" && !table) return sendError(res, 400, "Pick a table for a dine-in order.");
      if (table && data.orders.some((o) => o.status === "open" && o.tableId === table.id)) {
        return sendError(res, 409, `${table.name} already has a running bill — open it instead.`);
      }
      const now = new Date().toISOString();
      const order = {
        id: db.id(),
        no: null,
        token: nextToken(data),
        tableId: table ? table.id : null,
        tableName: table ? table.name : (mode === "parcel" ? "Parcel" : "Takeaway"),
        mode,
        status: "open",
        lines: normaliseLines(data, body.lines, []),
        discountType: body.discountType === "percent" ? "percent" : "amount",
        discountValue: Math.max(0, num(body.discountValue, 0)),
        customer: { name: str(body.customerName, 60), phone: str(body.customerPhone, 20) },
        note: str(body.note, 200),
        kotCount: 0,
        voidLog: [],
        createdBy: me.id,
        createdByName: me.name,
        createdAt: now,
        updatedAt: now,
        businessDate: dateKey(now),
      };
      applyTotals(data, order);
      data.orders.push(order);
      db.save();
      return send(res, 201, { order });
    }

    const order = data.orders.find((o) => o.id === route[1]);
    if (!order) return sendError(res, 404, "Order not found.");

    if (method === "GET") return send(res, 200, { order });

    if (route[2] === "kot" && method === "POST") {
      if (order.status !== "open") return sendError(res, 400, "This bill is already closed.");
      const pending = order.lines
        .filter((l) => l.qty > (l.printedQty || 0))
        .map((l) => ({ name: l.name, localName: l.localName, station: l.station, note: l.note, qty: l.qty - (l.printedQty || 0) }));
      if (!pending.length) return sendError(res, 400, "Nothing new to send to the kitchen.");
      order.kotCount = (order.kotCount || 0) + 1;
      order.lines.forEach((l) => { l.printedQty = l.qty; });
      order.updatedAt = new Date().toISOString();
      db.save();
      return send(res, 200, {
        order,
        kot: {
          no: order.kotCount, token: order.token, tableName: order.tableName, mode: order.mode,
          at: order.updatedAt, by: me.name, lines: pending, note: order.note,
        },
      });
    }

    if (route[2] === "transfer" && method === "POST") {
      if (order.status !== "open") return sendError(res, 400, "This bill is already closed.");
      const body = await readBody(req);
      const table = data.tables.find((t) => t.id === body.tableId);
      if (!table) return sendError(res, 400, "Pick a table to move to.");
      if (data.orders.some((o) => o.status === "open" && o.tableId === table.id && o.id !== order.id)) {
        return sendError(res, 409, `${table.name} already has a running bill.`);
      }
      order.tableId = table.id;
      order.tableName = table.name;
      order.mode = "dine-in";
      order.updatedAt = new Date().toISOString();
      db.save();
      return send(res, 200, { order });
    }

    if (route[2] === "merge" && method === "POST") {
      if (order.status !== "open") return sendError(res, 400, "This bill is already closed.");
      const body = await readBody(req);
      const source = data.orders.find((o) => o.id === body.fromOrderId && o.status === "open");
      if (!source || source.id === order.id) return sendError(res, 400, "Pick another running table to merge.");
      order.lines = order.lines.concat(source.lines.map((l) => Object.assign({}, l, { id: db.id() })));
      order.voidLog = (order.voidLog || []).concat(source.voidLog || []);
      order.kotCount = (order.kotCount || 0) + (source.kotCount || 0);
      source.status = "cancelled";
      source.merged = true; // a merge is not a cancellation — keep it out of the void figures
      source.voidLog = [];
      source.cancelReason = `Merged into ${order.tableName}`;
      source.cancelledAt = new Date().toISOString();
      source.cancelledByName = me.name;
      applyTotals(data, order);
      order.updatedAt = new Date().toISOString();
      db.save();
      return send(res, 200, { order });
    }

    if (route[2] === "pay" && method === "POST") {
      if (order.status !== "open") return sendError(res, 400, "This bill is already settled.");
      const body = await readBody(req);
      if (!order.lines.length) return sendError(res, 400, "Add at least one item before settling.");
      applyTotals(data, order);
      const mode = str(body.mode, 20) || "Cash";
      const received = Math.max(0, num(body.received, order.totals.total));
      order.payment = {
        mode,
        received: money(received),
        change: money(Math.max(0, received - order.totals.total)),
        note: str(body.note, 120),
      };
      order.status = "paid";
      order.no = nextBillNo(data);
      order.paidAt = new Date().toISOString();
      order.paidBy = me.id;
      order.paidByName = me.name;
      order.businessDate = dateKey(order.paidAt);
      order.updatedAt = order.paidAt;
      db.save();
      return send(res, 200, { order });
    }

    if (route[2] === "cancel" && method === "POST") {
      const body = await readBody(req);
      if (order.status === "cancelled") return send(res, 200, { order });
      // A cashier may drop a bill they have not settled; anything paid is the admin's call.
      if (order.status === "paid" && !isAdmin) return sendError(res, 403, "Only the admin can cancel a settled bill.");
      order.status = "cancelled";
      order.cancelReason = str(body.reason, 200) || "Cancelled";
      order.cancelledAt = new Date().toISOString();
      order.cancelledByName = me.name;
      order.updatedAt = order.cancelledAt;
      db.save();
      return send(res, 200, { order });
    }

    if (method === "PUT" || (method === "POST" && !route[2])) {
      if (order.status !== "open") return sendError(res, 400, "This bill is already closed.");
      const body = await readBody(req);
      const before = order.lines;
      const after = normaliseLines(data, body.lines, before);
      recordVoids(order, before, after, me);
      order.lines = after;
      if ("discountType" in body) order.discountType = body.discountType === "percent" ? "percent" : "amount";
      if ("discountValue" in body) order.discountValue = Math.max(0, num(body.discountValue, 0));
      if ("mode" in body && ["dine-in", "takeaway", "parcel"].includes(body.mode)) order.mode = body.mode;
      if ("tableId" in body) {
        const target = body.tableId ? data.tables.find((t) => t.id === body.tableId) : null;
        if (body.tableId && !target) return sendError(res, 400, "Table not found.");
        if (target && data.orders.some((o) => o.status === "open" && o.tableId === target.id && o.id !== order.id)) {
          return sendError(res, 409, `${target.name} already has a running bill.`);
        }
        order.tableId = target ? target.id : null;
        order.tableName = target ? target.name : order.mode === "parcel" ? "Parcel" : "Takeaway";
      }
      if ("customerName" in body) order.customer.name = str(body.customerName, 60);
      if ("customerPhone" in body) order.customer.phone = str(body.customerPhone, 20);
      if ("note" in body) order.note = str(body.note, 200);
      applyTotals(data, order);
      order.updatedAt = new Date().toISOString();
      db.save();
      return send(res, 200, { order });
    }
  }

  /* ---------- reports ---------- */
  if (route[0] === "dashboard" && method === "GET") {
    let from = str(query.from, 10) || todayKey();
    let to = str(query.to, 10) || from;
    if (!isAdmin) { from = todayKey(); to = from; } // counters see today only
    const report = buildReport(data, from, to);
    if (!isAdmin) {
      report.mine = (report.byStaff.find((r) => r.key === me.name) || { amount: 0, orders: 0 });
    }
    return send(res, 200, { report });
  }

  if (route[0] === "dayclose" && method === "GET") {
    if (needAdmin()) return;
    const date = str(query.date, 10) || todayKey();
    const report = buildReport(data, date, date);
    const orders = data.orders.filter((o) => o.businessDate === date && o.status === "paid");
    report.voids = data.orders
      .filter((o) => o.businessDate === date)
      .flatMap((o) => (o.voidLog || []).map((v) => Object.assign({ table: o.tableName }, v)));
    report.firstBill = orders.length ? Math.min(...orders.map((o) => o.no)) : null;
    report.lastBill = orders.length ? Math.max(...orders.map((o) => o.no)) : null;
    return send(res, 200, { report, settings: data.settings });
  }

  if (route[0] === "export" && route[1] === "orders.csv" && method === "GET") {
    if (needAdmin()) return;
    const from = str(query.from, 10) || todayKey();
    const to = str(query.to, 10) || from;
    const list = data.orders
      .filter((o) => o.businessDate >= from && o.businessDate <= to && o.status !== "open")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return send(res, 200, ordersToCsv(data, list), {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="coffeemia-sales-${from}-to-${to}.csv"`,
    });
  }

  return sendError(res, 404, "Unknown endpoint.");
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, parsed.query || {});
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (err) {
    console.error("[pos]", err);
    if (!res.headersSent) sendError(res, 500, err.message || "Something went wrong.");
  }
});

if (require.main === module) {
  const data = seedIfEmpty();
  server.listen(PORT, () => {
    console.log(`[pos] Coffeemia POS running on http://localhost:${PORT}`);
    console.log(`[pos] Data file: ${db.DB_FILE}`);
    warnIfDefaultPasswords(data);
  });
}

module.exports = server;
