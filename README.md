# Coffeemia POS

Point of sale for **Coffeemia**, Veeramanikkam Nagar, Palayamkottai: table-wise
orders, kitchen tickets, printed bills, an editable menu with editable rates,
GST billing, a sales dashboard, and separate admin / counter-staff logins.

It runs on one machine at the counter with **no installation and no database** —
just Node.js. Phones and tablets on the same Wi-Fi open the same app in a
browser, so two counters can work at once and the owner can watch the dashboard
from their phone.

---

## Running it

```bash
npm start
```

Then open **http://localhost:3100**. There is nothing to install first — the
app uses only what Node ships with.

To use it from a tablet or phone on the same Wi-Fi, find the counter machine's
local address (`ipconfig` on Windows, `ifconfig`/`ip addr` on Mac and Linux) and
open `http://<that-address>:3100` — for example `http://192.168.1.7:3100`.

| Setting | How to change it |
| --- | --- |
| Port | `PORT=8080 npm start` |
| Where data is stored | `POS_DATA_DIR=/path/to/folder npm start` |
| Timezone for the business day | `TZ=Asia/Kolkata` (already the default) |

Everything lives in one file: `data/pos.json`. **Copy that file to keep a
backup** — it holds the menu, rates, tables, staff and every bill.

## Logins created on first run

| Username | Password | PIN | Access |
| --- | --- | --- | --- |
| `admin` | `admin123` | 1111 | Owner — everything |
| `user1` | `user123` | 2222 | Counter staff |
| `user2` | `user123` | 3333 | Counter staff |

