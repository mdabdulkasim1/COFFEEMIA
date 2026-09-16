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
  trademark: true, // show a superscript TM after the cafe name on the logo
  logo: "",        // the shop's own logo, as a data: URI, printed on the bill
  upiId: "",       // e.g. coffeemia@hdfcbank — never an account number
  upiName: "",     // what the payer sees; falls back to the cafe name
  upiQrOnBill: true,
  qrSource: "none", // "none" | "upi" (generated, carries the amount) | "image" (the bank's own QR)
  bankQr: "",       // the bank's QR as a data: URI, printed as-is
  bankQrNote: "Scan to pay",
  // GST off until the shop is registered — a bill must not show a tax breakup
  // for tax nobody is collecting. Everything below stays configured, so turning
  // taxEnabled on is the only change needed once the GSTIN arrives.
  taxEnabled: false,
  taxMode: "inclusive", // when switched on: menu rates already contain GST
  taxName: "GST",
  taxPercent: 5,
  splitGst: true,       // show the CGST / SGST halves on the bill
  gstNote: "All prices shown above are inclusive of GST.",
  serviceChargeEnabled: false,
  serviceChargePercent: 0,
  roundOff: true,
  showLocalNames: true,
  // Paper is its own choice: the counter screen stays bilingual while bills,
  // kitchen tickets and the rate list print in English only.
  printLocalNames: false,
  printWidth: "80mm", // or "58mm"
  printKotOnSave: false,
  footerNote: "Freshly made · Served warm — Thank you, visit again!",
  paymentModes: ["Cash", "UPI", "Card"],
};

/* name, localName, price */
const MENU = [
  {
    name: "Avil Milk",
    local: "அவல் மில்க்",
    station: "Beverages",
    items: [
      ["Normal Avil Milk", "நார்மல் அவல் மில்க்", 100],
      ["Fruit Avil Milk", "பழம் அவல் மில்க்", 140],
      ["Nuts & Mixed Avil Milk", "நட்ஸ் அவல் மில்க்", 180],
    ],
  },
  {
    name: "Signature Mocktails",
    local: "சிறப்பு மாக்டெயில்ஸ்",
    station: "Beverages",
    items: [
      ["Blue Lagoon Mocktail", "", 99],
      ["Virgin Mojito", "", 99],
      ["Mango Passion Cooler", "", 99],
      ["Pineapple Ginger Fizz", "", 99],
      ["Strawberry Basil Sparkler", "", 99],
    ],
  },
  {
    name: "Fresh Juices & Milkshakes",
    local: "புதிய ஜூஸ் & மில்க்ஷேக்கள்",
    station: "Beverages",
    items: [
      ["Lemon / Mint Juice", "எலுமிச்சை / புதினா ஜூஸ்", 30],
      ["Fresh Fruit Juice", "சீசன் பழ ஜூஸ்", 50],
      ["Milkshake", "மில்க்ஷேக்", 70],
      ["Rose Milk", "ரோஸ் மில்க்", 40],
    ],
  },
  {
    name: "Tea Selection",
    local: "தேநீர் வகைகள்",
    station: "Beverages",
    items: [
      ["Tea", "தேநீர்", 20],
      ["Ginger Tea", "இஞ்சி தேநீர்", 25],
      ["Sulaimani Tea", "சுலைமானி தேநீர்", 15],
      ["Green Tea", "கிரீன் டீ", 15],
      ["Protein Tea", "புரோட்டீன் டீ", 40],
      ["Sangu Poo Tea (Butterfly Pea Tea)", "சங்கு பூ டீ", 25],
    ],
  },
  {
    name: "Coffee Corner",
    local: "காபி வகைகள்",
    station: "Beverages",
    items: [
      ["Filter Coffee", "பில்டர் காபி", 25],
      ["Black Coffee", "பிளாக் காபி", 20],
      ["Cappuccino / Latte", "கப்புச்சினோ / லாட்டே", 25],
      ["Hot Chocolate / Boost", "ஹாட் சாக்லேட் / பூஸ்ட்", 30],
      ["Coffeemia Special Iced Cappuccino", "காஃபீமியா ஸ்பெஷல் ஐஸ்டு கப்புச்சினோ", 30],
      ["Banana Coffee", "வாழைப்பழ காபி", 40],
      ["Cold Coffee", "கோல்ட் காபி", 50],
      ["Rose Milk Coffee", "ரோஸ் மில்க் காபி", 50],
    ],
  },
  {
    name: "Special Drinks",
    local: "சிறப்பு பானங்கள்",
    station: "Beverages",
    items: [
      ["Coco-Mia – Coconut Affogato", "கோகோ-மியா (தேங்காய் அஃபோகாட்டோ)", 199],
    ],
  },
  {
    name: "Snacks",
    local: "தின்பண்டங்கள்",
    station: "Kitchen",
    items: [
      ["Samosa", "சமோசா", 15],
      ["Veg Puff", "வெஜ் பப்ஸ்", 20],
      ["Egg Puff", "முட்டை பப்ஸ்", 25],
      ["Chicken Cutlet", "சிக்கன் கட்லெட்", 30],
      ["Chicken Roll", "சிக்கன் ரோல்", 40],
      ["Chicken Sandwich", "சிக்கன் சாண்ட்விச்", 70],
      ["Chicken Popcorn", "சிக்கன் பாப்கார்ன்", 120],
      ["Ela Ada", "இலை அட", 20],
      ["Avil Bonda", "அவல் போண்டா", 20],
      ["Pazham Pori", "பழம்போரி", 20],
    ],
  },
  {
    name: "Combo",
    local: "காம்போ",
    station: "Beverages",
    items: [
      ["Irani Chai + Osmania Biscuits", "இரானி சாய் + ஒஸ்மானியா பிஸ்கட்ஸ்", 50],
    ],
  },
  /* Counter-only: packing is rung up like an item, so it lands on the bill
     and in the sales figures. Deliberately not on the customer's card. */
  {
    name: "Parcel",
    local: "பார்சல்",
    station: "Beverages",
    items: [
      ["Parcel Charge 1", "பார்சல் கட்டணம் 1", 5],
      ["Parcel Charge 2", "பார்சல் கட்டணம் 2", 10],
    ],
  },
];

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
