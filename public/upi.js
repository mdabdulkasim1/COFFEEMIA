/* UPI payment QR for the bill.

   The QR itself is produced by the vendored qrcode-generator library (MIT,
   Kazuhiko Arase). An earlier hand-written encoder was dropped after testing:
   codes it produced would not scan at all, which is not a risk worth taking on
   something that carries a payment amount. */
(function (global) {
  "use strict";

  /* A UPI ID looks like name@bank — never an account number. */
  const VPA = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$/;

  function isValidUpiId(value) {
    return VPA.test(String(value || "").trim());
  }

  /**
   * The NPCI deep link. Amount is fixed to two decimals so the payer's app
   * shows exactly what the bill says.
   */
  function buildUri(opts) {
    const o = opts || {};
    if (!isValidUpiId(o.upiId)) return "";
    const parts = [
      // The ID is already validated to safe characters, and some UPI apps
      // dislike a percent-encoded @, so it goes in as-is.
      "pa=" + String(o.upiId).trim(),
      "pn=" + encodeURIComponent(String(o.payeeName || "").trim() || "Cafe"),
      "am=" + (Math.round((Number(o.amount) || 0) * 100) / 100).toFixed(2),
      "cu=INR",
    ];
    if (o.note) parts.push("tn=" + encodeURIComponent(String(o.note).slice(0, 50)));
    return "upi://pay?" + parts.join("&");
  }

  /** Crisp whole-module SVG — what a thermal head needs to print a readable code. */
  function svg(text, opts) {
    const o = Object.assign({ size: 132, quiet: 4 }, opts || {});
    const qr = global.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const total = n + o.quiet * 2;
    let path = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) path += "M" + (c + o.quiet) + " " + (r + o.quiet) + "h1v1h-1z";
      }
    }
    return (
      '<svg class="upi-qr" viewBox="0 0 ' + total + " " + total + '" ' +
      'width="' + o.size + '" height="' + o.size + '" shape-rendering="crispEdges" ' +
      'xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + total + '" height="' + total + '" fill="#fff"/>' +
      '<path d="' + path + '" fill="#000"/></svg>'
    );
  }

  global.UPI = { buildUri: buildUri, isValidUpiId: isValidUpiId, svg: svg };
})(typeof window !== "undefined" ? window : globalThis);
