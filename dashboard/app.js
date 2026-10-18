// เปิดนอก claude.ai: บันทึกไฟล์ผ่านลิงก์ดาวน์โหลดของเบราว์เซอร์
const localDownloads = {
  async save({ filename, data }) {
    const url = URL.createObjectURL(new Blob([data], { type: "text/html;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

const { useState, useMemo, useRef, useEffect, useCallback } = React;
const html = htm.bind(React.createElement);

/* ===== ส่วนคำนวณ: คัดลอกจากไฟล์เดิมทุกบรรทัด ไม่แก้ ===== */
const OK_STATUS = "จัดส่งสำเร็จ";
const ALL = "__all__";
const REQUIRED = ["order_datetime", "region", "category", "channel", "qty", "unit_price", "discount_pct", "status"];
const TH_MONTH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

const fmtBaht = new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB", maximumFractionDigits: 0 });
const fmtBaht2 = new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = new Intl.NumberFormat("th-TH");
const fmtPct = new Intl.NumberFormat("th-TH", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

const clean = (v) => String(v ?? "").replace(/^\uFEFF/, "").trim();
function num(v) {
  const s = clean(v).replace(/[,\s฿%]/g, "");
  if (s === "") return NaN;
  return Number(s);
}
function monthKey(v) {
  const s = clean(v);
  let m, y, mo;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})/))) { y = +m[1]; mo = +m[2]; }
  else if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/))) { y = +m[3]; mo = +m[2]; }
  else return null;
  if (y > 2400) y -= 543; // ปี พ.ศ. → ค.ศ.
  if (mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}`;
}
function monthLabel(key, long) {
  const [y, m] = key.split("-").map(Number);
  return long ? `${TH_MONTH[m - 1]} ${y + 543}` : `${TH_MONTH[m - 1]} ${String((y + 543) % 100).padStart(2, "0")}`;
}
function niceMax(v) {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}
const isCancel = (s) => s.includes("ยกเลิก");

function prepare(res) {
  const fields = (res.meta.fields || []).map(clean);
  const missing = REQUIRED.filter((c) => !fields.includes(c));
  if (missing.length) {
    throw new Error(`ไฟล์ไม่มีคอลัมน์ ${missing.join(", ")} — คอลัมน์ที่พบ: ${fields.join(", ") || "ไม่พบหัวคอลัมน์"}`);
  }
  const hasId = fields.includes("order_id");
  const rows = res.data.map((r, i) => {
    const qty = num(r.qty), price = num(r.unit_price);
    let disc = num(r.discount_pct);
    if (!isFinite(disc)) disc = 0;
    const valid = isFinite(qty) && isFinite(price);
    const id = hasId && clean(r.order_id) ? clean(r.order_id) : `row-${i}`;
    return {
      id,
      month: monthKey(r.order_datetime), // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM"
      ...dayInfo(r.order_datetime), // date "YYYY-MM-DD" + mega (วันเมกะเซลหรือไม่)
      productId: clean(r.product_id),
      qty: valid ? qty : 0,
      region: clean(r.region) || "(ไม่ระบุ)",
      category: clean(r.category) || "(ไม่ระบุ)",
      channel: clean(r.channel) || "(ไม่ระบุ)",
      carrier: clean(r.carrier) || "(ไม่ระบุ)",
      province: clean(r.province) || "(ไม่ระบุ)",
      status: clean(r.status) || "(ไม่ระบุ)",
      valid,
      net: valid ? qty * price * (1 - disc / 100) : 0,
    };
  });
  if (!rows.length) throw new Error("ไฟล์มีแค่หัวคอลัมน์ ยังไม่มีแถวข้อมูล");
  const uniq = (k) => [...new Set(rows.map((r) => r[k]))].sort((a, b) => a.localeCompare(b, "th"));
  return { rows, hasId, parseErrors: res.errors.length, regions: uniq("region"), categories: uniq("category"), channels: uniq("channel") };
}

function summarize(rows) {
  let net = 0, badNumbers = 0, badDates = 0;
  const okOrders = new Set(), allOrders = new Set(), cancelOrders = new Set(), returnOrders = new Set();
  const statusCount = new Map(), byMonth = new Map(), byChannel = new Map(), byCarrier = new Map(), byProvince = new Map(), byCarrierCat = new Map(), byRegion = new Map();
  for (const r of rows) {
    statusCount.set(r.status, (statusCount.get(r.status) || 0) + 1);
    allOrders.add(r.id);
    if (isCancel(r.status)) cancelOrders.add(r.id);
    if (r.status === "คืนสินค้า") returnOrders.add(r.id);
    if (r.status !== OK_STATUS) continue;
    okOrders.add(r.id);
    if (!r.valid) { badNumbers++; continue; }
    net += r.net;
    byChannel.set(r.channel, (byChannel.get(r.channel) || 0) + r.net);
    byCarrier.set(r.carrier, (byCarrier.get(r.carrier) || 0) + r.net);
    const cc = byCarrierCat.get(r.carrier) || new Map();
    cc.set(r.category, (cc.get(r.category) || 0) + r.net);
    byCarrierCat.set(r.carrier, cc);
    const pv = byProvince.get(r.province) || { value: 0, region: r.region };
    pv.value += r.net;
    byProvince.set(r.province, pv);
    byRegion.set(r.region, (byRegion.get(r.region) || 0) + r.net);
    if (r.month) byMonth.set(r.month, (byMonth.get(r.month) || 0) + r.net);
    else badDates++;
  }
  return {
    net,
    okCount: okOrders.size,
    allCount: allOrders.size,
    cancelCount: cancelOrders.size,
    aov: okOrders.size ? net / okOrders.size : null,
    cancelRate: allOrders.size ? cancelOrders.size / allOrders.size : null,
    returnCount: returnOrders.size,
    returnRate: allOrders.size ? returnOrders.size / allOrders.size : null,
    statuses: [...statusCount.entries()].sort((a, b) => b[1] - a[1]),
    monthly: [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([key, value]) => ({ key, value })), // เรียงปี-เดือนตามเวลา
    channels: [...byChannel.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value })),
    carriers: [...byCarrier.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value })),
    carrierStack: [...byCarrier.entries()].sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ key, value, segs: [...byCarrierCat.get(key).entries()].map(([cat, v]) => ({ cat, value: v })) })),
    provinces: [...byProvince.entries()].sort((a, b) => b[1].value - a[1].value).map(([key, p]) => ({ key, value: p.value, region: p.region })),
    regionSales: [...byRegion.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value })),
    badNumbers, badDates,
  };
}
// ===== วันเมกะเซล (3.3, 6.6, 9.9, 10.10, 11.11, 12.12) =====
const MEGA_MONTHS = new Set([3, 6, 9, 10, 11, 12]);
function dayInfo(v) {
  const s = clean(v);
  let m, y, mo, d;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/))) { y = +m[3]; mo = +m[2]; d = +m[1]; }
  else return { date: null, mega: false };
  if (y > 2400) y -= 543;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { date: null, mega: false };
  const p2 = (n) => String(n).padStart(2, "0");
  return { date: `${y}-${p2(mo)}-${p2(d)}`, mega: mo === d && MEGA_MONTHS.has(mo) };
}
// กำไรขั้นต้น = ยอดขายสุทธิ − qty × unit_cost (join products.csv ด้วย product_id); % = กำไรขั้นต้น ÷ ยอดขายสุทธิของแถวที่มีต้นทุน
function megaSummarize(rows, costs) {
  const g = () => ({ net: 0, days: new Set(), gpNet: 0, cost: 0, unmatched: 0 });
  const mega = g(), normal = g(), events = new Map();
  let noDate = 0;
  for (const r of rows) {
    if (r.status !== OK_STATUS || !r.valid) continue;
    if (!r.date) { noDate++; continue; }
    const t = r.mega ? mega : normal;
    t.net += r.net;
    t.days.add(r.date);
    let c = null;
    if (costs) {
      if (costs.has(r.productId)) { c = r.qty * costs.get(r.productId); t.gpNet += r.net; t.cost += c; }
      else t.unmatched++;
    }
    if (r.mega) {
      const e = events.get(r.date) || { date: r.date, net: 0, gpNet: 0, cost: 0 };
      e.net += r.net;
      if (c != null) { e.gpNet += r.net; e.cost += c; }
      events.set(r.date, e);
    }
  }
  const gp = (o) => (costs && o.gpNet > 0 ? (o.gpNet - o.cost) / o.gpNet : null);
  const fin = (t) => ({ net: t.net, days: t.days.size, perDay: t.days.size ? t.net / t.days.size : null, gp: gp(t), unmatched: t.unmatched });
  return {
    mega: fin(mega), normal: fin(normal), total: mega.net + normal.net, hasCost: !!costs, noDate,
    events: [...events.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((e) => ({ ...e, gp: gp(e) })),
  };
}
function megaLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `${m}.${d} (${y + 543})`;
}
/* ===== จบส่วนคำนวณ ===== */

// ไอคอน SVG (Lucide) แทน emoji
const ICONS = {
  banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  check: '<path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m7.5 4.27 9 5.15"/><path d="M3.29 7 12 12l8.71-5"/><path d="M12 22V12"/><path d="m16 16 2 2 4-4"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  x: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
};
const Icon = ({ name, className = "ico" }) =>
  html`<svg className=${className} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[name] }} />`;

const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ตัวเลขวิ่งขึ้น จบที่ค่าจริงเป๊ะเสมอ (เฟรมสุดท้าย set เป็น target ตรง ๆ)
function useCountUp(target, ms = 900) {
  const [v, setV] = useState(target);
  const from = useRef(0);
  useEffect(() => {
    if (target == null || !isFinite(target) || reduceMotion()) { setV(target); from.current = target; return; }
    const start = from.current ?? 0, t0 = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.max(0, Math.min(1, (t - t0) / ms)), e = 1 - Math.pow(1 - p, 3);
      if (p < 1) { setV(start + (target - start) * e); raf = requestAnimationFrame(tick); }
      else { setV(target); from.current = target; }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((e) => setW(Math.floor(e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Tip({ x, y, width, children }) {
  const left = Math.max(70, Math.min(width - 70, x));
  return html`<div className="tip" style=${{ left: left + "px", top: y + "px" }}>${children}</div>`;
}

function Sparkline({ data }) {
  if (data.length < 2) return null;
  const W = 300, H = 70, max = Math.max(...data.map((d) => d.value)) || 1;
  const pts = data.map((d, i) => [(i / (data.length - 1)) * W, H - 6 - (d.value / max) * (H - 12)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return html`<div className="spark"><svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
    <path d=${line} fill="none" stroke="var(--c4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    <circle cx=${last[0]} cy=${last[1]} r="4.5" fill="var(--c1)" />
  </svg></div>`;
}

function Donut({ statuses, total }) {
  const R = 52, C = 2 * Math.PI * R;
  let acc = 0;
  const tone = (st) => (st === OK_STATUS ? "var(--ok)" : isCancel(st) || st === "คืนสินค้า" ? "var(--bad)" : "var(--c4)");
  const okShare = (statuses.find(([st]) => st === OK_STATUS) || [0, 0])[1] / (total || 1);
  return html`<svg className="donut" viewBox="0 0 132 132" role="img" aria-label="สัดส่วนสถานะคำสั่งซื้อ">
    <circle cx="66" cy="66" r=${R} fill="none" stroke="var(--line)" strokeWidth="14" />
    ${statuses.map(([st, c]) => {
      const len = (c / (total || 1)) * C, off = acc; acc += len;
      return html`<circle key=${st} cx="66" cy="66" r=${R} fill="none" stroke=${tone(st)} strokeWidth="14"
        strokeDasharray=${`${Math.max(0, len - 2)} ${C}`} strokeDashoffset=${-off} transform="rotate(-90 66 66)" strokeLinecap="butt" />`;
    })}
    <text x="66" y="64" textAnchor="middle" className="num" fill="var(--ink)" fontSize="22" fontWeight="700">${fmtPct.format(okShare)}</text>
    <text x="66" y="84" textAnchor="middle" fill="var(--muted)" fontSize="12">ส่งสำเร็จ</text>
  </svg>`;
}

function LineChart({ data }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const pl = 16 + Math.max(...ticks.map((t) => fmtBaht.format(t).length)) * 7.2;
  const W = Math.max(w, 300), H = 290, pr = 18, pt = 22, pb = 34;
  const iw = W - pl - pr, ih = H - pt - pb;
  const n = data.length;
  const xAt = (i) => pl + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const yAt = (v) => pt + ih - (v / max) * ih;
  const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 58))));
  const path = data.map((d, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(d.value).toFixed(1)}`).join(" ");
  const area = n > 1 ? `${path} L${xAt(n - 1)},${pt + ih} L${xAt(0)},${pt + ih} Z` : "";
  const band = n === 1 ? iw : iw / (n - 1);
  const best = data.reduce((b, d, i) => (d.value > data[b].value ? i : b), 0);

  return html`<div className="chart" ref=${ref} onMouseLeave=${() => setHover(null)}>
    ${w > 0 && html`<svg viewBox=${`0 0 ${W} ${H}`} width="100%" role="img" aria-label="กราฟเส้นยอดขายสุทธิรายเดือน">
      <g className="grid">${ticks.map((t) => html`<line key=${t} x1=${pl} x2=${W - pr} y1=${yAt(t)} y2=${yAt(t)} strokeDasharray="2 6" />`)}</g>
      <g className="axis">
        ${ticks.map((t) => html`<text key=${t} x=${pl - 8} y=${yAt(t) + 4} textAnchor="end">${fmtBaht.format(t)}</text>`)}
        ${data.map((d, i) => i % step === 0 && html`<text key=${d.key} x=${xAt(i)} y=${H - 10} textAnchor="middle">${monthLabel(d.key)}</text>`)}
      </g>
      <path d=${path} fill="none" stroke="var(--c4)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      ${hover != null && html`<line x1=${xAt(hover)} x2=${xAt(hover)} y1=${pt} y2=${pt + ih} stroke="var(--muted)" strokeDasharray="3 4" />`}
      ${data.map((d, i) => {
        const isLast = i === n - 1;
        return html`<circle key=${d.key} cx=${xAt(i)} cy=${yAt(d.value)} r=${hover === i ? 6.5 : isLast ? 5.5 : i === best ? 4.5 : 3}
          fill=${isLast ? "var(--c1)" : i === best ? "var(--muted)" : "var(--surface)"} stroke=${isLast ? "var(--c1)" : i === best ? "var(--muted)" : "var(--c4)"} strokeWidth="2" />`;
      })}
      ${n > 1 && best !== n - 1 && html`<text x=${xAt(best)} y=${yAt(data[best].value) - 12} textAnchor="middle" fill="var(--muted)" fontSize="13" fontWeight="600">${`สูงสุด ${fmtBaht.format(data[best].value)}`}</text>`}
      <text x=${xAt(n - 1)} y=${yAt(data[n - 1].value) - 12} textAnchor=${n > 1 ? "end" : "middle"} fill="var(--c1)" fontSize="14" fontWeight="700">${`${n > 1 && best === n - 1 ? "สูงสุด " : ""}${monthLabel(data[n - 1].key)} ${fmtBaht.format(data[n - 1].value)}`}</text>
      ${data.map((d, i) => html`<rect key=${"h" + d.key} className="hit" x=${xAt(i) - band / 2} y=${pt} width=${band} height=${ih} fill="transparent"
          tabIndex="0" aria-label=${`${monthLabel(d.key, true)} ${fmtBaht.format(d.value)}`}
          onMouseEnter=${() => setHover(i)} onClick=${() => setHover(i)} onFocus=${() => setHover(i)} onBlur=${() => setHover(null)} />`)}
    </svg>`}
    ${hover != null && w > 0 && html`<${Tip} x=${(xAt(hover) / W) * w} y=${(yAt(data[hover].value) / H) * (w * H / W) - 12} width=${w}>
      ${monthLabel(data[hover].key, true)}<b>${fmtBaht.format(data[hover].value)}</b>
    </${Tip}>`}
  </div>`;
}

