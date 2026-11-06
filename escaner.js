// Escáner de zonas (estrategia de niveles 1/2/3): una vez por día (11:30 de Argentina) o a pedido mira las velas de 4 h de Bitunix (públicas, sin claves),
// marca soportes y resistencias, les suma confirmaciones (EMA 200/50, Fibonacci diario, Bollinger) y arma un plan de
// 3 entradas límite (15/30/55% del 10% de la cuenta) con stop al 1-2% de la cuenta. Avisa por Telegram al dueño; no opera.
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://fapi.bitunix.com';
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'HYPEUSDT', 'TAOUSDT'];
const H4 = 4 * 36e5;
const CFG = {
  pivotK: 3, // una vela es pivote si su cuerpo es el extremo entre las 3 de cada lado
  reactionBars: 12, // cuánto se mira hacia adelante para medir el rebote (12 velas de 4 h = 2 días)
  maxDist: 0.15, // zonas hasta 15% del precio
  coinPct: 0.10, // máximo por moneda: 10% de la cuenta (margen)
  split: { 3: [0.15, 0.30, 0.55], 2: [0.35, 0.65], 1: [1] },
  maxRisk: 0.02, // pérdida máxima si saltan las 3 entradas y el stop: 2% de la cuenta
  leverage: 10,
  nearPct: 0.015, // aviso de "se acerca a la entrada 1"
  alertRR: 1.5, // por Telegram solo avisa a favor de la tendencia y con R/B ≥ 1,5 (en el backtest, lo demás perdía)
};

// ---------- Indicadores ----------
function ema(v, n) {
  const out = new Array(v.length).fill(null), k = 2 / (n + 1);
  let e = null;
  for (let i = 0; i < v.length; i++) {
    if (i === n - 1) e = v.slice(0, n).reduce((a, x) => a + x, 0) / n;
    else if (i >= n) e = v[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
function bollinger(v, n = 20, m = 2) {
  const s = v.slice(-n), mid = s.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mid) ** 2, 0) / n);
  return { mid, up: mid + m * sd, low: mid - m * sd };
}
function rsi(v, n = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l ? 100 - 100 / (1 + g / l) : 100;
}
function macd(v) {
  const a = ema(v, 12), b = ema(v, 26), line = v.map((_, i) => (a[i] != null && b[i] != null ? a[i] - b[i] : null));
  const sig = ema(line.filter((x) => x != null), 9), hist = sig.map((s, i) => (s == null ? null : line[line.length - sig.length + i] - s));
  return { hist: hist.at(-1), prev: hist.at(-2) };
}
function atr(c, n = 14) {
  const tr = c.slice(1).map((x, i) => Math.max(x.h - x.l, Math.abs(x.h - c[i].c), Math.abs(x.l - c[i].c)));
  return tr.slice(-n).reduce((a, x) => a + x, 0) / n;
}

// ---------- Soportes y resistencias ----------
// Pivotes por cuerpo de vela (no por mecha): se agrupan los que caen a menos de tol y cada grupo es una zona.
function zonesOf(c, a) {
  const k = CFG.pivotK, piv = [];
  for (let i = k; i < c.length - k; i++) {
    const lo = Math.min(c[i].o, c[i].c), hi = Math.max(c[i].o, c[i].c);
    const around = c.slice(i - k, i + k + 1);
    const after = c.slice(i + 1, i + 1 + CFG.reactionBars);
    if (around.every((x) => Math.min(x.o, x.c) >= lo)) piv.push({ p: lo, wick: c[i].l, t: c[i].t, react: after.length ? Math.max(...after.map((x) => x.h)) / lo - 1 : 0 });
    if (around.every((x) => Math.max(x.o, x.c) <= hi)) piv.push({ p: hi, wick: c[i].h, t: c[i].t, react: after.length ? 1 - Math.min(...after.map((x) => x.l)) / hi : 0 });
  }
  piv.sort((x, y) => x.p - y.p);
  const tol = (p) => Math.max(0.35 * a, p * 0.0025), zones = [];
  for (const x of piv) {
    const z = zones.at(-1);
    if (z && x.p - z.price <= tol(z.price)) {
      z.list.push(x); z.price = z.list.reduce((s, y) => s + y.p, 0) / z.list.length;
    } else zones.push({ price: x.p, list: [x] });
  }
  return zones.map((z) => ({
    price: z.price, touches: z.list.length, react: Math.max(...z.list.map((x) => x.react)),
    low: Math.min(...z.list.map((x) => Math.min(x.wick, x.p))), high: Math.max(...z.list.map((x) => Math.max(x.wick, x.p))),
    last: Math.max(...z.list.map((x) => x.t)),
  })).filter((z) => z.touches >= 2 || z.react >= 0.06);
}

