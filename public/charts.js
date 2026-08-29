/* Tiny dependency-free SVG charts for the dashboard. Each helper returns an
   HTML string so screens can be built with plain template literals. */
(function (global) {
  "use strict";

  const PALETTE = ["#c0562c", "#2d5f8a", "#2f7d4f", "#b8791b", "#7b4a8c", "#4b443c", "#0f766e", "#9c421d"];

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function round(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  /** Vertical bars — hourly or day-by-day sales. Plain HTML so the labels stay
      upright and readable however many columns there are. */
  function bars(data, opts) {
    const o = Object.assign({ height: 170, currency: "", empty: "No sales in this period" }, opts || {});
    const rows = (data || []).filter(function (d) { return d && isFinite(d.value); });
    if (!rows.length) return '<div class="empty small">' + esc(o.empty) + "</div>";

    const max = Math.max.apply(null, rows.map(function (d) { return d.value; })) || 1;
    const every = Math.ceil(rows.length / 14); // thin the labels when it gets crowded

    const cols = rows
      .map(function (d, i) {
        const pct = d.value > 0 ? Math.max(3, (d.value / max) * 100) : 0;
        const label = i % every === 0 ? esc(d.label) : "";
        return (
          '<div class="bar-col" title="' + esc(d.label) + ": " + o.currency + round(d.value) + '">' +
          '<div class="bar-col-track"><div class="bar-col-fill" style="height:' + pct + '%"></div></div>' +
          '<div class="bar-col-label">' + label + "</div></div>"
        );
      })
      .join("");

    const peak = rows.reduce(function (a, b) { return b.value > a.value ? b : a; });
    return (
      '<div class="bar-chart" style="--chart-h:' + o.height + 'px">' + cols + "</div>" +
      '<div class="small muted" style="text-align:right;margin-top:6px">Busiest: ' +
      esc(peak.label) + " · " + o.currency + round(peak.value) + "</div>"
    );
  }

  /** Donut — payment or order-type split. Returns svg + legend. */
  function donut(data, opts) {
    const o = Object.assign({ size: 168, currency: "", empty: "Nothing to show yet" }, opts || {});
    const rows = (data || []).filter(function (d) { return d && d.value > 0; });
    const total = rows.reduce(function (s, d) { return s + d.value; }, 0);
    if (!total) return '<div class="empty small">' + esc(o.empty) + "</div>";

    const R = 60, r = 36, cx = 70, cy = 70;
    let angle = -Math.PI / 2;
    const arcs = rows
      .map(function (d, i) {
        const sweep = (d.value / total) * Math.PI * 2;
        const a0 = angle;
        const a1 = angle + sweep;
        angle = a1;
        const large = sweep > Math.PI ? 1 : 0;
        // A full-circle single slice cannot be drawn as an arc; use a ring instead.
        if (rows.length === 1) {
          return '<circle cx="' + cx + '" cy="' + cy + '" r="' + (R + r) / 2 + '" fill="none" stroke="' + PALETTE[0] + '" stroke-width="' + (R - r) + '"><title>' + esc(d.label) + "</title></circle>";
        }
        const p = function (rad, ang) { return [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)]; };
        const [x0, y0] = p(R, a0), [x1, y1] = p(R, a1), [x2, y2] = p(r, a1), [x3, y3] = p(r, a0);
        return (
          '<path d="M' + x0 + " " + y0 + " A" + R + " " + R + " 0 " + large + " 1 " + x1 + " " + y1 +
          " L" + x2 + " " + y2 + " A" + r + " " + r + " 0 " + large + " 0 " + x3 + " " + y3 + ' Z" fill="' + PALETTE[i % PALETTE.length] + '">' +
          "<title>" + esc(d.label) + ": " + o.currency + round(d.value) + "</title></path>"
        );
      })
      .join("");

    const legend = rows
      .map(function (d, i) {
        const pct = Math.round((d.value / total) * 100);
        return '<span><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' + esc(d.label) + " · " + o.currency + round(d.value) + " (" + pct + "%)</span>";
      })
      .join("");

    return (
      '<div style="display:flex;flex-direction:column;align-items:center">' +
      '<svg viewBox="0 0 140 140" style="width:' + o.size + "px;max-width:100%;height:" + o.size + 'px">' + arcs +
      '<text x="70" y="66" text-anchor="middle" font-size="9" fill="#857b6e">TOTAL</text>' +
      '<text x="70" y="82" text-anchor="middle" font-size="16" font-weight="700" fill="#1b1917">' + o.currency + round(total) + "</text>" +
      "</svg>" +
      '<div class="legend">' + legend + "</div></div>"
    );
  }

  /** Horizontal ranked bars — top items, categories, staff. */
  function ranked(data, opts) {
    const o = Object.assign({ currency: "", empty: "Nothing yet", suffix: "" }, opts || {});
    const rows = data || [];
    if (!rows.length) return '<div class="empty small">' + esc(o.empty) + "</div>";
    const max = Math.max.apply(null, rows.map(function (d) { return d.value; })) || 1;
    return rows
      .map(function (d) {
        return (
          '<div class="bar-row"><div><div class="nm">' + esc(d.label) +
          (d.hint ? ' <span class="muted small">' + esc(d.hint) + "</span>" : "") + "</div>" +
          '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(3, (d.value / max) * 100) + '%"></div></div></div>' +
          '<div class="num"><b>' + o.currency + round(d.value) + o.suffix + "</b></div></div>"
        );
      })
      .join("");
  }

  global.Charts = { bars: bars, donut: donut, ranked: ranked, PALETTE: PALETTE };
})(window);