function BarChart({ data, label }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const W = Math.max(w, 260), rowH = 46, pt = 6;
  const labelW = Math.min(120, W * 0.32);
  const valW = 10 + Math.max(...data.map((d) => fmtBaht.format(d.value).length)) * 7.4;
  const H = pt + data.length * rowH + 4;
  const iw = W - labelW - valW - 8;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const trunc = (s) => (s.length > 14 ? s.slice(0, 13) + "…" : s);

  return html`<div className="chart" ref=${ref} onMouseLeave=${() => setHover(null)}>
    ${w > 0 && html`<svg viewBox=${`0 0 ${W} ${H}`} width="100%" role="img" aria-label=${label}>
      ${data.map((d, i) => {
        const y = pt + i * rowH;
        const bw = Math.max(2, (d.value / max) * iw);
        return html`<g key=${d.key} className="hit" tabIndex="0" aria-label=${`${d.key} ${fmtBaht.format(d.value)}`}
            onMouseEnter=${() => setHover(i)} onClick=${() => setHover(i)} onFocus=${() => setHover(i)} onBlur=${() => setHover(null)}>
          <rect x="0" y=${y} width=${W} height=${rowH} fill=${hover === i ? "var(--glass-hi)" : "transparent"} rx="10" />
          <text className="bar-label" x=${labelW - 10} y=${y + rowH / 2 + 5} textAnchor="end">${trunc(d.key)}</text>
          <rect x=${labelW} y=${y + 12} width=${iw} height=${rowH - 24} rx="7" fill="var(--line)" />
          <rect className="growx" style=${{ animationDelay: `${i * 80}ms` }} x=${labelW} y=${y + 12} width=${bw} height=${rowH - 24} rx="7"
            fill=${i === 0 ? "var(--c1)" : "var(--c4)"} opacity=${hover == null || hover === i ? 1 : 0.45} />
          <text className="bar-val" x=${labelW + bw + 6} y=${y + rowH / 2 + 5}>${fmtBaht.format(d.value)}</text>
        </g>`;
      })}
    </svg>`}
    ${hover != null && w > 0 && html`<${Tip}
        x=${((labelW + Math.max(2, (data[hover].value / max) * iw) / 2) / W) * w}
        y=${((pt + hover * rowH + 6) / H) * (w * H / W)} width=${w}>
      ${data[hover].key}<b>${fmtBaht.format(data[hover].value)}</b>${fmtPct.format(data[hover].value / total)} ของยอดรวม
    </${Tip}>`}
  </div>`;
}

// สีแท่งตามภูมิภาค (ผูกกับลำดับภูมิภาคในไฟล์ สีจึงไม่เปลี่ยนตามตัวกรอง)
const REGION_COLORS = ["var(--r1)", "var(--r2)", "var(--r3)", "var(--r4)", "var(--r5)", "var(--r6)", "var(--c2)", "var(--muted)"];
// สีตามหมวดสินค้า (ผูกกับลำดับหมวดในไฟล์ สีจึงไม่เปลี่ยนตามตัวกรอง)
// ชุดสี Okabe–Ito ที่คนตาบอดสีแยกได้ (ผูกกับลำดับหมวดในไฟล์ สีจึงไม่เปลี่ยนตามตัวกรอง)
const CAT_COLORS = ["var(--k1)", "var(--k2)", "var(--k3)", "var(--k4)", "var(--k5)", "var(--k6)", "var(--k7)", "var(--k8)"];