// Fibonacci del último impulso en diario: del mínimo al máximo (o al revés) de los últimos 120 días
function fibOf(d) {
  const s = d.slice(-120);
  let hi = 0, lo = 0;
  s.forEach((x, i) => { if (x.h > s[hi].h) hi = i; if (x.l < s[lo].l) lo = i; });
  const H = s[hi].h, L = s[lo].l, up = lo < hi;
  const at = (r) => (up ? H - r * (H - L) : L + r * (H - L));
  return { up, high: H, low: L, levels: [[0.5, at(0.5)], [0.618, at(0.618)], [0.66, at(0.66)], [0.786, at(0.786)]] };
}

// Confirmaciones de una zona y su nivel. side: 'long' (soporte) o 'short' (resistencia).
function scoreZone(z, side, ctx) {
  const near = (v) => v != null && Math.abs(v - z.price) <= Math.max(0.5 * ctx.atr, z.price * 0.006);
  const why = [];
  let s = 1;
  if (near(ctx.ema200)) { s += 1; why.push('EMA 200'); }
  if (near(ctx.ema50)) { s += 0.75; why.push('EMA 50'); }
  const fib = ctx.fib.levels.filter(([, p]) => near(p)).map(([r]) => r);
  if (fib.some((r) => r >= 0.66)) { s += 0.75; why.push(`Fibo ${fib.filter((r) => r >= 0.66).join(' / ')}`); }
  else if (fib.length) { s += 0.5; why.push(`Fibo ${fib.join(' / ')}`); }
  if (near(side === 'long' ? ctx.bb.low : ctx.bb.up)) { s += 0.25; why.push(`Bollinger ${side === 'long' ? 'inferior' : 'superior'}`); }
  if (z.touches >= 3) { s += 0.25; why.push(`${z.touches} toques`); }
  if (z.react >= 0.08) { s += 0.25; why.push(`rebote de ${Math.round(z.react * 100)}%`); }
  // En contra: cruce de EMAs y MACD a favor del movimiento que va hacia la zona
  const against = side === 'long' ? ctx.ema50 < ctx.ema200 && ctx.price < ctx.ema50 : ctx.ema50 > ctx.ema200 && ctx.price > ctx.ema50;
  if (against) { s -= 0.5; why.push('⚠ EMAs cruzadas en contra'); }
  if (ctx.macd.hist != null && (side === 'long' ? ctx.macd.hist < 0 && ctx.macd.hist < ctx.macd.prev : ctx.macd.hist > 0 && ctx.macd.hist > ctx.macd.prev)) { s -= 0.25; why.push('⚠ MACD con fuerza en contra'); }
  const hasEma = why.includes('EMA 200') || why.includes('EMA 50');
  const level = s >= 2.5 && hasEma ? 3 : s >= 2 ? 2 : s >= 1.5 ? 1.5 : 1; // 1.5 = "2 justito": no se entra
  return { ...z, score: Math.round(s * 100) / 100, level, why };
}

// Plan de entradas para un lado: hasta 3 zonas buenas (nivel 2 sólido o 3), stop detrás de la siguiente zona, TP en la zona opuesta
function planOf(side, zones, ctx, account) {
  const long = side === 'long', px = ctx.price;
  const inRange = (z) => (long ? z.price < px * 0.997 && z.price > px * (1 - CFG.maxDist) : z.price > px * 1.003 && z.price < px * (1 + CFG.maxDist));
  const scored = zones.filter(inRange).map((z) => scoreZone(z, side, ctx)).sort((a, b) => (long ? b.price - a.price : a.price - b.price));
  const good = scored.filter((z) => z.level >= 2).slice(0, 3);
  if (!good.length) return null;
  const w = CFG.split[good.length], last = good.at(-1);
  const beyond = scored.filter((z) => (long ? z.price < last.price : z.price > last.price))[0];
  const stop = beyond ? (long ? beyond.low - 0.3 * ctx.atr : beyond.high + 0.3 * ctx.atr) : (long ? last.price - 1.5 * ctx.atr : last.price + 1.5 * ctx.atr);
  const opp = zones.filter((z) => (long ? z.price > px * 1.003 : z.price < px * 0.997)).sort((a, b) => (long ? a.price - b.price : b.price - a.price))[0];
  const capital = account * CFG.coinPct, notional = capital * CFG.leverage;
  const entries = good.map((z, i) => ({ price: z.price, pct: w[i], margin: capital * w[i], qty: (notional * w[i]) / z.price, level: z.level, why: z.why }));
  const qty = entries.reduce((a, e) => a + e.qty, 0), avg = entries.reduce((a, e) => a + e.qty * e.price, 0) / qty;
  const loss = Math.abs(avg - stop) * qty, risk = account ? loss / account : null;
  const tp = opp ? opp.price : null;
  return {
    side, entries, avg, stop, tp, risk, leverage: CFG.leverage,
    maxLeverage: risk ? Math.max(1, Math.floor((CFG.leverage * CFG.maxRisk) / risk)) : null, // con este apalancamiento el stop queda en 2%
    rr: tp ? Math.abs(tp - avg) / Math.abs(avg - stop) : null,
  };
}

