/* SidsBnb payout module UI. Usage:
 *   <link rel="stylesheet" href="payout/payout.css"><script src="payout/core.js"></script><script src="payout/payout-ui.js"></script>
 *   SidPayoutUI.mount(document.getElementById("payout"), { snapshotUrl: "payout/data/payout-snapshot.json" });  // relative paths, or a live JSON endpoint
 * Vanilla JS, no dependencies, all classes prefixed "sbp-" so it can drop into another app (e.g. a React page via useEffect). */
(function (root) {
  "use strict";
  const ORDER = ["35662324", "23542067", "985426", "1141445"]; // Garage, Diku, Nayan, then Sid Suite (small)
  const PAGE = 10, LIST_DAYS = 90, STALE_DAYS = 7;
  function mount(el, opts = {}) {
    const C = opts.core || root.SidPayoutCore; if (!C) throw new Error("SidPayoutCore (core.js) must load first");
    const IDS = ORDER.filter((id) => C.LISTINGS[id]).concat(Object.keys(C.LISTINGS).filter((id) => !ORDER.includes(id)));
    const WINDOW_NIGHTS = Object.assign({ "35662324": 30, "23542067": 30, "985426": 30, "1141445": 92 }, opts.windowNights || {});
    const snapshotUrl = opts.snapshotUrl || "payout/data/payout-snapshot.json", fallbackUrl = opts.fallbackUrl || "payout/data/payout-snapshot.json"; // relative: works under a subpath
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const parts = (d, o) => Object.fromEntries(new Intl.DateTimeFormat("en-US", o).formatToParts(d).map((p) => [p.type, p.value]));
    // "Thu Jan 1, 2027" (year dropped when short && same year as today)
    const day = (iso, short) => { const p = parts(new Date(iso + "T12:00:00Z"), { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
      return `${p.weekday} ${p.month} ${p.day}` + (short && p.year === todayCT().slice(0, 4) ? "" : `, ${p.year}`); };
    const stamp = (iso) => { const p = parts(new Date(iso), { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      return `${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} CT`; };
    const dollars = (c) => (c % 100 === 0 ? C.fmt(c).replace(/\.00$/, "") : C.fmt(c));
    const floors = Object.fromEntries(IDS.map((id) => [id, C.LISTINGS[id].floor30])); Object.assign(floors, opts.floors || {});
    let snap = opts.snapshot || null, shown = PAGE, depShown = 6, listing = opts.listing || new URLSearchParams(location.search).get("listing") || IDS[0];
    if (!C.LISTINGS[listing]) listing = IDS[0];
    el.classList.add("sbp");
    el.innerHTML = `<div class="sbp-seg" role="tablist" data-r="tabs"></div>
      <div class="sbp-dates">${["ci", "co"].map((k) => `<label class="sbp-date"><span class="sbp-lbl">${k === "ci" ? "Check-in" : "Check-out"}</span>
        <span class="sbp-dval" data-r="${k}-txt"></span><input type="date" data-r="${k}" aria-label="${k === "ci" ? "Check-in" : "Check-out"}"></label>`).join("")}</div>
      <section class="sbp-card sbp-result" data-r="result" aria-live="polite"></section>
      <section class="sbp-card sbp-list"><div class="sbp-lhead"><h2>Next open check-ins</h2><span class="sbp-sub" data-r="lsub"></span></div><div data-r="windows"></div></section>
      <section class="sbp-card sbp-list" data-r="depcard" hidden><div class="sbp-lhead"><h2>Recent deposits</h2><span class="sbp-sub" data-r="dsub"></span></div><div data-r="deposits"></div></section>`;
    const $ = (r) => el.querySelector(`[data-r="${r}"]`);
    const L = () => (snap && snap.listings[listing]) || null;

    async function load() {
      if (!snap) {
        let r = await fetch(snapshotUrl, { cache: "no-store" }).catch(() => null);
        if (!r || !r.ok) r = await fetch(fallbackUrl, { cache: "no-store" });
        snap = await r.json();
      }
      renderTabs(); pickDefaultDates(); renderAll();
    }
    function renderTabs() {
      $("tabs").innerHTML = IDS.map((id) => `<button type="button" role="tab" aria-selected="${id === listing}" data-id="${id}" class="${id === listing ? "sbp-on" : ""}${C.LISTINGS[id].floor30 == null ? " sbp-minor" : ""}">${esc(C.LISTINGS[id].short)}</button>`).join("");
      $("tabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { listing = b.dataset.id; shown = PAGE; if (opts.syncUrl !== false) history.replaceState(null, "", "?listing=" + listing); renderTabs(); pickDefaultDates(true); renderAll(); }));
    }
    function setDates(ci, co) { $("ci").value = ci; $("co").value = co; $("ci-txt").textContent = day(ci); $("co-txt").textContent = day(co); }
    function pickDefaultDates(ignoreUrl) {
      const l = L(), n = WINDOW_NIGHTS[listing], t = C.addDays(todayCT(), 1); let start = t;
      if (l) { const w = C.openWindows(C.calFromSnapshotListing(l), t, C.addDays(t, 820), n)[0]; if (w) start = w.checkIn; }
      let ci = start, co = C.addDays(start, n);
      const q = new URLSearchParams(location.search), qi = opts.checkIn || q.get("checkin"), qo = opts.checkOut || q.get("checkout"), iso = /^\d{4}-\d{2}-\d{2}$/;
      if (!ignoreUrl && iso.test(qi || "") && iso.test(qo || "") && C.nightsBetween(qi, qo) > 0) { ci = qi; co = qo; }
      setDates(ci, co);
    }
    function compute(id, ci, co) {
      const l = snap.listings[id]; const exact = (l.quotes || []).find((q) => q.s === ci && q.e === co && (q.a || 1) === 1);
      const cal = C.calFromSnapshotListing(l), rates = l.rates && Number.isFinite(l.rates.mgmtBp) ? l.rates : null;
      const r = exact ? C.expandQuote(exact) : C.estimate({ cal, checkIn: ci, checkOut: co, rates: rates || {} });
      return { r, cal, rates: exact ? { ...C.learnRates(r) } : rates };
    }
    const ctDay = (iso) => stamp(iso).replace(/,.*$/, ""); // "Oct 3"
    const ageDays = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    function dataLine() {
      const l = L(); if (!l) return "";
      const at = l.capturedAt || snap.capturedAt, calAt = l.calendarAt || at;
      const stale = ageDays(at) > STALE_DAYS || ageDays(calAt) > STALE_DAYS;
      const calPart = calAt.slice(0, 10) === at.slice(0, 10) ? "" : ` · open dates as of ${esc(ctDay(calAt))}`;
      return `<p class="sbp-age${stale ? " sbp-stale" : ""}" data-r="age">${stale ? '<i class="sbp-dot" aria-hidden="true"></i>' : ""}Prices as of ${esc(ctDay(at))}${stale ? `<b>${calPart}</b>` : calPart}</p>`;
    }
    function renderResult() {
      const ci = $("ci").value, co = $("co").value, n = C.nightsBetween(ci, co), name = C.LISTINGS[listing].name;
      if (!L()) { $("result").innerHTML = `<p class="sbp-empty">No Airbnb data yet for ${esc(name)}.</p>`; return; }
      if (n <= 0) { $("result").innerHTML = `<p class="sbp-empty">Pick a check-out after check-in.</p>`; return; }
      const { r, cal, rates } = compute(listing, ci, co);
      if (!r.ok) { $("result").innerHTML = `<p class="sbp-empty">${esc(r.error)}</p>`; return; }
      const floorC = C.floorCents(floors[listing], n), v = C.verdict(r.deposit, floorC);
      const low = C.lowestPassingNightly({ cal, checkIn: ci, checkOut: co, rates: rates || {}, floorC, metric: "deposit" });
      const exact = r.source === "airbnb";
      const verdict = floorC === null ? `<div class="sbp-verdict"><span class="sbp-pill sbp-nof">No floor</span></div>`
        : `<div class="sbp-verdict" data-r="verdict"><span class="sbp-pill sbp-${v.verdict === "PASS" ? "pass" : "fail"}">${v.verdict}</span>
           <span>${C.fmt(Math.abs(v.gap))} ${v.gap >= 0 ? "over" : "under"} your ${dollars(floorC)} floor</span></div>`;
      const line = (label, cents, cls = "") => `<div class="sbp-li ${cls}"><span>${label}</span><span>${C.fmt(cents)}</span></div>`;
      const by = (k) => r.lines.filter((x) => x.kind === k);
      const ref = [line(`Nightly · ${C.fmt(Math.round(r.nightly / n))} avg × ${n}`, r.nightly),
        ...by("promo").map((x) => line("Promotion", x.cents)), ...by("discount").map((x) => line("Monthly discount", x.cents)), ...by("other").map((x) => line("Other fees", x.cents)),
        ...by("mgmt").map((x) => line("Management fee <small>(in guest total)</small>", x.cents)),
        line("Guest total", r.guestTotal, "sbp-strong"),
        line("Airbnb fee", -Math.abs(r.hostFee)), line(`Airbnb “You earn” <small>${exact ? "Airbnb quote " + esc(ctDay(r.capturedAt || L().capturedAt)) : "computed"}</small>`, r.youEarn),
        line("Tax on Airbnb fee <small>computed</small>", -r.feeTax), line("Deposited <small>computed</small>", r.deposit, "sbp-strong sbp-top")];
      $("result").innerHTML = `<div class="sbp-rhead"><span>${n} nights</span><span class="sbp-tag${exact ? "" : " sbp-tag-est"}" data-r="src">${exact ? "Airbnb quote · " + esc(ctDay(r.capturedAt || L().capturedAt)) : "Computed · " + esc(ctDay(L().capturedAt || snap.capturedAt)) + " prices"}</span></div>
        <div class="sbp-earn-l">Deposited to your bank</div><div class="sbp-earn" data-r="deposit">${C.fmt(r.deposit)}</div>
        ${verdict}
        ${low ? `<p class="sbp-low" data-r="low">Deposit reaches your floor at <b>$${low.nightly}/night</b></p>` : ""}
        ${r.problems && r.problems.length ? `<p class="sbp-note">${r.problems.map(esc).join("<br>")}</p>` : ""}
        ${dataLine()}
        <details class="sbp-bd"><summary>Not your money · for reference</summary><div class="sbp-ref">${ref.join("")}</div></details>`;
    }
    function renderWindows() {
      const l = L(), n = WINDOW_NIGHTS[listing]; $("lsub").textContent = `${n} nights`;
      $("windows").closest("section").hidden = !l; if (!l) return;
      const cal = C.calFromSnapshotListing(l), first = [C.addDays(todayCT(), 1), l.horizon?.first || ""].sort().at(-1);
      const all = C.openWindows(cal, first, C.addDays(l.horizon?.last || first, -n), n);
      const horizon = C.addDays(first, LIST_DAYS), soon = all.filter((w) => w.checkIn < horizon);
      const list = all.slice(0, shown);
      const quotes = new Map((l.quotes || []).map((q) => [q.s + q.e, q])), floor = (x) => C.floorCents(floors[listing], x);
      const cur = $("ci").value + $("co").value;
      let computed = 0;
      const rows = list.map((w) => {
        const q = quotes.get(w.checkIn + w.checkOut); if (!q) computed++;
        const r = q ? C.expandQuote(q) : C.estimate({ cal, checkIn: w.checkIn, checkOut: w.checkOut, rates: l.rates || {} });
        const v = C.verdict(r.deposit, floor(n)).verdict;
        return `<button type="button" class="sbp-wrow${w.checkIn + w.checkOut === cur ? " sbp-sel" : ""}" data-ci="${w.checkIn}" data-co="${w.checkOut}">
          <span class="sbp-wd">${esc(day(w.checkIn, true))}</span><span class="sbp-wy">${q ? "" : "≈ "}${C.fmt(r.deposit)}</span>
          ${v === "NO FLOOR" ? "" : `<span class="sbp-pill sbp-${v === "PASS" ? "pass" : "fail"}">${v === "PASS" ? "Pass" : "Fail"}</span>`}</button>`;
      });
      if (computed) $("lsub").textContent = `${n} nights · ≈ computed`;
      const head = soon.length ? "" : `<p class="sbp-empty">Nothing open in the next ${LIST_DAYS} days${all.length ? "; next ones below" : ""}.</p>`;
      $("windows").innerHTML = head + rows.join("") + (all.length > list.length ? `<button type="button" class="sbp-more" data-r="more">Show more</button>` : "");
      $("windows").querySelectorAll(".sbp-wrow").forEach((b) => (b.onclick = () => { setDates(b.dataset.ci, b.dataset.co); renderResult(); renderWindows(); el.scrollIntoView({ behavior: "smooth", block: "start" }); }));
      const more = $("more"); if (more) more.onclick = () => { shown = list.length + PAGE; renderWindows(); };
    }
    function renderDeposits() {
      const D = snap && snap.deposits, items = D && Array.isArray(D.items) ? D.items.filter((x) => C.LISTINGS[x.listing] && C.LISTINGS[x.listing].floor30 != null) : [];
      $("depcard").hidden = !items.length; if (!items.length) return;
      items.sort((a, b) => (b.paidOn + b.listing).localeCompare(a.paidOn + a.listing));
      $("dsub").textContent = "as of " + stamp(D.capturedAt).replace(/,.*$/, "");
      const span = (x) => x.start && x.end ? `${day(x.start, true)} – ${day(x.end, true)}` : "";
      const list = items.slice(0, depShown);
      $("deposits").innerHTML = list.map((x) => `<div class="sbp-drow"><div><div class="sbp-wd">${esc(day(x.paidOn, true))} · ${esc(C.LISTINGS[x.listing].short)}</div>
          <div class="sbp-dsub">${x.kind === "stay" ? esc(span(x)) : esc(x.kind[0].toUpperCase() + x.kind.slice(1)) + (span(x) ? " · " + esc(span(x)) : "")}</div></div>
          <span class="sbp-wy${x.amount < 0 ? " sbp-neg" : ""}">${C.fmt(x.amount)}</span></div>`).join("")
        + (items.length > list.length ? `<button type="button" class="sbp-more" data-r="dmore">Show more</button>` : "");
      const m = $("dmore"); if (m) m.onclick = () => { depShown += 10; renderDeposits(); };
    }
    function renderAll() { renderResult(); renderWindows(); renderDeposits(); }
    for (const k of ["ci", "co"]) {
      const i = $(k);
      i.closest("label").addEventListener("click", (e) => { if (e.target !== i && i.showPicker) { e.preventDefault(); try { i.showPicker(); } catch (_) { i.focus(); } } });
      i.onchange = () => {
        if (!i.value) return;
        let ci = $("ci").value, co = $("co").value;
        if (k === "ci" && C.nightsBetween(ci, co) <= 0) co = C.addDays(ci, WINDOW_NIGHTS[listing]);
        setDates(ci, co); renderAll();
      };
    }
    const ready = load();
    return { ready, setListing(id) { listing = id; shown = PAGE; renderTabs(); pickDefaultDates(true); renderAll(); }, reload() { snap = null; return load(); } };
  }
  root.SidPayoutUI = { mount };
})(typeof self !== "undefined" ? self : this);