function StackedCarrierChart({ data, colorOf, rank }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null); // { i: แท่ง, j: ช่วงสี }
  const W = Math.max(w, 260), rowH = 46, pt = 6;
  const labelW = Math.min(120, W * 0.32);
  const valW = 10 + Math.max(...data.map((d) => fmtBaht.format(d.value).length)) * 7.4;
  const H = pt + data.length * rowH + 4;
  const iw = W - labelW - valW - 8;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const trunc = (s) => (s.length > 14 ? s.slice(0, 13) + "…" : s);
  const rows = data.map((d) => {
    let x = labelW;
    const segs = [...d.segs].sort((a, b) => rank(a.cat) - rank(b.cat)).map((sg) => {
      const sw = (sg.value / max) * iw;
      const out = { ...sg, x, w: sw };
      x += sw;
      return out;
    });
    return { ...d, segs, bw: Math.max(2, x - labelW) };
  });
  const hv = hover && rows[hover.i] && rows[hover.i].segs[hover.j];

  return html`<div className="chart" ref=${ref} onMouseLeave=${() => setHover(null)}>
    ${w > 0 && html`<svg viewBox=${`0 0 ${W} ${H}`} width="100%" role="img" aria-label="กราฟแท่งซ้อนยอดขายสุทธิตามบริษัทขนส่ง แยกสีตามหมวดสินค้า">
      <defs>${rows.map((d, i) => html`<clipPath key=${d.key} id=${`crclip-${i}`}>
        <rect x=${labelW} y=${pt + i * rowH + 12} width=${d.bw} height=${rowH - 24} rx="7" /></clipPath>`)}</defs>
      ${rows.map((d, i) => {
        const y = pt + i * rowH;
        return html`<g key=${d.key}>
          <rect x="0" y=${y} width=${W} height=${rowH} fill=${hover && hover.i === i ? "var(--glass-hi)" : "transparent"} rx="10" />
          <text className="bar-label" x=${labelW - 10} y=${y + rowH / 2 + 5} textAnchor="end">${trunc(d.key)}</text>
          <rect x=${labelW} y=${y + 12} width=${iw} height=${rowH - 24} rx="7" fill="var(--line)" />
          <g className="growx" style=${{ animationDelay: `${i * 80}ms` }} clipPath=${`url(#crclip-${i})`}>
            ${d.segs.map((sg, j) => html`<rect key=${sg.cat} className="hit" tabIndex="0"
                aria-label=${`${d.key} ${sg.cat} ${fmtBaht.format(sg.value)} ${fmtPct.format(sg.value / (d.value || 1))}`}
                x=${sg.x} y=${y + 12} width=${Math.max(0, sg.w)} height=${rowH - 24} fill=${colorOf(sg.cat)} stroke="var(--surface)" strokeWidth="1.5"
                opacity=${hover == null || (hover.i === i && hover.j === j) ? 1 : 0.4}
                onMouseEnter=${() => setHover({ i, j })} onClick=${() => setHover({ i, j })}
                onFocus=${() => setHover({ i, j })} onBlur=${() => setHover(null)} />`)}
          </g>
          <text className="bar-val" x=${labelW + d.bw + 6} y=${y + rowH / 2 + 5}>${fmtBaht.format(d.value)}</text>
        </g>`;
      })}
    </svg>`}
    ${hv && w > 0 && html`<${Tip}
        x=${((hv.x + hv.w / 2) / W) * w}
        y=${((pt + hover.i * rowH + 8) / H) * (w * H / W)} width=${w}>
      ${hv.cat} (${rows[hover.i].key})<b>${fmtBaht.format(hv.value)}</b>${fmtPct.format(hv.value / (rows[hover.i].value || 1))} ของแท่งนี้
    </${Tip}>`}
  </div>`;
}

function ProvinceChart({ data, colorOf }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const W = Math.max(w, 260), rowH = 30, pt = 4;
  const labelW = Math.min(120, W * 0.32);
  const valW = 10 + Math.max(...data.map((d) => fmtBaht.format(d.value).length)) * 7.4;
  const H = pt + data.length * rowH + 4;
  const iw = W - labelW - valW - 8;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const trunc = (s) => (s.length > 14 ? s.slice(0, 13) + "…" : s);

  return html`<div className="chart" ref=${ref} onMouseLeave=${() => setHover(null)}>
    ${w > 0 && html`<svg viewBox=${`0 0 ${W} ${H}`} width="100%" role="img" aria-label="กราฟแท่งยอดขายสุทธิรายจังหวัด">
      ${data.map((d, i) => {
        const y = pt + i * rowH;
        const bw = Math.max(2, (d.value / max) * iw);
        return html`<g key=${d.key} className="hit" tabIndex="0" aria-label=${`${d.key} (${d.region}) ${fmtBaht.format(d.value)}`}
            onMouseEnter=${() => setHover(i)} onClick=${() => setHover(i)} onFocus=${() => setHover(i)} onBlur=${() => setHover(null)}>
          <rect x="0" y=${y} width=${W} height=${rowH} fill=${hover === i ? "var(--glass-hi)" : "transparent"} rx="8" />
          <text className="bar-label" x=${labelW - 10} y=${y + rowH / 2 + 5} textAnchor="end">${trunc(d.key)}</text>
          <rect x=${labelW} y=${y + 7} width=${iw} height=${rowH - 14} rx="5" fill="var(--line)" />
          <rect className="growx" style=${{ animationDelay: `${Math.min(i, 20) * 40}ms` }} x=${labelW} y=${y + 7} width=${bw} height=${rowH - 14} rx="5"
            fill=${colorOf(d.region, i)} opacity=${hover == null || hover === i ? 1 : 0.4} />
          <text className="bar-val" x=${labelW + bw + 6} y=${y + rowH / 2 + 5}>${fmtBaht.format(d.value)}</text>
        </g>`;
      })}
    </svg>`}
    ${hover != null && w > 0 && html`<${Tip}
        x=${((labelW + Math.max(2, (data[hover].value / max) * iw) / 2) / W) * w}
        y=${((pt + hover * rowH + 4) / H) * (w * H / W)} width=${w}>
      ${data[hover].key} (${data[hover].region})<b>${fmtBaht.format(data[hover].value)}</b>${fmtPct.format(data[hover].value / total)} ของยอดรวม
    </${Tip}>`}
  </div>`;
}

function RegionChart({ data, colorOf }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const W = Math.max(w, 260), rowH = 40, pt = 4;
  const labelW = Math.min(150, W * 0.38);
  const valW = 10 + Math.max(...data.map((d) => fmtMillion.format(d.value).length)) * 7.6;
  const H = pt + data.length * rowH + 4;
  const iw = W - labelW - valW - 8;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const trunc = (s) => (s.length > 20 ? s.slice(0, 19) + "…" : s);

  return html`<div className="chart" ref=${ref} onMouseLeave=${() => setHover(null)}>
    ${w > 0 && html`<svg viewBox=${`0 0 ${W} ${H}`} width="100%" role="img" aria-label="กราฟแท่งยอดขายสุทธิรายภูมิภาค">
      ${data.map((d, i) => {
        const y = pt + i * rowH;
        const bw = Math.max(2, (d.value / max) * iw);
        return html`<g key=${d.key} className="hit" tabIndex="0" aria-label=${`${d.key} ${fmtBaht.format(d.value)}`}
            onMouseEnter=${() => setHover(i)} onClick=${() => setHover(i)} onFocus=${() => setHover(i)} onBlur=${() => setHover(null)}>
          <rect x="0" y=${y} width=${W} height=${rowH} fill=${hover === i ? "var(--glass-hi)" : "transparent"} rx="8" />
          <text className="bar-label" x=${labelW - 10} y=${y + rowH / 2 + 5} textAnchor="end">${trunc(d.key)}</text>
          <rect x=${labelW} y=${y + 9} width=${iw} height=${rowH - 18} rx="6" fill="var(--line)" />
          <rect className="growx" style=${{ animationDelay: `${i * 70}ms` }} x=${labelW} y=${y + 9} width=${bw} height=${rowH - 18} rx="6"
            fill=${colorOf(d.key)} opacity=${hover == null || hover === i ? 1 : 0.4} />
          <text className="bar-val" x=${labelW + bw + 6} y=${y + rowH / 2 + 5}>${fmtMillion.format(d.value)}</text>
        </g>`;
      })}
    </svg>`}
    ${hover != null && w > 0 && html`<${Tip}
        x=${((labelW + Math.max(2, (data[hover].value / max) * iw) / 2) / W) * w}
        y=${((pt + hover * rowH + 4) / H) * (w * H / W)} width=${w}>
      ${data[hover].key}<b>${fmtBaht.format(data[hover].value)}</b>${fmtPct.format(data[hover].value / total)} ของยอดรวม
    </${Tip}>`}
  </div>`;
}

function CompareBars({ rows, max }) {
  const top = max || Math.max(...rows.map((r) => r.value || 0), 0) || 1;
  return html`<div className="cmp">
    ${rows.map((r) => html`<div className="cmp-row" key=${r.label}>
      <span>${r.label}</span>
      <span className="cmp-track" aria-hidden="true"><span className="cmp-fill" style=${{ width: `${Math.max(0, Math.min(1, (r.value || 0) / top)) * 100}%`, background: r.color }}></span></span>
      <span className="cmp-val">${r.text}</span>
    </div>`)}
  </div>`;
}

// บทสรุปผู้บริหาร: ตรวจว่าตัวเลขทุกตัวในบทสรุปมาจาก JSON
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;
const normNum = (t) => String(Number(t.replace(/,/g, "")));
const countLeaves = (o) => (o && typeof o === "object" ? Object.values(o).reduce((a, v) => a + countLeaves(v), 0) : 1);
const SUM_SECTIONS = ["ภาพรวมยอดขาย", "แนวโน้มเดือนล่าสุด", "พื้นที่", "ช่องทางขายและบริษัทขนส่ง", "คุณภาพคำสั่งซื้อ", "วันเมกะเซลและกำไรขั้นต้น"];
const NO_DATA = "ไม่มีข้อมูลในตัวกรองนี้";
const nonEmpty = (o) => !!o && Object.keys(o).length > 0;
// หัวข้อไหนไม่มีข้อมูลใน JSON ให้เขียนว่า "ไม่มีข้อมูลในตัวกรองนี้" เสมอ 
const sectionHasData = (p) => [
  p["คำสั่งซื้อสำเร็จ"] > 0,
  nonEmpty(p["เดือนล่าสุด"]),
  nonEmpty(p["ภูมิภาคยอดสูงสุด_ล้านบาท"]) || nonEmpty(p["จังหวัดยอดสูงสุด_ล้านบาท"]),
  nonEmpty(p["ช่องทางยอดสูงสุด_ล้านบาท"]) || nonEmpty(p["บริษัทขนส่งยอดสูงสุด_ล้านบาท"]),
  p["อัตรายกเลิก_เปอร์เซ็นต์"] != null || p["อัตราคืนสินค้า_เปอร์เซ็นต์"] != null,
  !!p["วันเมกะเซล"] && Object.values(p["วันเมกะเซล"]).some((v) => v != null),
];
// ไฮไลต์ตัวเลขที่ไม่อยู่ใน JSON
function CheckedText({ text, allowed }) {
  const parts = text.split(/(\d[\d,]*(?:\.\d+)?)/);
  return parts.map((t, i) => (i % 2 === 1 && !allowed.has(normNum(t))
    ? html`<mark key=${i} className="badnum" title="ไม่พบตัวเลขนี้ใน JSON">${t}</mark>`
    : t));
}
// สร้างรายงานด้วยประโยคแม่แบบ เติมตัวเลขจาก JSON ตามที่เขียนไว้เท่านั้น (ไม่คำนวณตัวเลขใหม่ในประโยค)
const fmtJ = (v) => Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 });
const topList = (o) => Object.entries(o || {});
function buildReport(p) {
  const has = sectionHasData(p);
  const nd = (v, unit) => (v == null ? NO_DATA : `${fmtJ(v)}${unit}`);
  const mb = ([k, v]) => `${k} (${fmtJ(v)} ล้านบาท)`;
  const sec = (title, ok, bullets) => ({ title, bullets: ok ? bullets.filter(Boolean) : [NO_DATA] });
  const lm = p["เดือนล่าสุด"], mom = lm ? lm["เทียบเดือนก่อนหน้า_เปอร์เซ็นต์"] : null;
  const rg = topList(p["ภูมิภาคยอดสูงสุด_ล้านบาท"]), pv = topList(p["จังหวัดยอดสูงสุด_ล้านบาท"]);
  const chn = topList(p["ช่องทางยอดสูงสุด_ล้านบาท"]), car = topList(p["บริษัทขนส่งยอดสูงสุด_ล้านบาท"]);
  const cr = p["อัตรายกเลิก_เปอร์เซ็นต์"], rr = p["อัตราคืนสินค้า_เปอร์เซ็นต์"];
  const mg = p["วันเมกะเซล"] || {};
  const share = mg["สัดส่วนยอดขายวันเมกะเซล_เปอร์เซ็นต์"];
  const gm = mg["กำไรขั้นต้นวันเมกะเซล_เปอร์เซ็นต์"], gn = mg["กำไรขั้นต้นวันปกติ_เปอร์เซ็นต์"];
  const hasGp = gm != null && gn != null;

  const sections = [
    sec("ภาพรวม", has[0], [
      `ยอดขายสุทธิ ${fmtJ(p["ยอดขายสุทธิ_ล้านบาท"])} ล้านบาท ในช่วง ${p["ช่วงข้อมูล"]}`,
      `คำสั่งซื้อสำเร็จ ${fmtJ(p["คำสั่งซื้อสำเร็จ"])} รายการ`,
      `มูลค่าเฉลี่ยต่อคำสั่งซื้อ (AOV) ${nd(p["AOV_บาท"], " บาท")}`,
    ]),
    sec("แนวโน้มเดือนล่าสุด", has[1], lm && [
      `เดือนล่าสุดในช่วงที่เลือก: ${lm["เดือน"]} ยอดขายสุทธิ ${fmtJ(lm["ยอด_ล้านบาท"])} ล้านบาท`,
      mom == null ? "ไม่มีเดือนก่อนหน้าในช่วงที่เลือกให้เปรียบเทียบ"
        : mom < 0 ? `ยอดขายลดลง ${fmtJ(Math.abs(mom))}% เมื่อเทียบกับเดือนก่อนหน้า`
        : mom > 0 ? `ยอดขายเพิ่มขึ้น ${fmtJ(mom)}% เมื่อเทียบกับเดือนก่อนหน้า`
        : "ยอดขายเท่ากับเดือนก่อนหน้า",
    ]),
    sec("พื้นที่", has[2], [
      rg.length ? `ภูมิภาคยอดสูงสุด: ${mb(rg[0])}` : `ภูมิภาค: ${NO_DATA}`,
      rg.length > 1 && `ภูมิภาคอันดับรอง: ${rg.slice(1).map(mb).join(", ")}`,
      pv.length ? `จังหวัดยอดสูงสุด: ${mb(pv[0])}` : `จังหวัด: ${NO_DATA}`,
      pv.length > 1 && `จังหวัดอันดับรอง: ${pv.slice(1).map(mb).join(", ")}`,
    ]),
    sec("ช่องทางและขนส่ง", has[3], [
      chn.length ? `ช่องทางขายยอดสูงสุด: ${mb(chn[0])}` : `ช่องทางขาย: ${NO_DATA}`,
      car.length ? `บริษัทขนส่งที่มียอดขายสุทธิผ่านมากที่สุด: ${mb(car[0])}` : `บริษัทขนส่ง: ${NO_DATA}`,
    ]),
    sec("คุณภาพคำสั่งซื้อ", has[4], [
      `อัตรายกเลิก ${nd(cr, "%")} ของคำสั่งซื้อทั้งหมดในตัวกรองนี้`,
      `อัตราคืนสินค้า ${nd(rr, "%")} ของคำสั่งซื้อทั้งหมดในตัวกรองนี้`,
      cr != null && rr != null && (cr > rr ? "การยกเลิกเป็นประเด็นที่ควรติดตามมากกว่าการคืนสินค้า"
        : rr > cr ? "การคืนสินค้าเป็นประเด็นที่ควรติดตามมากกว่าการยกเลิก" : "อัตรายกเลิกและอัตราคืนสินค้าอยู่ในระดับเท่ากัน"),
    ]),
    sec("วันเมกะเซลและกำไร", has[5], [
      `วันเมกะเซลมีสัดส่วน ${nd(share, "%")} ของยอดขายสุทธิ`,
      hasGp ? `กำไรขั้นต้น: วันเมกะเซล ${fmtJ(gm)}% และวันปกติ ${fmtJ(gn)}%` : `กำไรขั้นต้น: ${NO_DATA} (ต้องอัปโหลด products.csv ในแท็บวันเมกะเซล)`,
      hasGp && (gm < gn ? "กำไรขั้นต้นวันเมกะเซลต่ำกว่าวันปกติ" : "กำไรขั้นต้นวันเมกะเซลไม่ต่ำกว่าวันปกติ"),
    ]),
  ];

  // ข้อเสนอแนะ: เฉพาะประเด็นที่ข้อมูลบ่งชี้
  const recs = [];
  if (hasGp && gm < gn) recs.push({
    title: "กำไรขั้นต้นวันเมกะเซลต่ำกว่าวันปกติ",
    found: `กำไรขั้นต้นวันเมกะเซล ${fmtJ(gm)}% เทียบกับวันปกติ ${fmtJ(gn)}%`,
    cause: "ส่วนลดหรือโปรโมชันวันเมกะเซลอาจลึกเกินไป หรือสินค้าที่ขายดีในวันเมกะเซลอาจเป็นกลุ่มที่กำไรต่ำ",
    action: "ทบทวนระดับส่วนลดวันเมกะเซล กำหนดเพดานส่วนลดต่อหมวด และคัดสินค้ากำไรสูงเข้าร่วมแคมเปญ",
  });
  if (lm && mom != null && mom < 0) recs.push({
    title: "ยอดขายเดือนล่าสุดลดลง",
    found: `ยอดขาย ${lm["เดือน"]} ลดลง ${fmtJ(Math.abs(mom))}% เมื่อเทียบกับเดือนก่อนหน้า`,
    cause: "อาจมาจากฤดูกาล แคมเปญของเดือนก่อนหน้าสิ้นสุดลง คู่แข่งจัดโปรโมชัน หรือข้อมูลเดือนล่าสุดยังไม่ครบเดือน",
    action: "ตรวจว่าข้อมูลเดือนล่าสุดครบเดือนหรือไม่ แล้วใช้ตัวกรองช่องทางและหมวดสินค้าหาส่วนที่ลดลงมากที่สุด เพื่อวางแคมเปญเฉพาะจุด",
  });
  const net = p["ยอดขายสุทธิ_ล้านบาท"];
  const allRegions = (p["ตัวกรอง"] || {})["ภูมิภาค"] === "ทุกภูมิภาค";
  if (allRegions && rg.length && net > 0 && rg[0][1] / net >= 0.5) recs.push({ // เงื่อนไขภายใน: ภูมิภาคแรก ≥ ครึ่งหนึ่งของยอดรวม (ไม่แสดงเป็นตัวเลขใหม่)
    title: "ยอดขายกระจุกในภูมิภาคเดียว",
    found: `ภูมิภาค ${rg[0][0]} มียอดขายสุทธิ ${fmtJ(rg[0][1])} ล้านบาท จากยอดขายสุทธิรวม ${fmtJ(net)} ล้านบาท`,
    cause: "ฐานลูกค้า การรับรู้แบรนด์ หรือความเร็วขนส่งในภูมิภาคนี้อาจดีกว่า ขณะที่การตลาดยังไม่ครอบคลุมภูมิภาคอื่น",
    action: `ทดลองแคมเปญหรือโปรค่าส่งใน${rg.length > 1 ? ` ${rg[1][0]} ซึ่งเป็นภูมิภาคอันดับรอง` : "ภูมิภาคอื่น"} และติดตามผลรายเดือน เพื่อลดการพึ่งพาภูมิภาคเดียว`,
  });
  return {
    sections, recs,
    noRec: "ไม่พบประเด็นที่ข้อมูลบ่งชี้ตามเงื่อนไขที่ตรวจ ได้แก่ กำไรขั้นต้นวันเมกะเซล ยอดเดือนล่าสุด และการกระจุกตัวของยอดขายในภูมิภาคเดียว",
  };
}
const reportTexts = (r) => [...r.sections.flatMap((x) => x.bullets), ...r.recs.flatMap((x) => [x.found, x.cause, x.action]), r.recs.length ? "" : r.noRec];

// CSS ของรายงาน: ใช้ร่วมกันทั้งตัวอย่างบนจอ การพิมพ์ และไฟล์ .html ที่ดาวน์โหลด
const REPORT_CSS = `
@page { size: A4 portrait; margin: 18mm; }
.report { font-family: "IBM Plex Sans Thai", "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif; color: #111827; background: #FFFFFF; text-align: left; font-size: 11pt; line-height: 1.7; }
.report * { box-sizing: border-box; }
.report h1 { margin: 0 0 4pt; font-size: 18pt; line-height: 1.45; font-weight: 700; color: #111827; }
.report .r-meta { margin: 0 0 12pt; padding: 0 0 8pt; border-bottom: 1px solid #D1D5DB; font-size: 10pt; line-height: 1.7; color: #374151; }
.report .r-meta div { margin: 0; }
.report .r-meta b { color: #111827; font-weight: 600; }
.report .r-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6pt; margin: 0 0 14pt; break-inside: avoid; page-break-inside: avoid; }
.report .r-kpi { border: 1px solid #D1D5DB; border-radius: 4pt; padding: 5pt 7pt; }
.report .r-kpi .l { font-size: 9pt; line-height: 1.6; color: #4B5563; }
.report .r-kpi .v { font-size: 13pt; line-height: 1.6; font-weight: 700; color: #111827; font-variant-numeric: tabular-nums; }
.report .r-sec { margin: 0 0 10pt; break-inside: avoid; page-break-inside: avoid; }
.report .r-sec.r-recs { break-inside: auto; page-break-inside: auto; }
.report h2 { margin: 0 0 3pt; font-size: 12.5pt; line-height: 1.6; font-weight: 700; color: #111827; break-after: avoid; page-break-after: avoid; }
.report h3 { margin: 6pt 0 2pt; font-size: 11pt; line-height: 1.7; font-weight: 700; color: #111827; break-after: avoid; page-break-after: avoid; }
.report ul { margin: 0; padding: 0 0 0 16pt; }
.report li { margin: 0 0 2pt; font-size: 11pt; line-height: 1.7; color: #111827; break-inside: avoid; page-break-inside: avoid; }
.report .r-issue { break-inside: avoid; page-break-inside: avoid; }
.report .lbl { font-weight: 600; }
.report .r-foot { margin-top: 14pt; padding-top: 6pt; border-top: 1px solid #D1D5DB; font-size: 9pt; line-height: 1.7; color: #4B5563; break-inside: avoid; page-break-inside: avoid; }
.report mark.badnum { background: none; color: #B91C1C; font-weight: 700; text-decoration: underline; }
`;
(() => { const st = document.createElement("style"); st.textContent = REPORT_CSS; document.head.appendChild(st); })();

function Report({ r, allowed }) {
  const A = new Set(allowed);
  const T = (t) => html`<${CheckedText} text=${t} allowed=${A} />`;
  return html`<article className="report">
    <h1>บทสรุปผู้บริหาร · บ้านสบาย ช็อป</h1>
    <div className="r-meta">
      <div><b>ตัวกรอง:</b> ${r.filterText}</div>
      <div><b>ช่วงข้อมูล:</b> ${r.range}</div>
      <div><b>วันที่สร้าง:</b> ${r.dateTh}</div>
    </div>
    <div className="r-kpis">
      ${r.kpis.map(([l, v]) => html`<div className="r-kpi" key=${l}><div className="l">${l}</div><div className="v">${v}</div></div>`)}
    </div>
    ${r.sections.map((x) => html`<section className="r-sec" key=${x.title}>
      <h2>${x.title}</h2>
      <ul>${x.bullets.map((b, i) => html`<li key=${i}>${T(b)}</li>`)}</ul>
    </section>`)}
    <section className="r-sec r-recs">
      <h2>ข้อเสนอแนะ</h2>
      ${r.recs.length ? r.recs.map((x) => html`<div className="r-issue" key=${x.title}>
        <h3>${x.title}</h3>
        <ul>
          <li><span className="lbl">สิ่งที่พบ: </span>${T(x.found)}</li>
          <li><span className="lbl">สาเหตุที่เป็นไปได้ (ข้อสันนิษฐาน): </span>${T(x.cause)}</li>
          <li><span className="lbl">ข้อเสนอแนะ: </span>${T(x.action)}</li>
        </ul>
      </div>`) : html`<ul><li>${T(r.noRec)}</li></ul>`}
    </section>
    <div className="r-foot">สร้างจากตัวเลขสรุปของ dashboard ข้อเสนอแนะเป็นข้อสันนิษฐาน ควรตรวจสอบก่อนตัดสินใจ</div>
  </article>`;
}

function DataTable({ head, rows }) {
  return html`<details>
    <summary>ดูเป็นตาราง</summary>
    <table>
      <thead><tr>${head.map((h, i) => html`<th key=${h} className=${i ? "r" : ""}>${h}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr key=${r[0]}>${r.map((c, i) => html`<td key=${i} className=${i ? "r num" : ""}>${c}</td>`)}</tr>`)}</tbody>
    </table>
  </details>`;
}

function Counter({ value, fmt }) {
  return value == null ? "—" : fmt.format(value); // แสดงค่าทันที ไม่มีตัวเลขวิ่ง
}

// แสดงผลเป็นล้านบาท ทศนิยม 1 ตำแหน่ง (เฉพาะการแสดงผล ไม่เปลี่ยนค่าที่คำนวณ)
const fmtMillion = { format: (v) => `฿${(v / 1e6).toLocaleString("th-TH", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ล้าน` };

function Kpi({ label, value, fmt, note, icon, tone, share }) {
  return html`<div className="glass kpi" style=${{ "--tone": tone }}>
    <div className="head">
      <span className="badge"><${Icon} name=${icon} /></span>
      <span className="label">${label}</span>
    </div>
    <div className="value num"><${Counter} value=${value} fmt=${fmt} /></div>
    <div className="note">${note}</div>
    ${share != null && html`<div className="bar" aria-hidden="true"><span style=${{ width: `${Math.min(100, share * 100)}%` }} /></div>`}
  </div>`;
}

function App() {
  const [state, setState] = useState({ status: "idle" });
  const [region, setRegion] = useState(ALL);
  const [cat, setCat] = useState(ALL);
  const [ch, setCh] = useState(ALL);
  const [tab, setTab] = useState("overview");
  const [theme, setTheme] = useState(() => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"));
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("dash-theme", theme); } catch (e) {}
  }, [theme]);
  const [products, setProducts] = useState({ status: "idle" });
  const prodRef = useRef(null);
  const [sum, setSum] = useState({ status: "idle" });
  const sumCtl = useRef(null);
  const [printMsg, setPrintMsg] = useState("");
  const [downloads, setDownloads] = useState(undefined); // undefined = กำลังตรวจ, null = ใช้ไม่ได้
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = window.claude && window.claude.use ? await window.claude.use("downloads") : localDownloads;
        if (live) setDownloads(d || null);
      } catch (e) { if (live) setDownloads(null); }
    })();
    return () => { live = false; };
  }, []);
  // ไฟล์ HTML หน้าเดียวที่จัดหน้า A4 ไว้แล้ว เปิดใน Chrome แล้วกด Ctrl+P บันทึกเป็น PDF
  const downloadHtml = async () => {
    const el = document.getElementById("print-root");
    if (sum.status !== "done" || !downloads || !el) return;
    const doc = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>บทสรุปผู้บริหาร · บ้านสบาย ช็อป</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet">
<style>
html, body { margin: 0; background: #FFFFFF; }
@media screen {
  body { padding: 18mm 0; }
  .report, .hint { width: 174mm; max-width: calc(100% - 32px); margin-left: auto; margin-right: auto; }
  .hint { margin-bottom: 12pt; font: 10pt/1.7 "IBM Plex Sans Thai", Tahoma, sans-serif; color: #4B5563; }
}
@media print { .hint { display: none; } }
${REPORT_CSS}
</style>
</head>
<body>
<p class="hint">กด Ctrl+P (Mac: ⌘P) แล้วเลือก “บันทึกเป็น PDF” กระดาษ A4 แนวตั้ง</p>
${el.innerHTML}
</body>
</html>
`;
    setPrintMsg("");
    try {
      await downloads.save({ filename: `executive-summary-${sum.report.date}.html`, data: doc });
    } catch (e) {
      const code = e && e.code;
      if (code === "declined") return;
      if (["unavailable", "not_granted", "capability_disabled", "capability_removed"].includes(code)) setDownloads(null);
      setPrintMsg(code === "rate_limited" ? "มีหน้าต่างบันทึกไฟล์เปิดอยู่ รอสักครู่แล้วกดใหม่"
        : code === "extension_not_enabled" || code === "rejected_extension" ? "หน้านี้ดาวน์โหลดไฟล์ .html ไม่ได้"
        : "ดาวน์โหลดรายงานไม่สำเร็จ ลองกดใหม่อีกครั้ง");
    }
  };
  const monthsRead = state.status === "ready" ? state.rows.map((r) => r.month).filter(Boolean).sort() : [];
  // ช่วงเดือน: null = ใช้เดือนแรก/เดือนสุดท้ายของข้อมูล (ค่าเริ่มต้น)
  const [fromM, setFromM] = useState(null);
  const [toM, setToM] = useState(null);
  const monthOpts = [...new Set(monthsRead)];
  const firstM = monthOpts[0] || null, lastM = monthOpts[monthOpts.length - 1] || null;
  const fromEff = fromM && monthOpts.includes(fromM) ? fromM : firstM;
  const toEff = toM && monthOpts.includes(toM) ? toM : lastM;
  const rangeInvalid = !!(fromEff && toEff && fromEff > toEff);
  const monthActive = !rangeInvalid && !!firstM && (fromEff !== firstM || toEff !== lastM);
  const rangeText = monthOpts.length
    ? `ข้อมูล ${monthLabel(rangeInvalid ? firstM : fromEff, true)} – ${monthLabel(rangeInvalid ? lastM : toEff, true)}`
    : "";
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  const handleFile = useCallback((file) => {
    if (!file) return;
    setState({ status: "loading", fileName: file.name });
    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      encoding: "UTF-8",
      transformHeader: (h) => clean(h).toLowerCase(),
      complete: (res) => {
        try {
          const out = prepare(res);
          setRegion(ALL); setCat(ALL); setCh(ALL); setFromM(null); setToM(null);
          setState({ status: "ready", fileName: file.name, ...out });
        } catch (e) {
          setState({ status: "error", fileName: file.name, message: e.message });
        }
      },
      error: (err) => setState({ status: "error", fileName: file.name, message: `อ่านไฟล์ไม่ได้: ${err.message}` }),
    });
  }, []);

  const pick = () => inputRef.current && inputRef.current.click();
  const pickProducts = () => prodRef.current && prodRef.current.click();
  const handleProducts = useCallback((file) => {
    if (!file) return;
    setProducts({ status: "loading", fileName: file.name });
    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      encoding: "UTF-8",
      transformHeader: (h) => clean(h).toLowerCase(),
      complete: (res) => {
        const fields = (res.meta.fields || []).map(clean);
        const missing = ["product_id", "unit_cost"].filter((c) => !fields.includes(c));
        if (missing.length) {
          setProducts({ status: "error", fileName: file.name, message: `products.csv ไม่มีคอลัมน์ ${missing.join(", ")} — คอลัมน์ที่พบ: ${fields.join(", ") || "ไม่พบหัวคอลัมน์"}` });
          return;
        }
        const costs = new Map();
        let bad = 0;
        for (const r of res.data) {
          const id = clean(r.product_id), c = num(r.unit_cost);
          if (id && isFinite(c)) costs.set(id, c); else bad++;
        }
        if (!costs.size) { setProducts({ status: "error", fileName: file.name, message: "ไม่พบแถวที่มี product_id และ unit_cost เป็นตัวเลข" }); return; }
        setProducts({ status: "ready", fileName: file.name, costs, count: costs.size, bad });
      },
      error: (err) => setProducts({ status: "error", fileName: file.name, message: `อ่านไฟล์ไม่ได้: ${err.message}` }),
    });
  }, []);
  const onInput = (e) => { handleFile(e.target.files[0]); e.target.value = ""; };
  const onDrop = (e) => { e.preventDefault(); setOver(false); handleFile(e.dataTransfer.files[0]); };

  const filtered = useMemo(() => {
    if (state.status !== "ready") return [];
    return state.rows.filter((r) => (region === ALL || r.region === region) && (cat === ALL || r.category === cat) && (ch === ALL || r.channel === ch)
      && (!monthActive || (r.month && r.month >= fromEff && r.month <= toEff)));
  }, [state, region, cat, ch, monthActive, fromEff, toEff]);
  const s = useMemo(() => summarize(filtered), [filtered]);
  const ready = state.status === "ready";
  const isFiltered = region !== ALL || cat !== ALL || ch !== ALL || monthActive || rangeInvalid;
  const fkey = `${region}|${cat}|${ch}|${monthActive ? fromEff + "~" + toEff : "all"}`; // เปลี่ยนตัวกรองแล้วให้กราฟเล่นแอนิเมชันใหม่
  const chTotal = s.channels.reduce((a, d) => a + d.value, 0) || 1;
  const crTotal = s.carriers.reduce((a, d) => a + d.value, 0) || 1;
  const pvTotal = s.provinces.reduce((a, d) => a + d.value, 0) || 1;
  const catRank = (c) => (ready ? state.categories.indexOf(c) : 0);
  const catColor = (c) => CAT_COLORS[Math.max(0, catRank(c)) % CAT_COLORS.length];
  const crCats = [...new Set(s.carrierStack.flatMap((d) => d.segs.map((sg) => sg.cat)))].sort((a, b) => catRank(a) - catRank(b));
  const regionColor = (rg) => REGION_COLORS[Math.max(0, ready ? state.regions.indexOf(rg) : 0) % REGION_COLORS.length];
  const mega = useMemo(() => megaSummarize(filtered, products.status === "ready" ? products.costs : null), [filtered, products]);
  const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
  const payload = useMemo(() => {
    if (!ready) return null;
    const mm = s.monthly, last = mm[mm.length - 1], prev = mm[mm.length - 2];
    const top = (arr, n) => Object.fromEntries(arr.slice(0, n).map((d) => [d.key, r2(d.value / 1e6)]));
    const p = {
      "ตัวกรอง": { "ภูมิภาค": region === ALL ? "ทุกภูมิภาค" : region, "หมวดสินค้า": cat === ALL ? "ทุกหมวด" : cat, "ช่องทาง": ch === ALL ? "ทุกช่องทาง" : ch },
      "ช่วงข้อมูล": rangeText.replace(/^ข้อมูล /, ""),
      "ยอดขายสุทธิ_ล้านบาท": r1(s.net / 1e6),
      "คำสั่งซื้อสำเร็จ": s.okCount,
      "AOV_บาท": s.aov == null ? null : Math.round(s.aov),
      "อัตรายกเลิก_เปอร์เซ็นต์": s.cancelRate == null ? null : r1(s.cancelRate * 100),
      "อัตราคืนสินค้า_เปอร์เซ็นต์": s.returnRate == null ? null : r1(s.returnRate * 100),
    };
    if (last) p["เดือนล่าสุด"] = {
      "เดือน": monthLabel(last.key, true), "ยอด_ล้านบาท": r2(last.value / 1e6),
      ...(prev && prev.value > 0 ? { "เทียบเดือนก่อนหน้า_เปอร์เซ็นต์": r1(((last.value - prev.value) / prev.value) * 100) } : {}),
    };
    p["ภูมิภาคยอดสูงสุด_ล้านบาท"] = top(s.regionSales, 3);
    p["จังหวัดยอดสูงสุด_ล้านบาท"] = top(s.provinces, 3);
    p["ช่องทางยอดสูงสุด_ล้านบาท"] = top(s.channels, 1);
    p["บริษัทขนส่งยอดสูงสุด_ล้านบาท"] = top(s.carriers, 1);
    const mg = { "สัดส่วนยอดขายวันเมกะเซล_เปอร์เซ็นต์": mega.total > 0 ? r1((mega.mega.net / mega.total) * 100) : null };
    if (mega.hasCost) {
      mg["กำไรขั้นต้นวันเมกะเซล_เปอร์เซ็นต์"] = mega.mega.gp == null ? null : r1(mega.mega.gp * 100);
      mg["กำไรขั้นต้นวันปกติ_เปอร์เซ็นต์"] = mega.normal.gp == null ? null : r1(mega.normal.gp * 100);
    }
    p["วันเมกะเซล"] = mg;
    const keys = Object.keys(p);
    while (countLeaves(p) > 30 && keys.length) delete p[keys.pop()]; // ไม่เกิน 30 ค่า
    return p;
  }, [ready, s, mega, region, cat, ch, rangeText]);
  const leafCount = payload ? countLeaves(payload) : 0;
  useEffect(() => { if (sumCtl.current) sumCtl.current.abort(); setSum({ status: "idle" }); }, [payload]);
  const runSummary = () => {
    if (!payload) return;
    const json = JSON.stringify(payload, null, 1);
    const built = buildReport(payload);
    const allowed = new Set((json.match(NUM_RE) || []).map(normNum));
    const bad = [...new Set(reportTexts(built).join(" ").match(NUM_RE) || [])].filter((t) => !allowed.has(normNum(t)));
    const now = new Date(), p2 = (n) => String(n).padStart(2, "0");
    const f = payload["ตัวกรอง"] || {};
    const report = {
      ...built,
      filterText: `ภูมิภาค ${f["ภูมิภาค"]}, หมวดสินค้า ${f["หมวดสินค้า"]}, ช่องทาง ${f["ช่องทาง"]}`,
      range: payload["ช่วงข้อมูล"],
      date: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
      dateTh: now.toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" }),
      kpis: [
        ["ยอดขายสุทธิ", fmtMillion.format(s.net)],
        ["คำสั่งซื้อสำเร็จ", fmtInt.format(s.okCount)],
        ["AOV", s.aov == null ? "—" : fmtBaht.format(s.aov)],
        ["อัตรายกเลิก", s.cancelRate == null ? "—" : fmtPct.format(s.cancelRate)],
        ["อัตราคืนสินค้า", s.returnRate == null ? "—" : fmtPct.format(s.returnRate)],
      ],
    };
    setSum({ status: "done", report, bad, allowed: [...allowed] });
    setPrintMsg("");
  };
  const pvRegions = [...new Set(s.provinces.map((d) => d.region))].sort((a, b) => (ready ? state.regions.indexOf(a) - state.regions.indexOf(b) : 0));
  const statusTotal = s.statuses.reduce((a, [, c]) => a + c, 0);
  const tone = (st) => (st === OK_STATUS ? "var(--ok)" : isCancel(st) || st === "คืนสินค้า" ? "var(--bad)" : "var(--c4)");

  return html`<div className="wrap">
    <input ref=${inputRef} type="file" accept=".csv,text/csv" onChange=${onInput} aria-label="อัปโหลด orders.csv" />
    <input ref=${prodRef} type="file" accept=".csv,text/csv" aria-label="อัปโหลด products.csv"
      onChange=${(e) => { handleProducts(e.target.files[0]); e.target.value = ""; }} />
    <header className="top">
      <div>
        <h1>ภาพรวมยอดขายร้านออนไลน์</h1>
        ${rangeText && html`<p className="range">${rangeText}</p>`}
        <p>ร้านบ้านสบาย ช็อป · คำนวณจากไฟล์ orders.csv ที่คุณอัปโหลด ข้อมูลอยู่ในเบราว์เซอร์นี้เท่านั้น</p>
      </div>
      <div className="head-actions">
        ${state.status !== "idle" && html`<div className="file-ctl">
          <span className="file-name" title=${state.fileName}>${state.status === "loading" ? "กำลังอ่าน " : ""}${state.fileName}</span>
          <button className="btn ghost" onClick=${pick}><${Icon} name="upload" />อัปโหลดไฟล์ใหม่</button>
        </div>`}
        <button className="btn ghost" aria-pressed=${theme === "dark" ? "true" : "false"} onClick=${() => setTheme(theme === "dark" ? "light" : "dark")}>
          <${Icon} name=${theme === "dark" ? "sun" : "moon"} />${theme === "dark" ? "ธีมสว่าง" : "ธีมมืด"}
        </button>
      </div>
    </header>

    ${state.status === "error" && html`<div className="glass alert" role="alert">
      <${Icon} name="alert" />
      <div><strong>ใช้ไฟล์นี้ไม่ได้</strong>${state.message}</div>
    </div>`}

    ${!ready && html`<div className=${"glass drop rise" + (over ? " over" : "")} tabIndex="0" role="button" aria-label="เลือกไฟล์ orders.csv"
        onClick=${pick}
        onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${onDrop}
        onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }}>
      <div className="big"><${Icon} name="upload" /></div>
      <h2>${state.status === "loading" ? "กำลังอ่านไฟล์…" : "ลากไฟล์ orders.csv มาวางตรงนี้"}</h2>
      <p>หรือคลิกเพื่อเลือกไฟล์ รองรับ CSV แบบ UTF-8 (มี BOM ได้) แถวแรกต้องเป็นชื่อคอลัมน์</p>
      <span className="btn" aria-hidden="true">เลือกไฟล์ CSV</span>
      <div className="cols">
        ${["order_id", ...REQUIRED, "shipping_fee"].map((c) => html`<code key=${c}>${c}</code>`)}
      </div>
    </div>`}

    ${ready && html`<${React.Fragment}>
      <div className="glass filters" role="search" aria-label="ตัวกรอง">
        <span className="tag"><${Icon} name="filter" />ตัวกรอง</span>
        <div className="field">
          <label htmlFor="f-region">ภูมิภาค</label>
          <select id="f-region" className=${region !== ALL ? "on" : ""} value=${region} onChange=${(e) => setRegion(e.target.value)}>
            <option value=${ALL}>ทุกภูมิภาค</option>
            ${state.regions.map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-cat">หมวดสินค้า</label>
          <select id="f-cat" className=${cat !== ALL ? "on" : ""} value=${cat} onChange=${(e) => setCat(e.target.value)}>
            <option value=${ALL}>ทุกหมวด</option>
            ${state.categories.map((c) => html`<option key=${c} value=${c}>${c}</option>`)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-ch">ช่องทาง</label>
          <select id="f-ch" className=${ch !== ALL ? "on" : ""} value=${ch} onChange=${(e) => setCh(e.target.value)}>
            <option value=${ALL}>ทุกช่องทาง</option>
            ${state.channels.map((c) => html`<option key=${c} value=${c}>${c}</option>`)}
          </select>
        </div>
        <div className="field period" role="group" aria-labelledby="period-label">
          <span className="period-label" id="period-label">ช่วงเดือน</span>
          <div className="period-row">
            <select id="f-from" aria-label="ตั้งแต่เดือน" className=${rangeInvalid ? "" : fromEff !== firstM ? "on" : ""} aria-invalid=${rangeInvalid ? "true" : "false"}
              value=${fromEff || ""} onChange=${(e) => setFromM(e.target.value)}>
              ${monthOpts.map((m) => html`<option key=${m} value=${m}>${monthLabel(m, true)}</option>`)}
            </select>
            <span className="period-sep" aria-hidden="true">ถึง</span>
            <select id="f-to" aria-label="ถึงเดือน" className=${rangeInvalid ? "" : toEff !== lastM ? "on" : ""} aria-invalid=${rangeInvalid ? "true" : "false"}
              value=${toEff || ""} onChange=${(e) => setToM(e.target.value)}>
              ${monthOpts.map((m) => html`<option key=${m} value=${m}>${monthLabel(m, true)}</option>`)}
            </select>
          </div>
        </div>
        ${isFiltered && html`<button className="clear" onClick=${() => { setRegion(ALL); setCat(ALL); setCh(ALL); setFromM(null); setToM(null); }}>ล้างตัวกรอง</button>`}
        ${rangeInvalid && html`<div className="warn" role="alert" style=${{ flexBasis: "100%", marginTop: 0 }}>
          ${`เดือน “ตั้งแต่” (${monthLabel(fromEff, true)}) อยู่หลังเดือน “ถึง” (${monthLabel(toEff, true)}) จึงยังไม่กรองตามช่วงเวลา เลือกใหม่ให้ “ตั้งแต่” อยู่ก่อนหรือเท่ากับ “ถึง”`}
        </div>`}
      </div>

      <p className="sr-only" aria-live="polite">${`ยอดขายสุทธิ ${fmtBaht.format(s.net)} จาก ${fmtInt.format(filtered.length)} แถวที่ตรงตัวกรอง`}</p>
      <div className="tabs" role="tablist" aria-label="มุมมองแดชบอร์ด"
          onKeyDown=${(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const ids = ["overview", "detail", "mega", "summary"]; const t = ids[(ids.indexOf(tab) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length]; setTab(t); const el = document.getElementById(`tab-${t}`); el && el.focus(); } }}>
        ${[["overview", "ภาพรวมผู้บริหาร"], ["detail", "รายละเอียด"], ["mega", "วันเมกะเซล"], ["summary", "บทสรุปผู้บริหาร"]].map(([id, label]) => html`<button key=${id} id=${`tab-${id}`} className="tab" role="tab"
            aria-selected=${tab === id ? "true" : "false"} aria-controls=${`panel-${id}`} tabIndex=${tab === id ? 0 : -1}
            onClick=${() => setTab(id)}>${label}</button>`)}
      </div>

      ${tab === "overview" && html`<div className="bento" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
        <section className="glass card hero span-7" aria-label="ยอดขายสุทธิ">
          <div>
            <div className="label"><span className="badge"><${Icon} name="banknote" /></span>ยอดขายสุทธิ</div>
            <div className="value num" data-full=${fmtBaht2.format(s.net)} tabIndex="0" aria-label=${`ยอดขายสุทธิ ${fmtBaht2.format(s.net)}`}><${Counter} value=${s.net} fmt=${fmtMillion} /></div>
            ${(() => {
              const mm = s.monthly, last = mm[mm.length - 1], prev = mm[mm.length - 2];
              if (!last || !prev || !(prev.value > 0)) return html`<div className="mom">ยังไม่มีเดือนก่อนหน้าให้เทียบ</div>`;
              const mom = (last.value - prev.value) / prev.value;
              return html`<div className="mom">
                <span className=${mom >= 0 ? "up" : "down"}>${mom >= 0 ? "▲" : "▼"} ${fmtPct.format(Math.abs(mom))}</span>
                ${` เดือนล่าสุด (${monthLabel(last.key, true)}) เทียบเดือนก่อนหน้า (${monthLabel(prev.key, true)})`}
              </div>`;
            })()}
            <div className="note">จำนวน × ราคา × (1 − ส่วนลด%) เฉพาะสถานะ “จัดส่งสำเร็จ” ไม่รวมค่าจัดส่ง</div>
          </div>
          <${Sparkline} key=${fkey} data=${s.monthly} />
        </section>

        <section className="glass card span-5" aria-label="ข้อมูลที่อ่านได้">
          <h3>สถานะคำสั่งซื้อ</h3>
          <div className="sub">ทุกแถวในตัวกรองนี้</div>
          <div className="status">
            <${Donut} key=${fkey} statuses=${s.statuses} total=${statusTotal} />
            <div className="legend">
              ${s.statuses.map(([st, c]) => html`<div className="row" key=${st}>
                <span className="dot" style=${{ background: tone(st) }} aria-hidden="true"></span>${st}
                <span className="num">${fmtInt.format(c)}</span>
              </div>`)}
            </div>
          </div>
          <div className="rows-read">
            อ่านได้ <b className="num">${fmtInt.format(state.rows.length)}</b> แถว
            ${isFiltered && html`<span>, ตรงตัวกรอง <b className="num">${fmtInt.format(filtered.length)}</b> แถว</span>`}
          </div>
          ${(s.badNumbers > 0 || s.badDates > 0 || state.parseErrors > 0) && html`<div className="warn">
            ${s.badNumbers > 0 && html`<span>${fmtInt.format(s.badNumbers)} แถวที่จัดส่งสำเร็จมี qty หรือ unit_price ไม่ใช่ตัวเลข จึงไม่นับในยอดขาย. </span>`}
            ${s.badDates > 0 && html`<span>${fmtInt.format(s.badDates)} แถวอ่านวันที่ไม่ได้ จึงไม่อยู่ในกราฟรายเดือน (แต่นับในยอดรวม). </span>`}
            ${state.parseErrors > 0 && html`<span>พบรูปแบบ CSV ผิดปกติ ${fmtInt.format(state.parseErrors)} จุด</span>`}
          </div>`}
        </section>

        <div className="kpi-mini span-12">
          <${Kpi} label="คำสั่งซื้อสำเร็จ" value=${s.okCount} fmt=${fmtInt} icon="check" tone="var(--ok)"
            share=${s.allCount ? s.okCount / s.allCount : null}
            note=${state.hasId ? "นับ order_id ไม่ซ้ำที่สถานะ “จัดส่งสำเร็จ”" : "ไม่มีคอลัมน์ order_id จึงนับเป็นแถว"} />
          <${Kpi} label="มูลค่าเฉลี่ยต่อคำสั่งซื้อ (AOV)" value=${s.aov} fmt=${fmtBaht} icon="receipt" tone="var(--c1)"
            note="ยอดขายสุทธิ ÷ คำสั่งซื้อสำเร็จ" />
          <${Kpi} label="อัตรายกเลิก" value=${s.cancelRate} fmt=${fmtPct} icon="x" tone="var(--bad)" share=${s.cancelRate}
            note=${`ยกเลิก ${fmtInt.format(s.cancelCount)} จาก ${fmtInt.format(s.allCount)} คำสั่งซื้อทั้งหมด`} />
          <${Kpi} label="อัตราคืนสินค้า" value=${s.returnRate} fmt=${fmtPct} icon="undo" tone="var(--bad)" share=${s.returnRate}
            note=${`คืนสินค้า ${fmtInt.format(s.returnCount)} จาก ${fmtInt.format(s.allCount)} คำสั่งซื้อทั้งหมด`} />
        </div>

        <section className="glass card span-12">
          <h3>ยอดขายสุทธิรายเดือน</h3>
          <div className="sub">บาท ตามเดือนของ order_datetime · ชี้หรือกด Tab เพื่อดูค่า</div>
          ${s.monthly.length ? html`<${React.Fragment}>
            <${LineChart} key=${fkey} data=${s.monthly} />
            <${DataTable} head=${["เดือน", "ยอดขายสุทธิ"]}
              rows=${s.monthly.map((d) => [monthLabel(d.key, true), fmtBaht.format(d.value)])} />
          </${React.Fragment}>` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>

        <section className="glass card span-6 short">
          <h3>ยอดขายสุทธิรายภูมิภาค</h3>
          <div className="sub">ล้านบาท เรียงจากมากไปน้อย</div>
          ${s.regionSales.length ? html`<${React.Fragment}>
            <${RegionChart} key=${fkey} data=${s.regionSales} colorOf=${(rg) => (s.regionSales.length && rg === s.regionSales[0].key ? "var(--c1)" : "var(--c4)")} />
            <${DataTable} head=${["ภูมิภาค", "ยอดขายสุทธิ", "สัดส่วน"]}
              rows=${s.regionSales.map((d) => [d.key, fmtBaht.format(d.value), fmtPct.format(d.value / pvTotal)])} />
          </${React.Fragment}>` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>

        <section className="glass card span-6 short">
          <h3>5 จังหวัดยอดสูงสุด</h3>
          <div className="sub">บาท สีแท่งตามภูมิภาค เรียงจากมากไปน้อย</div>
          ${s.provinces.length ? html`<${React.Fragment}>
            <${ProvinceChart} key=${fkey} data=${s.provinces.slice(0, 5)} colorOf=${(rg, i) => (i === 0 ? "var(--c1)" : "var(--c4)")} />
            <${DataTable} head=${["จังหวัด", "ยอดขายสุทธิ", "สัดส่วน"]}
              rows=${s.provinces.slice(0, 5).map((d) => [d.key, fmtBaht.format(d.value), fmtPct.format(d.value / pvTotal)])} />
          </${React.Fragment}>` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>
      </div>`}

      ${tab === "detail" && html`<div className="bento" role="tabpanel" id="panel-detail" aria-labelledby="tab-detail">
        <section className="glass card span-4">
          <h3>ยอดขายตามช่องทาง</h3>
          <div className="sub">บาท เรียงจากมากไปน้อย</div>
          ${s.channels.length ? html`<${React.Fragment}>
            <${BarChart} key=${fkey} data=${s.channels} label="กราฟแท่งยอดขายสุทธิตามช่องทาง" />
            <${DataTable} head=${["ช่องทาง", "ยอดขายสุทธิ", "สัดส่วน"]}
              rows=${s.channels.map((d) => [d.key, fmtBaht.format(d.value), fmtPct.format(d.value / chTotal)])} />
          </${React.Fragment}>` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>

        <section className="glass card span-8 short">
          <h3>ยอดขายสุทธิตามบริษัทขนส่ง</h3>
          <div className="sub">บาท ตามคอลัมน์ carrier เฉพาะ “จัดส่งสำเร็จ” แยกสีตามหมวดสินค้า เรียงจากยอดรวมมากไปน้อย</div>
          ${s.carriers.length ? html`<${React.Fragment}>
            <div className="prov-legend" aria-label="คำอธิบายสีหมวดสินค้า">
              ${crCats.map((c) => html`<span key=${c}><i style=${{ background: catColor(c) }} aria-hidden="true"></i>${c}</span>`)}
            </div>
            <${StackedCarrierChart} key=${fkey} data=${s.carrierStack} colorOf=${catColor} rank=${catRank} />
            <${DataTable} head=${["บริษัทขนส่ง", "ยอดขายสุทธิ", "สัดส่วน"]}
              rows=${s.carriers.map((d) => [d.key, fmtBaht.format(d.value), fmtPct.format(d.value / crTotal)])} />
          </${React.Fragment}>` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>

        <section className="glass card span-12">
          <h3>ยอดขายสุทธิรายจังหวัด</h3>
          <div className="sub">${region === ALL ? "บาท ทุกจังหวัด สีแท่งตามภูมิภาค เรียงจากมากไปน้อย" : `บาท เฉพาะจังหวัดใน${region} เรียงจากมากไปน้อย`}</div>
          ${s.provinces.length ? html`<${React.Fragment}>
            ${region === ALL && html`<div className="prov-legend" aria-label="คำอธิบายสีภูมิภาค">
              ${pvRegions.map((rg) => html`<span key=${rg}><i style=${{ background: regionColor(rg) }} aria-hidden="true"></i>${rg}</span>`)}
            </div>`}
            <${ProvinceChart} key=${fkey} data=${s.provinces} colorOf=${region === ALL ? regionColor : (rg, i) => (i === 0 ? "var(--c1)" : "var(--c4)")} />
            <${DataTable} head=${["จังหวัด", "ยอดขายสุทธิ", "สัดส่วน"]}
              rows=${s.provinces.map((d) => [d.key, fmtBaht.format(d.value), fmtPct.format(d.value / pvTotal)])} />
          </${React.Fragment}>` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>
      </div>`}

      ${tab === "mega" && html`<div className="bento" role="tabpanel" id="panel-mega" aria-labelledby="tab-mega">
        <section className="glass card span-12">
          <h3>วันเมกะเซลเทียบกับวันปกติ</h3>
          <div className="sub">วันเมกะเซลคือ 3.3, 6.6, 9.9, 10.10, 11.11 และ 12.12 ตามวันที่ใน order_datetime ยอดขายสุทธินิยามเดิม เฉพาะ “จัดส่งสำเร็จ” ตามตัวกรองด้านบน</div>
          <div className="prod-ctl">
            <span>${products.status === "ready" ? `ต้นทุนจาก ${products.fileName} (${fmtInt.format(products.count)} สินค้า)` : products.status === "loading" ? `กำลังอ่าน ${products.fileName}` : "อัปโหลด products.csv เพื่อใช้ unit_cost คำนวณ % กำไรขั้นต้น"}</span>
            <button className=${products.status === "ready" ? "btn ghost" : "btn"} onClick=${pickProducts}><${Icon} name="upload" />${products.status === "ready" ? "เปลี่ยน products.csv" : "อัปโหลด products.csv"}</button>
          </div>
          ${products.status === "error" && html`<div className="warn" role="alert">${products.message}</div>`}
          ${products.status === "ready" && products.bad > 0 && html`<div className="mega-note">${`${fmtInt.format(products.bad)} แถวใน products.csv ไม่มี product_id หรือ unit_cost ไม่ใช่ตัวเลข จึงข้ามไป`}</div>`}
        </section>

        <section className="glass card span-4">
          <h3>สัดส่วนยอดขาย</h3>
          <div className="sub">ส่วนแบ่งของยอดขายสุทธิทั้งหมด</div>
          ${mega.total > 0 ? html`<${React.Fragment}>
            <${CompareBars} max=${1} rows=${[
              { label: "เมกะเซล", value: mega.mega.net / mega.total, text: fmtPct.format(mega.mega.net / mega.total), color: "var(--c1)" },
              { label: "วันปกติ", value: mega.normal.net / mega.total, text: fmtPct.format(mega.normal.net / mega.total), color: "var(--c4)" },
            ]} />
            <div className="mega-note">${`เมกะเซล ${fmtBaht.format(mega.mega.net)} จาก ${fmtInt.format(mega.mega.days)} วัน วันปกติ ${fmtBaht.format(mega.normal.net)} จาก ${fmtInt.format(mega.normal.days)} วัน (นับเฉพาะวันที่มียอดขาย)`}</div>
          </${React.Fragment}>` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>

        <section className="glass card span-4">
          <h3>ยอดขายเฉลี่ยต่อวัน</h3>
          <div className="sub">ยอดขายสุทธิ ÷ จำนวนวันที่มียอดขาย เพราะจำนวนวันสองกลุ่มต่างกันมาก</div>
          ${mega.total > 0 ? html`<${CompareBars} rows=${[
            { label: "เมกะเซล", value: mega.mega.perDay, text: mega.mega.perDay == null ? "—" : fmtBaht.format(mega.mega.perDay), color: "var(--c1)" },
            { label: "วันปกติ", value: mega.normal.perDay, text: mega.normal.perDay == null ? "—" : fmtBaht.format(mega.normal.perDay), color: "var(--c4)" },
          ]} />` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>

        <section className="glass card span-4">
          <h3>% กำไรขั้นต้น</h3>
          <div className="sub">(ยอดขายสุทธิ − qty × unit_cost) ÷ ยอดขายสุทธิ</div>
          ${!mega.hasCost ? html`<div className="empty">อัปโหลด products.csv ด้านบนเพื่อดู % กำไรขั้นต้น</div>`
            : mega.total > 0 ? html`<${React.Fragment}>
              <${CompareBars} max=${1} rows=${[
                { label: "เมกะเซล", value: mega.mega.gp, text: mega.mega.gp == null ? "—" : fmtPct.format(mega.mega.gp), color: "var(--c1)" },
                { label: "วันปกติ", value: mega.normal.gp, text: mega.normal.gp == null ? "—" : fmtPct.format(mega.normal.gp), color: "var(--c4)" },
              ]} />
              ${(mega.mega.unmatched + mega.normal.unmatched) > 0 && html`<div className="mega-note">${`${fmtInt.format(mega.mega.unmatched + mega.normal.unmatched)} แถวไม่พบ product_id ใน products.csv จึงไม่นับใน % กำไรขั้นต้น`}</div>`}
            </${React.Fragment}>` : html`<div className="empty">ไม่มียอดขายในตัวกรองนี้</div>`}
        </section>

        <section className="glass card span-12">
          <h3>แยกตามวันเมกะเซล</h3>
          <div className="sub">เรียงตามเวลา สัดส่วนเทียบกับยอดขายสุทธิทั้งหมดในตัวกรองนี้</div>
          ${mega.events.length ? html`<div className="chart"><table>
            <thead><tr><th>วัน</th><th className="r">ยอดขายสุทธิ</th><th className="r">สัดส่วน</th><th className="r">% กำไรขั้นต้น</th></tr></thead>
            <tbody>
              ${mega.events.map((e) => html`<tr key=${e.date}><td>${megaLabel(e.date)}</td><td className="r num">${fmtBaht.format(e.net)}</td>
                <td className="r num">${fmtPct.format(e.net / (mega.total || 1))}</td><td className="r num">${e.gp == null ? "—" : fmtPct.format(e.gp)}</td></tr>`)}
              <tr><td><b>รวมวันเมกะเซล</b></td><td className="r num"><b>${fmtBaht.format(mega.mega.net)}</b></td>
                <td className="r num"><b>${fmtPct.format(mega.mega.net / (mega.total || 1))}</b></td><td className="r num"><b>${mega.mega.gp == null ? "—" : fmtPct.format(mega.mega.gp)}</b></td></tr>
              <tr><td>วันปกติ</td><td className="r num">${fmtBaht.format(mega.normal.net)}</td>
                <td className="r num">${fmtPct.format(mega.normal.net / (mega.total || 1))}</td><td className="r num">${mega.normal.gp == null ? "—" : fmtPct.format(mega.normal.gp)}</td></tr>
            </tbody>
          </table></div>` : html`<div className="empty">ไม่มียอดขายในวันเมกะเซลตามตัวกรองนี้</div>`}
          ${mega.noDate > 0 && html`<div className="mega-note">${`${fmtInt.format(mega.noDate)} แถวอ่านวันที่ไม่ได้ จึงไม่อยู่ในการเทียบนี้`}</div>`}
        </section>
      </div>`}

      ${tab === "summary" && html`<div className="bento" role="tabpanel" id="panel-summary" aria-labelledby="tab-summary">
        <section className="glass card span-12 exec-sum" aria-label="บทสรุปผู้บริหาร">
          <div className="head">
            <div>
              <h3>บทสรุปผู้บริหาร</h3>
              <div className="sub">${`สร้างด้วยประโยคแม่แบบจากตัวเลขสรุป ${leafCount} ค่าตามตัวกรองปัจจุบัน (${rangeText.replace(/^ข้อมูล /, "")})`}</div>
            </div>
            <div className="sum-actions">
              <button className="btn" onClick=${runSummary}><${Icon} name="spark" />${sum.status === "done" ? "สร้างบทสรุปใหม่" : "สร้างบทสรุป"}</button>
              ${downloads !== null && html`<button className="btn ghost" onClick=${downloadHtml} disabled=${sum.status !== "done" || !downloads}
                title=${sum.status !== "done" ? "สร้างบทสรุปก่อน จึงจะดาวน์โหลดได้" : ""}><${Icon} name="upload" className="ico flip" />ดาวน์โหลดรายงานสำหรับทำ PDF</button>`}
            </div>
          </div>
          ${downloads !== null && html`<div className="print-hint">เปิดไฟล์ใน Chrome แล้วกด Ctrl+P → บันทึกเป็น PDF</div>`}
          ${sum.status === "idle" && html`<div className="sum-status">กด “สร้างบทสรุป” เพื่อสร้างบทสรุปตามตัวกรองที่เลือกอยู่</div>`}
          ${sum.status === "done" && html`<${React.Fragment}>
            ${sum.bad.length > 0
              ? html`<div className="warn" role="alert">${`พบตัวเลขที่ไม่อยู่ใน JSON ${sum.bad.length} ตัว: ${sum.bad.join(", ")} (ไฮไลต์สีแดงในรายงาน) ตรวจก่อนนำไปใช้`}</div>`
              : html`<div className="ok-note">ตรวจแล้ว ตัวเลขทุกตัวในบทสรุปมีอยู่ใน JSON</div>`}
            ${printMsg && html`<div className="warn" role="alert">${printMsg}</div>`}
            <div className="paper"><${Report} r=${sum.report} allowed=${sum.allowed} /></div>
            ${ReactDOM.createPortal(html`<${Report} r=${sum.report} allowed=${sum.allowed} />`, document.getElementById("print-root"))}
          </${React.Fragment}>`}
          <details>
            <summary>ดู JSON ที่ใช้สร้างบทสรุป</summary>
            <pre className="json">${JSON.stringify(payload, null, 2)}</pre>
          </details>
        </section>
      </div>`}
    </${React.Fragment}>`}
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
