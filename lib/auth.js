"use strict";
/**
 * Password / PIN hashing (scrypt) + cookie session management. Zero dependencies.
 *
 * Staff sign in either with username + password, or with a 4-6 digit PIN on the
 * counter tablet (fast shift hand-over). Both are stored hashed.
 */
const crypto = require("crypto");

/* ---------- Secrets ---------- */
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(secret), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifySecret(secret, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  const derived = crypto.scryptSync(String(secret), salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(derived, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- Sessions (in-memory, sliding TTL) ---------- */
const SESSIONS = new Map(); // token -> { userId, expires }
const COOKIE = "pos_session";
const TTL_MS = 1000 * 60 * 60 * 16; // one long cafe shift

function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  SESSIONS.set(token, { userId, expires: Date.now() + TTL_MS });
  return token;
}

function destroySession(token) {
  if (token) SESSIONS.delete(token);
}

function getSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    SESSIONS.delete(token);
    return null;
  }
  s.expires = Date.now() + TTL_MS; // sliding expiry
  return s;
}

/** Drop every session belonging to a user (used on password reset / deactivate). */
function destroyUserSessions(userId) {
  for (const [token, s] of SESSIONS) if (s.userId === userId) SESSIONS.delete(token);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (process.env.SECURE_COOKIE === "1") attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function tokenFromReq(req) {
  return parseCookies(req)[COOKIE] || null;
}

module.exports = {
  hashSecret,
  verifySecret,
  createSession,
  destroySession,
  destroyUserSessions,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  tokenFromReq,
  COOKIE,
};
