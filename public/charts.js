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

  /** Hour by hour, day against day line chart. */
  function hourComparison(data, opts) {
    const o = Object.assign({ currency: "" }, opts || {});
    const rawDays = (data && data.days) || [];
    const hours = (data && data.tradingHours && data.tradingHours.length)
      ? data.tradingHours
      : ["08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22"];

    if (!rawDays.length || !rawDays.some(function(d) { return d.total > 0; })) {
      return '<div class="empty small">No settled bills in these days yet.</div>';
    }

    const isLongWindow = rawDays.length > 7;
    let seriesList = [];

    if (isLongWindow) {
      // Long window fallback: 3 series (Today, Yesterday, Period Average)
      const todayObj = rawDays[0] || { label: "Today", hours: {}, total: 0 };
      const yestObj = rawDays[1] || { label: "Yesterday", hours: {}, total: 0 };
      const avgHours = (data && data.periodAvgHours) || {};
      let avgTotal = 0;
      hours.forEach(function(h) { avgTotal += (avgHours[h] || 0); });

      seriesList = [
        { label: todayObj.label || "Today", hours: todayObj.hours || {}, total: todayObj.total || 0, color: "#C0562C", dash: false, strokeW: 2.5 },
        { label: yestObj.label || "Yesterday", hours: yestObj.hours || {}, total: yestObj.total || 0, color: "#52525b", dash: false, strokeW: 2.0 },
        { label: rawDays.length + "-day Average", hours: avgHours, total: round(avgTotal), color: "#71717a", dash: true, strokeW: 1.8 },
      ];
    } else {
      const COLORS = ["#C0562C", "#52525b", "#71717a", "#a1a1aa", "#cbd5e1", "#e2e8f0", "#f4f4f5"];
      seriesList = rawDays.map(function(d, i) {
        return {
          label: d.label,
          hours: d.hours || {},
          total: d.total || 0,
          color: COLORS[i % COLORS.length],
          dash: false,
          strokeW: i === 0 ? 2.5 : 1.5,
        };
      });
    }

    let maxVal = 1;
    seriesList.forEach(function (s) {
      hours.forEach(function (h) {
        const v = (s.hours && s.hours[h]) || 0;
        if (v > maxVal) maxVal = v;
      });
    });

    const W = 640, H = 200, padL = 50, padR = 20, padT = 20, padB = 35;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    const xStep = hours.length > 1 ? chartW / (hours.length - 1) : chartW;

    const legend =
      '<div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">' +
      seriesList.map(function(s) {
        const dashStyle = s.dash ? 'border-bottom:2px dashed ' + s.color : 'background:' + s.color;
        return '<span style="display:inline-flex;align-items:center;gap:6px;background:#FAF7F2;border:1px solid #E3D8C8;border-radius:4px;padding:3px 8px;font-size:11.5px;font-weight:600;color:#1B1917">' +
          '<i style="width:10px;height:10px;border-radius:2px;' + dashStyle + ';display:inline-block"></i>' +
          esc(s.label) + ' ' + o.currency + round(s.total) + '</span>';
      }).join('') +
      '</div>';

    const paths = seriesList.map(function(s, sIdx) {
      const pts = hours.map(function(h, hIdx) {
        const val = (s.hours && s.hours[h]) || 0;
        const x = padL + hIdx * xStep;
        const y = padT + chartH - (val / maxVal) * chartH;
        return { x: x, y: y, val: val, h: h };
      });

      const pathStr = pts.map(function(p, i) { return (i === 0 ? 'M' : 'L') + round(p.x) + ' ' + round(p.y); }).join(' ');
      const strokeDash = s.dash ? 'stroke-dasharray="4,4"' : '';
      const circles = pts.map(function(p) {
        return '<circle cx="' + round(p.x) + '" cy="' + round(p.y) + '" r="' + (sIdx === 0 ? 3.5 : 2.5) + '" fill="' + s.color + '">' +
          '<title>' + esc(s.label) + ' ' + p.h + ':00 · ' + o.currency + round(p.val) + '</title></circle>';
      }).join('');

      return '<path d="' + pathStr + '" fill="none" stroke="' + s.color + '" stroke-width="' + s.strokeW + '" ' + strokeDash + ' stroke-linecap="round"/>' + circles;
    }).join('');

    const xLabels = hours.map(function(h, i) {
      if (hours.length > 12 && i % 2 !== 0) return '';
      const hNum = Number(h);
      const h12 = hNum % 12 === 0 ? 12 : hNum % 12;
      const ampm = hNum < 12 ? 'am' : 'pm';
      const x = padL + i * xStep;
      return '<text x="' + round(x) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="#857b6e">' + h12 + ampm + '</text>';
    }).join('');

    const yGridLines =
      '<line x1="' + padL + '" y1="' + padT + '" x2="' + (W - padR) + '" y2="' + padT + '" stroke="#e3d8c8" stroke-width="0.8"/>' +
      '<text x="' + (padL - 6) + '" y="' + (padT + 4) + '" text-anchor="end" font-size="10" fill="#857b6e">' + o.currency + round(maxVal) + '</text>' +
      '<line x1="' + padL + '" y1="' + round(padT + chartH / 2) + '" x2="' + (W - padR) + '" y2="' + round(padT + chartH / 2) + '" stroke="#e3d8c8" stroke-width="0.8"/>' +
      '<text x="' + (padL - 6) + '" y="' + round(padT + chartH / 2 + 3) + '" text-anchor="end" font-size="10" fill="#857b6e">' + o.currency + round(maxVal / 2) + '</text>' +
      '<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '" stroke="#e3d8c8" stroke-width="1.2"/>' +
      '<text x="' + (padL - 6) + '" y="' + (H - padB + 3) + '" text-anchor="end" font-size="10" fill="#857b6e">' + o.currency + '0</text>';

    return (
      '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;overflow:visible">' +
      yGridLines +
      paths +
      xLabels +
      '</svg>' +
      legend
    );
  }

  /** Customers day by day: Bar chart + table underneath. */
  function customersDayByDay(data, opts) {
    const o = Object.assign({ currency: "" }, opts || {});
    const info = data || {};
    const rows = info.rows || [];
    if (!rows.length) {
      return '<div class="empty small">No settled bills in this period yet.</div>';
    }

    const maxCust = Math.max.apply(null, rows.map(function(r) { return r.customers; })) || 1;
    const summary = info.summary ? '<div style="font-size:12.5px;font-weight:600;color:var(--brand);margin-bottom:12px">' + esc(info.summary) + '</div>' : '';

    const every = Math.ceil(rows.length / 14);
    const cols = rows.map(function(d, i) {
      const pct = d.customers > 0 ? Math.max(4, (d.customers / maxCust) * 100) : 0;
      const label = i % every === 0 ? esc(d.label) : "";
      return (
        '<div class="bar-col" title="' + esc(d.label) + ': ' + d.customers + ' customers">' +
        '<div class="bar-col-track"><div class="bar-col-fill" style="height:' + pct + '%"></div></div>' +
        '<div class="bar-col-label" style="white-space:nowrap;font-size:10px">' + label + '</div></div>'
      );
    }).join("");

    const barChart = '<div class="bar-chart" style="--chart-h:130px;margin-bottom:14px">' + cols + '</div>';

    const tableRows = rows.map(function(d) {
      return (
        '<tr>' +
        '<td style="font-weight:600;white-space:nowrap"><b>' + esc(d.label) + '</b></td>' +
        '<td class="num"><b>' + d.customers + '</b></td>' +
        '<td class="num">' + d.items + '</td>' +
        '<td class="num">' + o.currency + round(d.avgBill) + '</td>' +
        '<td class="num"><b>' + o.currency + round(d.takings) + '</b></td>' +
        '<td class="num small">' + d.mobileCount + ' <span class="muted">(' + d.newCustomers + ' new)</span></td>' +
        '</tr>'
      );
    }).join('');

    const table =
      '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">' +
      '<table class="grid" style="font-size:12.5px">' +
      '<thead><tr><th>Date</th><th class="num">Customers</th><th class="num">Items</th><th class="num">Avg bill</th><th class="num">Takings</th><th class="num">Mobile (New)</th></tr></thead>' +
      '<tbody>' + tableRows + '</tbody>' +
      '</table></div>';

    return summary + barChart + table;
  }

  /** Day x Hour Heatmap matrix. */
  function heatmap(data, opts) {
    const o = Object.assign({ currency: "" }, opts || {});
    const rows = data || [];
    if (!rows.length || !rows.some(function(r) { return r.total > 0; })) {
      return '<div class="empty small">No settled bills in these days yet.</div>';
    }

    const hourSet = new Set();
    rows.forEach(function(r) {
      Object.keys(r.hours || {}).forEach(function(h) {
        if (r.hours[h] > 0) hourSet.add(Number(h));
      });
    });

    const activeHours = Array.from(hourSet).sort(function(a, b) { return a - b; });
    const startH = activeHours.length ? Math.min.apply(null, activeHours) : 8;
    const endH = activeHours.length ? Math.max.apply(null, activeHours) : 22;
    const hours = [];
    for (let h = startH; h <= endH; h++) {
      hours.push(String(h).padStart(2, '0'));
    }

    let maxVal = 1;
    rows.forEach(function(r) {
      hours.forEach(function(h) {
        const v = (r.hours && r.hours[h]) || 0;
        if (v > maxVal) maxVal = v;
      });
    });

    const headerCols = hours.map(function(h) {
      const hNum = Number(h);
      const h12 = hNum % 12 === 0 ? 12 : hNum % 12;
      const ampm = hNum < 12 ? 'am' : 'pm';
      return '<th style="text-align:center;padding:6px 4px;font-size:11px">' + h12 + ampm + '</th>';
    }).join('');

    const bodyRows = rows.map(function(r) {
      const cells = hours.map(function(h) {
        const val = (r.hours && r.hours[h]) || 0;
        const ratio = val > 0 ? val / maxVal : 0;
        const bg = ratio > 0 ? 'rgba(192, 86, 44, ' + Math.max(0.12, ratio.toFixed(2)) + ')' : '#faf7f2';
        const txtCol = ratio > 0.45 ? '#ffffff' : '#1b1917';
        const display = val > 0 ? Math.round(val) : '—';
        return '<td style="background:' + bg + ';color:' + txtCol + ';text-align:center;padding:7px 4px;font-size:11.5px;font-weight:' + (ratio > 0 ? '600' : '400') + '" title="' + esc(r.date) + ' ' + h + ':00 · ' + o.currency + round(val) + '">' + display + '</td>';
      }).join('');

      return '<tr><td style="font-weight:600;white-space:nowrap;padding:7px 8px;font-size:12px">' + esc(r.label || r.date) + '</td>' +
        cells +
        '<td style="font-weight:700;text-align:right;padding:7px 8px;font-size:12px;background:#f4ece0">' + o.currency + round(r.total) + '</td></tr>';
    }).join('');

    const legend =
      '<div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:#857B6E;margin-top:10px">' +
      '<span>Quiet</span>' +
      '<div style="display:inline-flex;gap:3px;align-items:center">' +
      '<span style="width:14px;height:14px;border-radius:2px;background:rgba(192, 86, 44, 0.12)"></span>' +
      '<span style="width:14px;height:14px;border-radius:2px;background:rgba(192, 86, 44, 0.35)"></span>' +
      '<span style="width:14px;height:14px;border-radius:2px;background:rgba(192, 86, 44, 0.55)"></span>' +
      '<span style="width:14px;height:14px;border-radius:2px;background:rgba(192, 86, 44, 0.75)"></span>' +
      '<span style="width:14px;height:14px;border-radius:2px;background:rgba(192, 86, 44, 1.0)"></span>' +
      '</div>' +
      '<span>Busy · up to ' + o.currency + round(maxVal) + '</span>' +
      '</div>';

    return (
      '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">' +
      '<table class="grid" style="min-width:100%;font-size:12px;border-spacing:2px;border-collapse:separate">' +
      '<thead><tr><th style="padding:6px 8px;font-size:11px">Day</th>' + headerCols + '<th style="text-align:right;padding:6px 8px;font-size:11px">Total</th></tr></thead>' +
      '<tbody>' + bodyRows + '</tbody>' +
      '</table></div>' +
      legend
    );
  }

  /** Menu Focus — Log-scale scatter bubble plot with collision-aware labels and quadrant legends. */
  function menuFocus(data, opts) {
    const o = Object.assign({ currency: "" }, opts || {});
    const items = (data || []).slice();
    if (!items.length) {
      return '<div class="empty small">No settled bills in this period yet.</div>';
    }

    const W = 640, H = 290;
    const maxR = 22;
    const padL = 50, padR = 40, padT = 30, padB = 45;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    const rates = items.map(function(i) { return i.price; });
    const logQtys = items.map(function(i) { return i.logQty; });

    const minRate = Math.min.apply(null, rates.concat([10]));
    const maxRate = Math.max.apply(null, rates.concat([100]));
    const minLog = Math.min.apply(null, logQtys.concat([1]));
    const maxLog = Math.max.apply(null, logQtys.concat([3]));

    const rateRange = Math.max(10, maxRate - minRate);
    const logRange = Math.max(0.5, maxLog - minLog);

    const midRate = minRate + rateRange / 2;
    const midLog = minLog + logRange / 2;

    const midX = padL + ((midLog - minLog) / logRange) * chartW;
    const midY = padT + chartH - ((midRate - minRate) / rateRange) * chartH;

    const maxAmt = Math.max.apply(null, items.map(function(i) { return i.amount; })) || 1;

    // Calculate position, radius, and quadrant color for every item
    const nodes = items.map(function(item) {
      const x = padL + ((item.logQty - minLog) / logRange) * chartW;
      const y = padT + chartH - ((item.price - minRate) / rateRange) * chartH;
      const r = Math.max(6, Math.min(maxR, Math.sqrt(item.amount / maxAmt) * maxR));

      const isHighRate = item.price >= midRate;
      const isHighQty = item.logQty >= midLog;
      let colors = { fill: "rgba(184, 121, 27, 0.45)", stroke: "#b8791b" }; // Review (gold)
      if (isHighRate && isHighQty) colors = { fill: "rgba(192, 86, 44, 0.45)", stroke: "#C0562C" }; // Core (terracotta)
      else if (isHighRate && !isHighQty) colors = { fill: "rgba(47, 125, 79, 0.45)", stroke: "#2f7d4f" }; // Push more (green)
      else if (!isHighRate && isHighQty) colors = { fill: "rgba(45, 95, 138, 0.45)", stroke: "#2d5f8a" }; // Volume fillers (blue)

      return {
        item: item,
        x: x,
        y: y,
        r: r,
        amount: item.amount,
        name: item.name,
        colors: colors,
      };
    });

    // Sort nodes by amount descending so higher takings get label placement priority
    nodes.sort(function(a, b) { return b.amount - a.amount; });

    const placedBoxes = [];

    function intersects(b1, b2) {
      return !(b1.maxX < b2.minX || b1.minX > b2.maxX || b1.maxY < b2.minY || b1.minY > b2.maxY);
    }

    const elements = nodes.map(function(node) {
      const item = node.item;
      const x = node.x;
      const y = node.y;
      const r = node.r;

      // Circle element with quadrant color & full tooltip detail
      const circleEl =
        '<circle cx="' + round(x) + '" cy="' + round(y) + '" r="' + round(r) + '" fill="' + node.colors.fill + '" stroke="' + node.colors.stroke + '" stroke-width="1.5">' +
        '<title>' + esc(node.name) + ' · ' + item.qty + ' sold · ' + o.currency + round(item.price) + ' rate · ' + o.currency + round(item.amount) + ' takings</title></circle>';

      // Label collision test
      const fontH = 11;
      const estWidth = node.name.length * 6 + 6;
      let chosenTextEl = "";

      const candidates = [
        { x: x, y: y - r - 4, align: "middle", box: { minX: x - estWidth / 2, maxX: x + estWidth / 2, minY: y - r - 4 - fontH, maxY: y - r - 2 } },
        { x: x, y: y + r + 10, align: "middle", box: { minX: x - estWidth / 2, maxX: x + estWidth / 2, minY: y + r + 2, maxY: y + r + 10 + fontH } },
        { x: x + r + 4, y: y + 3, align: "start", box: { minX: x + r + 4, maxX: x + r + 4 + estWidth, minY: y - fontH / 2, maxY: y + fontH / 2 } },
      ];

      for (let c = 0; c < candidates.length; c++) {
        const cand = candidates[c];
        const box = cand.box;

        if (box.minX < 10 || box.maxX > W - 10 || box.minY < 10 || box.maxY > H - 15) {
          continue;
        }

        let hit = false;
        for (let p = 0; p < placedBoxes.length; p++) {
          if (intersects(box, placedBoxes[p])) {
            hit = true;
            break;
          }
        }

        if (!hit) {
          placedBoxes.push(box);
          chosenTextEl =
            '<text x="' + round(cand.x) + '" y="' + round(cand.y) + '" text-anchor="' + cand.align + '" font-size="10" font-weight="600" fill="#1b1917" style="pointer-events:none">' +
            esc(node.name) +
            '</text>';
          break;
        }
      }

      return '<g class="bubble-group">' + circleEl + chosenTextEl + '</g>';
    }).join('');

    const yAxisTicks =
      '<text x="' + (padL - 6) + '" y="' + (padT + 4) + '" text-anchor="end" font-size="10" fill="#857b6e">' + o.currency + round(maxRate) + '</text>' +
      '<text x="' + (padL - 6) + '" y="' + round(midY + 3) + '" text-anchor="end" font-size="10" fill="#857b6e">' + o.currency + round(midRate) + '</text>' +
      '<text x="' + (padL - 6) + '" y="' + (H - padB + 3) + '" text-anchor="end" font-size="10" fill="#857b6e">' + o.currency + '0</text>';

    const medianLabel =
      '<text x="' + (W - padR - 10) + '" y="' + round(midY - 6) + '" text-anchor="end" font-size="10" font-weight="600" fill="#857b6e">avg ' + o.currency + round(midRate) + ' a unit</text>';

    const xAxisTicks =
      '<text x="' + padL + '" y="' + (H - padB + 15) + '" font-size="10" fill="#857b6e">1</text>';

    const legend =
      '<div style="display:flex;align-items:center;gap:14px;font-size:11px;color:#1b1917;margin-top:10px;flex-wrap:wrap">' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><i style="width:10px;height:10px;border-radius:2px;background:#2f7d4f;display:inline-block"></i><b>Push more</b> — dearer, sells less</span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><i style="width:10px;height:10px;border-radius:2px;background:#C0562C;display:inline-block"></i><b>Core sellers</b></span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><i style="width:10px;height:10px;border-radius:2px;background:#2d5f8a;display:inline-block"></i><b>Volume fillers</b></span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><i style="width:10px;height:10px;border-radius:2px;background:#b8791b;display:inline-block"></i><b>Review</b></span>' +
      '</div>';

    return (
      '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;overflow:visible">' +
      // Quadrant dividers & Median line
      '<line x1="' + round(midX) + '" y1="' + padT + '" x2="' + round(midX) + '" y2="' + (H - padB) + '" stroke="#e3d8c8" stroke-dasharray="4,4" stroke-width="1"/>' +
      '<line x1="' + padL + '" y1="' + round(midY) + '" x2="' + (W - padR) + '" y2="' + round(midY) + '" stroke="#e3d8c8" stroke-dasharray="4,4" stroke-width="1"/>' +

      // Median Rate Label
      medianLabel +

      // Quadrant Titles
      '<text x="' + (padL + 10) + '" y="' + (padT + 15) + '" font-size="10" font-weight="700" fill="#2f7d4f" letter-spacing="0.5">PUSH MORE</text>' +
      '<text x="' + (W - padR - 10) + '" y="' + (padT + 15) + '" text-anchor="end" font-size="10" font-weight="700" fill="#C0562C" letter-spacing="0.5">CORE SELLERS</text>' +
      '<text x="' + (padL + 10) + '" y="' + (H - padB - 10) + '" font-size="10" font-weight="700" fill="#b8791b" letter-spacing="0.5">REVIEW</text>' +
      '<text x="' + (W - padR - 10) + '" y="' + (H - padB - 10) + '" text-anchor="end" font-size="10" font-weight="700" fill="#2d5f8a" letter-spacing="0.5">VOLUME FILLERS</text>' +

      // Axes & Ticks
      '<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '" stroke="#1b1917" stroke-width="1.2"/>' +
      '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '" stroke="#1b1917" stroke-width="1.2"/>' +
      yAxisTicks +
      xAxisTicks +

      // Axis Titles
      '<text x="' + (W / 2) + '" y="' + (H - 5) + '" text-anchor="middle" font-size="11" font-weight="600" fill="#857b6e">units sold →</text>' +
      '<text x="12" y="' + (H / 2) + '" text-anchor="middle" font-size="11" font-weight="600" fill="#857b6e" transform="rotate(-90 12 ' + (H / 2) + ')">Rate (' + o.currency + ') →</text>' +

      elements +
      '</svg>' +
      legend
    );
  }

  /** Bought together item pair cards. */
  function boughtTogether(data, opts) {
    const o = Object.assign({ currency: "", empty: "Not enough bills with two or more items yet." }, opts || {});
    const pairs = data || [];
    if (!pairs.length) return '<div class="empty small">' + esc(o.empty) + '</div>';

    const max = Math.max.apply(null, pairs.map(function(p) { return p.count; })) || 1;
    return pairs.map(function(p) {
      return (
        '<div class="bar-row"><div><div class="nm"><b>' + esc(p.itemA) + '</b> + <b>' + esc(p.itemB) + '</b></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(5, (p.count / max) * 100) + '%"></div></div></div>' +
        '<div class="num"><b>' + p.count + ' bills</b></div></div>'
      );
    }).join('');
  }

  /** Slow movers (4 or fewer sold). */
  function slowMovers(data, opts) {
    const o = Object.assign({ currency: "", empty: "Nothing is lagging — every item sold more than four." }, opts || {});
    const items = data || [];
    if (!items.length) return '<div class="empty small">' + esc(o.empty) + '</div>';

    return items.map(function(i) {
      return (
        '<div class="bar-row"><div><div class="nm"><b>' + esc(i.key) + '</b> <span class="muted small">(' + esc(i.category || "Other") + ')</span></div>' +
        '<div class="bar-track" style="background:#fbe6e4"><div class="bar-fill" style="background:var(--red);width:' + Math.max(10, (i.qty / 4) * 100) + '%"></div></div></div>' +
        '<div class="num"><b>' + i.qty + ' sold</b> <div class="muted small">' + o.currency + round(i.amount) + '</div></div></div>'
      );
    }).join('');
  }

  global.Charts = {
    bars: bars,
    donut: donut,
    ranked: ranked,
    hourComparison: hourComparison,
    heatmap: heatmap,
    menuFocus: menuFocus,
    boughtTogether: boughtTogether,
    slowMovers: slowMovers,
    customersDayByDay: customersDayByDay,
    PALETTE: PALETTE,
  };
})(window);
