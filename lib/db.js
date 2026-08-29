"use strict";
/**
 * Tiny JSON-file data store for the cafe POS. Zero dependencies.
 * The whole database lives in memory and is persisted atomically on change.
 * A cafe writes a few hundred orders a day, so this is plenty fast and
 * avoids any native database dependency on the counter machine.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.POS_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "pos.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

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

let cache = null;
let writeQueue = Promise.resolve();

function load() {
  if (cache) return cache;
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      for (const k of Object.keys(EMPTY)) {
        if (!(k in cache)) cache[k] = JSON.parse(JSON.stringify(EMPTY[k]));
      }
    } catch (e) {
      // Corrupt file: keep a copy and start fresh rather than refuse to boot.
      try { fs.renameSync(DB_FILE, DB_FILE + ".corrupt-" + Date.now()); } catch (_) {}
      cache = JSON.parse(JSON.stringify(EMPTY));
    }
  } else {
    cache = JSON.parse(JSON.stringify(EMPTY));
  }
  return cache;
}

/** Persist the current cache atomically (write temp, then rename). Serialized. */
function save() {
  const snapshot = JSON.stringify(cache, null, 2);
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        ensureDir();
        const tmp = DB_FILE + ".tmp-" + process.pid;
        fs.writeFile(tmp, snapshot, (err) => {
          if (err) return resolve();
          fs.rename(tmp, DB_FILE, () => resolve());
        });
      })
  );
  return writeQueue;
}

function id() {
  return crypto.randomUUID();
}

module.exports = { load, save, id, DATA_DIR, DB_FILE };
