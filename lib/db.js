"use strict";
/**
 * MySQL Database Abstraction & Persistence Layer for Coffeemia POS.
 *
 * Configured for MySQL / MariaDB:
 *   Host:     process.env.DB_HOST || "localhost"
 *   Port:     process.env.DB_PORT || 3306
 *   User:     process.env.DB_USER || "root"
 *   Password: process.env.DB_PASSWORD || ""
 *   Database: process.env.DB_NAME || "akb-cofeemia"
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = parseInt(process.env.DB_PORT || "3306", 10);
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : "";
const DB_NAME = process.env.DB_NAME || process.env.POS_DB_NAME || "akb-cofeemia";

const DATA_DIR = process.env.POS_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "pos.json");

const EMPTY = {
  meta: { version: 1 },
  settings: {},
  categories: [],
  items: [],
  tables: [],
  users: [],
  orders: [],
  counters: { bill: 0, token: 0, tokenDay: "" },
};

let pool = null;
let cache = null;
let writeQueue = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function id() {
  return crypto.randomUUID();
}

/** Initialize MySQL database connection pool, database, and tables. */
async function initDb() {
  try {
    // 1. Ensure database exists (attempt creation, ignore permission error if pre-created on cPanel)
    try {
      const rootConn = await mysql.createConnection({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
      });
      await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await rootConn.end();
    } catch (dbCreateErr) {
      console.warn(`[pos-db] Note on database initialization: ${dbCreateErr.message}`);
    }

    // 2. Create connection pool
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    console.log(`[pos-db] Connected to MySQL database: ${DB_NAME} at ${DB_HOST}:${DB_PORT}`);

    // 3. Create tables if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`settings\` (
        \`setting_key\` VARCHAR(100) PRIMARY KEY,
        \`setting_value\` LONGTEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`categories\` (
        \`id\` VARCHAR(36) PRIMARY KEY,
        \`name\` VARCHAR(100) NOT NULL,
        \`local_name\` VARCHAR(100) DEFAULT '',
        \`station\` VARCHAR(50) DEFAULT 'Kitchen',
        \`sort\` INT DEFAULT 0,
        \`active\` TINYINT(1) DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`items\` (
        \`id\` VARCHAR(36) PRIMARY KEY,
        \`category_id\` VARCHAR(36) NOT NULL,
        \`name\` VARCHAR(120) NOT NULL,
        \`local_name\` VARCHAR(120) DEFAULT '',
        \`code\` VARCHAR(20) DEFAULT '',
        \`price\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        \`available\` TINYINT(1) DEFAULT 1,
        \`archived\` TINYINT(1) DEFAULT 0,
        \`sort\` INT DEFAULT 0,
        \`price_history\` LONGTEXT DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`pos_tables\` (
        \`id\` VARCHAR(36) PRIMARY KEY,
        \`name\` VARCHAR(60) NOT NULL,
        \`zone\` VARCHAR(60) DEFAULT 'Main',
        \`seats\` INT DEFAULT 4,
        \`sort\` INT DEFAULT 0,
        \`active\` TINYINT(1) DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`users\` (
        \`id\` VARCHAR(36) PRIMARY KEY,
        \`username\` VARCHAR(60) NOT NULL UNIQUE,
        \`name\` VARCHAR(100) NOT NULL,
        \`role\` VARCHAR(30) NOT NULL DEFAULT 'cashier',
        \`password_hash\` VARCHAR(255) NOT NULL,
        \`pin_hash\` VARCHAR(255) DEFAULT NULL,
        \`active\` TINYINT(1) DEFAULT 1,
        \`created_at\` VARCHAR(50) DEFAULT NULL,
        \`last_login_at\` VARCHAR(50) DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`orders\` (
        \`id\` VARCHAR(36) PRIMARY KEY,
        \`no\` INT DEFAULT NULL,
        \`token\` INT DEFAULT 1,
        \`table_id\` VARCHAR(36) DEFAULT NULL,
        \`table_name\` VARCHAR(60) DEFAULT '',
        \`mode\` VARCHAR(30) DEFAULT 'dine-in',
        \`status\` VARCHAR(30) DEFAULT 'open',
        \`lines\` LONGTEXT NOT NULL,
        \`totals\` LONGTEXT DEFAULT NULL,
        \`discount_type\` VARCHAR(20) DEFAULT 'amount',
        \`discount_value\` DECIMAL(10,2) DEFAULT 0.00,
        \`customer\` LONGTEXT DEFAULT NULL,
        \`note\` TEXT DEFAULT NULL,
        \`kot_count\` INT DEFAULT 0,
        \`void_log\` LONGTEXT DEFAULT NULL,
        \`cancel_reason\` TEXT DEFAULT NULL,
        \`created_by\` VARCHAR(36) DEFAULT NULL,
        \`created_by_name\` VARCHAR(100) DEFAULT NULL,
        \`paid_by\` VARCHAR(36) DEFAULT NULL,
        \`paid_by_name\` VARCHAR(100) DEFAULT NULL,
        \`business_date\` VARCHAR(10) DEFAULT '',
        \`created_at\` VARCHAR(50) DEFAULT NULL,
        \`updated_at\` VARCHAR(50) DEFAULT NULL,
        \`paid_at\` VARCHAR(50) DEFAULT NULL,
        \`merged\` TINYINT(1) DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`counters\` (
        \`counter_key\` VARCHAR(50) PRIMARY KEY,
        \`value_num\` INT DEFAULT 0,
        \`value_str\` VARCHAR(50) DEFAULT ''
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 4. Check if MySQL has data, or migrate existing pos.json
    const [userRows] = await pool.query("SELECT COUNT(*) AS count FROM `users`");
    if (userRows[0].count === 0) {
      ensureDir();
      if (fs.existsSync(DB_FILE)) {
        try {
          console.log("[pos-db] Seeding existing pos.json data into MySQL...");
          const jsonContent = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
          await seedJsonToMysql(jsonContent);
          console.log("[pos-db] Successfully migrated pos.json to MySQL database.");
        } catch (err) {
          console.error("[pos-db] Error reading pos.json for seed:", err.message);
        }
      }
    }

    // 5. Load snapshot into cache
    await loadFromDb();
  } catch (err) {
    console.warn(`[pos-db] MySQL initialization skipped (${err.message}). Using file storage (${DB_FILE}).`);
    pool = null;
    loadFromFile();
  }
}

/** Synchronous file-based JSON load fallback */
function loadFromFile() {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch (e) {
      cache = JSON.parse(JSON.stringify(EMPTY));
    }
  } else {
    cache = JSON.parse(JSON.stringify(EMPTY));
  }
}

/** Seed JSON object into MySQL tables */
async function seedJsonToMysql(data) {
  if (!pool) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Settings
    if (data.settings) {
      for (const [k, v] of Object.entries(data.settings)) {
        await conn.query(
          "INSERT INTO `settings` (`setting_key`, `setting_value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `setting_value` = ?",
          [k, JSON.stringify(v), JSON.stringify(v)]
        );
      }
    }

    // Categories
    if (Array.isArray(data.categories)) {
      for (const c of data.categories) {
        await conn.query(
          `INSERT INTO \`categories\` (\`id\`, \`name\`, \`local_name\`, \`station\`, \`sort\`, \`active\`)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE \`name\`=?, \`local_name\`=?, \`station\`=?, \`sort\`=?, \`active\`=?`,
          [c.id, c.name, c.localName || "", c.station || "Kitchen", c.sort || 0, c.active ? 1 : 0,
           c.name, c.localName || "", c.station || "Kitchen", c.sort || 0, c.active ? 1 : 0]
        );
      }
    }

    // Items
    if (Array.isArray(data.items)) {
      for (const i of data.items) {
        await conn.query(
          `INSERT INTO \`items\` (\`id\`, \`category_id\`, \`name\`, \`local_name\`, \`code\`, \`price\`, \`available\`, \`archived\`, \`sort\`, \`price_history\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE \`category_id\`=?, \`name\`=?, \`local_name\`=?, \`code\`=?, \`price\`=?, \`available\`=?, \`archived\`=?, \`sort\`=?, \`price_history\`=?`,
          [i.id, i.categoryId, i.name, i.localName || "", i.code || "", i.price || 0, i.available ? 1 : 0, i.archived ? 1 : 0, i.sort || 0, JSON.stringify(i.priceHistory || []),
           i.categoryId, i.name, i.localName || "", i.code || "", i.price || 0, i.available ? 1 : 0, i.archived ? 1 : 0, i.sort || 0, JSON.stringify(i.priceHistory || [])]
        );
      }
    }

    // Tables
    if (Array.isArray(data.tables)) {
      for (const t of data.tables) {
        await conn.query(
          `INSERT INTO \`pos_tables\` (\`id\`, \`name\`, \`zone\`, \`seats\`, \`sort\`, \`active\`)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE \`name\`=?, \`zone\`=?, \`seats\`=?, \`sort\`=?, \`active\`=?`,
          [t.id, t.name, t.zone || "Main", t.seats || 4, t.sort || 0, t.active ? 1 : 0,
           t.name, t.zone || "Main", t.seats || 4, t.sort || 0, t.active ? 1 : 0]
        );
      }
    }

    // Users
    if (Array.isArray(data.users)) {
      for (const u of data.users) {
        await conn.query(
          `INSERT INTO \`users\` (\`id\`, \`username\`, \`name\`, \`role\`, \`password_hash\`, \`pin_hash\`, \`active\`, \`created_at\`, \`last_login_at\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE \`name\`=?, \`role\`=?, \`password_hash\`=?, \`pin_hash\`=?, \`active\`=?, \`last_login_at\`=?`,
          [u.id, u.username, u.name, u.role, u.passwordHash, u.pinHash || null, u.active ? 1 : 0, u.createdAt || new Date().toISOString(), u.lastLoginAt || null,
           u.name, u.role, u.passwordHash, u.pinHash || null, u.active ? 1 : 0, u.lastLoginAt || null]
        );
      }
    }

    // Orders
    if (Array.isArray(data.orders)) {
      for (const o of data.orders) {
        await conn.query(
          `INSERT INTO \`orders\` (\`id\`, \`no\`, \`token\`, \`table_id\`, \`table_name\`, \`mode\`, \`status\`, \`lines\`, \`totals\`, \`discount_type\`, \`discount_value\`, \`customer\`, \`note\`, \`kot_count\`, \`void_log\`, \`cancel_reason\`, \`created_by\`, \`created_by_name\`, \`paid_by\`, \`paid_by_name\`, \`business_date\`, \`created_at\`, \`updated_at\`, \`paid_at\`, \`merged\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE \`status\`=?, \`lines\`=?, \`totals\`=?, \`updated_at\`=?, \`paid_at\`=?`,
          [
            o.id, o.no || null, o.token || 1, o.tableId || null, o.tableName || "", o.mode || "dine-in", o.status || "open",
            JSON.stringify(o.lines || []), JSON.stringify(o.totals || {}), o.discountType || "amount", o.discountValue || 0,
            JSON.stringify(o.customer || {}), o.note || "", o.kotCount || 0, JSON.stringify(o.voidLog || []), o.cancelReason || "",
            o.createdBy || null, o.createdByName || "", o.paidBy || null, o.paidByName || "", o.businessDate || "",
            o.createdAt || new Date().toISOString(), o.updatedAt || new Date().toISOString(), o.paidAt || null, o.merged ? 1 : 0,
            o.status || "open", JSON.stringify(o.lines || []), JSON.stringify(o.totals || {}), o.updatedAt || new Date().toISOString(), o.paidAt || null
          ]
        );
      }
    }

    // Counters
    if (data.counters) {
      if (data.counters.bill !== undefined) {
        await conn.query("INSERT INTO \`counters\` (\`counter_key\`, \`value_num\`) VALUES ('bill', ?) ON DUPLICATE KEY UPDATE \`value_num\` = ?", [data.counters.bill, data.counters.bill]);
      }
      if (data.counters.token !== undefined) {
        await conn.query("INSERT INTO \`counters\` (\`counter_key\`, \`value_num\`) VALUES ('token', ?) ON DUPLICATE KEY UPDATE \`value_num\` = ?", [data.counters.token, data.counters.token]);
      }
      if (data.counters.tokenDay !== undefined) {
        await conn.query("INSERT INTO \`counters\` (\`counter_key\`, \`value_str\`) VALUES ('tokenDay', ?) ON DUPLICATE KEY UPDATE \`value_str\` = ?", [data.counters.tokenDay, data.counters.tokenDay]);
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error("[pos-db] Error during JSON seed to MySQL:", err);
    throw err;
  } finally {
    conn.release();
  }
}