function analyze(symbol, c4, c1d, account) {
  const closes = c4.map((x) => x.c), price = closes.at(-1);
  const ctx = {
    price, atr: atr(c4), ema50: ema(closes, 50).at(-1), ema200: ema(closes, 200).at(-1), bb: bollinger(closes),
    rsi: rsi(closes), macd: macd(closes), fib: fibOf(c1d),
  };
  const zones = zonesOf(c4, ctx.atr), trend = ctx.ema50 > ctx.ema200 ? 'alcista' : 'bajista';
  const mark = (p) => {
    if (!p) return null;
    const withTrend = (p.side === 'long') === (trend === 'alcista');
    const skip = !withTrend ? 'contra la tendencia' : !(p.rr >= CFG.alertRR) ? `R/B menor a ${CFG.alertRR}` : null;
    return { ...p, withTrend, alert: !skip, skip };
  };
  return {
    symbol, price, time: c4.at(-1).t, rsi: ctx.rsi, ema50: ctx.ema50, ema200: ctx.ema200, trend, fib: ctx.fib,
    long: mark(planOf('long', zones, ctx, account)), short: mark(planOf('short', zones, ctx, account)),
  };
}

// ---------- Datos ----------
async function klines(symbol, interval, pages) {
  const out = [];
  let end = Date.now();
  for (let i = 0; i < pages; i++) {
    const r = await fetch(`${BASE_URL}/api/v1/futures/market/kline?symbol=${symbol}&interval=${interval}&limit=200&endTime=${end}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.code !== 0 || !Array.isArray(j.data)) throw new Error(`Bitunix velas ${symbol}: ${j.msg || r.status}`);
    out.push(...j.data);
    if (j.data.length < 200) break;
    end = Math.min(...j.data.map((x) => +x.time)) - 1;
  }
  const seen = new Set();
  return out.map((x) => ({ t: +x.time, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.baseVol }))
    .filter((x) => !seen.has(x.t) && seen.add(x.t)).sort((a, b) => a.t - b.t);
}

// ---------- Mensajes ----------
const fmt = (p) => (p == null ? '—' : p >= 1000 ? p.toLocaleString('es-AR', { maximumFractionDigits: 1 }) : p >= 10 ? p.toLocaleString('es-AR', { maximumFractionDigits: 2 }) : p.toLocaleString('es-AR', { maximumSignificantDigits: 5 }));
const pct = (v) => (v * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
const coin = (s) => s.replace(/USDT$/, '');
const keyOf = (r, p) => `${r.symbol}:${p.side}:${p.entries.map((e) => e.price.toPrecision(4)).join('/')}`;
function planText(r, p) {
  const lv = (l) => (l === 3 ? 'nivel 3' : 'nivel 2');
  return `<b>${coin(r.symbol)} ${p.side === 'long' ? 'LONG 🟢' : 'SHORT 🔴'}</b> · precio ${fmt(r.price)} · tendencia ${r.trend} · RSI ${Math.round(r.rsi)}
${p.entries.map((e, i) => `${i + 1}) ${fmt(e.price)} · ${Math.round(e.pct * 100)}% · ${lv(e.level)} (${e.why.join(', ')})`).join('\n')}
Promedio ${fmt(p.avg)} · stop ${fmt(p.stop)} · TP ${fmt(p.tp)}${p.rr ? ` · R/B ${p.rr.toFixed(1)}` : ''}
Riesgo si ${p.entries.length > 1 ? `entran las ${p.entries.length}` : 'entra'} y toca el stop: ${pct(p.risk)} de la cuenta a ${p.leverage}x${p.risk > CFG.maxRisk ? ` ⚠ más del 2%: usá hasta ${p.maxLeverage}x o salteala` : ''}`;
}

module.exports = function createEscaner({ DATA_DIR, readDb, sendToOwner, log = console.error }) {
  const file = path.join(DATA_DIR, 'escaner.json');
  let state = { results: [], sent: {}, near: {}, updated: null, error: null };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* primera vez */ }
  const persist = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(state)); fs.renameSync(file + '.tmp', file); };
  // La cuenta de referencia: lo que hay hoy en Bitunix (equity)
  const account = () => { try { return readDb('owner').futuresAccounts?.['futuros-bitunix']?.accounts?.reduce((a, x) => a + (+x.equityUSD || 0), 0) || 0; } catch { return 0; } };

  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      const acc = account(), results = [];
      for (const s of PAIRS) {
        try {
          const now = Date.now();
          const c4 = (await klines(s, '4h', 3)).filter((x) => x.t + H4 <= now); // solo velas cerradas
          const c1d = await klines(s, '1d', 1);
          const r = analyze(s, c4, c1d, acc);
          r.live = c4.length ? (await klines(s, '15m', 1)).at(-1)?.c ?? r.price : r.price; // precio de ahora para el aviso de cercanía
          results.push(r);
        } catch (e) { log('Escáner', s, e.message); }
      }
      const fresh = [], close = [], live = {};
      for (const r of results) for (const p of [r.long, r.short].filter((x) => x?.alert)) {
        const k = keyOf(r, p); live[k] = 1;
        if (!state.sent[k]) { fresh.push(planText(r, p)); state.sent[k] = Date.now(); }
        if (!state.near[k] && Math.abs(r.live / p.entries[0].price - 1) <= CFG.nearPct) {
          close.push(`⏰ <b>${coin(r.symbol)}</b> está a ${pct(Math.abs(r.live / p.entries[0].price - 1))} de la entrada 1 del ${p.side} (${fmt(p.entries[0].price)}). Esperá confirmación en 1 h / 15 min (pinbar o envolvente) antes de entrar.`);
          state.near[k] = Date.now();
        }
      }
      // Lo que ya no está vigente se olvida (si vuelve a aparecer, avisa de nuevo)
      for (const m of [state.sent, state.near]) for (const k of Object.keys(m)) if (!live[k]) delete m[k];
      const first = !state.updated; // la primera vez manda todo lo vigente
      state = { ...state, results, updated: new Date().toISOString(), error: null };
      persist();
      if (sendToOwner) {
        if (fresh.length) await sendToOwner(`🧭 <b>Escáner de zonas</b>: ${first ? 'setups vigentes' : fresh.length === 1 ? 'setup nuevo' : fresh.length + ' setups nuevos'}\n\n${fresh.join('\n\n')}\n\n<i>Órdenes límite sugeridas; no opera solo.</i>`).catch((e) => log('Escáner (Telegram):', e.message));
        for (const m of close) await sendToOwner(m).catch((e) => log('Escáner (Telegram):', e.message));
      }
    } catch (e) { state.error = e.message; log('Escáner:', e.message); }
    finally { running = false; }
  }
  // Una vez por día a las 11:30 de Argentina (UTC−3); si la app estaba apagada a esa hora, corre al prender.
  // A mano se puede correr cuando quieras desde la tarjeta (POST /api/escaner/run).
  const slot = (now) => { const d = new Date(now - 3 * 3600e3); d.setUTCHours(11, 30, 0, 0); const t = d.getTime() + 3 * 3600e3; return t > now ? t - 86400e3 : t; };
  if (!state.lastAuto && state.updated) state.lastAuto = Date.parse(state.updated); // no repetir lo que ya corrió hoy
  const tick = () => { const s = slot(Date.now()); if ((state.lastAuto || 0) < s) { state.lastAuto = Date.now(); run(); } };
  setTimeout(tick, 30_000);
  setInterval(tick, 60_000);
  return { status: () => ({ ...state, sent: undefined, near: undefined, pairs: PAIRS, cfg: CFG }), run };
};
module.exports._test = { ema, rsi, bollinger, zonesOf, fibOf, scoreZone, planOf, analyze, CFG };
