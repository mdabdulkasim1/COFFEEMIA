/* Receipt, kitchen ticket and day-close printing.
   Everything renders into #print-area; the print stylesheet hides the app and
   shows only that node, so a plain browser print goes straight to an 80mm or
   58mm thermal roll (set the roll size in Settings, and the paper size once in
   the browser's own print dialog). */
(function (global) {
  "use strict";

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function amt(n) {
    return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  }
  function when(iso) {
    const d = new Date(iso || Date.now());
    return d.toLocaleDateString("en-GB") + "  " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  function head(s, title) {
    return (
      '<div class="c">' +
      '<h1>' + esc(s.cafeName || "Cafe") + "</h1>" +
      (s.cafeNameLocal ? '<div class="b ta" style="font-size:14px">' + esc(s.cafeNameLocal) + "</div>" : "") +
      (s.address ? "<div>" + esc(s.address) + "</div>" : "") +
      (s.phone ? "<div>Ph: " + esc(s.phone) + "</div>" : "") +
      (s.gstin ? "<div>GSTIN: " + esc(s.gstin) + "</div>" : "") +
      (title ? '<div class="sep"></div><div class="b">' + esc(title) + "</div>" : "") +
      "</div>"
    );
  }
  function paint(html, widthClass) {
    let host = document.getElementById("print-area");
    if (!host) {
      // It lives outside #app in index.html; recreate it if a page ever lacks it.
      host = document.createElement("div");
      host.id = "print-area";
      document.body.appendChild(host);
    }
    host.className = "";
    host.innerHTML = '<div class="receipt ' + (widthClass || "") + '">' + html + "</div>";
    // Let the browser lay the node out before opening the print dialog.
    setTimeout(function () { global.print(); }, 60);
  }
  function widthClass(s) {
    return s && s.printWidth === "58mm" ? "w58" : "";
  }

  /* ---------------- Customer bill ---------------- */
  function bill(order, s, opts) {
    const o = order || {};
    const t = o.totals || {};
    const cur = s.currency || "";
    const rows = (o.lines || [])
      .map(function (l, i) {
        const local = s.showLocalNames && l.localName ? '<div class="ta">' + esc(l.localName) + "</div>" : "";
        const note = l.note ? '<div style="font-size:10px">* ' + esc(l.note) + "</div>" : "";
        return (
          "<tr><td>" + (i + 1) + ".</td>" +
          "<td>" + esc(l.name) + local + note + "</td>" +
          '<td class="r">' + l.qty + "</td>" +
          '<td class="r">' + amt(l.price) + "</td>" +
          '<td class="r">' + amt(l.price * l.qty) + "</td></tr>"
        );
      })
      .join("");

    let lines = "";
    const add = function (label, value) {
      lines += '<tr><td colspan="3">' + esc(label) + '</td><td class="r" colspan="2">' + value + "</td></tr>";
    };
    add("Subtotal", amt(t.subtotal));
    if (t.discount > 0) {
      add("Discount" + (t.discountType === "percent" ? " (" + t.discountValue + "%)" : ""), "-" + amt(t.discount));
    }
    if (t.serviceCharge > 0) add("Service charge (" + t.serviceChargePercent + "%)", amt(t.serviceCharge));
    // Exclusive GST is added on at the bottom; inclusive GST is already in the
    // rates and is shown as a breakup underneath the total instead.
    if (t.tax > 0 && t.taxMode !== "inclusive") {
      add((t.taxName || "GST") + " (" + t.taxPercent + "%)", amt(t.tax));
    }
    if (t.roundOff) add("Round off", (t.roundOff > 0 ? "+" : "") + amt(t.roundOff));

    let gstBlock = "";
    if (t.tax > 0 && t.taxMode === "inclusive") {
      const name = t.taxName || "GST";
      const half = t.taxPercent / 2;
      gstBlock =
        '<div class="sep"></div>' +
        '<div class="b">' + esc(name) + " breakup (included in the total)</div>" +
        "<table><tr><td>Taxable value</td><td class=\"r\">" + amt(t.taxableValue) + "</td></tr>" +
        (s.splitGst !== false && t.cgst !== undefined
          ? "<tr><td>CGST " + half + "%</td><td class=\"r\">" + amt(t.cgst) + "</td></tr>" +
            "<tr><td>SGST " + half + "%</td><td class=\"r\">" + amt(t.sgst) + "</td></tr>"
          : "<tr><td>" + esc(name) + " " + t.taxPercent + "%</td><td class=\"r\">" + amt(t.tax) + "</td></tr>") +
        "</table>";
    }

    const pay = o.payment || {};
    const html =
      head(s, null) +
      '<div class="sep"></div>' +
      "<table><tr><td>Bill</td><td class=\"r b\">" + (o.no ? "#" + o.no : "(unsettled)") + "</td></tr>" +
      "<tr><td>Date</td><td class=\"r\">" + when(o.paidAt || o.createdAt) + "</td></tr>" +
      "<tr><td>" + esc(o.tableName || "Counter") + "</td><td class=\"r\">Token " + (o.token || "-") + "</td></tr>" +
      "<tr><td>Mode</td><td class=\"r\">" + esc(String(o.mode || "").replace("-", " ").toUpperCase()) + "</td></tr>" +
      (o.customer && o.customer.name ? "<tr><td>Guest</td><td class=\"r\">" + esc(o.customer.name) + "</td></tr>" : "") +
      "<tr><td>Billed by</td><td class=\"r\">" + esc(o.paidByName || o.createdByName || "") + "</td></tr></table>" +
      '<div class="sep"></div>' +
      '<table><tr class="b"><td>#</td><td>Item</td><td class="r">Qty</td><td class="r">Rate</td><td class="r">Amt</td></tr>' +
      rows +
      '<tr><td colspan="5"><div class="sep"></div></td></tr>' +
      lines +
      "</table>" +
      '<div class="sep"></div>' +
      '<table><tr class="big"><td>TOTAL</td><td class="r">' + cur + amt(t.total) + "</td></tr></table>" +
      gstBlock +
      (pay.mode
        ? '<div class="sep"></div><table>' +
          "<tr><td>Paid by " + esc(pay.mode) + "</td><td class=\"r\">" + amt(pay.received || t.total) + "</td></tr>" +
          (pay.change > 0 ? "<tr><td>Change</td><td class=\"r\">" + amt(pay.change) + "</td></tr>" : "") +
          "</table>"
        : "") +
      '<div class="sep"></div>' +
      '<div class="c">' + esc(t.itemCount || 0) + " item(s)" +
      (t.tax > 0 && t.taxMode === "inclusive" && s.gstNote
        ? '<div class="b">' + esc(s.gstNote) + "</div>"
        : "") +
      (o.note ? "<div>" + esc(o.note) + "</div>" : "") +
      (s.footerNote ? "<div>" + esc(s.footerNote) + "</div>" : "") +
      (opts && opts.reprint ? '<div class="b">** REPRINT **</div>' : "") +
      "</div>";
    paint(html, widthClass(s));
  }

  /* ---------------- Kitchen order ticket ---------------- */
  function kot(k, s) {
    const groups = {};
    (k.lines || []).forEach(function (l) {
      const station = l.station || "Kitchen";
      (groups[station] = groups[station] || []).push(l);
    });
    const body = Object.keys(groups)
      .map(function (station) {
        return (
          '<div class="sep"></div><div class="b">' + esc(station) + "</div>" +
          groups[station]
            .map(function (l) {
              return (
                '<div class="kot-item">' + l.qty + " x " + esc(l.name) +
                (s.showLocalNames && l.localName ? ' <span class="ta">' + esc(l.localName) + "</span>" : "") +
                (l.note ? '<div style="font-size:11px;font-weight:400">* ' + esc(l.note) + "</div>" : "") +
                "</div>"
              );
            })
            .join("")
        );
      })
      .join("");

    const html =
      '<div class="c"><h1>KOT</h1><div class="token">TOKEN ' + (k.token || "-") + "</div>" +
      '<div class="b">' + esc(k.tableName || "Counter") + " · " + esc(String(k.mode || "").replace("-", " ").toUpperCase()) + "</div>" +
      "<div>" + when(k.at) + " · " + esc(k.by || "") + "</div>" +
      "<div>Ticket " + (k.no || 1) + "</div></div>" +
      body +
      (k.note ? '<div class="sep"></div><div class="b">Note: ' + esc(k.note) + "</div>" : "") +
      '<div class="sep"></div>';
    paint(html, widthClass(s));
  }

  /* ---------------- Day close (Z report) ---------------- */
  function dayClose(report, s, date) {
    const cur = s.currency || "";
    const t = report.totals || {};
    const block = function (title, rows, valueKey) {
      if (!rows || !rows.length) return "";
      return (
        '<div class="sep"></div><div class="b">' + esc(title) + "</div><table>" +
        rows
          .map(function (r) {
            return "<tr><td>" + esc(r.key) + (r.qty ? " (" + r.qty + ")" : "") +
              '</td><td class="r">' + amt(r[valueKey || "amount"]) + "</td></tr>";
          })
          .join("") +
        "</table>"
      );
    };
    const html =
      head(s, "DAY CLOSE — " + esc(date)) +
      '<div class="sep"></div>' +
      "<table>" +
      "<tr><td>Bills</td><td class=\"r b\">" + t.orders + "</td></tr>" +
      (report.firstBill ? "<tr><td>Bill range</td><td class=\"r\">#" + report.firstBill + " – #" + report.lastBill + "</td></tr>" : "") +
      "<tr><td>Items sold</td><td class=\"r\">" + t.itemsSold + "</td></tr>" +
      "<tr><td>Average bill</td><td class=\"r\">" + amt(t.average) + "</td></tr>" +
      "<tr><td>Discounts</td><td class=\"r\">" + amt(t.discount) + "</td></tr>" +
      (t.tax
        ? "<tr><td>Taxable value</td><td class=\"r\">" + amt(t.taxableValue) + "</td></tr>" +
          "<tr><td>" + esc(s.taxName || "GST") + " collected</td><td class=\"r\">" + amt(t.tax) + "</td></tr>"
        : "") +
      "<tr><td>Cancelled</td><td class=\"r\">" + t.cancelledCount + " / " + amt(t.cancelledValue) + "</td></tr>" +
      (t.openCount ? "<tr><td>Still running</td><td class=\"r\">" + t.openCount + " / " + amt(t.openValue) + "</td></tr>" : "") +
      "</table>" +
      '<div class="sep"></div>' +
      '<table><tr class="big"><td>NET SALES</td><td class="r">' + cur + amt(t.gross) + "</td></tr></table>" +
      (t.tax && t.taxMode === "inclusive" ? '<div class="c">(GST included in the figure above)</div>' : "") +
      block("Payments", report.byPayment) +
      block("Order type", report.byMode) +
      block("Counter staff", report.byStaff) +
      block("Categories", report.byCategory) +
      block("Top items", report.topItems) +
      (report.voids && report.voids.length
        ? '<div class="sep"></div><div class="b">Voids after KOT</div>' +
          report.voids.map(function (v) {
            return "<div>" + esc(v.table) + ": " + v.qty + " x " + esc(v.name) + " (" + esc(v.by) + ")</div>";
          }).join("")
        : "") +
      '<div class="sep"></div><div class="c">Printed ' + when() + "</div>";
    paint(html, widthClass(s));
  }

  global.Print = { bill: bill, kot: kot, dayClose: dayClose };
})(window);