/** Load current database state from MySQL into memory cache */
async function loadFromDb() {
  if (!pool) {
    cache = JSON.parse(JSON.stringify(EMPTY));
    return cache;
  }

  const [settingRows] = await pool.query("SELECT \`setting_key\`, \`setting_value\` FROM \`settings\`");
  const settings = {};
  for (const r of settingRows) {
    try { settings[r.setting_key] = JSON.parse(r.setting_value); } catch (_) { settings[r.setting_key] = r.setting_value; }
  }

  const [catRows] = await pool.query("SELECT * FROM \`categories\` ORDER BY \`sort\` ASC");
  const categories = catRows.map((r) => ({
    id: r.id,
    name: r.name,
    localName: r.local_name || "",
    station: r.station || "Kitchen",
    sort: r.sort || 0,
    active: !!r.active,
  }));

  const [itemRows] = await pool.query("SELECT * FROM \`items\` ORDER BY \`sort\` ASC");
  const items = itemRows.map((r) => {
    let ph = [];
    if (r.price_history) {
      ph = typeof r.price_history === "string" ? JSON.parse(r.price_history) : r.price_history;
    }
    return {
      id: r.id,
      categoryId: r.category_id,
      name: r.name,
      localName: r.local_name || "",
      code: r.code || "",
      price: Number(r.price) || 0,
      available: !!r.available,
      archived: !!r.archived,
      sort: r.sort || 0,
      priceHistory: ph,
    };
  });

  const [tableRows] = await pool.query("SELECT * FROM \`pos_tables\` ORDER BY \`sort\` ASC");
  const tables = tableRows.map((r) => ({
    id: r.id,
    name: r.name,
    zone: r.zone || "Main",
    seats: r.seats || 4,
    sort: r.sort || 0,
    active: !!r.active,
  }));

  const [userRows] = await pool.query("SELECT * FROM \`users\`");
  const users = userRows.map((r) => ({
    id: r.id,
    username: r.username,
    name: r.name,
    role: r.role,
    passwordHash: r.password_hash,
    pinHash: r.pin_hash || null,
    active: !!r.active,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }));

  const [orderRows] = await pool.query("SELECT * FROM \`orders\` ORDER BY \`created_at\` DESC");
  const orders = orderRows.map((r) => ({
    id: r.id,
    no: r.no,
    token: r.token,
    tableId: r.table_id,
    tableName: r.table_name,
    mode: r.mode,
    status: r.status,
    lines: typeof r.lines === "string" ? JSON.parse(r.lines) : (r.lines || []),
    totals: typeof r.totals === "string" ? JSON.parse(r.totals) : (r.totals || {}),
    discountType: r.discount_type,
    discountValue: Number(r.discount_value) || 0,
    customer: typeof r.customer === "string" ? JSON.parse(r.customer) : (r.customer || {}),
    note: r.note || "",
    kotCount: r.kot_count || 0,
    voidLog: typeof r.void_log === "string" ? JSON.parse(r.void_log) : (r.void_log || []),
    cancelReason: r.cancel_reason || "",
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    paidBy: r.paid_by,
    paidByName: r.paid_by_name,
    businessDate: r.business_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    paidAt: r.paid_at,
    merged: !!r.merged,
  }));

  const [counterRows] = await pool.query("SELECT * FROM \`counters\`");
  const counters = { bill: 0, token: 0, tokenDay: "" };
  for (const r of counterRows) {
    if (r.counter_key === "bill") counters.bill = r.value_num || 0;
    if (r.counter_key === "token") counters.token = r.value_num || 0;
    if (r.counter_key === "tokenDay") counters.tokenDay = r.value_str || "";
  }

  cache = {
    meta: { version: 1 },
    settings,
    categories,
    items,
    tables,
    users,
    orders,
    counters,
  };

  return cache;
}

/** Synchronous load returning cached in-memory structure */
function load() {
  if (!cache) {
    cache = JSON.parse(JSON.stringify(EMPTY));
  }
  return cache;
}

/** Persist all current in-memory cache directly to MySQL & fallback file */
function save() {
  if (!cache) return Promise.resolve();
  writeQueue = writeQueue.then(async () => {
    try {
      if (pool) {
        await seedJsonToMysql(cache);
      }
      // Also write pos.json as secondary file backup
      ensureDir();
      const snapshot = JSON.stringify(cache, null, 2);
      const tmp = DB_FILE + ".tmp-" + process.pid;
      await fs.promises.writeFile(tmp, snapshot);
      await fs.promises.rename(tmp, DB_FILE);
    } catch (err) {
      console.error("[pos-db] Error saving to MySQL / file:", err.message);
    }
  });
  return writeQueue;
}

/** MySQL Helper to execute raw queries if needed */
async function query(sql, params) {
  if (!pool) throw new Error("MySQL pool not initialized");
  return pool.query(sql, params);
}

module.exports = {
  initDb,
  loadFromDb,
  load,
  save,
  query,
  id,
  DATA_DIR,
  DB_FILE,
};
