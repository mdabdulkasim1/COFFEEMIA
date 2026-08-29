"use strict";
/**
 * First-run seed: the Coffeemia menu card, a default table layout, the three
 * logins the owner asked for, and sensible receipt settings.
 * Everything seeded here is editable from the app afterwards.
 */
const db = require("./db");
const auth = require("./auth");

const DEFAULT_SETTINGS = {
  cafeName: "Coffeemia",
  cafeNameLocal: "காஃபீமியா",
  tagline: "TEA · COFFEE · JUICE · SNACKS",
  address: "Veeramanikkam Nagar, Palayamkottai",
  phone: "",
  gstin: "",
  currency: "₹",
  taxEnabled: true,
  taxMode: "inclusive", // menu rates already contain GST — the usual way here
  taxName: "GST",
  taxPercent: 5,
  splitGst: true,       // show the CGST / SGST halves on the bill
  gstNote: "All prices shown above are inclusive of GST.",
  serviceChargeEnabled: false,
  serviceChargePercent: 0,
  roundOff: true,
  showLocalNames: true,
  printWidth: "80mm", // or "58mm"
  printKotOnSave: false,
  footerNote: "Freshly made · Served warm — Thank you, visit again!",
  paymentModes: ["Cash", "UPI", "Card"],
};

/* name, localName, price */
const MENU = [
  {
    name: "Tea",
    local: "டீ",
    station: "Beverages",
    items: [
      ["Tea", "டீ", 15],
      ["Masala Tea", "மசாலா டீ", 20],
      ["Ginger Tea", "இஞ்சி டீ", 20],
      ["Sulaimani", "சுலைமானி", 15],
      ["Green Tea", "கிரீன் டீ", 15],
    ],
  },
  {
    name: "Coffee",
    local: "காபி",
    station: "Beverages",
    items: [
      ["Filter Coffee", "பில்டர் காபி", 25],
      ["Black Coffee", "பிளாக் காபி", 20],
      ["Hot Chocolate / Boost", "பூஸ்ட்", 30],
      ["Cold Coffee", "கோல்ட் காபி", 50],
    ],
  },
  {
    name: "Snacks",
    local: "ஸ்நாக்ஸ்",
    station: "Kitchen",
    items: [
      ["Samosa", "சமோசா", 15],
      ["Vegetable Puffs", "பப்ஸ்", 20],
      ["Egg Puffs", "முட்டை பப்ஸ்", 25],
      ["Cutlet", "கட்லெட்", 20],
      ["Medhu Vada", "மெது வடை", 15],
      ["Chicken Roll", "சிக்கன் ரோல்", 40],
      ["Ilai Appam", "இலை அப்பம்", 20],
      ["Aval Bonda", "அவல் போண்டா", 20],
      ["Pazha Bajji", "பழ பஜ்ஜி", 20],
    ],
  },
  {
    name: "Fresh Juices",
    local: "ஜூஸ்",
    station: "Beverages",
    items: [
      ["Lime Juice / Mint Lime", "எலுமிச்சை", 30],
      ["Seasonal Fruit Juice", "பழச்சாறு", 50],
      ["Milkshakes", "மில்க்ஷேக்", 70],
      ["Rose Milk", "ரோஸ் மில்க்", 30],
    ],
  },
];

/**
 * Seed logins. The passwords here are throwaway demo values so the app is
 * usable the moment it starts on a counter machine. Anything reachable from
 * the internet should set the matching environment variables instead, so the
 * first deploy is never sitting on a published default.
 */
const USERS = [
  { username: "admin", name: "Owner", role: "admin", env: "ADMIN", password: "admin123", pin: "1111" },
  { username: "user1", name: "Counter 1", role: "cashier", env: "USER1", password: "user123", pin: "2222" },
  { username: "user2", name: "Counter 2", role: "cashier", env: "USER2", password: "user123", pin: "3333" },
];

