/* Receipt, kitchen ticket and day-close printing.
   Everything renders into #print-area; the print stylesheet hides the app and
   shows only that node, so a plain browser print goes straight to an 80mm or
   58mm thermal roll (set the roll size in Settings, and the paper size once in
   the browser's own print dialog).
   
   Supports direct driverless connections:
   - Browser Print (window.print())
   - Wi-Fi / Network IP (Raw TCP 9100 via /api/print/network)
   - Web Bluetooth API (navigator.bluetooth)
   - Web Serial API (navigator.serial)
*/
(function (global) {
  "use strict";

  const CUP =
    '<svg class="brand-cup" viewBox="0 0 44 32" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M16.6 9.1c-1.9-1.7.5-2.9-1.4-4.6"/><path d="M21.6 9.1c-1.9-1.7.5-2.9-1.4-4.6"/></g><path d="M28.8 13.4h2.6c2.9 0 5.1 1.9 5.1 4.5s-2.2 4.5-5.1 4.5h-2.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M4.4 12.1h25.1v4.4c0 5.4-4 9.2-9.6 9.2h-5.9c-5.6 0-9.6-3.8-9.6-9.2z" fill="currentColor"/><ellipse cx="19.2" cy="28.4" rx="14.6" ry="1.9" fill="currentColor"/></svg>';

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
    const mark = s.logo
      ? '<img class="logo" src="' + s.logo + '" alt="' + esc(s.cafeName || "") + '">'
      : '<h1>' + esc(s.cafeName || "Cafe") +
      (s.trademark === false ? "" : '<sup class="tm">TM</sup>') + CUP + "</h1>";
    return (
      '<div class="c">' +
      mark +
      (s.cafeNameLocal ? '<div class="b ta" style="font-size:14px">' + esc(s.cafeNameLocal) + "</div>" : "") +
      (s.address ? "<div>" + esc(s.address) + "</div>" : "") +
      (s.phone ? "<div>Ph: " + esc(s.phone) + "</div>" : "") +
      (s.gstin ? "<div>GSTIN: " + esc(s.gstin) + "</div>" : "") +
      (title ? '<div class="sep"></div><div class="b">' + esc(title) + "</div>" : "") +
      "</div>"
    );
  }

  const PAGE_RULE_ID = "print-page-rule";
  function clearPageRule() {
    const el = document.getElementById(PAGE_RULE_ID);
    if (el) el.remove();
  }
  function setPageRule(css) {
    clearPageRule();
    const el = document.createElement("style");
    el.id = PAGE_RULE_ID;
    el.textContent = css;
    document.head.appendChild(el);
    global.addEventListener("afterprint", clearPageRule, { once: true });
  }

  function paint(html, widthClass, s) {
    clearPageRule();
    let host = document.getElementById("print-area");
    if (!host) {
      host = document.createElement("div");
      host.id = "print-area";
      document.body.appendChild(host);
    }
    host.className = "";
    host.innerHTML = '<div class="receipt ' + (widthClass || "") + '">' + html + "</div>";
    if (s && s.showPrintPreview === false) {
      console.log("Browser print preview suppressed per Settings. Enable 'Show browser print preview' in Settings or use Direct USB Serial mode.");
      return;
    }
    setTimeout(function () { global.print(); }, 60);
  }
  function widthClass(s) {
    return s && s.printWidth === "58mm" ? "w58" : "";
  }

  function upiBlock(order, totals, s) {
    if (s.upiQrOnBill === false) return "";
    if (order.payment && String(order.payment.mode || "").toLowerCase() === "cash") return "";

    if (s.qrSource === "image" && s.bankQr) {
      return (
        '<div class="sep"></div><div class="c">' +
        '<div class="b">' + esc(s.bankQrNote || "Scan to pay") + " " + esc(s.currency || "") + amt(totals.total) + "</div>" +
        '<img class="bank-qr" src="' + s.bankQr + '" alt="Scan to pay">' +
        '<div style="font-size:10px">Please enter ' + esc(s.currency || "") + amt(totals.total) + "</div></div>"
      );
    }

    if (s.qrSource === "upi" && s.upiId && global.UPI && global.qrcode) {
      const uri = global.UPI.buildUri({
        upiId: s.upiId,
        payeeName: s.upiName || s.cafeName,
        amount: totals.total,
        note: order.no ? "Bill " + order.no : "",
      });
      if (!uri) return "";
      return (
        '<div class="sep"></div><div class="c">' +
        '<div class="b">Scan to pay ' + esc(s.currency || "") + amt(totals.total) + "</div>" +
        global.UPI.svg(uri, { size: 150 }) +
        '<div style="font-size:10px">' + esc(s.upiId) + "</div></div>"
      );
    }
    return "";
  }

  /* ------------------------------------------------------------------ */
  /* ESC/POS Encoder for Direct Thermal Printing                        */
  /* ------------------------------------------------------------------ */
  function EscPosEncoder() {
    this.buffer = [];
  }
  EscPosEncoder.prototype.init = function () {
    this.buffer.push(0x1B, 0x40); // ESC @ Initialize
    return this;
  };
  EscPosEncoder.prototype.font = function (f) {
    const isB = f === "B" || f === 1;
    this.buffer.push(0x1B, 0x4D, isB ? 1 : 0); // ESC M n
    this.buffer.push(0x1B, 0x21, isB ? 1 : 0); // ESC ! n
    return this;
  };
  EscPosEncoder.prototype.align = function (pos) {
    const v = pos === "center" || pos === "c" ? 1 : pos === "right" || pos === "r" ? 2 : 0;
    this.buffer.push(0x1B, 0x61, v);
    return this;
  };
  EscPosEncoder.prototype.bold = function (enable) {
    this.buffer.push(0x1B, 0x45, enable !== false ? 1 : 0);
    return this;
  };
  EscPosEncoder.prototype.size = function (width, height) {
    const w = Math.min(Math.max(width || 1, 1), 8) - 1;
    const h = Math.min(Math.max(height || 1, 1), 8) - 1;
    this.buffer.push(0x1D, 0x21, (w << 4) | h);
    return this;
  };
  EscPosEncoder.prototype.text = function (str) {
    if (!str) return this;
    const clean = String(str)
      .replace(/₹/g, "Rs.")
      .replace(/·/g, "-")
      .replace(/—/g, "-")
      .replace(/™/g, "TM");
    const encoder = new TextEncoder();
    const bytes = encoder.encode(clean);
    for (let i = 0; i < bytes.length; i++) this.buffer.push(bytes[i]);
    return this;
  };
  EscPosEncoder.prototype.line = function (str) {
    if (str) this.text(str);
    this.buffer.push(0x0A);
    return this;
  };
  EscPosEncoder.prototype.rule = function (char, len) {
    const c = char || "-";
    const width = len || 42;
    this.line(c.repeat(width));
    return this;
  };
  EscPosEncoder.prototype.feed = function (n) {
    this.buffer.push(0x1B, 0x64, n || 3);
    return this;
  };
  EscPosEncoder.prototype.cut = function () {
    this.buffer.push(0x1D, 0x56, 0x42, 0x00);
    return this;
  };
  EscPosEncoder.prototype.encode = function () {
    return new Uint8Array(this.buffer);
  };

  /* ---------------- ESC/POS Formatters ---------------- */
  function encodeBill(order, s) {
    const e = new EscPosEncoder();
    const o = order || {};
    const t = o.totals || {};
    const cur = (s.currency === "₹" || !s.currency) ? "Rs." : s.currency;
    const is58 = !s.printWidth || s.printWidth === "58mm";
    // 30 columns for 58mm thermal paper (provides left/right margin), 46 columns for 80mm paper
    const width = is58 ? 30 : 46;

    e.init().align("center").bold(true).size(2, 2).line(s.cafeName || "Coffeemia");
    e.size(1, 1).bold(false);
    if (s.address) e.line(s.address);
    if (s.phone) e.line("Ph: " + s.phone);
    if (s.gstin) e.line("GSTIN: " + s.gstin);
    e.rule("-", width);

    e.align("left");
    const rightVal = function (label, val) {
      const v = String(val || "");
      const space = width - label.length - v.length;
      return label + " ".repeat(Math.max(1, space)) + v;
    };

    e.line(rightVal("Bill:", o.no ? "#" + o.no : "(unsettled)"));
    e.line(rightVal("Date:", when(o.paidAt || o.createdAt)));
    e.line(rightVal(o.tableName || "Counter", "Token " + (o.token || "-")));
    e.line(rightVal("Mode:", String(o.mode || "").replace("-", " ").toUpperCase()));
    if (o.customer && o.customer.name) e.line(rightVal("Guest:", o.customer.name));
    if (o.customer && o.customer.phone) e.line(rightVal("Mobile:", o.customer.phone));
    e.line(rightVal("Billed by:", o.paidByName || o.createdByName || ""));
    e.rule("-", width);

    if (is58) {
      // 30-column roll layout with left/right margins (Font A)
      // Item (10) + sep (1) + Qty (3) + sep (1) + Rate (6) + sep (1) + Amount (8) = 30
      e.bold(true).line("Item       Qty   Rate    Amount").bold(false);
      e.rule("-", 30);

      (o.lines || []).forEach(function (l) {
        let fullItemName = String(l.name || "");
        let qtyStr = String(l.qty || 0).padStart(3, " ");
        let rateStr = amt(l.price).padStart(6, " ");
        let amtStr = amt(l.price * l.qty).padStart(8, " ");

        if (fullItemName.length <= 10) {
          let namePad = fullItemName.padEnd(10, " ");
          e.line(namePad + " " + qtyStr + " " + rateStr + " " + amtStr);
        } else {
          e.line(fullItemName);
          let indent = " ".repeat(10);
          e.line(indent + " " + qtyStr + " " + rateStr + " " + amtStr);
        }
      });
    } else {
      // 46-column roll layout (80mm) with margins:
      // Item                      Qty     Rate     Amount
      // 22 chars (name) + 1 (sep) + 4 (qty) + 1 (sep) + 8 (rate) + 1 (sep) + 9 (amt) = 46
      e.bold(true).line("Item                    Qty     Rate     Amount").bold(false);
      e.rule("-", 46);

      (o.lines || []).forEach(function (l) {
        let fullItemName = String(l.name || "");
        let qtyStr = String(l.qty || 0).padStart(4, " ");
        let rateStr = amt(l.price).padStart(8, " ");
        let amtStr = amt(l.price * l.qty).padStart(9, " ");

        if (fullItemName.length <= 22) {
          let namePad = fullItemName.padEnd(22, " ");
          e.line(namePad + " " + qtyStr + " " + rateStr + " " + amtStr);
        } else {
          e.line(fullItemName);
          let indent = " ".repeat(22);
          e.line(indent + " " + qtyStr + " " + rateStr + " " + amtStr);
        }
      });
    }

    e.rule("-", width);
    const labelW = width - 9;
    e.line("Subtotal:".padEnd(labelW, " ") + amt(t.subtotal).padStart(9, " "));
    if (t.discount > 0) e.line("Discount:".padEnd(labelW, " ") + ("-" + amt(t.discount)).padStart(9, " "));
    if (t.serviceCharge > 0) e.line("Service Charge:".padEnd(labelW, " ") + amt(t.serviceCharge).padStart(9, " "));
    if (t.tax > 0 && t.taxMode !== "inclusive") e.line((s.taxName || "GST") + ":".padEnd(labelW, " ") + amt(t.tax).padStart(9, " "));

    e.rule("-", width).bold(true);
    e.line(rightVal("TOTAL:", cur + " " + amt(t.total)));
    e.bold(false).rule("-", width);

    const pay = o.payment || {};
    if (pay.mode) {
      e.line(rightVal("Paid by " + pay.mode + ":", amt(pay.received || t.total)));
      if (pay.change > 0) e.line(rightVal("Change:", amt(pay.change)));
      e.rule("-", width);
    }

    e.align("center");
    e.line((t.itemCount || 0) + " item(s)");
    if (s.footerNote) {
      const rawLines = String(s.footerNote).split(/\r?\n/);
      rawLines.forEach(function (ln) {
        let clean = ln.replace(/·/g, "-").replace(/—/g, "-").trim();
        if (!clean) return;
        if (clean.includes(" - Thank")) {
          let parts = clean.split(" - Thank");
          e.line(parts[0].trim());
          e.line("Thank" + parts[1]);
        } else if (clean.includes("- Thank")) {
          let parts = clean.split("- Thank");
          e.line(parts[0].trim());
          e.line("Thank" + parts[1]);
        } else {
          e.line(clean);
        }
      });
    }
    e.feed(3).cut();

    return e.encode();
  }

  function encodeKot(k, s) {
    const e = new EscPosEncoder();
    const is58 = !s.printWidth || s.printWidth === "58mm";
    const width = is58 ? 30 : 46;

    e.init().align("center").bold(true).size(2, 2).line("KOT");
    e.line("TOKEN " + (k.token || "-"));
    e.size(1, 1).bold(false);
    e.line((k.tableName || "Counter") + " - " + String(k.mode || "").replace("-", " ").toUpperCase());
    e.line(when(k.at) + " - " + (k.by || ""));
    e.rule("-", width);

    const groups = {};
    (k.lines || []).forEach(function (l) {
      const station = l.station || "Kitchen";
      (groups[station] = groups[station] || []).push(l);
    });

    Object.keys(groups).forEach(function (station) {
      e.align("center").bold(true).line("[" + station + "]").bold(false).align("left");
      groups[station].forEach(function (l) {
        e.bold(true).line(l.qty + " x " + l.name).bold(false);
        if (l.note) e.line("   * " + l.note);
      });
      e.rule("-", width);
    });

    if (k.note) e.line("Note: " + k.note).rule("-", width);
    e.feed(3).cut();
    return e.encode();
  }

  function encodeDayClose(report, s, date) {
    const e = new EscPosEncoder();
    const is58 = !s.printWidth || s.printWidth === "58mm";
    const width = is58 ? 30 : 46;
    const cur = (s.currency === "₹" || !s.currency) ? "Rs." : s.currency;
    const t = (report && report.totals) || {};

    e.init().align("center").bold(true).size(2, 2).line(s.cafeName || "Coffeemia");
    e.size(1, 1).bold(false);
    if (s.address) e.line(s.address);
    if (s.phone) e.line("Ph: " + s.phone);
    if (s.gstin) e.line("GSTIN: " + s.gstin);
    e.rule("-", width);
    e.bold(true).line("DAY CLOSE - " + (date || "")).bold(false);
    e.rule("-", width);

    e.align("left");
    const rightVal = function (label, val) {
      const v = String(val || "");
      const space = width - label.length - v.length;
      return label + " ".repeat(Math.max(1, space)) + v;
    };

    e.line(rightVal("Bills:", t.orders || 0));
    if (report.firstBill) {
      e.line(rightVal("Bill range:", "#" + report.firstBill + " - #" + report.lastBill));
    }
    e.line(rightVal("Items sold:", t.itemsSold || 0));
    e.line(rightVal("Average bill:", cur + " " + amt(t.average)));
    e.line(rightVal("Discounts:", cur + " " + amt(t.discount)));
    if (t.parcelCharge) e.line(rightVal("Parcel charges:", cur + " " + amt(t.parcelCharge)));
    if (t.tax) {
      e.line(rightVal("Taxable value:", cur + " " + amt(t.taxableValue)));
      e.line(rightVal((s.taxName || "GST") + " collected:", cur + " " + amt(t.tax)));
    }
    e.line(rightVal("Cancelled:", (t.cancelledCount || 0) + " / " + cur + " " + amt(t.cancelledValue)));
    if (t.openCount) {
      e.line(rightVal("Still running:", t.openCount + " / " + cur + " " + amt(t.openValue)));
    }
    e.rule("-", width);

    e.bold(true);
    e.line(rightVal("NET SALES:", cur + " " + amt(t.gross)));
    e.bold(false).rule("-", width);

    const printBlock = function (title, rows, valueKey) {
      if (!rows || !rows.length) return;
      e.bold(true).line(title).bold(false);
      rows.forEach(function (r) {
        let label = String(r.key || "");
        if (r.qty) label += " (" + r.qty + ")";
        let valStr = cur + " " + amt(r[valueKey || "amount"]);
        e.line(rightVal(label, valStr));
      });
      e.rule("-", width);
    };

    printBlock("Payments", report.byPayment);
    printBlock("Order type", report.byMode);
    printBlock("Counter staff", report.byStaff);
    printBlock("Categories", report.byCategory);
    printBlock("Top items", report.topItems);

    if (report.voids && report.voids.length) {
      e.bold(true).line("Voids after KOT").bold(false);
      report.voids.forEach(function (v) {
        e.line(v.table + ": " + v.qty + "x " + v.name + " (" + v.by + ")");
      });
      e.rule("-", width);
    }

    e.align("center");
    e.line("Printed " + when());
    e.feed(3).cut();

    return e.encode();
  }

  function encodeTest(title, s) {
    const e = new EscPosEncoder();
    const is58 = !s.printWidth || s.printWidth === "58mm";
    const width = is58 ? 42 : 64;

    e.init().font("B").align("center").bold(true).size(2, 2).line(s.cafeName || "Coffeemia");
    e.size(1, 1).bold(false).line(title || "Thermal Printer Test");
    e.line("Date: " + when());
    e.line("Connection: " + (s.printMethod || "Direct").toUpperCase());
    if (s.printerIp) e.line("IP: " + s.printerIp + ":" + (s.printerPort || 9100));
    e.rule("-", width).line("If you can read this,").line("your thermal printer is working!").rule("-", width);
    e.feed(3).cut();
    return e.encode();
  }

  /* ---------------- Transport Dispatchers ---------------- */

  // Wi-Fi / Network IP
  function sendNetworkPrint(bytes, s) {
    return fetch("/api/print/network", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bytes: Array.from(bytes),
        ip: s.printerIp,
        port: s.printerPort || 9100,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        return data;
      });
  }

  // Bluetooth
  // Bluetooth Transport & State Management
  let btDevice = null;
  let btGattServer = null;

  function setupBtDevice(device) {
    if (!device) return;
    btDevice = device;
    device.removeEventListener("gattserverdisconnected", onBtDisconnected);
    device.addEventListener("gattserverdisconnected", onBtDisconnected);
  }

  function onBtDisconnected() {
    console.log("Bluetooth printer disconnected, will reconnect on next print.");
    btGattServer = null;
  }

  function getBluetoothDevice() {
    if (btDevice) return Promise.resolve(btDevice);
    if (typeof navigator !== "undefined" && navigator.bluetooth && navigator.bluetooth.getDevices) {
      return navigator.bluetooth.getDevices().then(function (devices) {
        if (devices && devices.length > 0) {
          setupBtDevice(devices[0]);
          return btDevice;
        }
        return null;
      }).catch(function (err) {
        console.warn("getDevices failed:", err);
        return null;
      });
    }
    return Promise.resolve(null);
  }

  // Auto-restore paired Bluetooth device on startup if permitted
  if (typeof window !== "undefined" && typeof navigator !== "undefined" && navigator.bluetooth && navigator.bluetooth.getDevices) {
    getBluetoothDevice().catch(function () { });
  }

  function pairBluetooth() {
    if (!navigator.bluetooth) {
      alert("Web Bluetooth is not supported in this browser. Please use Chrome, Edge or Android.");
      return Promise.reject(new Error("Web Bluetooth unsupported"));
    }
    return navigator.bluetooth
      .requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          "00001101-0000-1000-8000-00805f9b34fb",
          "000018f0-0000-1000-8000-00805f9b34fb",
          "0000ff00-0000-1000-8000-00805f9b34fb",
          "49535343-fe7d-41a3-8c10-d3059f76c185",
          "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
          "0000ae30-0000-1000-8000-00805f9b34fb",
          "0000af30-0000-1000-8000-00805f9b34fb",
        ],
      })
      .then(function (device) {
        setupBtDevice(device);
        alert("Paired with Bluetooth printer: " + (device.name || "Thermal Printer"));
        connectBtGatt(device).catch(function () { });
        return device;
      });
  }

  function connectBtGatt(device) {
    if (btGattServer && btGattServer.connected) {
      return Promise.resolve(btGattServer);
    }
    if (device.gatt && device.gatt.connected) {
      btGattServer = device.gatt;
      return Promise.resolve(btGattServer);
    }
    return device.gatt.connect().then(function (server) {
      btGattServer = server;
      return server;
    });
  }

  function sendBluetoothPrint(bytes) {
    if (!navigator.bluetooth) {
      alert("Bluetooth printing requires Chrome, Edge or Android.");
      return Promise.reject(new Error("Web Bluetooth unsupported"));
    }
    return getBluetoothDevice()
      .then(function (device) {
        if (!device) throw new Error("No Bluetooth printer paired. Please pair in Settings.");
        return connectBtGatt(device);
      })
      .then(function (server) { return server.getPrimaryServices(); })
      .then(function (services) {
        if (!services || !services.length) throw new Error("No Bluetooth GATT services found on this printer");

        // Find first writable characteristic across all services
        let p = Promise.reject();
        services.forEach(function (service) {
          p = p.catch(function () {
            return service.getCharacteristics().then(function (chars) {
              const writable = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
              if (!writable) throw new Error("No writable characteristic in service");
              return writable;
            });
          });
        });
        return p;
      })
      .then(function (char) {
        let p = Promise.resolve();
        const chunkSize = 100;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.slice(i, i + chunkSize);
          p = p.then(function () {
            if (char.properties.writeWithoutResponse) {
              return char.writeValueWithoutResponse(chunk);
            }
            return char.writeValue(chunk);
          });
        }
        return p;
      });
  }

  // USB Serial
  let serialPort = null;
  function getSerialPort() {
    if (serialPort) return Promise.resolve(serialPort);
    if (typeof navigator !== "undefined" && navigator.serial && navigator.serial.getPorts) {
      return navigator.serial.getPorts().then(function (ports) {
        if (ports && ports.length > 0) {
          serialPort = ports[0];
          return serialPort;
        }
        return null;
      });
    }
    return Promise.resolve(null);
  }

  function pairSerial() {
    if (!navigator.serial) {
      alert("Web Serial is not supported in this browser. Please use Chrome or Edge.");
      return Promise.reject(new Error("Web Serial unsupported"));
    }
    return navigator.serial.requestPort().then(function (port) {
      serialPort = port;
      alert("Paired with USB Serial printer!");
      return port;
    });
  }

  function sendSerialPrint(bytes) {
    if (!navigator.serial) {
      alert("Web Serial is not supported in this browser. Please use Chrome or Edge.");
      return Promise.reject(new Error("Web Serial unsupported"));
    }
    return getSerialPort()
      .then(function (port) {
        if (!port) throw new Error("No USB printer paired. Please pair in Settings.");
        if (!port.writable) return port.open({ baudRate: 9600 }).then(function () { return port; });
        return port;
      })
      .then(function (port) {
        const writer = port.writable.getWriter();
        return writer.write(bytes).then(function () { writer.releaseLock(); });
      });
  }

  function getPrintMethod(s) {
    let m = (s && s.printMethod);
    if (!m && typeof localStorage !== "undefined") {
      m = localStorage.getItem("coffeemia_print_method");
    }
    return m || "browser";
  }

  function ensureBluetooth() {
    if (typeof navigator === "undefined" || !navigator.bluetooth) {
      return Promise.reject(new Error("Web Bluetooth unsupported"));
    }
    return getBluetoothDevice().then(function (dev) {
      if (dev) return connectBtGatt(dev);
      return Promise.reject(new Error("Bluetooth printer not paired"));
    });
  }

  /* ---------------- Master Print Function ---------------- */
  function printBill(order, s, opts) {
    const method = getPrintMethod(s);
    if (method === "network") {
      return sendNetworkPrint(encodeBill(order, s), s).catch(function (err) {
        console.warn("Wi-Fi Printer Error:", err);
        billHTML(order, s, Object.assign({}, opts, { isFallback: true }));
      });
    }
    if (method === "bluetooth") {
      return sendBluetoothPrint(encodeBill(order, s)).catch(function (err) {
        console.warn("Bluetooth Printer Error:", err);
        billHTML(order, s, Object.assign({}, opts, { isFallback: true }));
      });
    }
    if (method === "serial") {
      return sendSerialPrint(encodeBill(order, s)).catch(function (err) {
        console.warn("Serial Printer Error:", err);
        billHTML(order, s, Object.assign({}, opts, { isFallback: true }));
      });
    }
    billHTML(order, s, opts);
  }

  function printKot(k, s, opts) {
    const method = getPrintMethod(s);
    if (method === "network") {
      return sendNetworkPrint(encodeKot(k, s), s).catch(function (err) {
        console.warn("Wi-Fi Printer Error:", err);
        kotHTML(k, s, Object.assign({}, opts, { isFallback: true }));
      });
    }
    if (method === "bluetooth") {
      return sendBluetoothPrint(encodeKot(k, s)).catch(function (err) {
        console.warn("Bluetooth Printer Error:", err);
        kotHTML(k, s, Object.assign({}, opts, { isFallback: true }));
      });
    }
    if (method === "serial") {
      return sendSerialPrint(encodeKot(k, s)).catch(function (err) {
        console.warn("Serial Printer Error:", err);
        kotHTML(k, s, Object.assign({}, opts, { isFallback: true }));
      });
    }
    kotHTML(k, s, opts);
  }

  function printDayClose(report, s, date, opts) {
    const method = getPrintMethod(s);
    if (method === "network") {
      return sendNetworkPrint(encodeDayClose(report, s, date), s).catch(function (err) {
        console.warn("Wi-Fi Printer Error:", err);
        dayCloseHTML(report, s, date, Object.assign({}, opts, { isFallback: true }));
      });
    }
    if (method === "bluetooth") {
      return sendBluetoothPrint(encodeDayClose(report, s, date)).catch(function (err) {
        console.warn("Bluetooth Printer Error:", err);
        dayCloseHTML(report, s, date, Object.assign({}, opts, { isFallback: true }));
      });
    }
    if (method === "serial") {
      return sendSerialPrint(encodeDayClose(report, s, date)).catch(function (err) {
        console.warn("Serial Printer Error:", err);
        dayCloseHTML(report, s, date, Object.assign({}, opts, { isFallback: true }));
      });
    }
    dayCloseHTML(report, s, date, opts);
  }

  function testPrint(s) {
    const method = getPrintMethod(s);
    if (method === "network") {
      return sendNetworkPrint(encodeTest("Wi-Fi Network Test", s), s).then(function () {
        alert("Test print sent to Wi-Fi printer " + s.printerIp + ":" + (s.printerPort || 9100));
      }).catch(function (err) {
        alert("Network Printer Error: " + err.message);
      });
    }
    if (method === "bluetooth") {
      return sendBluetoothPrint(encodeTest("Bluetooth Test", s)).then(function () {
        alert("Test print sent to Bluetooth printer!");
      }).catch(function (err) {
        alert("Bluetooth Printer Error: " + err.message + "\n\nTip: Make sure you have paired the device first.");
      });
    }
    if (method === "serial") {
      return sendSerialPrint(encodeTest("USB Serial Test", s)).then(function () {
        alert("Test print sent to Serial printer!");
      }).catch(function (err) {
        alert("Serial Printer Error: " + err.message);
      });
    }
    // Browser test fallback
    billHTML({ no: 1, tableName: "Test Table", lines: [{ name: "Test Item", price: 100, qty: 1 }], totals: { subtotal: 100, total: 100 } }, s, {});
  }

  /* ---------------- Customer bill (Browser HTML) ---------------- */
  function billHTML(order, s, opts) {
    const o = order || {};
    const t = o.totals || {};
    const cur = s.currency || "";
    const rows = (o.lines || [])
      .map(function (l) {
        const note = l.note ? '<div style="font-size:10px">* ' + esc(l.note) + "</div>" : "";
        return (
          "<tr><td class=\"col-item\">" + esc(l.name) + note + "</td>" +
          '<td class="r col-qty">' + l.qty + "</td>" +
          '<td class="r col-rate">' + amt(l.price) + "</td>" +
          '<td class="r col-amt">' + amt(l.price * l.qty) + "</td></tr>"
        );
      })
      .join("");

    let lines = "";
    const add = function (label, value) {
      lines += '<tr><td colspan="2">' + esc(label) + '</td><td class="r" colspan="2">' + value + "</td></tr>";
    };
    add("Subtotal", amt(t.subtotal));
    if (t.discount > 0) {
      add("Discount" + (t.discountType === "percent" ? " (" + t.discountValue + "%)" : ""), "-" + amt(t.discount));
    }
    if (t.parcelCharge > 0) add(t.parcelChargeLabel || "Parcel charge", amt(t.parcelCharge));
    if (t.serviceCharge > 0) add("Service charge (" + t.serviceChargePercent + "%)", amt(t.serviceCharge));
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
      (o.customer && o.customer.phone ? "<tr><td>Mobile</td><td class=\"r\">" + esc(o.customer.phone) + "</td></tr>" : "") +
      "<tr><td>Billed by</td><td class=\"r\">" + esc(o.paidByName || o.createdByName || "") + "</td></tr></table>" +
      '<div class="sep"></div>' +
      '<table class="bill-items"><colgroup><col style="width:40%"><col style="width:15%"><col style="width:20%"><col style="width:25%"></colgroup>' +
      '<tr class="b"><td class="col-item">Item</td><td class="r col-qty">Qty</td><td class="r col-rate">Rate</td><td class="r col-amt">Amt</td></tr>' +
      rows +
      '<tr><td colspan="4"><div class="sep"></div></td></tr>' +
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
      upiBlock(o, t, s) +
      '<div class="sep"></div>' +
      '<div class="c">' + esc(t.itemCount || 0) + " item(s)" +
      (t.tax > 0 && t.taxMode === "inclusive" && s.gstNote
        ? '<div class="b">' + esc(s.gstNote) + "</div>"
        : "") +
      (o.note ? "<div>" + esc(o.note) + "</div>" : "") +
      (s.footerNote
        ? "<div>" + esc(s.footerNote)
            .replace(/·/g, "-").replace(/—/g, "-")
            .replace(/\s*-\s*Thank/gi, "<br>Thank")
            .replace(/\r?\n/g, "<br>") + "</div>"
        : "") +
      (opts && opts.reprint ? '<div class="b">** REPRINT **</div>' : "") +
      "</div>";
    paint(html, widthClass(s), s, !!(opts && opts.isFallback));
  }

  /* ---------------- Kitchen order ticket (Browser HTML) ---------------- */
  function kotHTML(k, s, opts) {
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
    paint(html, widthClass(s), s, !!(opts && opts.isFallback));
  }

  /* ---------------- Day close (Z report) ---------------- */
  function dayCloseHTML(report, s, date, opts) {
    const cur = s.currency || "";
    const t = (report && report.totals) || {};
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
      head(s, "DAY CLOSE - " + esc(date)) +
      '<div class="sep"></div>' +
      "<table>" +
      "<tr><td>Bills</td><td class=\"r b\">" + (t.orders || 0) + "</td></tr>" +
      (report && report.firstBill ? "<tr><td>Bill range</td><td class=\"r\">#" + report.firstBill + " - #" + report.lastBill + "</td></tr>" : "") +
      "<tr><td>Items sold</td><td class=\"r\">" + (t.itemsSold || 0) + "</td></tr>" +
      "<tr><td>Average bill</td><td class=\"r\">" + amt(t.average) + "</td></tr>" +
      "<tr><td>Discounts</td><td class=\"r\">" + amt(t.discount) + "</td></tr>" +
      (t.parcelCharge ? "<tr><td>Parcel charges</td><td class=\"r\">" + amt(t.parcelCharge) + "</td></tr>" : "") +
      (t.tax
        ? "<tr><td>Taxable value</td><td class=\"r\">" + amt(t.taxableValue) + "</td></tr>" +
        "<tr><td>" + esc(s.taxName || "GST") + " collected</td><td class=\"r\">" + amt(t.tax) + "</td></tr>"
        : "") +
      "<tr><td>Cancelled</td><td class=\"r\">" + (t.cancelledCount || 0) + " / " + amt(t.cancelledValue) + "</td></tr>" +
      (t.openCount ? "<tr><td>Still running</td><td class=\"r\">" + t.openCount + " / " + amt(t.openValue) + "</td></tr>" : "") +
      "</table>" +
      '<div class="sep"></div>' +
      '<table><tr class="big"><td>NET SALES</td><td class="r">' + cur + amt(t.gross) + "</td></tr></table>" +
      (t.tax && t.taxMode === "inclusive" ? '<div class="c">(GST included in the figure above)</div>' : "") +
      block("Payments", report && report.byPayment) +
      block("Order type", report && report.byMode) +
      block("Counter staff", report && report.byStaff) +
      block("Categories", report && report.byCategory) +
      block("Top items", report && report.topItems) +
      (report && report.voids && report.voids.length
        ? '<div class="sep"></div><div class="b">Voids after KOT</div>' +
        report.voids.map(function (v) {
          return "<div>" + esc(v.table) + ": " + v.qty + " x " + esc(v.name) + " (" + esc(v.by) + ")</div>";
        }).join("")
        : "") +
      '<div class="sep"></div><div class="c">Printed ' + when() + "</div>";
    paint(html, widthClass(s), s, !!(opts && opts.isFallback));
  }

  /* ---------------- Menu & rate list (A4, admin) ---------------- */
  function rateCard(card, s) {
    const cur = s.currency || "";
    const showLocal = s.showLocalNames !== false;
    let shown = 0;
    let off = 0;

    const blocks = (card.categories || []).map(function (c) {
      const rows = (c.items || []).map(function (i) {
        shown++;
        if (!i.available) off++;
        const local = showLocal && i.localName
          ? '<div class="ta sub">' + esc(i.localName) + "</div>" : "";
        return (
          '<tr' + (i.available ? "" : ' class="off"') + ">" +
          "<td>" + esc(i.name) + (i.available ? "" : ' <span class="sub">(not on sale)</span>') + local + "</td>" +
          '<td class="code">' + esc(i.code || "") + "</td>" +
          '<td class="r">' + cur + amt(i.price) + "</td></tr>"
        );
      }).join("");
      if (!rows) return "";
      return (
        '<section class="cat">' +
        "<h2>" + esc(c.name) +
        (showLocal && c.localName ? ' <span class="ta sub">' + esc(c.localName) + "</span>" : "") +
        '<span class="station">' + esc(c.station || "Kitchen") + "</span></h2>" +
        '<table><thead><tr><th>Item</th><th class="code">Code</th><th class="r">Rate</th></tr></thead>' +
        "<tbody>" + rows + "</tbody></table></section>"
      );
    }).join("");

    let taxLine = "";
    if (s.taxEnabled && s.taxPercent > 0) {
      taxLine = s.taxMode === "inclusive"
        ? "Rates shown are inclusive of " + esc(s.taxName || "GST") + " at " + s.taxPercent + "%."
        : esc(s.taxName || "GST") + " at " + s.taxPercent + "% is charged on top of these rates.";
    }

    const html =
      '<header>' + head(s, null) +
      '<div class="c title">MENU &amp; RATE LIST</div>' +
      '<div class="c sub">As on ' + when() + "</div></header>" +
      "<main>" + (blocks || '<p class="c sub">No items on the menu yet.</p>') + "</main>" +
      '<footer><div>' + shown + " item(s) in " + (card.categories || []).length + " categor" +
      ((card.categories || []).length === 1 ? "y" : "ies") +
      (off ? " · " + off + " not currently on sale" : "") + "</div>" +
      (taxLine ? "<div>" + taxLine + "</div>" : "") +
      "<div>" + esc(s.cafeName || "") + " · printed " + when() +
      (card.by ? " by " + esc(card.by) : "") + "</div></footer>";

    setPageRule("@page { size: A4 portrait; margin: 12mm; }");
    let host = document.getElementById("print-area");
    if (!host) {
      host = document.createElement("div");
      host.id = "print-area";
      document.body.appendChild(host);
    }
    host.className = "";
    host.innerHTML = '<div class="sheet">' + html + "</div>";
    setTimeout(function () { global.print(); }, 60);
  }

  global.Print = {
    bill: printBill,
    kot: printKot,
    dayClose: printDayClose,
    rateCard: rateCard,
    pairBluetooth: pairBluetooth,
    pairSerial: pairSerial,
    getBluetoothDevice: getBluetoothDevice,
    ensureBluetooth: ensureBluetooth,
    testPrint: testPrint,
  };
})(window);
