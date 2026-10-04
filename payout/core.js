/* SidsBnb payout core: pure logic shared by the Chrome extension, the website and the tests.
 * Integer cents everywhere. No network, no storage, no DOM.
 * Formula derived from 1,786 Airbnb GuestTotalPriceCalculatorQuery quotes captured 2026-09-24:
 *   accommodation = sum(nightly price)            promo = round(sum(price * pct) over promoted nights)
 *   mgmt = round(mgmtRate * (accommodation - promo))
 *   guestTotal = accommodation - promo + mgmt     hostFee = round(hostFeeRate * guestTotal)
 *   youEarn = guestTotal - hostFee                (the calendar's "You earn"; NOT what reaches the bank)
 * Cash deposited, verified against Sid's Airbnb transaction CSV (15.5%-fee payouts Aug-Oct 2026):
 *   feeTax  = round(5.28% * hostFee)               (sales tax on the host service fee, half-up, cents)
 *   deposit = guestTotal - hostFee - feeTax = youEarn - feeTax   (~ guestTotal * 0.836816)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SidPayoutCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LISTINGS = {
    "35662324": { name: "Garage Apartment (Ranju)", short: "Garage", floor30: 2500, csvTitles: ["East Austin monthly stay, garage, pets welcome"] },
    "23542067": { name: "Diku Suite", short: "Diku", floor30: 1500, csvTitles: ["Private Room · Desk · East Austin · Monthly"] },
    "985426": { name: "Nayan Suite", short: "Nayan", floor30: 1500, csvTitles: ["Pro Work Retreat · Desk · East Austin · Monthly"] },
    "1141445": { name: "Sid Suite", short: "Sid Suite", floor30: null }, // report-only: payout, no floor
  };
  const DEFAULT_HOST_FEE_BP = 1550; // 15.5% host-only service fee observed 2026-09-24
  const FEE_TAX_BP = 528;           // sales tax on the host service fee = 5.28% of the fee (CSV-verified Oct 2026)
  const OPS = { quote: "GuestTotalPriceCalculatorQuery", calendar: "getDLSHostCalendar" };

  // ---------- money / dates ----------
  function parseMoney(text) {
    if (typeof text === "number") return Math.round(text * 100);
    if (typeof text !== "string") return null;
    const t = text.replace(/[\u2212\u2013]/g, "-").replace(/\s/g, "");
    const m = t.match(/^(-)?(?:US)?\$?(-)?([0-9][0-9,]*)(?:\.([0-9]{1,2}))?$/);
    if (!m) return null;
    const cents = parseInt(m[3].replace(/,/g, ""), 10) * 100 + (m[4] ? parseInt(m[4].padEnd(2, "0"), 10) : 0);
    return m[1] || m[2] ? -cents : cents;
  }
  function fmt(cents) {
    if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
    const neg = cents < 0, a = Math.abs(cents);
    const s = "$" + Math.floor(a / 100).toLocaleString("en-US") + "." + String(a % 100).padStart(2, "0");
    return neg ? "−" + s : s;
  }
  const roundDiv = (a, b) => Math.floor((2 * a + b) / (2 * b)); // half-up for a >= 0
  function addDays(iso, n) {
    const d = new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000);
    return d.toISOString().slice(0, 10);
  }
  function isISODate(v) {
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
  }
  function nightsBetween(a, b) {
    if (!isISODate(a) || !isISODate(b)) return 0;
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  }
  function floorCents(floor30Dollars, nights) {
    if (floor30Dollars === null || floor30Dollars === undefined || floor30Dollars === "" || !(nights > 0)) return null;
    return roundDiv(Math.round(Number(floor30Dollars) * 100) * nights, 30);
  }

  // ---------- Airbnb response parsing ----------
  function classify(item) {
    const type = String(item.type || "").toUpperCase(), label = String(item.label || "").toLowerCase();
    if (type === "DAILY_PRICE" || /\bx\s*\d+\s*nights?\b/.test(label)) return "nightly";
    if (type === "AIRBNB_HOST_FEE" || label.includes("host service fee")) return "hostFee";
    if (type === "ONLINE_PASS_THROUGH_ADMIN" || label.includes("management fee")) return "mgmt";
    if (/PROMOTION|DISCOUNT|SPECIAL_OFFER/.test(type) || /discount|special offer|promotion/.test(label)) return "promo";
    if (/CLEANING/.test(type) || label.includes("cleaning")) return "cleaning";
    return "other";
  }
  /** Accepts the raw GraphQL JSON, the priceItemGroups array, or the normalized evidence groups. */
  function parseQuote(input) {
    let groups = input;
    if (input && !Array.isArray(input)) {
      groups = input?.data?.presentation?.hostPricingCalculator?.configuration?.mainModalContent?.priceBreakdown?.priceItemGroups || input.groups;
    }
    if (!Array.isArray(groups) || !groups.length) return { ok: false, error: "No price breakdown in Airbnb response" };
    const norm = groups.map((g) => g.totalItem
      ? { total: { label: g.totalItem.titleText, value: g.totalItem.formattedAmountText },
          items: (g.priceItems || []).map((i) => ({ label: i.titleText, value: i.formattedAmountText, type: i.type })) }
      : g);
    const earn = norm.find((g) => /you earn/i.test(g.total?.label || ""));
    const guest = norm.find((g) => /guest total/i.test(g.total?.label || ""));
    if (!earn) return { ok: false, error: "Airbnb response has no 'You earn' group", groups: norm };
    const lines = earn.items.map((i) => ({ label: i.label, type: i.type || "", cents: parseMoney(i.value), kind: classify(i) }));
    if (lines.some((l) => l.cents === null)) return { ok: false, error: "Unparseable amount in Airbnb response", groups: norm };
    const youEarn = parseMoney(earn.total.value);
    const sum = (k) => lines.filter((l) => l.kind === k).reduce((a, l) => a + l.cents, 0);
    const hostFee = sum("hostFee");
    const guestTotal = guest ? parseMoney(guest.total.value) : youEarn - hostFee;
    const r = {
      ok: true, source: "airbnb", lines, youEarn, guestTotal,
      nightly: sum("nightly"), promo: sum("promo"), mgmt: sum("mgmt"), hostFee, cleaning: sum("cleaning"), other: sum("other"),
      nightlyLabel: (lines.find((l) => l.kind === "nightly") || {}).label || "",
      reconciles: lines.reduce((a, l) => a + l.cents, 0) === youEarn,
    };
    return r;
  }
  /** Rates implied by a live quote (basis points); used to keep the estimate formula data-driven. */
  function learnRates(q) {
    if (!q || !q.ok) return null;
    const base = q.nightly + q.promo + (q.discount || 0); // promo and length-of-stay discount are negative
    const out = {};
    if (base > 0) out.mgmtBp = Math.round((q.mgmt / base) * 10000);
    if (q.guestTotal > 0 && q.hostFee) out.hostFeeBp = Math.round((-q.hostFee / q.guestTotal) * 10000);
    return out;
  }

  /** Strip a getDLSHostCalendar calendarGridViewSection down to prices/availability. Drops all reservation/guest data. */
  function normalizeCalendar(section) {
    const s = section?.data?.presentation?.hostCalendar?.sections?.calendarGridViewSection || section;
    const days = (s?.days || []).map((x) => ({
      date: x.day || x.date,
      available: !!x.available,
      price: x.priceData ? x.priceData.nativePrice : x.price,
      currency: x.priceData ? x.priceData.currency : x.currency,
      promotionType: (x.priceData ? x.priceData.promotionType : x.promotionType) || null,
    })).filter((d) => isISODate(d.date));
    const promotions = [];
    const settings = s?.customSettings || s?.settings;
    for (const p of settings?.promotions || []) {
      const pct = parseFloat(String(p.discountDisplay || "").replace(/[^0-9.]/g, ""));
      if (p.dateRange && pct > 0) promotions.push({ start: p.dateRange.startDate, end: p.dateRange.endDate, pctBp: Math.round(pct * 100) });
    }
    return { days, promotions };
  }
  function mergeCalendars(list) {
    const map = new Map(); const promos = []; const seen = new Set();
    for (const c of list) {
      for (const d of c.days) map.set(d.date, d);
      for (const p of c.promotions) { const k = p.start + p.end + p.pctBp; if (!seen.has(k)) { seen.add(k); promos.push(p); } }
    }
    return { days: map, promotions: promos };
  }
  function promoBpFor(date, promotions) {
    let bp = 0;
    for (const p of promotions) if (date >= p.start && date <= p.end) bp = Math.max(bp, p.pctBp);
    return bp;
  }

  // ---------- cash deposited ----------
  /** Sales tax on Airbnb's host fee (positive cents in, positive cents out). */
  const feeTaxFor = (hostFeeAbs, feeTaxBp = FEE_TAX_BP) => roundDiv(Math.abs(hostFeeAbs) * feeTaxBp, 10000);
  /** Cash Airbnb deposits for an Airbnb quote / estimate ({guestTotal, hostFee<=0, youEarn}). */
  function deposit(q, { feeTaxBp = FEE_TAX_BP } = {}) {
    const hostFee = Math.abs(q.hostFee), feeTax = feeTaxFor(hostFee, feeTaxBp);
    const youEarn = Number.isInteger(q.youEarn) ? q.youEarn : q.guestTotal - hostFee;
    return { guestTotal: q.guestTotal, hostFee, feeTax, youEarn, deposit: youEarn - feeTax };
  }
  /** Same rule from the guest total alone (= CSV "Gross earnings" for a single-payout reservation). */
  function depositFromGross(grossC, { hostFeeBp = DEFAULT_HOST_FEE_BP, feeTaxBp = FEE_TAX_BP } = {}) {
    const hostFee = roundDiv(grossC * hostFeeBp, 10000), feeTax = feeTaxFor(hostFee, feeTaxBp);
    return { guestTotal: grossC, hostFee, feeTax, youEarn: grossC - hostFee, deposit: grossC - hostFee - feeTax };
  }

  // ---------- formula estimate ----------
  /** cal: {days: Map(date->{available,price,promotionType}), promotions: [...]}. rates: {mgmtBp, hostFeeBp}. */
  function estimate({ cal, checkIn, checkOut, rates, priceOverride }) {
    const nights = nightsBetween(checkIn, checkOut);
    const problems = [];
    if (nights <= 0) return { ok: false, error: "Check-out must be after check-in" };
    if (!rates || rates.mgmtBp === undefined || rates.mgmtBp === null) problems.push("Management-fee rate unknown for this listing; estimate excludes it");
    const mgmtBp = rates && Number.isFinite(rates.mgmtBp) ? rates.mgmtBp : 0;
    const hostFeeBp = rates && Number.isFinite(rates.hostFeeBp) ? rates.hostFeeBp : DEFAULT_HOST_FEE_BP;
    let acc = 0, promoRaw = 0, missing = 0, unavailable = 0, promoNights = 0;
    for (let i = 0; i < nights; i++) {
      const date = addDays(checkIn, i);
      const d = cal && cal.days.get(date);
      let priceC;
      if (priceOverride !== undefined) priceC = Math.round(priceOverride * 100);
      else if (!d || d.price === undefined || d.price === null) { missing++; continue; }
      else priceC = Math.round(Number(d.price) * 100);
      if (d && !d.available) unavailable++;
      acc += priceC;
      const bp = d && d.promotionType ? promoBpFor(date, cal.promotions) : 0;
      if (bp) { promoRaw += priceC * bp; promoNights++; }
    }
    if (missing) return { ok: false, error: `No calendar price for ${missing} of ${nights} nights` };
    if (unavailable) problems.push(`${unavailable} of ${nights} nights are booked or blocked on the host calendar`);
    const promo = roundDiv(promoRaw, 10000);
    // Length-of-stay discount (Airbnb: weekly 7+ nights, monthly 28+ nights), applied before the management fee
    // (verified Oct 3, 2026: Diku $60 x 30, 20% monthly -> You earn $1,521.00; Nayan $63 -> $1,533.17).
    const disc = (cal && cal.discounts) || {}, losKind = nights >= 28 && disc.monthlyBp ? "monthly" : nights >= 7 && disc.weeklyBp ? "weekly" : null;
    const losBp = losKind === "monthly" ? disc.monthlyBp : losKind === "weekly" ? disc.weeklyBp : 0;
    if (losBp && promo) problems.push("A promotion and a length-of-stay discount both apply; how Airbnb combines them is not verified");
    const los = roundDiv(losBp * (acc - promo), 10000);
    const base = acc - promo - los;
    const mgmt = roundDiv(mgmtBp * base, 10000);
    const guestTotal = base + mgmt;
    const hostFee = roundDiv(hostFeeBp * guestTotal, 10000);
    const youEarn = guestTotal - hostFee;
    const lines = [
      { label: `$${(acc / 100 / nights).toFixed(2)} avg x ${nights} nights`, kind: "nightly", cents: acc },
      ...(promo ? [{ label: `Promotion (${promoNights} nights)`, kind: "promo", cents: -promo }] : []),
      ...(los ? [{ label: `${losKind === "monthly" ? "Monthly" : "Weekly"} discount`, kind: "discount", cents: -los }] : []),
      { label: `Management fee (${(mgmtBp / 100).toFixed(2)}%)`, kind: "mgmt", cents: mgmt },
      { label: `Host service fee (${(hostFeeBp / 100).toFixed(2)}%)`, kind: "hostFee", cents: -hostFee },
    ];
    const feeTax = feeTaxFor(hostFee, rates && Number.isFinite(rates.feeTaxBp) ? rates.feeTaxBp : FEE_TAX_BP);
    return { ok: true, source: "estimate", nights, lines, nightly: acc, promo: -promo || 0, discount: -los || 0, mgmt, guestTotal, hostFee: -hostFee, youEarn, feeTax, deposit: youEarn - feeTax,
      problems, rates: { mgmtBp, hostFeeBp }, unavailable, promoNights };
  }

  /** Lowest whole-dollar uniform nightly price whose payout clears floorC (current promotions still applied).
   *  metric: "deposit" (cash to the bank, default) or "youEarn" (calendar figure). */
  function lowestPassingNightly({ cal, checkIn, checkOut, rates, floorC, metric = "deposit" }) {
    if (floorC === null || floorC === undefined) return null;
    const pay = (n) => {
      const c = cal || { days: new Map(), promotions: [] };
      const days = new Map();
      for (let i = 0; i < nightsBetween(checkIn, checkOut); i++) {
        const date = addDays(checkIn, i); const d = c.days.get(date) || {};
        days.set(date, { available: true, price: n, promotionType: d.promotionType || null });
      }
      const e = estimate({ cal: { days, promotions: c.promotions || [], discounts: c.discounts }, checkIn, checkOut, rates });
      return e.ok ? e[metric] : null;
    };
    let lo = 1, hi = 20000;
    if (pay(hi) === null || pay(hi) < floorC) return null;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pay(mid) >= floorC) hi = mid; else lo = mid + 1; }
    return { nightly: lo, payout: pay(lo) };
  }

  function verdict(youEarn, floorC) {
    if (floorC === null || floorC === undefined) return { verdict: "NO FLOOR", gap: null };
    return { verdict: youEarn >= floorC ? "PASS" : "FAIL", gap: youEarn - floorC };
  }

  /** Check-ins whose `nights` occupied nights are all available on the host calendar. */
  function openWindows(cal, first, last, nights = 30) {
    const out = [];
    for (let d = first; d <= last; d = addDays(d, 1)) {
      let ok = true;
      for (let i = 0; i < nights; i++) { const x = cal.days.get(addDays(d, i)); if (!x || !x.available) { ok = false; break; } }
      if (ok) out.push({ checkIn: d, checkOut: addDays(d, nights) });
    }
    return out;
  }
  /** Collapse consecutive check-ins with the same verdict into ranges. */
  function collapse(rows) {
    const out = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.verdict === r.verdict && addDays(last.lastCheckIn, 1) === r.checkIn) {
        last.lastCheckIn = r.checkIn; last.count++; last.min = Math.min(last.min, r.youEarn); last.max = Math.max(last.max, r.youEarn);
      } else out.push({ verdict: r.verdict, firstCheckIn: r.checkIn, lastCheckIn: r.checkIn, count: 1, min: r.youEarn, max: r.youEarn });
    }
    return out;
  }

  // ---------- persisted-query URL building ----------
  const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64"));
  function opUrl({ origin, op, hash, template, variables, currency = "USD", locale = "en" }) {
    let u;
    if (template) { u = new URL(template, origin); }
    else {
      u = new URL(`/api/v3/${op}/${hash}`, origin);
      u.searchParams.set("operationName", op);
      u.searchParams.set("locale", locale);
    }
    u.pathname = `/api/v3/${op}/${hash}`;
    u.searchParams.set("operationName", op);
    u.searchParams.set("currency", currency);
    u.searchParams.set("variables", JSON.stringify(variables));
    u.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }));
    return u.href;
  }
  function quoteVariables(templateVars, listingId, checkIn, checkOut, adults = 1) {
    const v = templateVars && templateVars.params ? JSON.parse(JSON.stringify(templateVars)) : { params: { placement: "EDIT_PANEL" } };
    Object.assign(v.params, {
      listingId: b64("StayListing:" + listingId), startDate: checkIn, endDate: checkOut,
      guestCounts: { numberOfAdults: adults, numberOfChildren: 0, numberOfInfants: 0, numberOfPets: 0 },
    });
    delete v.params.overridePriceNative; // never preview a different price: quote what is live
    return v;
  }
  function calendarVariables(templateVars, listingId, start, end, timeZone = "America/Chicago") {
    const v = templateVars && templateVars.listingId ? JSON.parse(JSON.stringify(templateVars)) : {
      hostCalendarViewType: "MONTH_VIEW", lensTypes: ["NOTE", "PRICE", "PROMOTION"], timeZone,
      localizationContext: { timeZone, firstDayOfWeek: 0 }, hostCalendarSectionTypes: ["METADATA", "NAVIGATION", "MAIN_VIEW"], includeCustomSettings: true,
    };
    Object.assign(v, { listingId: b64("StayListing:" + listingId), startDate: start, endDate: end, includeCustomSettings: true });
    return v;
  }
  /** Parse an observed Airbnb API URL into {op, hash, variables}. */
  function parseOpUrl(url) {
    const m = String(url).match(/\/api\/v3\/([A-Za-z0-9_]+)\/([0-9a-f]{64})(?:[?#]|$)/);
    if (!m) return null;
    let variables = null;
    try { variables = JSON.parse(new URL(url, "https://www.airbnb.com").searchParams.get("variables") || "null"); } catch (e) { variables = null; }
    return { op: m[1], hash: m[2], variables };
  }

  // ---------- rate limiter (max concurrent + min spacing between starts) ----------
  function createLimiter({ maxConcurrent = 2, spacingMs = 250 } = {}) {
    let active = 0, lastStart = 0; const queue = [];
    const pump = () => {
      if (!queue.length || active >= maxConcurrent) return;
      const wait = Math.max(0, lastStart + spacingMs - Date.now());
      if (wait > 0) { setTimeout(pump, wait); return; }
      const job = queue.shift(); active++; lastStart = Date.now();
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
      pump();
    };
    return { run(fn) { return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); }); },
      clear() { queue.splice(0).forEach((j) => j.reject(new Error("cancelled"))); }, stats: () => ({ active, queued: queue.length }) };
  }

  // ---------- snapshot format (prices / availability / payouts only) ----------
  function compactQuote(q, checkIn, checkOut, adults, capturedAt) {
    return { s: checkIn, e: checkOut, a: adults, t: capturedAt, n: q.nightly, p: q.promo, m: q.mgmt, g: q.guestTotal, f: q.hostFee, c: q.cleaning + q.other, y: q.youEarn, l: q.nightlyLabel };
  }
  function expandQuote(c) {
    const lines = [{ label: c.l || "Nightly total", kind: "nightly", cents: c.n }];
    if (c.p) lines.push({ label: "Promotion / special offer", kind: "promo", cents: c.p });
    if (c.d) lines.push({ label: "Monthly discount", kind: "discount", cents: c.d });
    if (c.c) lines.push({ label: "Other fees", kind: "other", cents: c.c });
    lines.push({ label: "Management fee", kind: "mgmt", cents: c.m });
    lines.push({ label: "Host service fee", kind: "hostFee", cents: c.f });
    const feeTax = feeTaxFor(c.f);
    return { ok: true, source: "airbnb", capturedAt: c.t, lines, nightly: c.n, promo: c.p, mgmt: c.m, guestTotal: c.g, hostFee: c.f, youEarn: c.y, feeTax, deposit: c.y - feeTax, nightlyLabel: c.l, discount: c.d || 0 };
  }
  // ---------- Airbnb transaction-history CSV -> completed deposits (no guest data) ----------
  function parseCsv(text) {
    const rows = []; let row = [], f = "", q = false;
    text = String(text).replace(/^\uFEFF/, "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { row.push(f); f = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += ch;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    const head = rows.shift() || [];
    return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
  }
  const usDate = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ""); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
  const centsOrNull = (s) => (s === "" || s === undefined ? null : parseMoney(String(s)));
  const KIND = { Reservation: "stay", "Resolution Adjustment": "adjustment", Adjustment: "adjustment", Cleaning: "cleaning", "Resolution Payout": "resolution", "Misc Credit": "credit", "Cancellation Fee": "cancellation fee", "Cancellation Fee Refund": "cancellation refund" };
  /** Completed payouts for Sid's listings from Airbnb's transaction CSV. Only allowlisted money/date fields survive:
   *  guest names, confirmation/reference codes, booking dates and bank details are never copied. */
  function depositsFromCsv(text, { since = null } = {}) {
    const byTitle = new Map(); for (const [id, L] of Object.entries(LISTINGS)) for (const t of L.csvTitles || []) byTitle.set(t.trim(), id);
    const out = []; let payout = null;
    for (const r of parseCsv(text)) {
      if (r.Type === "Payout") { payout = { paidOn: usDate(r.Date), arrivesBy: usDate(r["Arriving by date"]) }; continue; }
      if (!payout) continue; // not yet paid out
      const listing = byTitle.get((r.Listing || "").trim()); if (!listing) continue;
      const amount = centsOrNull(r.Amount); if (amount === null || !payout.paidOn || (since && payout.paidOn < since)) continue;
      out.push({ paidOn: payout.paidOn, arrivesBy: payout.arrivesBy, listing, kind: KIND[r.Type] || "other", start: usDate(r["Start date"]), end: usDate(r["End date"]),
        nights: r.Nights ? Number(r.Nights) : null, amount, gross: centsOrNull(r["Gross earnings"]), hostFee: centsOrNull(r["Service fee"]),
        feeTax: centsOrNull(r["Sales tax on service fee"]), mgmt: centsOrNull(r["Management fee"]) });
    }
    return out;
  }
  const DEPOSIT_FIELDS = ["paidOn", "arrivesBy", "listing", "kind", "start", "end", "nights", "amount", "gross", "hostFee", "feeTax", "mgmt"];

  function calFromSnapshotListing(L) {
    return { days: new Map((L.days || []).map((d) => [d.date, d])), promotions: L.promotions || [], discounts: L.discounts || null };
  }
  function validateSnapshot(s) {
    const errs = [];
    if (!s || s.schemaVersion !== 1) errs.push("schemaVersion must be 1");
    if (!s || !isISODate(String(s.capturedAt || "").slice(0, 10))) errs.push("capturedAt missing");
    for (const k of Object.keys(s || {})) if (!["schemaVersion", "capturedAt", "source", "listings", "deposits"].includes(k)) errs.push(`top-level field '${k}' not allowed`);
    if (s && s.deposits !== undefined) {
      const D = s.deposits;
      if (!D || typeof D !== "object" || !Array.isArray(D.items)) errs.push("deposits must be {capturedAt, source, items: []}");
      else {
        for (const k of Object.keys(D)) if (!["capturedAt", "source", "items"].includes(k)) errs.push(`deposits field '${k}' not allowed`);
        if (!isISODate(String(D.capturedAt || "").slice(0, 10))) errs.push("deposits.capturedAt missing");
        for (const it of D.items) {
          const extra = Object.keys(it).filter((k) => !DEPOSIT_FIELDS.includes(k)); if (extra.length) { errs.push(`deposit field '${extra[0]}' not allowed`); break; }
          if (!LISTINGS[it.listing] || !isISODate(it.paidOn) || !Number.isInteger(it.amount)) { errs.push("bad deposit item"); break; }
        }
      }
    }
    const allowedListing = new Set(["days", "promotions", "quotes", "rates", "horizon", "capturedAt", "source", "calendarAt", "discounts"]);
    const allowedDay = new Set(["date", "available", "price", "currency", "promotionType"]);
    for (const [id, L] of Object.entries((s && s.listings) || {})) {
      if (!LISTINGS[id]) errs.push("unknown listing " + id);
      for (const k of Object.keys(L)) if (!allowedListing.has(k)) errs.push(`listing ${id}: field '${k}' not allowed`);
      for (const d of L.days || []) for (const k of Object.keys(d)) if (!allowedDay.has(k)) { errs.push(`listing ${id}: day field '${k}' not allowed`); break; }
      const allowedQuote = new Set(["s", "e", "a", "t", "n", "p", "d", "m", "g", "f", "c", "y", "l"]);
      if (L.discounts && Object.keys(L.discounts).some((k) => !["weeklyBp", "monthlyBp"].includes(k))) errs.push(`listing ${id}: bad discounts`);
      for (const q of L.quotes || []) {
        if (!isISODate(q.s) || !isISODate(q.e) || !Number.isInteger(q.y)) { errs.push(`listing ${id}: bad quote`); break; }
        const extra = Object.keys(q).filter((k) => !allowedQuote.has(k)); if (extra.length) { errs.push(`listing ${id}: quote field '${extra[0]}' not allowed`); break; }
      }
      for (const p of L.promotions || []) if (Object.keys(p).some((k) => !["start", "end", "pctBp"].includes(k))) { errs.push(`listing ${id}: bad promotion`); break; }
      if (L.days && !Array.isArray(L.days)) errs.push(`listing ${id}: days must be an array`);
    }
    return errs;
  }

  return { LISTINGS, DEFAULT_HOST_FEE_BP, FEE_TAX_BP, OPS, deposit, depositFromGross, feeTaxFor, parseCsv, depositsFromCsv, DEPOSIT_FIELDS, parseMoney, fmt, addDays, isISODate, nightsBetween, floorCents, parseQuote, learnRates,
    normalizeCalendar, mergeCalendars, estimate, lowestPassingNightly, verdict, openWindows, collapse, opUrl, quoteVariables,
    calendarVariables, parseOpUrl, createLimiter, compactQuote, expandQuote, calFromSnapshotListing, validateSnapshot, roundDiv };
});