/** Environment overrides, e.g. POS_ADMIN_PASSWORD / POS_ADMIN_PIN. */
function credentialsFor(u) {
  const password = process.env[`POS_${u.env}_PASSWORD`];
  const pin = process.env[`POS_${u.env}_PIN`];
  return {
    password: password && password.length >= 6 ? password : u.password,
    pin: pin && /^\d{4,6}$/.test(pin) ? pin : u.pin,
    usedDefault: !(password && password.length >= 6),
  };
}

/**
 * Shouts at boot if any login still has its published demo password. Cheap to
 * run (a few scrypt checks) and the one thing worth interrupting startup for
 * when the app is on a public URL.
 */
function warnIfDefaultPasswords(data) {
  const auth = require("./auth");
  const stale = USERS.filter((u) => {
    const user = data.users.find((x) => x.username === u.username);
    return user && user.active && auth.verifySecret(u.password, user.passwordHash);
  }).map((u) => u.username);

  if (!stale.length) return [];
  console.warn(
    "\n[pos] ================= SECURITY WARNING =================\n" +
      `[pos] These logins still use the published demo password: ${stale.join(", ")}\n` +
      "[pos] Anyone who finds this address can sign in and take money.\n" +
      "[pos] Change them now in Settings -> Staff & access.\n" +
      "[pos] ===================================================\n"
  );
  return stale;
}

const TABLE_COUNT = 8;

/** Short keyboard code for an item, e.g. "Masala Tea" -> "MT". Unique per menu. */
function makeCode(name, taken) {
  const words = String(name).replace(/[^A-Za-z ]/g, " ").split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] || "IT").slice(0, 3);
  base = base.toUpperCase().slice(0, 4);
  let code = base;
  let n = 1;
  while (taken.has(code)) code = base + ++n;
  taken.add(code);
  return code;
}

function seedIfEmpty() {
  const data = db.load();
  let changed = false;

  if (!data.settings || !data.settings.cafeName) {
    data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    changed = true;
  } else {
    // Fill in any setting added by a later version without clobbering choices.
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(k in data.settings)) { data.settings[k] = v; changed = true; }
    }
  }

  if (data.categories.length === 0 && data.items.length === 0) {
    const codes = new Set();
    MENU.forEach((cat, ci) => {
      const catId = db.id();
      data.categories.push({
        id: catId,
        name: cat.name,
        localName: cat.local,
        station: cat.station,
        sort: ci,
        active: true,
      });
      cat.items.forEach(([name, local, price], ii) => {
        data.items.push({
          id: db.id(),
          categoryId: catId,
          name,
          localName: local,
          code: makeCode(name, codes),
          price,
          available: true,
          sort: ii,
        });
      });
    });
    changed = true;
  }

  if (data.tables.length === 0) {
    for (let i = 1; i <= TABLE_COUNT; i++) {
      data.tables.push({
        id: db.id(),
        name: "Table " + i,
        zone: "Main",
        seats: 4,
        sort: i,
        active: true,
      });
    }
    changed = true;
  }

  if (data.users.length === 0) {
    let anyDefault = false;
    USERS.forEach((u) => {
      const cred = credentialsFor(u);
      if (cred.usedDefault) anyDefault = true;
      data.users.push({
        id: db.id(),
        username: u.username,
        name: u.name,
        role: u.role,
        passwordHash: auth.hashSecret(cred.password),
        pinHash: auth.hashSecret(cred.pin),
        active: true,
        createdAt: new Date().toISOString(),
      });
    });
    changed = true;
    console.log(
      anyDefault
        ? "[pos] Seeded logins — admin/admin123 (PIN 1111), user1/user123 (PIN 2222), user2/user123 (PIN 3333).\n" +
            "[pos] Change these from Settings -> Staff before going live."
        : "[pos] Seeded logins admin, user1 and user2 using the passwords from the environment."
    );
  }

  if (changed) db.save();
  return data;
}

module.exports = { seedIfEmpty, warnIfDefaultPasswords, DEFAULT_SETTINGS };
