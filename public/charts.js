/* Tiny dependency-free SVG charts for the dashboard. Each helper returns an
   HTML string so screens can be built with plain template literals. */
(function (global) {
  "use strict";

  /* Six categorical hues, terracotta first so the brand leads. Checked with a
     palette validator: every step sits in the lightness band, clears the chroma
     floor, holds 3:1 against the card, and keeps neighbouring pairs apart for
     colour-blind readers. The old set failed three of those - do not add a
     seventh by eye; anything beyond six folds into "Other". */
  const PALETTE = ["#C0562C", "#3070C4", "#2E8B57", "#9B5DB8", "#A8801B", "#0F9B93"];

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

  /* One hue, light to dark: a heatmap encodes magnitude, so it must never be a
     rainbow. Steps of the brand terracotta, each checked for text contrast. */
  const HEAT = ["#FBF3EE", "#F6DFD2", "#EFC3AE", "#E39F80", "#D1764D", "#B24A21"];
  function heatStep(v, max) {
    if (!max || v <= 0) return 0;
    const n = Math.ceil((v / max) * (HEAT.length - 1));
    return Math.min(HEAT.length - 1, Math.max(1, n));
  }

  /**
   * Day x hour heatmap. Rows are days, columns are hours, darker is busier.
   * The number is printed in every cell that has room, so the grid is readable
   * without relying on colour alone.
   */
  function heatmap(days, hours, opts) {
    const o = Object.assign({ currency: "", empty: "No sales in this period" }, opts || {});
    if (!days || !days.length || !hours || !hours.length) {
      return '<div class="empty small">' + esc(o.empty) + "</div>";
    }
    let max = 0;
    days.forEach(function (d) {
      (d.hours || []).forEach(function (v) { if (v > max) max = v; });
    });
    const short = function (v) {
      if (!v) return "";
      return v >= 1000 ? round(v / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(v));
    };
    const head = '<tr><th class="corner"></th>' +
      hours.map(function (h) { return "<th>" + esc(h.label) + "</th>"; }).join("") +
      '<th class="tot">Day</th></tr>';
    const body = days.map(function (d) {
      return '<tr><th class="day">' + esc(d.label) + "</th>" +
        (d.hours || []).map(function (v, i) {
          const step = heatStep(v, max);
          // Only the darkest step takes white text; step 4 reads better in ink.
          const dark = step >= 5;
          return '<td class="cell" style="background:' + HEAT[step] + (dark ? ";color:#fff" : "") +
            '" title="' + esc(d.label + " · " + (hours[i] ? hours[i].label : "")) + ": " + o.currency + round(v) + '">' +
            short(v) + "</td>";
        }).join("") +
        '<td class="tot">' + o.currency + short(d.total) + "</td></tr>";
    }).join("");
    const legend = '<div class="heat-legend"><span class="small muted">Quiet</span>' +
      HEAT.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join("") +
      '<span class="small muted">Busy · up to ' + o.currency + round(max) + "</span></div>";
    return '<div class="heat-wrap"><table class="heat">' + head + body + "</table></div>" + legend;
  }

  /**
   * Several days of hourly takings on one grid, so today can be read against
   * the days before it. One line per day, the newest in the brand hue and
   * thicker; every series is also named in the legend, never colour alone.
   */
  function lines(series, hours, opts) {
    const o = Object.assign({ currency: "", height: 210, empty: "No sales in this period" }, opts || {});
    const rows = (series || []).filter(function (s) { return s && s.values && s.values.length; });
    if (!rows.length || !hours.length) return '<div class="empty small">' + esc(o.empty) + "</div>";

    const W = 720, H = o.height, padL = 46, padR = 12, padT = 12, padB = 26;
    let max = 0;
    rows.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    if (max <= 0) max = 1;
    const x = function (i) {
      return hours.length === 1 ? padL : padL + (i * (W - padL - padR)) / (hours.length - 1);
    };
    const y = function (v) { return padT + (1 - v / max) * (H - padT - padB); };

    const grid = [0, 0.5, 1].map(function (f) {
      const v = max * f;
      return '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) +
        '" stroke="#e3d8c8" stroke-width="1"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" fill="#857b6e">' +
        o.currency + Math.round(v) + "</text>";
    }).join("");

    const ticks = hours.map(function (h, i) {
      if (hours.length > 9 && i % 2) return "";
      return '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#857b6e">' +
        esc(h.label) + "</text>";
    }).join("");

    const paths = rows.map(function (s, n) {
      const colour = s.colour || PALETTE[n % PALETTE.length];
      const d = s.values.map(function (v, i) { return (i ? "L" : "M") + round(x(i)) + " " + round(y(v)); }).join(" ");
      const dots = s.emphasis
        ? s.values.map(function (v, i) {
            return '<circle cx="' + round(x(i)) + '" cy="' + round(y(v)) + '" r="3.5" fill="' + colour +
              '" stroke="#fff" stroke-width="1.5"><title>' + esc(s.label + " · " + hours[i].label) + ": " +
              o.currency + round(v) + "</title></circle>";
          }).join("")
        : "";
      return '<path d="' + d + '" fill="none" stroke="' + colour + '" stroke-width="' + (s.emphasis ? 2.5 : 1.6) +
        '" stroke-linejoin="round" stroke-linecap="round"' +
        (s.dashed ? ' stroke-dasharray="4 3"' : "") + ' opacity="' + (s.emphasis ? 1 : 0.75) + '"/>' + dots;
    }).join("");

    const legend = rows.map(function (s, n) {
      const colour = s.colour || PALETTE[n % PALETTE.length];
      return '<span class="lg"><i style="background:' + colour + '"></i>' + esc(s.label) +
        (s.total !== undefined ? ' <b>' + o.currency + round(s.total) + "</b>" : "") + "</span>";
    }).join("");

    return '<div class="chart-scroll"><svg viewBox="0 0 ' + W + " " + H + '" class="lines" role="img">' +
      grid + ticks + paths + "</svg></div>" + '<div class="chart-legend">' + legend + "</div>";
  }

  /**
   * Menu focus: units sold across, average price up, bubble size is sales
   * value. Items high and to the left are the ones worth pushing.
   */
  function scatter(points, opts) {
    const o = Object.assign({ currency: "", height: 300, empty: "Nothing sold yet" }, opts || {});
    const rows = (points || []).filter(function (p) { return p && p.qty > 0; });
    if (!rows.length) return '<div class="empty small">' + esc(o.empty) + "</div>";

    const W = 720, H = o.height, padL = 48, padR = 16, padT = 16, padB = 34;
    const maxQty = Math.max.apply(null, rows.map(function (p) { return p.qty; }));
    const minQty = Math.min.apply(null, rows.map(function (p) { return p.qty; }));
    const maxPrice = Math.max.apply(null, rows.map(function (p) { return p.price; })) * 1.1 || 1;
    const maxAmt = Math.max.apply(null, rows.map(function (p) { return p.amount; })) || 1;
    // Units run from a handful to a thousand, so the axis is logarithmic — and
    // it starts at the quietest item, not at 1, or a week with no slow movers
    // would leave the whole left half of the chart empty.
    const lx = function (q) { return Math.log10(Math.max(1, q)); };
    const lmin = lx(minQty);
    const lspan = Math.max(0.3, lx(maxQty) - lmin);
    const lmax = lspan;
    const r = function (a) { return 4 + Math.sqrt(a / maxAmt) * 14; };
    // Inset by the widest bubble so nothing straddles the axis or the edge.
    const inset = r(maxAmt) + 2;
    const x0 = padL + inset, x1 = W - padR - inset;
    const x = function (q) { return x0 + ((lx(q) - lmin) / lspan) * (x1 - x0); };
    const y = function (p) { return padT + (1 - p / maxPrice) * (H - padT - padB); };

    const avgPrice = rows.reduce(function (n, p) { return n + p.amount; }, 0) /
      rows.reduce(function (n, p) { return n + p.qty; }, 0);
    const midQty = Math.pow(10, lmin + lspan / 2);

    const guides =
      '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(avgPrice) + '" y2="' + y(avgPrice) +
      '" stroke="#c9bda9" stroke-width="1" stroke-dasharray="4 3"/>' +
      '<text x="' + (W - padR) + '" y="' + (y(avgPrice) - 5) + '" text-anchor="end" font-size="10" fill="#857b6e">avg ' +
      o.currency + round(avgPrice) + " a unit</text>" +
      '<line y1="' + padT + '" y2="' + (H - padB) + '" x1="' + x(midQty) + '" x2="' + x(midQty) +
      '" stroke="#c9bda9" stroke-width="1" stroke-dasharray="4 3"/>';

    const axes = [1, 3, 10, 30, 100, 300, 1000, 3000]
      .filter(function (v) { return v >= minQty * 0.9 && v <= maxQty * 1.1; }).map(function (v) {
      return '<text x="' + x(v) + '" y="' + (H - 16) + '" text-anchor="middle" font-size="10" fill="#857b6e">' + v + "</text>";
    }).join("") +
      '<text x="' + ((padL + W - padR) / 2) + '" y="' + (H - 3) + '" text-anchor="middle" font-size="10" fill="#857b6e">units sold</text>' +
      [0, 0.5, 1].map(function (f) {
        const v = maxPrice * f;
        return '<text x="' + (padL - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" fill="#857b6e">' +
          o.currency + Math.round(v) + "</text>";
      }).join("");

    const dots = rows.map(function (p) {
      const high = p.price >= avgPrice;
      const many = p.qty >= midQty;
      // Four quadrants, four fixed hues — never recoloured when the list changes.
      const colour = high ? (many ? PALETTE[0] : PALETTE[2]) : (many ? PALETTE[1] : PALETTE[4]);
      return '<circle cx="' + round(x(p.qty)) + '" cy="' + round(y(p.price)) + '" r="' + round(r(p.amount)) +
        '" fill="' + colour + '" fill-opacity=".55" stroke="' + colour + '" stroke-width="1.5">' +
        "<title>" + esc(p.key) + "\n" + p.qty + " sold at " + o.currency + round(p.price) +
        "\n" + o.currency + round(p.amount) + " of sales</title></circle>";
    }).join("");

    // Name only the biggest few, and never let two names sit on top of each
    // other: a name that would collide drops below its bubble instead, and is
    // skipped altogether if that collides too.
    const placed = [];
    const clear = function (cx, cy, half) {
      return !placed.some(function (b) {
        return Math.abs(b.y - cy) < 11 && Math.abs(b.x - cx) < b.half + half;
      });
    };
    const labels = rows.slice(0, 6).map(function (p) {
      const text = p.key.length > 20 ? p.key.slice(0, 19) + "\u2026" : p.key;
      const half = text.length * 2.6;
      // Keep the whole name on the canvas, even for a bubble at either end.
      const cx = round(Math.min(W - padR - half, Math.max(padL + half, x(p.qty))));
      const above = round(y(p.price) - r(p.amount) - 5);
      const below = round(y(p.price) + r(p.amount) + 11);
      let cy = null;
      if (clear(cx, above, half)) cy = above;
      else if (clear(cx, below, half)) cy = below;
      if (cy === null) return "";
      placed.push({ x: cx, y: cy, half: half });
      return '<text x="' + cx + '" y="' + cy +
        '" text-anchor="middle" font-size="10" fill="#4b443c">' + esc(text) + "</text>";
    }).join("");

    const key = '<div class="chart-legend">' +
      '<span class="lg"><i style="background:' + PALETTE[2] + '"></i>Push more — dearer, sells less</span>' +
      '<span class="lg"><i style="background:' + PALETTE[0] + '"></i>Core sellers</span>' +
      '<span class="lg"><i style="background:' + PALETTE[1] + '"></i>Volume fillers</span>' +
      '<span class="lg"><i style="background:' + PALETTE[4] + '"></i>Review</span></div>';

    return '<div class="chart-scroll"><svg viewBox="0 0 ' + W + " " + H + '" class="scatter" role="img">' +
      guides + axes + dots + labels + "</svg></div>" + key;
  }

  global.Charts = {
    bars: bars, donut: donut, ranked: ranked,
    heatmap: heatmap, lines: lines, scatter: scatter,
    PALETTE: PALETTE, HEAT: HEAT,
  };
})(window);
