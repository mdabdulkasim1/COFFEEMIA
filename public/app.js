/* Coffeemia POS — single-page counter app.
   Screens: floor (tables), order taking, dashboard, bills, menu & rates,
   table layout, staff and settings. Server is the source of truth for money;
   this file keeps a live preview so the counter never waits on the network. */
(function () {
  "use strict";

  /* ================================================================== */
  /* State                                                              */
  /* ================================================================== */
  const S = {
    user: null,
    settings: {},
    categories: [],
    items: [],
    tables: [],
    openOrders: [],
    today: "",
    route: { name: "floor", params: {} },
    cart: null,
    view: {},           // per-screen scratch (filters, active category, ...)
    saving: false,
    dirty: false,
  };

  const app = document.getElementById("app");

  /* ================================================================== */
  /* Small helpers                                                      */
  /* ================================================================== */
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }
  /** Rupees read better without trailing zeros on screen; receipts keep 2dp. */
  function fmt(n) {
    const v = round2(n);
    return (S.settings.currency || "") + (Number.isInteger(v) ? v : v.toFixed(2));
  }
  function plain(n) {
    const v = round2(n);
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  function todayStr() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function since(iso) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return mins + " min";
    return Math.floor(mins / 60) + "h " + (mins % 60) + "m";
  }
  function timeOf(iso) {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }
  function isAdmin() {
    return S.user && S.user.role === "admin";
  }

  function toast(message, kind) {
    let host = document.querySelector(".toast-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), kind === "bad" ? 4200 : kind === "warn" ? 8000 : 2400);
  }

  /* ================================================================== */
  /* API                                                                */
  /* ================================================================== */
  async function api(path, opts) {
    const o = Object.assign({ method: "GET" }, opts || {});
    const init = { method: o.method, credentials: "same-origin", headers: {} };
    if (o.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(o.body);
    }
    const res = await fetch("/api" + path, init);
    if (res.status === 401) {
      S.user = null;
      renderLogin();
      throw new Error("Signed out — please sign in again.");
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  /** Wraps an async handler so every failure surfaces as a toast, never silence. */
  function guard(fn) {
    return async function (...args) {
      try { await fn(...args); }
      catch (err) { toast(err.message || "Something went wrong", "bad"); }
    };
  }

  /* ================================================================== */
  /* Modal + confirm                                                    */
  /* ================================================================== */
  function modal(opts) {
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.className = "modal-host";
      host.innerHTML =
        '<div class="modal"><div class="card-head"><h3>' + esc(opts.title) + "</h3></div>" +
        '<div class="modal-body">' + (opts.body || "") + "</div>" +
        '<div class="modal-foot">' +
        '<button class="btn" data-x="cancel">' + esc(opts.cancelText || "Cancel") + "</button>" +
        '<button class="btn ' + (opts.danger ? "danger" : "primary") + '" data-x="ok">' + esc(opts.okText || "Confirm") + "</button>" +
        "</div></div>";
      document.body.appendChild(host);
      const close = (value) => { host.remove(); resolve(value); };
      host.addEventListener("click", (e) => {
        if (e.target === host) return close(null);
        const x = e.target.closest("[data-x]");
        if (!x) return;
        if (x.dataset.x === "cancel") return close(null);
        const form = {};
        host.querySelectorAll("[name]").forEach((f) => {
          form[f.name] = f.type === "checkbox" ? f.checked : f.value;
        });
        if (opts.validate) {
          const err = opts.validate(form);
          if (err) return toast(err, "bad");
        }
        close(form);
      });
      host.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close(null);
        if (e.key === "Enter" && e.target.tagName === "INPUT" && !opts.multiline) {
          host.querySelector('[data-x="ok"]').click();
        }
      });
      const first = host.querySelector("input, select, textarea");
      if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 40);
      if (opts.onOpen) opts.onOpen(host);
    });
  }

  function confirmBox(title, message, okText, danger) {
    return modal({
      title,
      body: '<p style="margin:0;line-height:1.6">' + esc(message) + "</p>",
      okText: okText || "Yes, continue",
      danger: danger !== false,
    });
  }

  /* ================================================================== */
  /* Login                                                              */
  /* ================================================================== */
  let loginMode = "password";
  let pinBuffer = "";

  function renderLogin(message) {
    document.body.classList.remove("app-ready");
    app.innerHTML =
      '<div class="login-wrap"><div class="login-card">' +
      '<div class="login-brand">' +
      "<h1>" + esc(S.settings.cafeName || "Coffeemia") + "</h1>" +
      (S.settings.cafeNameLocal !== undefined
        ? '<div class="local">' + esc(S.settings.cafeNameLocal || "காஃபீமியா") + "</div>"
        : '<div class="local">காஃபீமியா</div>') +
      '<div class="rule"></div>' +
      '<div class="tag">' + esc(S.settings.tagline || "Tea · Coffee · Juice · Snacks") + "</div>" +
      "</div>" +
      '<div class="tabs-lite">' +
      '<button class="' + (loginMode === "password" ? "on" : "") + '" data-act="login-mode" data-mode="password">Username</button>' +
      '<button class="' + (loginMode === "pin" ? "on" : "") + '" data-act="login-mode" data-mode="pin">Quick PIN</button>' +
      "</div>" +
      (loginMode === "password" ? passwordForm() : pinForm()) +
      (message ? '<p class="hint" style="color:var(--red)">' + esc(message) + "</p>" : "") +
      '<p class="hint">Counter staff sign in with a PIN. Ask the owner for your login.</p>' +
      "</div></div>";
  }

  function passwordForm() {
    return (
      '<form data-act="login-submit">' +
      '<label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" autocapitalize="none" required></label>' +
      '<label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>' +
      '<button class="btn primary block lg" type="submit">Sign in</button></form>'
    );
  }

  function pinForm() {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];
    return (
      '<div class="pin-display">' + "•".repeat(pinBuffer.length) + "</div>" +
      '<div class="pinpad">' +
      keys.map((k) =>
        '<button data-act="pin-key" data-key="' + k + '">' +
        (k === "clear" ? "C" : k === "back" ? "⌫" : k) + "</button>"
      ).join("") +
      "</div>" +
      '<button class="btn primary block lg" style="margin-top:12px" data-act="pin-submit">Sign in</button>'
    );
  }

  const doLogin = guard(async function (body, path) {
    const out = await api(path || "/login", { method: "POST", body });
    S.user = out.user;
    pinBuffer = "";
    await boot();
  });

  /* ================================================================== */
  /* Boot                                                               */
  /* ================================================================== */
  async function boot() {
    const data = await api("/bootstrap");
    S.user = data.user;
    S.settings = data.settings;
    S.gstinInfo = data.gstinInfo || null;
    S.categories = data.categories.filter((c) => c.active !== false);
    S.items = data.items;
    S.tables = data.tables;
    S.openOrders = data.openOrders;
    S.today = data.today;
    document.title = (S.settings.cafeName || "Cafe") + " POS";
    document.body.classList.add("app-ready");
    if (!location.hash || location.hash === "#/") location.hash = "#/floor";
    route();
  }

  async function refreshOpenOrders() {
    const data = await api("/bootstrap");
    S.openOrders = data.openOrders;
    S.settings = data.settings;
    S.items = data.items;
    S.categories = data.categories.filter((c) => c.active !== false);
    S.tables = data.tables;
  }

  /* ================================================================== */
  /* Router                                                             */
  /* ================================================================== */
  const ROUTES = {
    floor: { title: "Tables", render: renderFloor },
    order: { title: "Order", render: renderOrder },
    dashboard: { title: "Dashboard", render: renderDashboard },
    bills: { title: "Bills & reports", render: renderBills },
    menu: { title: "Menu & rates", render: renderMenu, admin: true },
    tables: { title: "Table layout", render: renderTablesAdmin, admin: true },
    staff: { title: "Staff & access", render: renderStaff, admin: true },
    settings: { title: "Settings", render: renderSettings },
  };

  function parseHash() {
    const raw = (location.hash || "#/floor").replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean);
    return { name: parts[0] || "floor", params: parts.slice(1) };
  }

  function route() {
    if (!S.user) return renderLogin();
    const parsed = parseHash();
    const def = ROUTES[parsed.name] || ROUTES.floor;
    if (def.admin && !isAdmin()) {
      toast("That section is for the admin only.", "bad");
      location.hash = "#/floor";
      return;
    }
    S.route = { name: ROUTES[parsed.name] ? parsed.name : "floor", params: parsed.params };
    renderShell();
    Promise.resolve(def.render(parsed.params)).catch((e) => toast(e.message, "bad"));
  }

  window.addEventListener("hashchange", route);

  /* ================================================================== */
  /* Shell                                                              */
  /* ================================================================== */
  const NAV = [
    { group: "Counter" },
    { key: "floor", label: "Tables", icon: "🍽" },
    { key: "order", label: "Quick order", icon: "⚡", hash: "#/order/quick/takeaway" },
    { key: "bills", label: "Bills", icon: "🧾" },
    { group: "Business" },
    { key: "dashboard", label: "Dashboard", icon: "📊" },
    { key: "menu", label: "Menu & rates", icon: "📋", admin: true },
    { key: "tables", label: "Table layout", icon: "🪑", admin: true },
    { key: "staff", label: "Staff & access", icon: "👥", admin: true },
    { key: "settings", label: "Settings", icon: "⚙" },
  ];

  function renderShell() {
    const running = S.openOrders.length;
    const nav = NAV.map((n) => {
      if (n.group) return '<div class="nav-sep">' + esc(n.group) + "</div>";
      if (n.admin && !isAdmin()) return "";
      const on = S.route.name === n.key && !(n.hash && S.route.params[0] !== "quick");
      return (
        '<a class="nav-item ' + (on ? "on" : "") + '" href="' + (n.hash || "#/" + n.key) + '">' +
        '<span class="ico">' + n.icon + "</span>" + esc(n.label) +
        (n.key === "floor" && running ? '<span class="pill busy" style="margin-left:auto">' + running + "</span>" : "") +
        "</a>"
      );
    }).join("");

    const title = (ROUTES[S.route.name] || ROUTES.floor).title;
    app.innerHTML =
      '<div class="shell">' +
      '<aside class="sidebar" id="sidebar">' +
      '<div class="logo"><b>' + esc(S.settings.cafeName || "Cafe") + "</b><span>Point of sale</span></div>" +
      nav +
      '<div class="foot"><b>' + esc(S.user.name) + "</b>" +
      (isAdmin() ? "Admin" : "Counter staff") + " · " + esc(S.user.username) +
      '<button class="btn sm ghost" style="margin-top:10px;width:100%;color:#efe7db;border-color:#3d372f" data-act="logout">Sign out</button>' +
      "</div></aside>" +
      '<div class="main">' +
      '<header class="topbar">' +
      '<button class="btn sm menu-toggle" data-act="toggle-nav">☰</button>' +
      '<div><h2>' + esc(title) + '</h2><div class="sub" id="topbar-sub"></div></div>' +
      '<div class="spacer"></div>' +
      '<div class="small muted" style="text-align:right">' + new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) +
      "<br>" + esc(S.user.name) + "</div>" +
      "</header>" +
      '<div class="content" id="screen"><div class="empty">Loading…</div></div>' +
      "</div></div>";
  }

  function screen() {
    return document.getElementById("screen");
  }
  function setSub(text) {
    const el = document.getElementById("topbar-sub");
    if (el) el.textContent = text || "";
  }

  /* ================================================================== */
  /* Floor / tables                                                     */
  /* ================================================================== */
  function openOrderFor(tableId) {
    return S.openOrders.find((o) => o.tableId === tableId);
  }

  async function renderFloor() {
    await refreshOpenOrders();
    const counter = S.openOrders.filter((o) => !o.tableId);
    const runningValue = S.openOrders.reduce((s, o) => s + o.total, 0);
    setSub(S.openOrders.length
      ? plural(S.openOrders.length, "bill") + " running · " + fmt(runningValue) + " on the floor"
      : "All tables free");

    const cards = S.tables
      .filter((t) => t.active !== false)
      .sort((a, b) => a.sort - b.sort)
      .map((t) => {
        const o = openOrderFor(t.id);
        return (
          '<button class="table-card ' + (o ? "busy" : "") + (o && o.pendingKot ? " kot" : "") + '" ' +
          'data-act="open-table" data-table="' + t.id + '" data-order="' + (o ? o.id : "") + '">' +
          '<div class="top"><div><b>' + esc(t.name) + "</b>" +
          '<div class="zone">' + esc(t.zone || "") + " · " + (t.seats || 4) + " seats</div></div>" +
          '<span class="pill ' + (o ? "busy" : "free") + '">' + (o ? "Running" : "Free") + "</span></div>" +
          (o
            ? '<div class="amt">' + fmt(o.total) + '</div><div class="meta">' + o.itemCount + " items · " + since(o.createdAt) + " · " + esc(o.createdByName) + "</div>"
            : '<div class="amt" style="color:var(--ink-3)">—</div><div class="meta">Tap to start a bill</div>')
        ) + "</button>";
      })
      .join("");

    const counterCards = counter.map((o) =>
      '<button class="table-card busy ' + (o.pendingKot ? "kot" : "") + '" data-act="open-order" data-order="' + o.id + '">' +
      '<div class="top"><div><b>' + esc(o.tableName) + '</b><div class="zone">Token ' + o.token + "</div></div>" +
      '<span class="pill busy">Running</span></div>' +
      '<div class="amt">' + fmt(o.total) + '</div><div class="meta">' + o.itemCount + " items · " + since(o.createdAt) + "</div></button>"
    ).join("");

    screen().innerHTML =
      '<div class="floor-strip">' +
      '<button class="btn primary lg" data-act="quick" data-mode="takeaway">＋ Takeaway bill</button>' +
      '<button class="btn lg" data-act="quick" data-mode="parcel">＋ Parcel</button>' +
      '<button class="btn lg ghost" data-act="refresh-floor">⟳ Refresh</button>' +
      "</div>" +
      (counterCards
        ? '<h3 style="font-size:14px;margin:4px 0 10px;color:var(--ink-2)">Counter &amp; parcel</h3><div class="table-grid" style="margin-bottom:22px">' + counterCards + "</div>"
        : "") +
      '<h3 style="font-size:14px;margin:4px 0 10px;color:var(--ink-2)">Dining tables</h3>' +
      (cards ? '<div class="table-grid">' + cards + "</div>"
             : '<div class="card card-pad empty"><div class="big">🪑</div>No tables set up yet.' +
               (isAdmin() ? '<div style="margin-top:12px"><a class="btn primary" href="#/tables">Set up tables</a></div>' : "") + "</div>");
  }

  /* ================================================================== */
  /* Cart model                                                         */
  /* ================================================================== */
  function newCart(tableId, mode) {
    const table = S.tables.find((t) => t.id === tableId);
    return {
      orderId: null,
      no: null,
      token: null,
      tableId: table ? table.id : null,
      tableName: table ? table.name : mode === "parcel" ? "Parcel" : "Takeaway",
      mode: table ? "dine-in" : mode || "takeaway",
      lines: [],
      discountType: "amount",
      discountValue: 0,
      customerName: "",
      customerPhone: "",
      note: "",
      kotCount: 0,
      createdAt: new Date().toISOString(),
    };
  }

  function cartFromOrder(o) {
    return {
      orderId: o.id,
      no: o.no,
      token: o.token,
      tableId: o.tableId,
      tableName: o.tableName,
      mode: o.mode,
      lines: o.lines.map((l) => Object.assign({}, l)),
      discountType: o.discountType,
      discountValue: o.discountValue,
      customerName: (o.customer || {}).name || "",
      customerPhone: (o.customer || {}).phone || "",
      note: o.note || "",
      kotCount: o.kotCount || 0,
      createdAt: o.createdAt,
      createdByName: o.createdByName,
    };
  }

  /** Mirrors lib/pricing.js so the cart total updates without a round trip. */
  function cartTotals(cart) {
    const s = S.settings;
    const subtotal = round2(cart.lines.reduce((sum, l) => sum + l.price * l.qty, 0));
    const value = Math.max(0, Number(cart.discountValue) || 0);
    let discount = cart.discountType === "percent" ? (subtotal * Math.min(value, 100)) / 100 : value;
    discount = round2(Math.min(discount, subtotal));
    const afterDiscount = round2(subtotal - discount);
    const scPercent = s.serviceChargeEnabled ? Number(s.serviceChargePercent) || 0 : 0;
    const serviceCharge = round2((afterDiscount * scPercent) / 100);
    const taxPercent = s.taxEnabled ? Number(s.taxPercent) || 0 : 0;
    const inclusive = s.taxMode !== "exclusive";
    const rounding = (n) => (s.roundOff === false ? round2(n) : Math.round(n));

    let tax, total, taxableValue, roundOff;
    if (!taxPercent) {
      const gross = round2(afterDiscount + serviceCharge);
      total = round2(rounding(gross));
      tax = 0;
      taxableValue = total;
      roundOff = round2(total - gross);
    } else if (inclusive) {
      const gross = round2(afterDiscount + serviceCharge);
      total = round2(rounding(gross));
      tax = round2(total - total / (1 + taxPercent / 100));
      taxableValue = round2(total - tax);
      roundOff = round2(total - gross);
    } else {
      taxableValue = round2(afterDiscount + serviceCharge);
      tax = round2((taxableValue * taxPercent) / 100);
      const gross = round2(taxableValue + tax);
      total = round2(rounding(gross));
      roundOff = round2(total - gross);
    }
    const cgst = round2(tax / 2);

    return {
      subtotal, discount, discountType: cart.discountType, discountValue: value,
      serviceCharge, serviceChargePercent: scPercent,
      tax, taxPercent, taxName: s.taxName || "GST",
      taxMode: taxPercent ? (inclusive ? "inclusive" : "exclusive") : "none",
      taxableValue, cgst, sgst: round2(tax - cgst),
      roundOff, total,
      itemCount: cart.lines.reduce((n, l) => n + l.qty, 0),
    };
  }

  function cartPayload(cart) {
    return {
      tableId: cart.tableId,
      mode: cart.mode,
      lines: cart.lines.map((l) => ({ id: l.id, itemId: l.itemId, name: l.name, price: l.price, qty: l.qty, note: l.note })),
      discountType: cart.discountType,
      discountValue: cart.discountValue,
      customerName: cart.customerName,
      customerPhone: cart.customerPhone,
      note: cart.note,
    };
  }

  /** Push the cart to the server, creating the order on first save. */
  async function saveCart(options) {
    const cart = S.cart;
    if (!cart) return null;
    const opts = options || {};
    if (!cart.orderId && !cart.lines.length && !opts.force) return null;
    S.saving = true;
    try {
      const out = cart.orderId
        ? await api("/orders/" + cart.orderId, { method: "PUT", body: cartPayload(cart) })
        : await api("/orders", { method: "POST", body: cartPayload(cart) });
      const o = out.order;
      cart.orderId = o.id;
      cart.token = o.token;
      cart.tableName = o.tableName;
      cart.kotCount = o.kotCount;
      // Keep server-assigned line ids so kitchen-printed quantities stay attached.
      cart.lines = o.lines.map((l) => Object.assign({}, l));
      S.dirty = false;
      return o;
    } finally {
      S.saving = false;
    }
  }

  let saveTimer = null;
  function scheduleSave() {
    S.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveCart().then(() => paintCart()).catch((e) => toast(e.message, "bad"));
    }, 700);
  }
  async function flushSave() {
    clearTimeout(saveTimer);
    if (!S.cart) return null;
    if (!S.cart.orderId && !S.cart.lines.length) return null;
    return saveCart();
  }

  /* ================================================================== */
  /* Order screen                                                       */
  /* ================================================================== */
  async function renderOrder(params) {
    const kind = params[0];
    const id = params[1];

    if (kind === "id") {
      const out = await api("/orders/" + id);
      if (out.order.status !== "open") {
        toast("That bill is already closed.", "bad");
        location.hash = "#/bills";
        return;
      }
      S.cart = cartFromOrder(out.order);
    } else if (kind === "table") {
      await refreshOpenOrders();
      const existing = openOrderFor(id);
      if (existing) {
        const out = await api("/orders/" + existing.id);
        S.cart = cartFromOrder(out.order);
      } else {
        S.cart = newCart(id, "dine-in");
      }
    } else {
      S.cart = newCart(null, id === "parcel" ? "parcel" : "takeaway");
    }

    S.view.cat = S.view.cat || "all";
    S.view.q = "";
    screen().innerHTML =
      '<div class="pos">' +
      '<div class="pos-left">' +
      '<div style="display:flex;gap:10px;margin-bottom:12px">' +
      '<input type="text" id="item-search" placeholder="Search item or type its code…" autocomplete="off" style="flex:1">' +
      (isAdmin() ? '<button class="btn" data-act="open-item">＋ Open item</button>' : "") +
      "</div>" +
      '<div class="cat-bar" id="cat-bar"></div>' +
      '<div class="item-grid" id="pos-items"></div>' +
      "</div>" +
      '<div class="card cart" id="pos-cart"></div>' +
      "</div>" +
      '<button class="cart-fab" data-act="toggle-cart"><span id="fab-count">0 items</span> · <span id="fab-total">' + fmt(0) + "</span> ▲</button>";

    paintCategories();
    paintItems();
    paintCart();

    const search = document.getElementById("item-search");
    search.addEventListener("input", () => { S.view.q = search.value; paintItems(); });
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const matches = visibleItems();
      if (matches.length === 1) { addItem(matches[0].id); search.value = ""; S.view.q = ""; paintItems(); }
    });
  }

  function paintCategories() {
    const bar = document.getElementById("cat-bar");
    if (!bar) return;
    bar.innerHTML =
      '<button class="' + (S.view.cat === "all" ? "on" : "") + '" data-act="cat" data-cat="all">All</button>' +
      S.categories.map((c) =>
        '<button class="' + (S.view.cat === c.id ? "on" : "") + '" data-act="cat" data-cat="' + c.id + '">' +
        esc(c.name) + (S.settings.showLocalNames && c.localName ? ' <span style="opacity:.6">' + esc(c.localName) + "</span>" : "") +
        "</button>"
      ).join("");
  }

  function catOrder(categoryId) {
    const idx = S.categories.findIndex((c) => c.id === categoryId);
    return idx < 0 ? 99 : idx;
  }

  function visibleItems() {
    const q = (S.view.q || "").trim().toLowerCase();
    return S.items
      .filter((i) => !i.archived)
      .filter((i) => S.view.cat === "all" || i.categoryId === S.view.cat)
      .filter((i) => !q || i.name.toLowerCase().includes(q) || (i.localName || "").includes(S.view.q.trim()) || (i.code || "").toLowerCase() === q)
      .sort((a, b) => {
        const ca = catOrder(a.categoryId), cb = catOrder(b.categoryId);
        return ca === cb ? a.sort - b.sort : ca - cb;
      });
  }

  function paintItems() {
    const host = document.getElementById("pos-items");
    if (!host) return;
    const list = visibleItems();
    if (!list.length) {
      host.innerHTML = '<div class="empty" style="grid-column:1/-1">No items match that search.</div>';
      return;
    }
    host.innerHTML = list.map((i) => {
      const qty = S.cart.lines.filter((l) => l.itemId === i.id).reduce((n, l) => n + l.qty, 0);
      return (
        '<button class="item-btn ' + (i.available ? "" : "off") + '" data-act="add-item" data-item="' + i.id + '"' +
        (i.available ? "" : " disabled") + ">" +
        (qty ? '<span class="qbadge">' + qty + "</span>" : "") +
        '<div><div class="nm">' + esc(i.name) + "</div>" +
        (S.settings.showLocalNames && i.localName ? '<div class="lc">' + esc(i.localName) + "</div>" : "") + "</div>" +
        '<div class="pr">' + fmt(i.price) + (i.available ? "" : ' <span class="small muted">· off</span>') + "</div>" +
        "</button>"
      );
    }).join("");
  }

  function paintCart() {
    const host = document.getElementById("pos-cart");
    if (!host) return;
    const cart = S.cart;
    const t = cartTotals(cart);

    const lines = cart.lines.length
      ? cart.lines.map((l, idx) =>
          '<div class="cart-line">' +
          '<div class="r1"><span class="nm">' + esc(l.name) +
          (l.printedQty >= l.qty && l.printedQty > 0 ? ' <span class="kot-tag">✓KOT</span>' : "") +
          '</span><span class="amt">' + fmt(l.price * l.qty) + "</span></div>" +
          '<div class="r2"><span class="rate">' + fmt(l.price) + " each</span>" +
          '<button class="btn sm ghost" data-act="line-note" data-idx="' + idx + '" title="Add a note">✎</button>' +
          '<span class="stepper">' +
          '<button data-act="line-minus" data-idx="' + idx + '">−</button>' +
          '<span class="q">' + l.qty + "</span>" +
          '<button data-act="line-plus" data-idx="' + idx + '">＋</button></span>' +
          '<button class="btn sm ghost" data-act="line-remove" data-idx="' + idx + '" title="Remove">✕</button></div>' +
          (l.note ? '<div class="note">' + esc(l.note) + "</div>" : "") +
          "</div>"
        ).join("")
      : '<div class="empty small">Tap an item to start the bill.</div>';

    const modes = [["dine-in", "Dine-in"], ["takeaway", "Takeaway"], ["parcel", "Parcel"]];
    const pendingKot = cart.lines.some((l) => l.qty > (l.printedQty || 0));

    host.innerHTML =
      '<button class="cart-grip" data-act="toggle-cart" aria-label="Close"></button>' +
      '<div class="cart-head"><div class="t"><b>' + esc(cart.tableName) + "</b>" +
      (cart.token ? '<span class="pill muted">Token ' + cart.token + "</span>" : "") +
      '<span style="flex:1"></span>' +
      '<button class="btn sm ghost" data-act="order-more">⋯</button></div>' +
      '<div class="mode-seg">' +
      modes.map(([v, label]) => '<button class="' + (cart.mode === v ? "on" : "") + '" data-act="mode" data-mode="' + v + '">' + label + "</button>").join("") +
      "</div>" +
      (cart.customerName ? '<div class="small muted" style="margin-top:8px">Guest: ' + esc(cart.customerName) + (cart.customerPhone ? " · " + esc(cart.customerPhone) : "") + "</div>" : "") +
      "</div>" +
      '<div class="cart-lines">' + lines + "</div>" +
      '<div class="cart-totals">' +
      '<div class="tline"><span>Subtotal (' + plural(t.itemCount, "item") + ")</span><span>" + fmt(t.subtotal) + "</span></div>" +
      (t.discount > 0 ? '<div class="tline"><span>Discount' + (t.discountType === "percent" ? " " + t.discountValue + "%" : "") + '</span><span>−' + fmt(t.discount) + "</span></div>" : "") +
      (t.serviceCharge > 0 ? '<div class="tline"><span>Service ' + t.serviceChargePercent + '%</span><span>' + fmt(t.serviceCharge) + "</span></div>" : "") +
      (t.tax > 0 && t.taxMode === "exclusive"
        ? '<div class="tline"><span>' + esc(t.taxName) + " " + t.taxPercent + '%</span><span>' + fmt(t.tax) + "</span></div>"
        : "") +
      (t.roundOff ? '<div class="tline"><span>Round off</span><span>' + (t.roundOff > 0 ? "+" : "") + fmt(t.roundOff) + "</span></div>" : "") +
      '<div class="tline grand"><span>Total</span><span>' + fmt(t.total) + "</span></div>" +
      (t.tax > 0 && t.taxMode === "inclusive"
        ? '<div class="tline small" style="opacity:.75"><span>includes ' + esc(t.taxName) + " " + t.taxPercent + '%</span><span>' + fmt(t.tax) + "</span></div>"
        : "") +
      "</div>" +
      '<div class="cart-actions">' +
      '<div class="pair">' +
      '<button class="btn ' + (pendingKot ? "dark" : "") + '" data-act="kot"' + (pendingKot ? "" : " disabled") + ">👨‍🍳 Send KOT</button>" +
      '<button class="btn" data-act="print-bill"' + (t.itemCount ? "" : " disabled") + ">🖨 Print bill</button>" +
      "</div>" +
      '<button class="btn primary lg block" data-act="settle"' + (t.itemCount ? "" : " disabled") + ">💵 Settle · " + fmt(t.total) + "</button>" +
      '<div class="pair"><button class="btn ghost" data-act="hold">Hold &amp; back</button>' +
      '<button class="btn ghost" data-act="discount">% Discount</button></div>' +
      "</div>";

    const fabCount = document.getElementById("fab-count");
    if (fabCount) {
      fabCount.textContent = plural(t.itemCount, "item");
      document.getElementById("fab-total").textContent = fmt(t.total);
    }
    setSub(cart.orderId ? "Running bill · " + since(cart.createdAt) : "New bill");
  }

  /* ---------------- Cart mutations ---------------- */
  function addItem(itemId) {
    const item = S.items.find((i) => i.id === itemId);
    if (!item || !item.available) return;
    // Merge into the matching plain line; a line carrying a note stays separate.
    const line = S.cart.lines.find((l) => l.itemId === itemId && !l.note);
    if (line) line.qty += 1;
    else {
      const cat = S.categories.find((c) => c.id === item.categoryId);
      S.cart.lines.push({
        id: null, itemId: item.id, name: item.name, localName: item.localName,
        categoryName: cat ? cat.name : "Other", station: cat ? cat.station : "Kitchen",
        price: item.price, qty: 1, note: "", printedQty: 0,
      });
    }
    paintCart();
    paintItems();
    scheduleSave();
  }

  function changeQty(idx, delta) {
    const line = S.cart.lines[idx];
    if (!line) return;
    line.qty += delta;
    if (line.qty <= 0) S.cart.lines.splice(idx, 1);
    paintCart();
    paintItems();
    scheduleSave();
  }

  /* ---------------- Order actions ---------------- */
  const sendKot = guard(async function () {
    await flushSave();
    if (!S.cart.orderId) return toast("Add an item first.", "bad");
    const out = await api("/orders/" + S.cart.orderId + "/kot", { method: "POST" });
    S.cart = cartFromOrder(out.order);
    paintCart();
    paintItems();
    Print.kot(out.kot, S.settings);
    toast("Kitchen ticket sent", "good");
  });

  const printBill = guard(async function () {
    const order = await flushSave() || (S.cart.orderId ? (await api("/orders/" + S.cart.orderId)).order : null);
    if (!order) return toast("Add an item first.", "bad");
    Print.bill(order, S.settings);
  });

  const settle = guard(async function () {
    const order = await flushSave() || (S.cart.orderId ? (await api("/orders/" + S.cart.orderId)).order : null);
    if (!order || !order.lines.length) return toast("Add an item first.", "bad");
    const total = order.totals.total;
    const modes = S.settings.paymentModes || ["Cash", "UPI", "Card"];
    const chips = [total, 50, 100, 200, 500, 2000].filter((v, i, a) => v >= total && a.indexOf(v) === i).slice(0, 5);

    const result = await modal({
      title: "Settle " + order.tableName + " · " + fmt(total),
      okText: "Take payment & print",
      body:
        '<div class="mode-seg" style="margin-bottom:14px" id="pay-modes">' +
        modes.map((m, i) => '<button type="button" class="' + (i === 0 ? "on" : "") + '" data-pay="' + esc(m) + '">' + esc(m) + "</button>").join("") +
        "</div>" +
        '<input type="hidden" name="mode" value="' + esc(modes[0]) + '">' +
        '<label class="field"><span>Amount received</span><input type="number" name="received" step="0.01" min="0" value="' + total + '"></label>' +
        '<div class="row" style="margin-bottom:12px">' +
        chips.map((v) => '<button type="button" class="btn sm" data-cash="' + v + '">' + fmt(v) + "</button>").join("") +
        "</div>" +
        '<div class="tline grand" style="border:0;margin:0"><span>Change</span><span id="pay-change">' + fmt(0) + "</span></div>" +
        '<label class="field" style="margin-top:12px"><span>Note (optional)</span><input type="text" name="note" placeholder="e.g. paid by GPay"></label>',
      onOpen(host) {
        const received = host.querySelector('[name="received"]');
        const hidden = host.querySelector('[name="mode"]');
        const change = host.querySelector("#pay-change");
        const update = () => {
          const diff = (Number(received.value) || 0) - total;
          change.textContent = fmt(Math.max(0, diff));
          change.style.color = diff < 0 ? "var(--red)" : "var(--ink)";
        };
        received.addEventListener("input", update);
        host.addEventListener("click", (e) => {
          const pay = e.target.closest("[data-pay]");
          if (pay) {
            host.querySelectorAll("#pay-modes button").forEach((b) => b.classList.remove("on"));
            pay.classList.add("on");
            hidden.value = pay.dataset.pay;
            // Anything other than cash is almost always tendered exactly.
            if (pay.dataset.pay.toLowerCase() !== "cash") { received.value = total; update(); }
          }
          const cash = e.target.closest("[data-cash]");
          if (cash) { received.value = cash.dataset.cash; update(); }
        });
        update();
      },
      validate(form) {
        if ((Number(form.received) || 0) + 0.001 < total) return "Amount received is less than the bill total.";
        return null;
      },
    });
    if (!result) return;

    const out = await api("/orders/" + order.id + "/pay", {
      method: "POST",
      body: { mode: result.mode, received: Number(result.received), note: result.note },
    });
    Print.bill(out.order, S.settings);
    toast("Bill #" + out.order.no + " settled · " + fmt(out.order.totals.total), "good");
    S.cart = null;
    location.hash = "#/floor";
  });

  const holdOrder = guard(async function () {
    await flushSave();
    if (S.cart && S.cart.orderId) toast("Held on " + S.cart.tableName, "good");
    S.cart = null;
    location.hash = "#/floor";
  });

  const setDiscount = guard(async function () {
    const cart = S.cart;
    const result = await modal({
      title: "Discount",
      okText: "Apply",
      body:
        '<label class="field"><span>Type</span><select name="type">' +
        '<option value="amount"' + (cart.discountType === "amount" ? " selected" : "") + ">Flat amount</option>" +
        '<option value="percent"' + (cart.discountType === "percent" ? " selected" : "") + ">Percentage</option>" +
        "</select></label>" +
        '<label class="field"><span>Value</span><input type="number" name="value" min="0" step="0.01" value="' + (cart.discountValue || 0) + '"></label>' +
        '<p class="small muted" style="margin:0">Set 0 to clear the discount.</p>',
    });
    if (!result) return;
    cart.discountType = result.type;
    cart.discountValue = Math.max(0, Number(result.value) || 0);
    paintCart();
    await flushSave();
    paintCart();
  });

  const lineNote = guard(async function (idx) {
    const line = S.cart.lines[idx];
    if (!line) return;
    const result = await modal({
      title: "Note for " + line.name,
      okText: "Save note",
      body: '<label class="field"><span>Kitchen note</span><input type="text" name="note" maxlength="120" value="' + esc(line.note || "") + '" placeholder="less sugar, extra spicy, no onion…"></label>',
    });
    if (!result) return;
    line.note = result.note.trim();
    paintCart();
    scheduleSave();
  });

  const orderMore = guard(async function () {
    const cart = S.cart;
    const others = S.openOrders.filter((o) => o.id !== cart.orderId);
    const freeTables = S.tables.filter((t) => t.active !== false && !S.openOrders.some((o) => o.tableId === t.id && o.id !== cart.orderId));
    const result = await modal({
      title: "Bill options",
      okText: "Apply",
      body:
        '<label class="field"><span>Move to table</span><select name="table"><option value="">— keep ' + esc(cart.tableName) + " —</option>" +
        freeTables.map((t) => '<option value="' + t.id + '"' + (t.id === cart.tableId ? " selected" : "") + ">" + esc(t.name) + "</option>").join("") +
        "</select></label>" +
        (others.length
          ? '<label class="field"><span>Merge another running table into this bill</span><select name="merge"><option value="">— no merge —</option>' +
            others.map((o) => '<option value="' + o.id + '">' + esc(o.tableName) + " · " + fmt(o.total) + "</option>").join("") +
            "</select></label>"
          : "") +
        '<div class="row"><label class="field"><span>Guest name</span><input type="text" name="customerName" value="' + esc(cart.customerName) + '"></label>' +
        '<label class="field"><span>Phone</span><input type="tel" name="customerPhone" value="' + esc(cart.customerPhone) + '"></label></div>' +
        '<label class="field"><span>Bill note</span><input type="text" name="note" value="' + esc(cart.note) + '" placeholder="printed on the bill"></label>' +
        '<button type="button" class="btn danger block" data-x="discard" style="margin-top:6px">Discard this bill</button>',
      onOpen(host) {
        host.querySelector('[data-x="discard"]').addEventListener("click", async () => {
          host.remove();
          const yes = await confirmBox("Discard bill?", "This clears " + cart.tableName + " without settling. Anything already sent to the kitchen stays on the void log.", "Discard");
          if (!yes) return;
          if (cart.orderId) await api("/orders/" + cart.orderId + "/cancel", { method: "POST", body: { reason: "Discarded at counter" } });
          S.cart = null;
          toast("Bill discarded");
          location.hash = "#/floor";
        });
      },
    });
    if (!result) return;

    cart.customerName = result.customerName;
    cart.customerPhone = result.customerPhone;
    cart.note = result.note;
    await flushSave();
    if (result.table && result.table !== cart.tableId && cart.orderId) {
      const out = await api("/orders/" + cart.orderId + "/transfer", { method: "POST", body: { tableId: result.table } });
      S.cart = cartFromOrder(out.order);
      toast("Moved to " + out.order.tableName, "good");
    }
    if (result.merge && cart.orderId) {
      const out = await api("/orders/" + cart.orderId + "/merge", { method: "POST", body: { fromOrderId: result.merge } });
      S.cart = cartFromOrder(out.order);
      toast("Tables merged", "good");
    }
    await refreshOpenOrders();
    paintCart();
    paintItems();
  });

  const openItem = guard(async function () {
    const result = await modal({
      title: "One-off item",
      okText: "Add to bill",
      body:
        '<label class="field"><span>Item name</span><input type="text" name="name" placeholder="e.g. Special order"></label>' +
        '<label class="field"><span>Rate</span><input type="number" name="price" min="0" step="0.5" value="0"></label>' +
        '<p class="small muted" style="margin:0">Use this for something not on the menu. Add it to the menu instead if you sell it regularly.</p>',
      validate: (f) => (f.name.trim() ? null : "Give the item a name."),
    });
    if (!result) return;
    S.cart.lines.push({
      id: null, itemId: null, name: result.name.trim(), localName: "", categoryName: "Other",
      station: "Kitchen", price: Math.max(0, Number(result.price) || 0), qty: 1, note: "", printedQty: 0,
    });
    paintCart();
    scheduleSave();
  });

  const setMode = guard(async function (mode) {
    const cart = S.cart;
    if (mode === "dine-in" && !cart.tableId) {
      const free = S.tables.filter((t) => t.active !== false && !S.openOrders.some((o) => o.tableId === t.id));
      if (!free.length) return toast("No free table right now.", "bad");
      const result = await modal({
        title: "Which table?",
        okText: "Move here",
        body: '<label class="field"><span>Table</span><select name="table">' +
          free.map((t) => '<option value="' + t.id + '">' + esc(t.name) + "</option>").join("") + "</select></label>",
      });
      if (!result) return;
      cart.tableId = result.table;
      cart.tableName = (S.tables.find((t) => t.id === result.table) || {}).name || "Table";
    }
    cart.mode = mode;
    if (mode !== "dine-in") {
      cart.tableId = null;
      cart.tableName = mode === "parcel" ? "Parcel" : "Takeaway";
    }
    paintCart();
    await flushSave();
    paintCart();
  });

  /* ================================================================== */
  /* Dashboard                                                          */
  /* ================================================================== */
  const PRESETS = {
    today: { label: "Today", from: () => todayStr(), to: () => todayStr() },
    yesterday: { label: "Yesterday", from: () => daysAgo(1), to: () => daysAgo(1) },
    week: { label: "Last 7 days", from: () => daysAgo(6), to: () => todayStr() },
    month: { label: "Last 30 days", from: () => daysAgo(29), to: () => todayStr() },
  };

  /** Pads the hours actually traded out to a readable span (08:00–22:00 by
      default) so a quiet morning still shows as a gap rather than a single bar. */
  function fillHours(byHour) {
    const map = new Map(byHour.map((h) => [Number(h.key), h.amount]));
    const hours = byHour.map((h) => Number(h.key));
    const start = Math.min(8, hours.length ? Math.min.apply(null, hours) : 8);
    const end = Math.max(22, hours.length ? Math.max.apply(null, hours) : 22);
    const out = [];
    for (let h = start; h <= end; h++) {
      const hh = h % 12 === 0 ? 12 : h % 12;
      out.push({ label: hh + (h < 12 ? "am" : "pm"), value: map.get(h) || 0 });
    }
    return out;
  }

  async function renderDashboard() {
    const v = S.view;
    if (!v.dashFrom) { v.dashFrom = todayStr(); v.dashTo = todayStr(); v.preset = "today"; }
    if (!isAdmin()) { v.dashFrom = todayStr(); v.dashTo = todayStr(); v.preset = "today"; }

    screen().innerHTML = '<div class="empty">Loading sales…</div>';
    const out = await api("/dashboard?from=" + v.dashFrom + "&to=" + v.dashTo);
    const r = out.report;
    const t = r.totals;
    const cur = S.settings.currency || "";
    const sameDay = v.dashFrom === v.dashTo;
    setSub(sameDay ? "Sales for " + v.dashFrom : v.dashFrom + " → " + v.dashTo);

    const filters = isAdmin()
      ? '<div class="filters">' +
        Object.entries(PRESETS).map(([k, p]) =>
          '<button class="btn ' + (v.preset === k ? "dark" : "") + '" data-act="dash-preset" data-preset="' + k + '">' + p.label + "</button>"
        ).join("") +
        '<label class="field"><span>From</span><input type="date" id="dash-from" value="' + v.dashFrom + '"></label>' +
        '<label class="field"><span>To</span><input type="date" id="dash-to" value="' + v.dashTo + '"></label>' +
        '<button class="btn primary" data-act="dash-apply">Show</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn" data-act="day-close">🧾 Day close</button>' +
        '<button class="btn" data-act="export-csv">⬇ Excel / CSV</button>' +
        "</div>"
      : '<div class="filters"><span class="pill muted">Today · ' + esc(v.dashFrom) + "</span>" +
        '<span class="small muted">Counter staff see the day\'s figures. Ask the owner for older reports.</span></div>';

    const kpi = (label, value, sub, cls) =>
      '<div class="kpi ' + (cls || "") + '"><div class="lbl">' + esc(label) + '</div><div class="val">' + value + "</div>" +
      (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") + "</div>";

    const hourly = fillHours(r.byHour);
    const daily = r.byDay.map((d) => ({ label: d.key.slice(5), value: d.amount }));

    screen().innerHTML =
      filters +
      '<div class="kpis">' +
      kpi("Net sales", fmt(t.gross),
        plural(t.orders, "bill") + (t.tax ? " · " + fmt(t.taxableValue) + " before " + esc(S.settings.taxName || "GST") : ""),
        "brand") +
      kpi("Average bill", fmt(t.average), t.itemsSold + " items sold") +
      kpi("Bills", String(t.orders), sameDay ? "settled today" : "over " + r.byDay.length + " days") +
      kpi("On the floor", fmt(t.openValue), t.openCount + (t.openCount === 1 ? " running bill" : " running bills")) +
      kpi(t.tax ? (S.settings.taxName || "GST") + " collected" : "Discounts", fmt(t.tax || t.discount),
        t.tax ? fmt(t.discount) + " discounts · " + t.cancelledCount + " cancelled" : t.cancelledCount + " cancelled · " + fmt(t.cancelledValue)) +
      (r.mine ? kpi("Your counter", fmt(r.mine.amount), r.mine.orders + " bills by you") : "") +
      "</div>" +
      '<div class="two-col" style="margin-bottom:16px">' +
      '<div class="card"><div class="card-head"><h3>' + (sameDay ? "Sales by hour" : "Sales by day") + "</h3></div>" +
      '<div class="card-pad">' + Charts.bars(sameDay ? hourly : daily, { currency: cur, empty: "No settled bills in this period yet." }) + "</div></div>" +
      '<div class="card"><div class="card-head"><h3>Payments</h3></div><div class="card-pad">' +
      Charts.donut(r.byPayment.map((p) => ({ label: p.key, value: p.amount })), { currency: cur }) + "</div></div>" +
      "</div>" +
      '<div class="three-col">' +
      '<div class="card"><div class="card-head"><h3>Top sellers</h3></div><div class="card-pad">' +
      Charts.ranked(r.topItems.map((i) => ({ label: i.key, value: i.qty, hint: fmt(i.amount) })), { suffix: " nos" }) + "</div></div>" +
      '<div class="card"><div class="card-head"><h3>Categories</h3><div class="spacer"></div><span class="pill muted">before discount</span></div><div class="card-pad">' +
      Charts.ranked(r.byCategory.map((c) => ({ label: c.key, value: c.amount, hint: c.qty + " nos" })), { currency: cur }) + "</div></div>" +
      '<div class="card"><div class="card-head"><h3>Counter staff</h3></div><div class="card-pad">' +
      Charts.ranked(r.byStaff.map((s) => ({ label: s.key, value: s.amount, hint: plural(s.orders, "bill") })), { currency: cur }) +
      '<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">' +
      '<div class="lbl small muted" style="font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin-bottom:4px">Order type</div>' +
      Charts.ranked(r.byMode.map((m) => ({ label: m.key.replace("-", " "), value: m.amount })), { currency: cur, empty: "—" }) +
      "</div></div></div>";
  }

  /* ================================================================== */
  /* Bills & reports                                                    */
  /* ================================================================== */
  async function renderBills() {
    const v = S.view;
    if (!v.billFrom) { v.billFrom = todayStr(); v.billTo = todayStr(); v.billStatus = ""; }
    if (!isAdmin()) { v.billFrom = todayStr(); v.billTo = todayStr(); }

    screen().innerHTML = '<div class="empty">Loading bills…</div>';
    const out = await api("/orders?from=" + v.billFrom + "&to=" + v.billTo + (v.billStatus ? "&status=" + v.billStatus : ""));
    const orders = out.orders;
    const paid = orders.filter((o) => o.status === "paid");
    const total = paid.reduce((s, o) => s + o.totals.total, 0);
    setSub(plural(paid.length, "bill") + " settled · " + fmt(total));

    const rows = orders.map((o) =>
      '<tr data-act="view-bill" data-order="' + o.id + '" style="cursor:pointer">' +
      "<td><b>" + (o.no ? "#" + o.no : "—") + '</b><div class="small muted">Token ' + o.token + "</div></td>" +
      "<td>" + timeOf(o.paidAt || o.createdAt) + '<div class="small muted">' + esc(o.businessDate) + "</td>" +
      "<td>" + esc(o.tableName) + '<div class="small muted">' + esc(String(o.mode).replace("-", " ")) + "</div></td>" +
      '<td class="small">' + esc(o.lines.slice(0, 3).map((l) => l.name + "×" + l.qty).join(", ")) +
      (o.lines.length > 3 ? ' <span class="muted">+' + (o.lines.length - 3) + " more</span>" : "") + "</td>" +
      '<td class="num"><b>' + fmt(o.totals.total) + "</b></td>" +
      "<td>" + esc((o.payment || {}).mode || "—") + "</td>" +
      "<td>" + esc(o.paidByName || o.createdByName) + "</td>" +
      '<td><span class="pill ' + o.status + '">' + o.status + "</span></td>" +
      '<td class="num"><button class="btn sm" data-act="reprint" data-order="' + o.id + '">🖨</button></td>' +
      "</tr>"
    ).join("");

    screen().innerHTML =
      '<div class="filters">' +
      (isAdmin()
        ? '<label class="field"><span>From</span><input type="date" id="bill-from" value="' + v.billFrom + '"></label>' +
          '<label class="field"><span>To</span><input type="date" id="bill-to" value="' + v.billTo + '"></label>'
        : '<span class="pill muted">Today only</span>') +
      '<label class="field"><span>Status</span><select id="bill-status">' +
      ["", "paid", "open", "cancelled"].map((s) =>
        '<option value="' + s + '"' + (v.billStatus === s ? " selected" : "") + ">" + (s ? s[0].toUpperCase() + s.slice(1) : "All") + "</option>"
      ).join("") + "</select></label>" +
      '<button class="btn primary" data-act="bills-apply">Show</button>' +
      '<span style="flex:1"></span>' +
      (isAdmin() ? '<button class="btn" data-act="export-csv">⬇ Excel / CSV</button>' : "") +
      "</div>" +
      '<div class="card">' +
      (rows
        ? '<div style="overflow-x:auto"><table class="grid"><thead><tr>' +
          "<th>Bill</th><th>Time</th><th>Table</th><th>Items</th><th class='num'>Total</th><th>Paid by</th><th>Staff</th><th>Status</th><th></th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>"
        : '<div class="empty"><div class="big">🧾</div>No bills in this range yet.</div>') +
      "</div>";
  }

  const viewBill = guard(async function (orderId) {
    const out = await api("/orders/" + orderId);
    const o = out.order;
    const t = o.totals;
    const rows = o.lines.map((l) =>
      "<tr><td>" + esc(l.name) + (l.note ? '<div class="small muted">' + esc(l.note) + "</div>" : "") +
      '</td><td class="num">' + l.qty + '</td><td class="num">' + fmt(l.price) + '</td><td class="num">' + fmt(l.price * l.qty) + "</td></tr>"
    ).join("");

    const result = await modal({
      title: (o.no ? "Bill #" + o.no : "Running bill") + " · " + o.tableName,
      okText: "🖨 Reprint bill",
      cancelText: "Close",
      body:
        '<div class="small muted" style="margin-bottom:12px">' +
        timeOf(o.paidAt || o.createdAt) + " · " + esc(o.businessDate) + " · " + esc(o.paidByName || o.createdByName) +
        " · " + esc(String(o.mode).replace("-", " ")) +
        (o.payment ? " · paid by " + esc(o.payment.mode) : "") + "</div>" +
        '<table class="grid"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>' +
        "<tbody>" + rows + "</tbody></table>" +
        '<div class="cart-totals" style="border:0;background:transparent;padding:12px 0 0">' +
        '<div class="tline"><span>Subtotal</span><span>' + fmt(t.subtotal) + "</span></div>" +
        (t.discount ? '<div class="tline"><span>Discount</span><span>−' + fmt(t.discount) + "</span></div>" : "") +
        (t.tax ? '<div class="tline"><span>' + esc(t.taxName) + "</span><span>" + fmt(t.tax) + "</span></div>" : "") +
        '<div class="tline grand"><span>Total</span><span>' + fmt(t.total) + "</span></div></div>" +
        (o.status === "cancelled" ? '<p class="pill cancelled" style="margin-top:12px">Cancelled: ' + esc(o.cancelReason || "") + "</p>" : "") +
        (isAdmin() && o.status === "paid"
          ? '<button type="button" class="btn danger block" data-x="void" style="margin-top:14px">Cancel this bill</button>'
          : ""),
      onOpen(host) {
        const voidBtn = host.querySelector('[data-x="void"]');
        if (!voidBtn) return;
        voidBtn.addEventListener("click", async () => {
          host.remove();
          const why = await modal({
            title: "Cancel bill #" + o.no,
            okText: "Cancel bill",
            danger: true,
            body: '<label class="field"><span>Reason (kept on the day report)</span><input type="text" name="reason" placeholder="wrong entry, guest left…"></label>',
            validate: (f) => (f.reason.trim() ? null : "Please give a reason."),
          });
          if (!why) return;
          await api("/orders/" + o.id + "/cancel", { method: "POST", body: { reason: why.reason } });
          toast("Bill cancelled");
          route();
        });
      },
    });
    if (result) Print.bill(o, S.settings, { reprint: true });
  });

  /* ================================================================== */
  /* Menu & rates (admin)                                               */
  /* ================================================================== */
  async function renderMenu() {
    await refreshOpenOrders();
    setSub(S.items.filter((i) => !i.archived).length + " items in " + S.categories.length + " categories");

    const sections = S.categories.sort((a, b) => a.sort - b.sort).map((c) => {
      const items = S.items.filter((i) => i.categoryId === c.id && !i.archived).sort((a, b) => a.sort - b.sort);
      const rows = items.map((i) =>
        "<tr>" +
        "<td><b>" + esc(i.name) + "</b>" + (i.localName ? '<div class="small muted">' + esc(i.localName) + "</div>" : "") + "</td>" +
        '<td class="small muted">' + esc(i.code || "") + "</td>" +
        '<td class="num" style="width:120px"><input type="number" min="0" step="0.5" class="rate-input" data-item="' + i.id + '" value="' + i.price + '" style="text-align:right"></td>' +
        '<td><label class="check" style="margin:0"><input type="checkbox" data-act="item-available" data-item="' + i.id + '"' + (i.available ? " checked" : "") + '><span class="small">' + (i.available ? "On sale" : "Off") + "</span></label></td>" +
        '<td class="num"><button class="btn sm" data-act="edit-item" data-item="' + i.id + '">Edit</button> ' +
        '<button class="btn sm danger" data-act="delete-item" data-item="' + i.id + '">✕</button></td>' +
        "</tr>"
      ).join("");
      return (
        '<div class="card" style="margin-bottom:16px"><div class="card-head">' +
        "<h3>" + esc(c.name) + (c.localName ? ' <span class="muted" style="font-weight:400">' + esc(c.localName) + "</span>" : "") + "</h3>" +
        '<span class="pill muted">' + (c.station || "Kitchen") + "</span>" +
        '<div class="spacer"></div>' +
        '<button class="btn sm" data-act="edit-category" data-cat="' + c.id + '">Rename</button>' +
        '<button class="btn sm" data-act="new-item" data-cat="' + c.id + '">＋ Item</button>' +
        '<button class="btn sm danger" data-act="delete-category" data-cat="' + c.id + '">✕</button>' +
        "</div>" +
        (rows
          ? '<div style="overflow-x:auto"><table class="grid"><thead><tr><th>Item</th><th>Code</th><th class="num">Rate</th><th>Status</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>"
          : '<div class="empty small">No items here yet.</div>')
      ) + "</div>";
    }).join("");

    screen().innerHTML =
      '<div class="filters">' +
      '<button class="btn primary" data-act="new-item">＋ New item</button>' +
      '<button class="btn" data-act="add-category">＋ New category</button>' +
      '<span style="flex:1"></span>' +
      '<span class="small muted">Change a rate in the box, then save.</span>' +
      '<button class="btn dark" data-act="save-rates">💾 Save rate changes</button>' +
      "</div>" +
      (sections || '<div class="card card-pad empty"><div class="big">📋</div>No categories yet — add one to start your menu.</div>');
  }

  const saveRates = guard(async function () {
    const prices = [];
    document.querySelectorAll(".rate-input").forEach((input) => {
      const item = S.items.find((i) => i.id === input.dataset.item);
      const price = Number(input.value);
      if (item && isFinite(price) && price >= 0 && price !== item.price) prices.push({ id: item.id, price });
    });
    if (!prices.length) return toast("No rate changes to save.");
    const out = await api("/items/prices", { method: "PUT", body: { prices } });
    S.items = out.items;
    toast(out.updated + " rate" + (out.updated === 1 ? "" : "s") + " updated", "good");
    renderMenu();
  });

  const itemForm = guard(async function (itemId, categoryId) {
    const item = itemId ? S.items.find((i) => i.id === itemId) : null;
    const cats = S.categories;
    if (!cats.length) return toast("Add a category first.", "bad");
    const result = await modal({
      title: item ? "Edit " + item.name : "New menu item",
      okText: item ? "Save changes" : "Add to menu",
      body:
        '<label class="field"><span>Item name</span><input type="text" name="name" value="' + esc(item ? item.name : "") + '" placeholder="e.g. Lemon Tea"></label>' +
        '<label class="field"><span>Tamil name (optional)</span><input type="text" name="localName" value="' + esc(item ? item.localName : "") + '" placeholder="லெமன் டீ"></label>' +
        '<div class="row">' +
        '<label class="field"><span>Category</span><select name="categoryId">' +
        cats.map((c) => '<option value="' + c.id + '"' + ((item ? item.categoryId : categoryId) === c.id ? " selected" : "") + ">" + esc(c.name) + "</option>").join("") +
        "</select></label>" +
        '<label class="field"><span>Rate</span><input type="number" name="price" min="0" step="0.5" value="' + (item ? item.price : 0) + '"></label>' +
        '<label class="field"><span>Short code</span><input type="text" name="code" maxlength="8" value="' + esc(item ? item.code : "") + '" placeholder="LT"></label>' +
        "</div>" +
        '<label class="check"><input type="checkbox" name="available"' + (!item || item.available ? " checked" : "") + "><span>Available on the counter</span></label>",
      validate: (f) => (f.name.trim() ? null : "Give the item a name."),
    });
    if (!result) return;
    const body = {
      name: result.name.trim(), localName: result.localName.trim(), categoryId: result.categoryId,
      price: Number(result.price) || 0, code: result.code.trim(), available: !!result.available,
    };
    if (item) await api("/items/" + item.id, { method: "PUT", body });
    else await api("/items", { method: "POST", body });
    toast(item ? "Item updated" : "Item added", "good");
    renderMenu();
  });

  const categoryForm = guard(async function (catId) {
    const cat = catId ? S.categories.find((c) => c.id === catId) : null;
    const result = await modal({
      title: cat ? "Rename " + cat.name : "New category",
      okText: cat ? "Save" : "Add category",
      body:
        '<label class="field"><span>Category name</span><input type="text" name="name" value="' + esc(cat ? cat.name : "") + '" placeholder="e.g. Milkshakes"></label>' +
        '<label class="field"><span>Tamil name (optional)</span><input type="text" name="localName" value="' + esc(cat ? cat.localName : "") + '"></label>' +
        '<label class="field"><span>Prints on which ticket?</span><select name="station">' +
        '<option value="Kitchen"' + (cat && cat.station === "Kitchen" ? " selected" : "") + ">Kitchen</option>" +
        '<option value="Beverages"' + (cat && cat.station === "Beverages" ? " selected" : "") + ">Beverages counter</option>" +
        "</select></label>",
      validate: (f) => (f.name.trim() ? null : "Give the category a name."),
    });
    if (!result) return;
    const body = { name: result.name.trim(), localName: result.localName.trim(), station: result.station };
    if (cat) await api("/categories/" + cat.id, { method: "PUT", body });
    else await api("/categories", { method: "POST", body: Object.assign(body, { sort: S.categories.length }) });
    toast("Saved", "good");
    renderMenu();
  });

  /* ================================================================== */
  /* Table layout (admin)                                               */
  /* ================================================================== */
  async function renderTablesAdmin() {
    await refreshOpenOrders();
    setSub(S.tables.length + " tables");
    const rows = S.tables.sort((a, b) => a.sort - b.sort).map((t) => {
      const busy = openOrderFor(t.id);
      return (
        "<tr><td><b>" + esc(t.name) + "</b></td><td>" + esc(t.zone || "") + '</td><td class="num">' + (t.seats || 4) + "</td>" +
        '<td><span class="pill ' + (busy ? "busy" : t.active === false ? "muted" : "free") + '">' +
        (busy ? "Running bill" : t.active === false ? "Hidden" : "Free") + "</span></td>" +
        '<td class="num"><button class="btn sm" data-act="edit-table" data-table="' + t.id + '">Edit</button> ' +
        '<button class="btn sm danger" data-act="delete-table" data-table="' + t.id + '">✕</button></td></tr>'
      );
    }).join("");

    screen().innerHTML =
      '<div class="filters">' +
      '<button class="btn primary" data-act="add-table">＋ Add table</button>' +
      '<button class="btn" data-act="generate-tables">Add several at once</button>' +
      '<span style="flex:1"></span><span class="small muted">Tables with a running bill cannot be removed.</span></div>' +
      '<div class="card">' +
      (rows
        ? '<table class="grid"><thead><tr><th>Table</th><th>Area</th><th class="num">Seats</th><th>Status</th><th></th></tr></thead><tbody>' + rows + "</tbody></table>"
        : '<div class="empty"><div class="big">🪑</div>No tables yet.</div>') +
      "</div>";
  }

  const tableForm = guard(async function (tableId) {
    const t = tableId ? S.tables.find((x) => x.id === tableId) : null;
    const result = await modal({
      title: t ? "Edit " + t.name : "New table",
      okText: t ? "Save" : "Add table",
      body:
        '<label class="field"><span>Name</span><input type="text" name="name" value="' + esc(t ? t.name : "Table " + (S.tables.length + 1)) + '"></label>' +
        '<div class="row"><label class="field"><span>Area</span><input type="text" name="zone" value="' + esc(t ? t.zone : "Main") + '" placeholder="Main / AC / Outdoor"></label>' +
        '<label class="field"><span>Seats</span><input type="number" name="seats" min="1" max="30" value="' + (t ? t.seats : 4) + '"></label></div>' +
        '<label class="check"><input type="checkbox" name="active"' + (!t || t.active !== false ? " checked" : "") + "><span>Show on the floor screen</span></label>",
      validate: (f) => (f.name.trim() ? null : "Give the table a name."),
    });
    if (!result) return;
    const body = { name: result.name.trim(), zone: result.zone.trim(), seats: Number(result.seats) || 4, active: !!result.active };
    if (t) await api("/tables/" + t.id, { method: "PUT", body });
    else await api("/tables", { method: "POST", body: Object.assign(body, { sort: S.tables.length + 1 }) });
    toast("Saved", "good");
    renderTablesAdmin();
  });

  const generateTables = guard(async function () {
    const result = await modal({
      title: "Add several tables",
      okText: "Add them",
      body:
        '<div class="row"><label class="field"><span>How many</span><input type="number" name="count" min="1" max="60" value="4"></label>' +
        '<label class="field"><span>Name prefix</span><input type="text" name="prefix" value="Table"></label>' +
        '<label class="field"><span>Area</span><input type="text" name="zone" value="Main"></label></div>',
    });
    if (!result) return;
    await api("/tables/generate", { method: "POST", body: { count: Number(result.count) || 0, prefix: result.prefix, zone: result.zone } });
    toast("Tables added", "good");
    renderTablesAdmin();
  });

  /* ================================================================== */
  /* Staff & access (admin)                                             */
  /* ================================================================== */
  async function renderStaff() {
    const out = await api("/users");
    const users = out.users;
    setSub(users.length + " logins");
    const rows = users.map((u) =>
      "<tr><td><b>" + esc(u.name) + '</b><div class="small muted">@' + esc(u.username) + "</div></td>" +
      '<td><span class="pill ' + (u.role === "admin" ? "busy" : "muted") + '">' + (u.role === "admin" ? "Admin" : "Counter staff") + "</span></td>" +
      "<td>" + (u.hasPin ? '<span class="small">PIN set</span>' : '<span class="small muted">No PIN</span>') + "</td>" +
      '<td><span class="pill ' + (u.active ? "free" : "cancelled") + '">' + (u.active ? "Active" : "Blocked") + "</span></td>" +
      '<td class="num">' +
      '<button class="btn sm" data-act="reset-password" data-user="' + u.id + '" data-name="' + esc(u.name) + '">Reset password</button> ' +
      '<button class="btn sm" data-act="edit-user" data-user="' + u.id + '">Edit</button> ' +
      (u.id === S.user.id ? "" : '<button class="btn sm danger" data-act="delete-user" data-user="' + u.id + '">✕</button>') +
      "</td></tr>"
    ).join("");

    screen().innerHTML =
      '<div class="filters"><button class="btn primary" data-act="add-user">＋ Add staff login</button>' +
      '<span style="flex:1"></span><span class="small muted">Counter staff can take orders and settle bills. Only admins see reports, rates and settings.</span></div>' +
      '<div class="card"><table class="grid"><thead><tr><th>Name</th><th>Access</th><th>Quick PIN</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" +
      '<div class="card card-pad" style="margin-top:16px"><h3 style="margin:0 0 6px;font-size:15px">How access works</h3>' +
      '<ul class="small muted" style="margin:0;padding-left:18px;line-height:1.8">' +
      "<li><b>Admin</b> — everything: dashboard, all reports, menu &amp; rates, table layout, staff, settings, cancelling settled bills.</li>" +
      "<li><b>Counter staff (user-1, user-2)</b> — tables, taking orders, kitchen tickets, printing and settling bills, plus today's own sales figures.</li>" +
      "<li>A staff member can sign in with their username and password, or tap in their 4-digit PIN on the counter tablet.</li>" +
      "</ul></div>";
  }

  const userForm = guard(async function (userId) {
    const out = userId ? await api("/users") : { users: [] };
    const u = userId ? out.users.find((x) => x.id === userId) : null;
    const result = await modal({
      title: u ? "Edit " + u.name : "New staff login",
      okText: u ? "Save" : "Create login",
      body:
        '<label class="field"><span>Display name</span><input type="text" name="name" value="' + esc(u ? u.name : "") + '" placeholder="e.g. Counter 3"></label>' +
        (u ? "" :
          '<label class="field"><span>Username</span><input type="text" name="username" autocapitalize="none" placeholder="user3"></label>' +
          '<label class="field"><span>Password</span><input type="text" name="password" placeholder="at least 6 characters"></label>' +
          '<label class="field"><span>Quick PIN (optional)</span><input type="text" name="pin" inputmode="numeric" maxlength="6" placeholder="4 digits"></label>') +
        '<label class="field"><span>Access level</span><select name="role">' +
        '<option value="cashier"' + (u && u.role === "cashier" ? " selected" : "") + ">Counter staff</option>" +
        '<option value="admin"' + (u && u.role === "admin" ? " selected" : "") + ">Admin (owner)</option>" +
        "</select></label>" +
        (u && u.id !== S.user.id
          ? '<label class="check"><input type="checkbox" name="active"' + (u.active ? " checked" : "") + "><span>Allowed to sign in</span></label>"
          : ""),
      validate: (f) => {
        if (!f.name.trim()) return "Give them a display name.";
        if (!userId && !/^[a-z0-9_.-]{3,40}$/.test((f.username || "").trim().toLowerCase())) return "Username: 3+ letters or numbers, no spaces.";
        if (!userId && (f.password || "").length < 6) return "Password must be at least 6 characters.";
        if (!userId && f.pin && !/^\d{4,6}$/.test(f.pin)) return "PIN must be 4 to 6 digits.";
        return null;
      },
    });
    if (!result) return;
    if (u) {
      const body = { name: result.name.trim(), role: result.role };
      if ("active" in result) body.active = !!result.active;
      await api("/users/" + u.id, { method: "PUT", body });
    } else {
      await api("/users", {
        method: "POST",
        body: {
          name: result.name.trim(), username: result.username.trim().toLowerCase(),
          password: result.password, pin: result.pin, role: result.role,
        },
      });
    }
    toast("Saved", "good");
    renderStaff();
  });

  const resetPassword = guard(async function (userId, name) {
    const result = await modal({
      title: "Reset password for " + name,
      okText: "Set new password",
      body:
        '<label class="field"><span>New password</span><input type="text" name="password" placeholder="at least 6 characters"></label>' +
        '<label class="field"><span>New quick PIN (optional)</span><input type="text" name="pin" inputmode="numeric" maxlength="6"></label>' +
        '<p class="small muted" style="margin:0">They will be signed out everywhere and must use the new password.</p>',
      validate: (f) => {
        if ((f.password || "").length < 6) return "Password must be at least 6 characters.";
        if (f.pin && !/^\d{4,6}$/.test(f.pin)) return "PIN must be 4 to 6 digits.";
        return null;
      },
    });
    if (!result) return;
    await api("/users/" + userId + "/password", { method: "POST", body: { password: result.password, pin: result.pin } });
    toast("Password updated", "good");
  });

  /* ================================================================== */
  /* Settings                                                           */
  /* ================================================================== */
  async function renderSettings() {
    const s = S.settings;
    setSub(isAdmin() ? "Shop details, receipt and tax" : "Your login");

    const adminCards = isAdmin()
      ? '<form id="settings-form">' +
        '<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Shop details</h3></div><div class="card-pad">' +
        '<div class="row"><label class="field"><span>Cafe name</span><input type="text" name="cafeName" value="' + esc(s.cafeName) + '"></label>' +
        '<label class="field"><span>Name in Tamil</span><input type="text" name="cafeNameLocal" value="' + esc(s.cafeNameLocal) + '"></label></div>' +
        '<label class="field"><span>Tagline</span><input type="text" name="tagline" value="' + esc(s.tagline) + '"></label>' +
        '<label class="field"><span>Address</span><input type="text" name="address" value="' + esc(s.address) + '"></label>' +
        '<div class="row"><label class="field"><span>Phone</span><input type="text" name="phone" value="' + esc(s.phone) + '"></label>' +
        '<label class="field"><span>Currency symbol</span><input type="text" name="currency" maxlength="3" value="' + esc(s.currency) + '"></label></div>' +
        '<label class="field"><span>GSTIN</span>' +
        '<input type="text" name="gstin" id="gstin-input" maxlength="20" autocapitalize="characters" spellcheck="false" ' +
        'placeholder="33AAAAA0000A1Z5" value="' + esc(s.gstin) + '"></label>' +
        '<div id="gstin-hint" class="small" style="margin:-8px 0 12px"></div>' +
        '<p class="small muted" style="margin:0">Leave this empty if you are not GST registered. It prints in the bill header.</p>' +
        "</div></div>" +

        '<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Bill &amp; printing</h3></div><div class="card-pad">' +
        '<div class="row"><label class="field"><span>Printer roll width</span><select name="printWidth">' +
        '<option value="80mm"' + (s.printWidth === "80mm" ? " selected" : "") + ">80 mm (standard thermal)</option>" +
        '<option value="58mm"' + (s.printWidth === "58mm" ? " selected" : "") + ">58 mm (small thermal)</option>" +
        "</select></label>" +
        '<label class="field"><span>Payment modes (comma separated)</span><input type="text" name="paymentModes" value="' + esc((s.paymentModes || []).join(", ")) + '"></label></div>' +
        '<label class="field"><span>Footer line on the bill</span><input type="text" name="footerNote" value="' + esc(s.footerNote) + '"></label>' +
        '<label class="check"><input type="checkbox" name="showLocalNames"' + (s.showLocalNames ? " checked" : "") + "><span>Show Tamil names on screen and on the bill</span></label>" +
        '<label class="check"><input type="checkbox" name="roundOff"' + (s.roundOff ? " checked" : "") + "><span>Round the total to the nearest rupee</span></label>" +
        "</div></div>" +

        '<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>GST &amp; charges</h3></div><div class="card-pad">' +
        '<label class="check"><input type="checkbox" name="taxEnabled"' + (s.taxEnabled ? " checked" : "") + "><span>This shop charges GST</span></label>" +
        '<label class="field"><span>How are the menu rates priced?</span><select name="taxMode">' +
        '<option value="inclusive"' + (s.taxMode !== "exclusive" ? " selected" : "") + ">Rates already include GST (usual for a cafe)</option>" +
        '<option value="exclusive"' + (s.taxMode === "exclusive" ? " selected" : "") + ">Add GST on top of the rate</option>" +
        "</select></label>" +
        '<div class="row"><label class="field"><span>Tax name</span><input type="text" name="taxName" value="' + esc(s.taxName) + '"></label>' +
        '<label class="field"><span>GST %</span><input type="number" name="taxPercent" min="0" max="100" step="0.5" value="' + s.taxPercent + '"></label></div>' +
        '<label class="check"><input type="checkbox" name="splitGst"' + (s.splitGst !== false ? " checked" : "") + "><span>Show the CGST / SGST halves on the bill</span></label>" +
        '<label class="field"><span>Note printed on every bill</span><input type="text" name="gstNote" value="' + esc(s.gstNote || "") + '"></label>' +
        '<p class="small muted" style="margin:0 0 6px">With inclusive rates nothing is added at the bottom of the bill — the GST already inside the total is printed as a breakup, followed by this note.</p>' +
        "</div></div>" +

        '<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Service charge</h3></div><div class="card-pad">' +
        '<label class="check"><input type="checkbox" name="serviceChargeEnabled"' + (s.serviceChargeEnabled ? " checked" : "") + "><span>Add a service charge</span></label>" +
        '<label class="field" style="max-width:220px"><span>Service charge %</span><input type="number" name="serviceChargePercent" min="0" max="100" step="0.5" value="' + s.serviceChargePercent + '"></label>' +
        "</div></div>" +
        '<button class="btn primary lg" type="submit">💾 Save settings</button></form>'
      : "";

    screen().innerHTML =
      adminCards +
      '<div class="card" style="margin-top:16px"><div class="card-head"><h3>Your login</h3></div><div class="card-pad">' +
      '<p class="small muted" style="margin-top:0">Signed in as <b>' + esc(S.user.name) + "</b> (@" + esc(S.user.username) + ") · " +
      (isAdmin() ? "Admin" : "Counter staff") + "</p>" +
      '<button class="btn" data-act="change-own-password">Change my password / PIN</button>' +
      '<button class="btn ghost" data-act="logout" style="margin-left:8px">Sign out</button>' +
      "</div></div>";

    const form = document.getElementById("settings-form");
    if (form) form.addEventListener("submit", (e) => { e.preventDefault(); saveSettings(form); });

    const gstinField = document.getElementById("gstin-input");
    if (gstinField) {
      paintGstinHint(S.gstinInfo);
      gstinField.addEventListener("input", () => {
        const v = gstinField.value.replace(/[\s-]/g, "").toUpperCase();
        gstinField.value = v;
        // Only the shape can be judged here; the check digit is the server's call.
        if (!v) return paintGstinHint(null);
        if (v.length < 15) return paintGstinHint({ typing: true, len: v.length });
        if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(v)) {
          return paintGstinHint({ ok: false, error: "That is not the GSTIN pattern (22AAAAA0000A1Z5)." });
        }
        paintGstinHint({ pending: true });
      });
    }
  }

  /** Shows what the server made of the GSTIN — its state, or what looks wrong. */
  function paintGstinHint(info) {
    const el = document.getElementById("gstin-hint");
    if (!el) return;
    if (!info || info.empty) {
      // Optional on purpose — plenty of shops are still waiting for the number.
      el.innerHTML = S.settings.taxEnabled
        ? '<span class="muted">Not added yet — bills print without it. Add it here whenever it comes through.</span>'
        : "";
      return;
    }
    if (info.typing) {
      el.innerHTML = '<span class="muted">' + info.len + " of 15 characters…</span>";
    } else if (info.pending) {
      el.innerHTML = '<span class="muted">Looks right — save to check it fully.</span>';
    } else if (info.ok === false) {
      el.innerHTML = '<span style="color:var(--red)">✕ ' + esc(info.error) + "</span>";
    } else if (!info.checksumOk) {
      el.innerHTML = '<span style="color:var(--amber)">⚠ ' + esc(info.warning) + "</span>";
    } else {
      el.innerHTML = '<span style="color:var(--green)">✓ Valid GSTIN' +
        (info.state ? " · registered in " + esc(info.state) : "") + "</span>";
    }
  }

  const saveSettings = guard(async function (form) {
    const body = {};
    form.querySelectorAll("[name]").forEach((f) => {
      body[f.name] = f.type === "checkbox" ? f.checked : f.value;
    });
    body.paymentModes = String(body.paymentModes || "").split(",").map((x) => x.trim()).filter(Boolean);
    body.taxPercent = Number(body.taxPercent) || 0;
    body.serviceChargePercent = Number(body.serviceChargePercent) || 0;
    const out = await api("/settings", { method: "PUT", body });
    S.settings = out.settings;
    S.gstinInfo = out.gstinInfo || null;
    document.title = (S.settings.cafeName || "Cafe") + " POS";
    toast("Settings saved", "good");
    if (S.gstinInfo && S.gstinInfo.warning) toast(S.gstinInfo.warning, "warn");
    else if (S.gstinInfo && S.gstinInfo.stateWarning) toast(S.gstinInfo.stateWarning, "warn");
    renderShell();
    renderSettings();
  });

  const changeOwnPassword = guard(async function () {
    const result = await modal({
      title: "Change my password",
      okText: "Update",
      body:
        '<label class="field"><span>Current password</span><input type="password" name="current"></label>' +
        '<label class="field"><span>New password</span><input type="password" name="password" placeholder="at least 6 characters"></label>' +
        '<label class="field"><span>New quick PIN (optional)</span><input type="text" name="pin" inputmode="numeric" maxlength="6"></label>',
      validate: (f) => {
        if ((f.password || "").length < 6) return "New password must be at least 6 characters.";
        if (f.pin && !/^\d{4,6}$/.test(f.pin)) return "PIN must be 4 to 6 digits.";
        return null;
      },
    });
    if (!result) return;
    await api("/me/password", { method: "POST", body: result });
    toast("Password updated", "good");
  });

  /* ================================================================== */
  /* Reports: day close + export                                        */
  /* ================================================================== */
  const dayClose = guard(async function () {
    const date = S.view.dashFrom || todayStr();
    const out = await api("/dayclose?date=" + date);
    Print.dayClose(out.report, out.settings, date);
  });

  function exportCsv() {
    const from = S.view.dashFrom || S.view.billFrom || todayStr();
    const to = S.view.dashTo || S.view.billTo || from;
    window.location.href = "/api/export/orders.csv?from=" + from + "&to=" + to;
  }

  /* ================================================================== */
  /* Events                                                             */
  /* ================================================================== */
  const HANDLERS = {
    /* auth */
    "login-mode": (el) => { loginMode = el.dataset.mode; pinBuffer = ""; renderLogin(); },
    "pin-key": (el) => {
      const k = el.dataset.key;
      if (k === "clear") pinBuffer = "";
      else if (k === "back") pinBuffer = pinBuffer.slice(0, -1);
      else if (pinBuffer.length < 6) pinBuffer += k;
      renderLogin();
      if (pinBuffer.length === 4) doLogin({ pin: pinBuffer }, "/login/pin");
    },
    "pin-submit": () => doLogin({ pin: pinBuffer }, "/login/pin"),
    logout: guard(async () => {
      await api("/logout", { method: "POST" });
      S.user = null;
      S.cart = null;
      location.hash = "#/";
      renderLogin();
    }),

    /* chrome */
    "toggle-nav": () => document.getElementById("sidebar").classList.toggle("open"),
    "toggle-cart": () => {
      const open = document.getElementById("pos-cart").classList.toggle("open");
      document.body.classList.toggle("cart-open", open);
    },

    /* floor */
    "open-table": (el) => {
      location.hash = el.dataset.order ? "#/order/id/" + el.dataset.order : "#/order/table/" + el.dataset.table;
    },
    "open-order": (el) => { location.hash = "#/order/id/" + el.dataset.order; },
    quick: (el) => { location.hash = "#/order/quick/" + el.dataset.mode; },
    "refresh-floor": () => renderFloor(),

    /* order screen */
    cat: (el) => { S.view.cat = el.dataset.cat; paintCategories(); paintItems(); },
    "add-item": (el) => addItem(el.dataset.item),
    "line-plus": (el) => changeQty(Number(el.dataset.idx), 1),
    "line-minus": (el) => changeQty(Number(el.dataset.idx), -1),
    "line-remove": (el) => changeQty(Number(el.dataset.idx), -Infinity),
    "line-note": (el) => lineNote(Number(el.dataset.idx)),
    mode: (el) => setMode(el.dataset.mode),
    "order-more": () => orderMore(),
    "open-item": () => openItem(),
    kot: () => sendKot(),
    "print-bill": () => printBill(),
    settle: () => settle(),
    hold: () => holdOrder(),
    discount: () => setDiscount(),

    /* dashboard + bills */
    "dash-preset": (el) => {
      const p = PRESETS[el.dataset.preset];
      S.view.preset = el.dataset.preset;
      S.view.dashFrom = p.from();
      S.view.dashTo = p.to();
      renderDashboard();
    },
    "dash-apply": () => {
      S.view.dashFrom = document.getElementById("dash-from").value || todayStr();
      S.view.dashTo = document.getElementById("dash-to").value || S.view.dashFrom;
      S.view.preset = "";
      renderDashboard();
    },
    "bills-apply": () => {
      const from = document.getElementById("bill-from");
      if (from) { S.view.billFrom = from.value || todayStr(); S.view.billTo = document.getElementById("bill-to").value || S.view.billFrom; }
      S.view.billStatus = document.getElementById("bill-status").value;
      renderBills();
    },
    "view-bill": (el) => viewBill(el.dataset.order),
    reprint: guard(async (el) => {
      const out = await api("/orders/" + el.dataset.order);
      Print.bill(out.order, S.settings, { reprint: true });
    }),
    "day-close": () => dayClose(),
    "export-csv": () => exportCsv(),

    /* menu admin */
    "new-item": (el) => itemForm(null, el.dataset.cat),
    "edit-item": (el) => itemForm(el.dataset.item),
    "delete-item": guard(async (el) => {
      const item = S.items.find((i) => i.id === el.dataset.item);
      const yes = await confirmBox("Remove " + item.name + "?", "It disappears from the counter. Past bills keep it.", "Remove");
      if (!yes) return;
      await api("/items/" + item.id, { method: "DELETE" });
      toast("Removed");
      renderMenu();
    }),
    "save-rates": () => saveRates(),
    "add-category": () => categoryForm(null),
    "edit-category": (el) => categoryForm(el.dataset.cat),
    "delete-category": guard(async (el) => {
      const cat = S.categories.find((c) => c.id === el.dataset.cat);
      const yes = await confirmBox("Remove " + cat.name + "?", "Move or delete its items first.", "Remove");
      if (!yes) return;
      await api("/categories/" + cat.id, { method: "DELETE" });
      toast("Removed");
      renderMenu();
    }),

    /* table admin */
    "add-table": () => tableForm(null),
    "edit-table": (el) => tableForm(el.dataset.table),
    "generate-tables": () => generateTables(),
    "delete-table": guard(async (el) => {
      const t = S.tables.find((x) => x.id === el.dataset.table);
      const yes = await confirmBox("Remove " + t.name + "?", "The table disappears from the floor screen.", "Remove");
      if (!yes) return;
      await api("/tables/" + t.id, { method: "DELETE" });
      toast("Removed");
      renderTablesAdmin();
    }),

    /* staff admin */
    "add-user": () => userForm(null),
    "edit-user": (el) => userForm(el.dataset.user),
    "reset-password": (el) => resetPassword(el.dataset.user, el.dataset.name),
    "delete-user": guard(async (el) => {
      const yes = await confirmBox("Remove this login?", "They will not be able to sign in again.", "Remove");
      if (!yes) return;
      await api("/users/" + el.dataset.user, { method: "DELETE" });
      toast("Login removed");
      renderStaff();
    }),

    /* settings */
    "change-own-password": () => changeOwnPassword(),
  };

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const handler = HANDLERS[el.dataset.act];
    if (!handler) return;
    e.preventDefault();
    handler(el, e);
  });

  document.addEventListener("submit", (e) => {
    const el = e.target.closest('[data-act="login-submit"]');
    if (!el) return;
    e.preventDefault();
    const form = {};
    el.querySelectorAll("[name]").forEach((f) => { form[f.name] = f.value; });
    doLogin(form);
  });

  document.addEventListener("change", (e) => {
    const el = e.target.closest('[data-act="item-available"]');
    if (!el) return;
    guard(async () => {
      await api("/items/" + el.dataset.item, { method: "PUT", body: { available: el.checked } });
      const item = S.items.find((i) => i.id === el.dataset.item);
      if (item) item.available = el.checked;
      toast(item.name + (el.checked ? " is on sale" : " turned off"));
      renderMenu();
    })();
  });

  /* Save a half-typed bill if the tab is closed or the tablet sleeps. */
  window.addEventListener("beforeunload", () => {
    if (S.dirty && S.cart && S.cart.orderId) {
      navigator.sendBeacon(
        "/api/orders/" + S.cart.orderId,
        new Blob([JSON.stringify(cartPayload(S.cart))], { type: "application/json" })
      );
    }
  });

  /* ================================================================== */
  /* Start                                                              */
  /* ================================================================== */
  (async function init() {
    try {
      const s = await api("/branding");
      S.settings = s.settings;
    } catch (e) { /* not signed in yet — the login screen uses its own defaults */ }
    try {
      await boot();
    } catch (e) {
      renderLogin();
    }
  })();
})();