**Change all three from Settings → Staff & access before you start billing.**
If you are hosting the app online, set the passwords through environment
variables instead so the very first deploy is never on a published default —
see [Putting it on the internet](#putting-it-on-the-internet).

Staff can sign in with a username and password, or tap their 4-digit PIN on the
counter tablet, which is faster at shift change.

### What each role can do

| | Admin | Counter staff (user-1, user-2) |
| --- | --- | --- |
| Take orders, kitchen tickets, print and settle bills | ✅ | ✅ |
| Move / merge tables, discounts, one-off items | ✅ | ✅ |
| Today's sales figures | ✅ | ✅ (own counter highlighted) |
| Older reports, date ranges, CSV export, day close | ✅ | ❌ |
| Menu, rates, categories | ✅ | ❌ |
| Table layout, staff logins, shop settings | ✅ | ❌ |
| Cancel a bill that is already settled | ✅ | ❌ |

## Day-to-day use

**Tables** — the home screen. Green means free, amber means a bill is running,
with its live total and how long the guests have been seated. A red "KOT
pending" corner means something on that bill has not gone to the kitchen yet.
Tap a table to open its bill; tap **Takeaway** or **Parcel** for counter sales.

**Taking an order** — tap items to add them. Use the category chips or the
search box (typing an item's short code and pressing Enter adds it straight
away). Use ✎ on a line for a kitchen note like "less sugar".

- **Send KOT** prints a kitchen ticket with only what is *new* since the last
  one, split by Kitchen and Beverages, with the token number in large type.
- **Print bill** prints the guest's bill without closing it.
- **Settle** takes the payment (Cash / UPI / Card), works out the change, prints
  the bill and frees the table.
- **Hold & back** parks the bill on the table and returns to the floor.
- **⋯** moves the bill to another table, merges two tables onto one bill, adds
  guest details, or discards the bill.

Orders save themselves as you go, so a tablet that sleeps or a browser that is
closed will not lose a running table.

**Bills** — every bill for the day (all history for the admin), with reprint,
and cancel-with-reason for the admin.

**Dashboard** — net sales, bills, average bill, what is still running on the
floor, sales by hour, payment split, top sellers, category split and staff-wise
totals. Admins can pick any date range, export to CSV for Excel, and print the
**day close** summary at the end of the night.

## Changing the menu and the rates

**Menu & rates** (admin) lists every category and item.

- Type a new number in the **Rate** box for any items you want to change, then
  press **Save rate changes**. Old rates are kept in the item's history, and
  bills already printed keep the rate they were billed at.
- **＋ New item** adds a dish — English name, Tamil name, category, rate and an
  optional short code for fast keyboard entry.
- The **On sale** switch takes something off the counter for the day (sold out)
  without deleting it.
- **＋ New category** adds a section, and each category is set to print on either
  the Kitchen or the Beverages ticket.

Deleting an item that has appeared on a bill hides it from the counter rather
than erasing it, so old bills stay correct.

## Printing

The app prints through the browser, so any printer the machine can already use
will work — thermal roll printers included.

1. Set the roll size in **Settings → Bill & printing** (80 mm or 58 mm).
2. The first time you print, in the browser's print dialog choose the thermal
   printer, set **Margins: None** and turn **Headers and footers off**.
3. Tick "remember" / set it as default so later prints go straight through.
   In Chrome, launching with `--kiosk-printing` skips the dialog entirely.

Tamil names print as long as the machine has a Tamil font (Windows and Android
both ship one). If Tamil looks wrong on a particular printer, turn off *Show
Tamil names* in Settings and the bills print in English only.

## GST

GST is **off by default** — until the shop is registered, a bill should not
show a tax breakup for tax nobody is collecting. Bills print exactly as you
would expect: items, subtotal, total, and no mention of GST anywhere.

Everything is configured and waiting, so when your registration comes through
it is **one checkbox**: Settings → GST & charges → *This shop charges GST*.
Nothing else needs changing.

Once switched on, it bills at **5% with the menu rates treated as already
including it** — the way most cafes here price. Nothing is added at the bottom
of the bill: a tea marked ₹15 stays ₹15, and the bill discloses the GST that
is already inside that amount.

```
TOTAL                     ₹45.00
--------------------------------
GST breakup (included in the total)
Taxable value              42.86
CGST 2.5%                   1.07
SGST 2.5%                   1.07
--------------------------------
All prices shown above are inclusive of GST.
```

The breakup always adds back up to the total the guest pays, to the paisa.

With GST switched on, **Settings → GST & charges** also lets you:

- switch between *rates already include GST* and *add GST on top of the rate*,
- change the percentage (5% is the usual restaurant rate) and the name,
- turn the CGST / SGST split off and print a single GST line instead,
- edit the note printed on every bill — it reads *"All prices shown above are
  inclusive of GST."* out of the box,
- switch it back off at any time.

The GSTIN is **optional and starts empty** — bills print perfectly well
without it, so you can run the counter today and drop the number in whenever
your registration comes through. Put it in **Settings → Shop details** and it
prints in the bill header from the next bill onward; nothing else needs
changing and past bills are untouched.

The field checks what you type: it upper-cases it, refuses anything that is not
a real GSTIN shape (15 characters, `33AAAAA0000A1Z5`), confirms the state it is
registered in, and verifies the final check digit. A check-digit mismatch is
flagged as a warning rather than blocked — your certificate is the last word,
but it almost always means a typo, so compare the two before carrying on.

The dashboard and the day-close report both show the taxable value alongside
the GST collected, so the figures are ready for a return.

## Settings worth knowing

- **Round off** rounds the final total to the nearest rupee and prints the
  adjustment on the bill.
- **Payment modes** is a plain comma-separated list — add "Swiggy" or "Zomato"
  if you need them for reporting.
- **Footer line** is the thank-you line at the bottom of every bill.

## Putting it on the internet

Read this first: **the counter machine is the better home for a POS.** If the
app is hosted online and the shop's internet drops, billing stops dead — at the
till, at the busiest hour. Run it on the counter machine (`npm start`) and
every device in the shop keeps working off the local Wi-Fi even when the line
is down.

Hosting it online is still worth it if you want to see the dashboard from home,
or run more than one branch. A good arrangement is the counter machine for
billing and a hosted copy for reporting, rather than betting the till on the
connection.

Printing works either way: the bill is printed by the browser on the counter
machine, so the printer never needs to reach the internet.

### Railway

1. Create a **new service** in Railway from this repository. The included
   `railway.json` sets the start command, so there is nothing to configure for
   the build.
2. **Add a Volume** (Settings → Volumes) mounted at `/data`.
3. Add these **Variables**:

   | Variable | Value | Why |
   | --- | --- | --- |
   | `POS_DATA_DIR` | `/data` | must match the volume mount path |
   | `SECURE_COOKIE` | `1` | served over HTTPS |
   | `TZ` | `Asia/Kolkata` | so the business day ends at midnight here |
   | `POS_ADMIN_PASSWORD` | *your own* | never deploy on the demo password |
   | `POS_USER1_PASSWORD` | *your own* | |
   | `POS_USER2_PASSWORD` | *your own* | |
   | `POS_ADMIN_PIN` | *4–6 digits* | optional, for the quick PIN pad |

4. **Settings → Networking → Generate Domain** for the public URL.
5. Deploy, open the URL and sign in.

**Do steps 2 and 3 before you take a single real bill.** A container filesystem
is wiped on every redeploy, so without the volume your menu, rates, staff and
the day's takings all vanish the next time the service restarts. And a POS on a
public address with the published demo password is an open till — the server
prints a loud warning at startup for as long as any account still has one.

The seed logins are only created when the database is empty, so once the volume
is in place your own passwords and staff stick.

### Any other host

Anything that runs Node 18+ works — Render, Fly, a VPS, a mini PC in the shop.

- `PORT` is read from the environment; nothing else is needed to boot.
- Point `POS_DATA_DIR` at storage that survives a restart.
- Set `SECURE_COOKIE=1` behind HTTPS.
- Sessions are held in memory, so a restart signs everyone out. They just sign
  in again; nothing is lost.

### Backups

Whatever the host, the whole shop is one file — `pos.json` in your data
directory. Copy it somewhere safe on a schedule. Restoring is putting the file
back and restarting.

## Notes

- Money is always recalculated on the server, so a stale browser tab can never
  bill an old rate.
- Anything removed from a bill after it went to the kitchen is written to a void
  log and printed on the day-close report.
- Bill numbers run continuously; token numbers restart each day.
- Sessions last one long shift (16 hours) and end when the server restarts.
