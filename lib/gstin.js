"use strict";
/**
 * GSTIN validation.
 *
 * A GSTIN is 15 characters: a 2-digit state code, the holder's 10-character
 * PAN, a 1-character entity number, the letter Z, and a check character.
 *
 * The shape is checked strictly — a GSTIN that is not 15 characters in that
 * pattern is simply not a GSTIN. The check character is verified too, but a
 * mismatch is reported as a warning rather than a refusal: it is far more
 * likely to be a typo than a bad rule, and the shop owner holds the real
 * certificate, so the last word is theirs.
 */

const SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const STATES = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  10: "Bihar", 11: "Sikkim", 12: "Arunachal Pradesh", 13: "Nagaland", 14: "Manipur",
  15: "Mizoram", 16: "Tripura", 17: "Meghalaya", 18: "Assam", 19: "West Bengal",
  20: "Jharkhand", 21: "Odisha", 22: "Chhattisgarh", 23: "Madhya Pradesh", 24: "Gujarat",
  25: "Daman & Diu", 26: "Dadra & Nagar Haveli and Daman & Diu", 27: "Maharashtra",
  28: "Andhra Pradesh (old)", 29: "Karnataka", 30: "Goa", 31: "Lakshadweep", 32: "Kerala",
  33: "Tamil Nadu", 34: "Puducherry", 35: "Andaman & Nicobar Islands", 36: "Telangana",
  37: "Andhra Pradesh", 38: "Ladakh", 97: "Other Territory", 99: "Centre Jurisdiction",
};

/** Upper-cases and strips spaces and dashes people paste in from a certificate. */
function normalise(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/[\s-]/g, "")
    .toUpperCase();
}

function checkCharacter(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/**
 * @returns {{ value, ok, empty, state, checksumOk, error, warning }}
 *   error   — the value cannot be a GSTIN; refuse to save it
 *   warning — it looks like a GSTIN but the check character disagrees
 */
function validate(raw) {
  const value = normalise(raw);
  if (!value) return { value: "", ok: true, empty: true, state: "", checksumOk: true };

  if (!SHAPE.test(value)) {
    return {
      value,
      ok: false,
      empty: false,
      state: "",
      checksumOk: false,
      error:
        value.length !== 15
          ? `A GSTIN is 15 characters — this one has ${value.length}.`
          : "That does not look like a GSTIN. The pattern is 22AAAAA0000A1Z5.",
    };
  }

  const state = STATES[value.slice(0, 2)] || "";
  const expected = checkCharacter(value.slice(0, 14));
  const checksumOk = expected === value[14];

  return {
    value,
    ok: true,
    empty: false,
    state,
    checksumOk,
    warning: checksumOk
      ? null
      : `The last character of ${value} does not match its check digit — please compare it with your GST certificate.`,
    stateWarning: state ? null : `State code ${value.slice(0, 2)} is not a state code we recognise.`,
  };
}

module.exports = { validate, normalise, checkCharacter, STATES };
