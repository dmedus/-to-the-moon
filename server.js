// Servidor local de "To the Moon". Sin dependencias: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');

// Cada línea del log (data/server.log) lleva fecha y hora
const stamp = () => new Date().toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...args) => orig(`[${stamp()}]`, ...args);
}

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const RATIOS_PATH = path.join(DATA_DIR, 'ratios.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const EMPTY_DB = {
  version: 1,
  portfolios: [],
  transactions: [],
  dividends: [],
  deposits: [],
  manualPrices: {},
  settings: { baseCurrency: 'USD' },
};

// Cada usuario tiene su carpeta: el dueño usa data/ (como siempre); cada amigo, data/users/<id>/.
const USERS_DIR = path.join(DATA_DIR, 'users');
const MEMBER_ID = /^[a-z0-9_-]{3,30}$/; // también es nombre de carpeta: sin puntos ni barras
function userDir(uid) {
  if (uid === 'owner') return DATA_DIR;
  if (!MEMBER_ID.test(uid)) throw new Error('usuario inválido');
  return path.join(USERS_DIR, uid);
}

function readDb(uid = 'owner') {
  const file = path.join(userDir(uid), 'db.json');
  if (!fs.existsSync(file)) return structuredClone(EMPTY_DB);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeDb(db, uid = 'owner') {
  const dir = userDir(uid), file = path.join(dir, 'db.json');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    // Backup diario: uno por día, se sobrescribe dentro del mismo día.
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.copyFileSync(file, path.join(backupDir, `db-${day}.json`));
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- Cotizaciones ----------
const cache = new Map(); // key -> { t, value }
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { t: Date.now(), value });
  return value;
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

async function stockQuote(ticker) {
  return cached('stk:' + ticker, 120_000, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const meta = j.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) throw new Error('sin precio');
    return {
      price: meta.regularMarketPrice,
      prevClose: meta.previousClose ?? meta.chartPreviousClose ?? null,
      currency: meta.currency,
    };
  });
}

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'BUSD', 'TUSD', 'USD']);

async function binanceTable() {
  return cached('binance', 60_000, async () => {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?type=MINI');
    if (!r.ok) throw new Error('Binance HTTP ' + r.status);
    const rows = await r.json();
    const map = {};
    for (const x of rows) map[x.symbol] = { price: +x.lastPrice, open: +x.openPrice };
    return map;
  });
}

async function cryptoQuote(sym) {
  if (STABLES.has(sym)) return { price: 1, prevClose: 1, currency: 'USD' };
  try {
    const t = (await binanceTable())[sym + 'USDT'];
    if (t) return { price: t.price, prevClose: t.open, currency: 'USD' };
  } catch { /* cae a Yahoo */ }
  const q = await stockQuote(sym + '-USD');
  return q;
}

async function ccl() {
  return cached('ccl', 300_000, async () => {
    const r = await fetch('https://dolarapi.com/v1/dolares/contadoconliqui');
    if (!r.ok) throw new Error('dolarapi HTTP ' + r.status);
    const j = await r.json();
    return { compra: j.compra, venta: j.venta, fecha: j.fechaActualizacion };
  });
}

// ---------- Bonos y ONs argentinos (data912) ----------
// Precio cada 100 de valor nominal. Los tickers con D al final cotizan en dólares MEP (AL30D, GD30D, MGCOD).
async function bondTable() {
  return cached('bonds', 120_000, async () => {
    const map = {};
    for (const list of ['arg_bonds', 'arg_corp', 'arg_notes']) {
      const r = await fetch('https://data912.com/live/' + list, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('data912 HTTP ' + r.status);
      for (const x of await r.json()) if (x.symbol && x.c > 0) map[x.symbol] = { c: +x.c, pct: +x.pct_change || 0 };
    }
    return map;
  });
}
// Se cargan en dólares: "AL30" o "MGCOO" (pesos) se buscan como AL30D / MGCOD
async function bondQuote(sym) {
  const t = await bondTable();
  const base = sym.replace(/[DCO]$/, '');
  const key = /[DC]$/.test(sym) && t[sym] ? sym : t[base + 'D'] ? base + 'D' : t[sym + 'D'] ? sym + 'D' : null;
  if (!key) {
    // Solo cotiza en pesos (ej. PMM29): se pasa a dólares con el CCL del día
    const peso = t[sym] || t[base];
    const fx = peso ? (await ccl().catch(() => null))?.venta : null;
    if (!peso || !fx) throw new Error('sin cotización en dólares');
    return { price: peso.c / fx, prevClose: peso.c / (1 + peso.pct / 100) / fx, currency: 'USD', symbol: (t[sym] ? sym : base) + ' (pesos ÷ CCL)', ars: peso.c, fromPesos: true };
  }
  const q = t[key];
  // ars: precio en pesos cada 100 VN (para comparar en el formulario cuando se compró en pesos)
  return { price: q.c, prevClose: q.c / (1 + q.pct / 100), currency: 'USD', symbol: key, ars: (t[base] || t[base + 'O'])?.c ?? null };
}
// Lista de tickers para sugerir al cargar: la versión en dólares (D) y, si no tiene, la de pesos. Sin las de cable (C).
async function bondList() {
  const t = await bondTable();
  return Object.keys(t).filter((s) => /D$/.test(s) || (!/C$/.test(s) && !t[s + 'D'] && !t[s.replace(/O$/, '') + 'D'])).sort();
}

async function quotes(stocks, cryptos, bonds = []) {
  const out = { stocks: {}, crypto: {}, bonds: {}, errors: {} };
  await Promise.all([
    ...stocks.map(async (t) => {
      try { out.stocks[t] = await stockQuote(t); } catch (e) { out.errors[t] = e.message; }
    }),
    ...cryptos.map(async (t) => {
      try { out.crypto[t] = await cryptoQuote(t); } catch (e) { out.errors[t] = e.message; }
    }),
    ...bonds.map(async (t) => {
      try { out.bonds[t] = await bondQuote(t); } catch (e) { out.errors[t] = e.message; }
    }),
  ]);
  return out;
}

// ---------- Cotizaciones y gráficos (solapa Cotizaciones) ----------
// Acciones y ETFs: Yahoo. Cripto: Binance (par contra USDT), y si no está, Yahoo <SÍMBOLO>-USD.
const RANGES = {
  '1d': { y: '5m', b: ['5m', 288], ttl: 60e3 }, '5d': { y: '30m', b: ['30m', 240], ttl: 120e3 },
  '1mo': { y: '1d', b: ['2h', 360], ttl: 600e3 }, '6mo': { y: '1d', b: ['1d', 183], ttl: 1800e3 },
  '1y': { y: '1d', b: ['1d', 365], ttl: 1800e3 }, '5y': { y: '1wk', b: ['1w', 260], ttl: 3600e3 },
};
const cryptoBase = (s) => String(s).toUpperCase().replace(/[-/]?(USDT|USDC|USD)$/, '');

async function yahooChart(sym, range) {
  const R = RANGES[range];
  return cached(`ych:${sym}:${range}`, R.ttl, async () => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${R.y}`, { headers: UA });
    if (!r.ok) throw new Error(r.status === 404 ? 'Símbolo no encontrado' : 'HTTP ' + r.status);
    const res = (await r.json()).chart?.result?.[0];
    if (!res?.meta?.regularMarketPrice) throw new Error('Símbolo no encontrado');
    const close = res.indicators?.quote?.[0]?.close ?? [];
    const points = (res.timestamp ?? []).map((t, i) => [t * 1000, close[i]]).filter((p) => p[1] != null);
    const m = res.meta;
    // En 1 día el cambio es contra el cierre anterior; en el resto, contra el primer punto del período
    const prev = range === '1d' ? m.previousClose ?? m.chartPreviousClose : points[0]?.[1] ?? m.chartPreviousClose;
    return { price: m.regularMarketPrice, prev, name: m.shortName || m.longName || sym, currency: m.currency, points };
  });
}

async function cryptoChart(sym, range) {
  const base = cryptoBase(sym), R = RANGES[range];
  return cached(`cch:${base}:${range}`, R.ttl, async () => {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${base}USDT&interval=${R.b[0]}&limit=${R.b[1]}`);
    if (r.ok) {
      const k = await r.json();
      if (Array.isArray(k) && k.length) {
        const points = k.map((x) => [x[0], +x[4]]);
        return { price: points.at(-1)[1], prev: +k[0][1], name: base, currency: 'USD', points };
      }
    }
    const y = await yahooChart(base + '-USD', range); // no está en Binance
    return { ...y, name: base };
  });
}

const chartOf = (kind, sym, range) => (kind === 'C' ? cryptoChart(sym, range) : yahooChart(String(sym).toUpperCase(), range));

// Velas japonesas: [fecha, apertura, máximo, mínimo, cierre] por vela, diarias (1d) o de 1 hora (1h).
// Se devuelve más historia de la que se ve: las medias móviles largas (EMA200) la necesitan.
// Diarias: ~2 años. De 1 hora: 1000 velas en cripto (~41 días) y 3 meses en acciones (solo horario de mercado).
const CANDLE_TF = { '1d': { b: ['1d', 730], y: ['2y', '1d'], ttl: 300e3 }, '1h': { b: ['1h', 1000], y: ['3mo', '60m'], ttl: 60e3 } };
async function candles(kind, sym, tf = '1d') {
  const T = CANDLE_TF[tf] || CANDLE_TF['1d'];
  if (kind === 'C') {
    const base = cryptoBase(sym);
    return cached(`cdl:C:${base}:${tf}`, T.ttl, async () => {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${base}USDT&interval=${T.b[0]}&limit=${T.b[1]}`);
      const k = r.ok ? await r.json() : null;
      if (Array.isArray(k) && k.length) return { name: base, price: +k.at(-1)[4], candles: k.map((x) => [x[0], +x[1], +x[2], +x[3], +x[4]]) };
      return { ...(await yahooCandles(base + '-USD', tf)), name: base }; // no está en Binance
    });
  }
  return yahooCandles(String(sym).toUpperCase(), tf);
}
async function yahooCandles(sym, tf = '1d') {
  const T = CANDLE_TF[tf] || CANDLE_TF['1d'];
  return cached(`cdl:S:${sym}:${tf}`, T.ttl, async () => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${T.y[0]}&interval=${T.y[1]}`, { headers: UA });
    if (!r.ok) throw new Error(r.status === 404 ? 'Símbolo no encontrado' : 'HTTP ' + r.status);
    const res = (await r.json()).chart?.result?.[0];
    const q = res?.indicators?.quote?.[0];
    if (!res?.meta?.regularMarketPrice || !q) throw new Error('Símbolo no encontrado');
    const c = (res.timestamp ?? []).map((t, i) => [t * 1000, q.open[i], q.high[i], q.low[i], q.close[i]]).filter((x) => x.slice(1).every((v) => v != null));
    return { name: res.meta.shortName || res.meta.longName || sym, price: res.meta.regularMarketPrice, candles: c };
  });
}

// Lista de seguimiento: precio, cambio del día y una mini línea del día por símbolo
async function watchlist(items) {
  const out = {};
  await Promise.all(items.map(async ([kind, sym]) => {
    const key = kind + ':' + sym;
    try {
      const c = await chartOf(kind, sym, '1d');
      const step = Math.max(1, Math.ceil(c.points.length / 60));
      out[key] = {
        price: c.price, prev: c.prev, chg: c.prev ? c.price - c.prev : null, chgPct: c.prev ? c.price / c.prev - 1 : null,
        name: c.name, spark: c.points.filter((_, i) => i % step === 0 || i === c.points.length - 1).map((p) => p[1]),
      };
    } catch (e) { out[key] = { error: e.message }; }
  }));
  return out;
}

// ---------- Dividendos (Yahoo) ----------
// Las fechas de Yahoo son fechas ex-dividendo. El próximo pago se estima con la frecuencia de los anteriores.
const DAY_MS = 864e5;
async function dividendInfo(ticker) {
  return cached('div:' + ticker, 6 * 3600e3, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3y&interval=1mo&events=div`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = (await r.json()).chart?.result?.[0];
    const divs = Object.values(res?.events?.dividends ?? {}).map((d) => ({ date: d.date * 1000, amount: d.amount })).sort((a, b) => a.date - b.date);
    const price = res?.meta?.regularMarketPrice ?? null;
    if (!divs.length) return { price, pays: false };

    const now = Date.now(), sum = (from, to) => divs.filter((d) => d.date >= from && d.date < to).reduce((a, d) => a + d.amount, 0);
    const ttm = sum(now - 365 * DAY_MS, now + DAY_MS), prev = sum(now - 730 * DAY_MS, now - 365 * DAY_MS);
    // Frecuencia: intervalo mediano entre los últimos pagos
    const gaps = divs.slice(-5).map((d, i, a) => (i ? (d.date - a[i - 1].date) / DAY_MS : null)).filter(Boolean).sort((a, b) => a - b);
    const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 365;
    const [freq, perYear] = gap < 45 ? ['Mensual', 12] : gap < 120 ? ['Trimestral', 4] : gap < 240 ? ['Semestral', 2] : ['Anual', 1];
    const last = divs.at(-1);
    // Monto estimado de los próximos: el último si los recientes son parejos o solo subieron (aumento de dividendo);
    // si bajan o saltan mucho (ej. PBR, extraordinarios), el promedio del último año
    const recent = divs.slice(-Math.min(perYear, 4)).map((d) => d.amount);
    const steady = recent.every((v, i) => i === 0 || v >= recent[i - 1] * 0.95) && Math.max(...recent) / Math.min(...recent) <= 1.5;
    const est = steady ? last.amount : ttm / perYear || last.amount;
    const stale = now - last.date > gap * 2 * DAY_MS; // dejó de pagar o se atrasó mucho
    const upcoming = [];
    if (!stale) for (let t = last.date + gap * DAY_MS; t < now + 365 * DAY_MS; t += gap * DAY_MS) if (t > now - 7 * DAY_MS) upcoming.push({ date: Math.round(t), amount: est });
    return {
      price, pays: ttm > 0, ttm, yield: price && ttm ? ttm / price : null, growth: prev ? ttm / prev - 1 : null,
      freq: steady ? freq : freq + ' (variable)', perYear, last, upcoming, stale,
    };
  });
}
async function dividends(tickers) {
  const out = {};
  await Promise.all(tickers.map(async (t) => { try { out[t] = await dividendInfo(t); } catch (e) { out[t] = { error: e.message }; } }));
  return out;
}

// ---------- Precio objetivo de analistas (Yahoo) ----------
// Este dato de Yahoo pide una cookie y un "crumb"; se consiguen una vez y se renuevan si vencen.
let yAuth = null;
async function yahooAuth(force) {
  if (yAuth && !force && Date.now() - yAuth.t < 6 * 3600e3) return yAuth;
  const r = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, cookie } });
  const crumb = await c.text();
  if (!c.ok || !crumb || crumb.length > 40) throw new Error('Yahoo no dio acceso');
  return (yAuth = { cookie, crumb, t: Date.now() });
}
async function analystTarget(ticker) {
  return cached('tgt:' + ticker, 12 * 3600e3, async () => {
    for (let i = 0; i < 2; i++) {
      const a = await yahooAuth(i > 0);
      const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=financialData,assetProfile,quoteType&crumb=${encodeURIComponent(a.crumb)}`, { headers: { ...UA, cookie: a.cookie } });
      if (r.status === 401 || r.status === 403) continue; // crumb vencido: se pide otro
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const q = (await r.json()).quoteSummary?.result?.[0] || {}, f = q.financialData || {};
      const v = (k) => f[k]?.raw ?? null;
      return { price: v('currentPrice'), mean: v('targetMeanPrice'), median: v('targetMedianPrice'), high: v('targetHighPrice'), low: v('targetLowPrice'), analysts: v('numberOfAnalystOpinions'), rec: f.recommendationKey && f.recommendationKey !== 'none' ? f.recommendationKey : null,
        sector: q.assetProfile?.sector || null, industry: q.assetProfile?.industry || null, kind: q.quoteType?.quoteType || null };
    }
    throw new Error('Yahoo no dio acceso');
  });
}
async function analystTargets(tickers) {
  const out = {};
  await Promise.all(tickers.map(async (t) => { try { out[t] = await analystTarget(t); } catch (e) { out[t] = { error: e.message }; } }));
  return out;
}

// ---------- Evolución del patrimonio ----------
// Una "foto" por día y por usuario en history.json: { days: { 'AAAA-MM-DD': { p: { idCartera: [valor, invertido] }, src } } }.
// src 'live' = valores que vio la app ese día; 'calc' = reconstruido con operaciones y precios de cierre (nunca pisa un 'live').
function readHistory(uid) {
  try { return JSON.parse(fs.readFileSync(path.join(userDir(uid), 'history.json'), 'utf8')); } catch { return { days: {} }; }
}
function writeHistory(uid, h) {
  const dir = userDir(uid), file = path.join(dir, 'history.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(h));
  fs.renameSync(file + '.tmp', file);
}
// Valida { idCartera: [valor, invertido, realizado acumulado] } con números finitos (el tercero es opcional)
function cleanSnapshot(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const [id, v] of Object.entries(p)) {
    if (!/^[\w-]{1,40}$/.test(id) || !Array.isArray(v) || v.length < 2 || v.length > 3 || !v.every((n) => Number.isFinite(+n))) return null;
    out[id] = v.map((n) => Math.round(+n * 100) / 100);
  }
  return out;
}
const isoDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

// ---------- Claves de exchanges (solo lectura) ----------
// Cada usuario carga sus claves desde Ajustes: quedan cifradas en su carpeta (keystore.js).
// El dueño además puede seguir usando los archivos data/pionex.env, data/bingx.env, data/bitget.env y data/binance.env.
const keystore = require('./keystore');
const bingx = require('./bingx');
const bitget = require('./bitget');
const binance = require('./binance');
const { pionexClosed } = require('./pionex');
const BOTS_PORTFOLIO_ID = 'bots-pionex';

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// Campos de cada exchange: [campo de la clave, variable del .env]
const EXCHANGES = {
  pionex: { env: 'pionex.env', fields: [['key', 'PIONEX_API_KEY'], ['secret', 'PIONEX_API_SECRET']] },
  bingx: { env: 'bingx.env', fields: [['key', 'BINGX_API_KEY'], ['secret', 'BINGX_SECRET_KEY']] },
  bitget: { env: 'bitget.env', fields: [['key', 'BITGET_API_KEY'], ['secret', 'BITGET_SECRET_KEY'], ['passphrase', 'BITGET_PASSPHRASE']] },
  binance: { env: 'binance.env', fields: [['key', 'BINANCE_API_KEY'], ['secret', 'BINANCE_SECRET_KEY']] },
};
function envKeys(ex) {
  const env = readEnv(path.join(DATA_DIR, EXCHANGES[ex].env));
  const keys = Object.fromEntries(EXCHANGES[ex].fields.map(([k, v]) => [k, env[v]]));
  return Object.values(keys).every((v) => v && !/pegá/.test(v)) ? keys : null;
}
// Devuelve { keys, source } o null. Lo cargado desde la app tiene prioridad sobre el .env.
function exchangeKeys(uid, ex) {
  const stored = keystore.get(userDir(uid), ex);
  if (stored) return { keys: stored, source: 'app' };
  const env = uid === 'owner' ? envKeys(ex) : null;
  return env ? { keys: env, source: 'env' } : null;
}

// ---------- BingX, Bitget y Binance ----------
async function syncBingx(uid, keys) {
  const snap = await bingx.fetchSnapshot(keys);
  writeDb(bingx.mergeSnapshot(readDb(uid), snap), uid);
  return { updated: snap.fetched };
}
async function syncBitget(uid, keys) {
  const snap = await bitget.fetchSnapshot(keys);
  writeDb(bingx.mergeSnapshot(readDb(uid), snap, bitget.PORTFOLIO_ID), uid);
  return { updated: snap.fetched };
}
// Binance: futuros y spot con la misma clave. Cada parte es opcional (hay quien tiene solo spot):
// falla la sincronización solo si fallan las dos. Una cartera se crea recién cuando hay algo para mostrar.
async function syncBinance(uid, keys) {
  const stateFile = path.join(userDir(uid), 'binance-spot.json'); // historial de Convert y fechas, no viaja al navegador
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* primera vez */ }
  const [fut, spot] = await Promise.allSettled([binance.fetchSnapshot(keys), binance.fetchSpot(keys, prev)]);
  if (fut.status === 'rejected' && spot.status === 'rejected') throw fut.reason;
  let db = readDb(uid);
  const has = (id) => db.portfolios.some((p) => p.id === id);
  if (fut.status === 'fulfilled') {
    const s = fut.value;
    if (has(binance.PORTFOLIO_ID) || s.open.length || s.closed.length || s.accounts.some((a) => Math.abs(a.equityUSD || 0) >= 1)) db = bingx.mergeSnapshot(db, s, binance.PORTFOLIO_ID);
  } else console.error(`[binance ${uid}] futuros:`, fut.reason.message);
  if (spot.status === 'fulfilled') {
    const s = spot.value;
    if (has(binance.SPOT_ID) || s.txs.length) {
      if (!has(binance.SPOT_ID)) {
        const used = new Set(db.portfolios.map((p) => p.slot));
        let slot = 1; while (used.has(slot) && slot < 8) slot++;
        db.portfolios.push({ id: binance.SPOT_ID, name: 'Cripto Binance', type: 'crypto', broker: 'Binance', slot });
      }
      // Las operaciones sincronizadas se reemplazan enteras; las cargadas a mano en esa cartera se conservan
      db.transactions = db.transactions.filter((t) => !(t.portfolioId === binance.SPOT_ID && t.externalId)).concat(s.txs);
    }
    fs.writeFileSync(stateFile, JSON.stringify(s.state));
  } else console.error(`[binance ${uid}] spot:`, spot.reason.message);
  writeDb(db, uid);
  return { updated: new Date().toISOString() };
}

async function pionexGet(keys, apiPath, query = {}) {
  const q = { ...query, timestamp: Date.now() };
  const qs = Object.keys(q).filter((k) => q[k] != null && q[k] !== '').sort().map((k) => `${k}=${encodeURIComponent(q[k])}`).join('&');
  const pathWithQuery = `${apiPath}?${qs}`;
  const signature = crypto.createHmac('sha256', keys.secret).update('GET' + pathWithQuery).digest('hex');
  const r = await fetch('https://api.pionex.com' + pathWithQuery, { headers: { 'PIONEX-KEY': keys.key, 'PIONEX-SIGNATURE': signature } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.result === false) throw new Error(`Pionex ${r.status}: ${j?.message || j?.code || 'error'}`);
  return j.data;
}

async function pionexBotOrders(keys, status) {
  const out = [];
  let pageToken;
  do {
    const d = await pionexGet(keys, '/api/v1/bot/orders', { status, pageToken });
    out.push(...(d.results ?? []));
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}

const TREND = { long: 'long', short: 'short', no_trend: 'neutral' };
const COPY = { copy_trade: 'copy trading', ai: 'AI' };
const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const day = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : null);

async function syncPionex(uid, keys) {
  const [running, finished, wallet] = await Promise.all([
    pionexBotOrders(keys, 'running'),
    pionexBotOrders(keys, 'finished'),
    pionexGet(keys, '/api/v1/wallet/balancesFull'),
  ]);
  // Inversión y ganancia oficiales (las que muestra la app de Pionex) de los bots activos
  const official = {};
  for (const d of wallet.botAccount?.detail ?? []) for (const x of d.list ?? []) if (x.buOrderId) official[x.buOrderId] = x;

  const db = readDb(uid);
  db.bots ||= [];
  if (!db.portfolios.some((p) => p.id === BOTS_PORTFOLIO_ID)) {
    const used = new Set(db.portfolios.map((p) => p.slot));
    let slot = 1; while (used.has(slot) && slot < 8) slot++;
    db.portfolios.push({ id: BOTS_PORTFOLIO_ID, name: 'Bots Pionex', type: 'bots', broker: 'Pionex', slot });
  }
  const now = new Date().toISOString();
  const byExt = new Map(db.bots.filter((b) => b.portfolioId === BOTS_PORTFOLIO_ID).map((b) => [b.externalId, b]));
  const upsert = (b, isRunning) => {
    const o = b.buOrderData ?? {};
    let invested, profit;
    if (isRunning) {
      // Valor actual según Pionex = su "inversión" + su "ganancia". Pero su inversión incluye ganancias
      // reinvertidas (profitExited) y, en bots con bono, capital de Pionex. Acá medimos contra tu plata real.
      const w = official[b.buOrderId];
      const value = (n(w?.investmentAmount) ?? n(o.usdtInvestment) ?? 0) + (n(w?.profit) ?? 0);
      if (o.investmentFrom === 'FUTURE_GRID_BONUS') {
        invested = 0;
        profit = value - (n(o.usdtInvestment) ?? 0); // el capital del bono vuelve a Pionex
      } else {
        const marginAdded = (n(o.extraMargin) ?? 0) - (n(o.initExtraMargin) ?? 0);
        let manual = 0;
        if (o.initQuoteInvestment != null && o.quoteInvestment != null) {
          manual = n(o.quoteInvestment) - n(o.initQuoteInvestment) - (n(o.profitExited) || 0);
          if (manual <= 0.01) manual = 0;
        }
        invested = (n(o.usdtInvestment) ?? 0) + marginAdded + manual;
        profit = value - invested;
      }
    } else {
      const c = pionexClosed(o, b.buOrderType);
      if (!c) return; // sin datos de cierre: se ignora
      ({ invested, profit } = c);
    }
    const rec = byExt.get(b.buOrderId) || { id: crypto.randomUUID().slice(0, 10), portfolioId: BOTS_PORTFOLIO_ID, note: '' };
    Object.assign(rec, {
      externalId: b.buOrderId, exchange: 'Pionex',
      pair: `${String(b.base).replace(/\.PERP$/, '')}/${b.quote}`,
      kind: b.buOrderType === 'spot_grid' ? 'spot_grid' : b.buOrderType === 'futures_grid' ? 'futures_grid' : 'other',
      trend: TREND[o.trend] || null, leverage: n(o.leverage) || 1,
      range: o.bottom != null ? [n(o.bottom), n(o.top)] : null, grids: n(o.row),
      start: day(b.createTime), end: isRunning ? null : day(b.closeTime),
      status: isRunning ? 'running' : 'finished',
      invested, profit,
      gridProfit: n(o.gridProfit), gridProfit24h: isRunning ? n(o.gridProfit24h) : null,
      entryPrice: n(o.positionOpenPrice), liqDown: n(o.estimateLiquidationPriceDown) || null, liqUp: n(o.estimateLiquidationPriceUp) || null,
      copy: o.investmentFrom === 'FUTURE_GRID_BONUS' ? 'bono de Pionex' : COPY[b.copyType] || b.copyType || null,
      updated: now,
    });
    if (!byExt.has(b.buOrderId)) { db.bots.push(rec); byExt.set(b.buOrderId, rec); }
  };
  finished.forEach((b) => upsert(b, false));
  running.forEach((b) => upsert(b, true));
  writeDb(db, uid);
  return { updated: now };
}

// ---------- Sincronización automática (servidor) ----------
// El servidor sincroniza los exchanges de todos los usuarios solo, así los datos están al día aunque nadie tenga la app abierta.
const SYNCS = { pionex: syncPionex, bingx: syncBingx, bitget: syncBitget, binance: syncBinance };
const syncStates = new Map(); // uid -> { pionex: { error, updated, last }, ... }
function syncStateFor(uid) {
  if (!syncStates.has(uid)) syncStates.set(uid, Object.fromEntries(Object.keys(SYNCS).map((ex) => [ex, { error: null, updated: null, last: 0 }])));
  return syncStates.get(uid);
}
// Corre la sincronización de un exchange para un usuario. Como mucho una vez por minuto, salvo que se pida a mano.
async function runSync(uid, ex, { force = false } = {}) {
  const k = exchangeKeys(uid, ex);
  if (!k) return { configured: false };
  const st = syncStateFor(uid)[ex];
  if (!force && Date.now() - st.last < 60_000) return { configured: true, skipped: true };
  st.last = Date.now();
  try {
    const r = await SYNCS[ex](uid, k.keys);
    Object.assign(st, { error: null, updated: r.updated });
    return { configured: true, updated: r.updated };
  } catch (e) {
    Object.assign(st, { error: e.message, last: 0 });
    throw e;
  }
}
function activeUids() {
  const a = auth.load();
  return ['owner', ...Object.entries(a.members || {}).filter(([, m]) => m.active).map(([id]) => id)];
}
async function runSyncs() {
  for (const uid of activeUids()) for (const ex of Object.keys(SYNCS)) await runSync(uid, ex).catch(() => {});
}
setTimeout(runSyncs, 3000);
setInterval(runSyncs, 3 * 60 * 1000);

// ---------- Alertas por Telegram (alerts.js) ----------
const alerts = require('./alerts')({
  DATA_DIR, userDir, readDb, activeUids, keystore, dividendInfo,
  quotes: { stockQuote, cryptoQuote, bondQuote },
});

// ---------- Copia de seguridad diaria (backup.js): OneDrive + Telegram del dueño ----------
const backup = require('./backup')({ DATA_DIR, keystore, sendTelegramFile: (name, buf, caption) => alerts.sendFileToOwner(name, buf, caption) });

// Al guardar desde la app, los registros que vienen de un exchange (con externalId) se toman del disco:
// así un guardado del navegador nunca pisa una sincronización más nueva.
function mergeFromClient(client, uid) {
  const cur = readDb(uid);
  const synced = (arr) => (arr || []).filter((x) => x.externalId);
  const manual = (arr) => (arr || []).filter((x) => !x.externalId);
  return {
    ...client,
    transactions: [...synced(cur.transactions), ...manual(client.transactions)],
    bots: [...synced(cur.bots), ...manual(client.bots)],
    futures: [...synced(cur.futures), ...manual(client.futures)],
    futuresAccounts: cur.futuresAccounts || {},
  };
}

// ---------- Vista del invitado ----------
// El invitado recibe todos los montos multiplicados por un factor secreto de su sesión:
// porcentajes, distribución y rendimientos son los reales; los montos no significan nada.
function guestView(db, k) {
  const mul = (o, keys) => { for (const key of keys) if (o[key] != null && o[key] !== '') o[key] = Number(o[key]) * k; };
  const d = structuredClone(db);
  for (const t of d.transactions || []) { mul(t, ['qty', 'fee']); t.note = ''; }
  for (const x of d.dividends || []) { mul(x, ['amount']); x.note = ''; }
  for (const x of d.deposits || []) { mul(x, ['amount']); x.note = ''; }
  for (const b of d.bots || []) { mul(b, ['invested', 'profit', 'gridProfit', 'gridProfit24h']); b.note = ''; }
  for (const f of d.futures || []) { mul(f, ['qty', 'notional', 'margin', 'pnl', 'pnlBase', 'fees', 'funding', 'feesPaid', 'fundingTotal', 'fundingLast']); f.note = ''; }
  for (const acc of Object.values(d.futuresAccounts || {})) for (const a of acc.accounts || []) mul(a, ['equity', 'balance', 'unrealized', 'equityUSD']);
  d.manualPrices = {};
  return d;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

// Imágenes de reglas/estrategia: todo lo que esté en public/reglas aparece en la app.
const REGLAS_DIR = path.join(PUBLIC_DIR, 'reglas');
function listReglas() {
  if (!fs.existsSync(REGLAS_DIR)) return [];
  return fs.readdirSync(REGLAS_DIR)
    .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
    .sort()
    .map((f) => ({
      src: 'reglas/' + encodeURIComponent(f),
      // Título a partir del nombre: "01-reglas-michael-saylor-2026.jpeg" -> "Reglas michael saylor 2026"
      // (el número inicial solo sirve para ordenar)
      title: f.replace(/\.[^.]+$/, '').replace(/^\d+[-_ ]+/, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
    }));
}
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function jsonBody(req) {
  try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; }
}

const list = (s) => (s ? s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : []);

// Páginas y archivos que se pueden ver sin iniciar sesión
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/setup.html', '/setup.js', '/styles.css', '/icon.svg',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png', '/apple-touch-icon.png', '/manifest.webmanifest', '/sw.js']);

// ---------- Rutas de autenticación ----------
async function handleAuth(req, res, url, session) {
  const a = auth.load();
  const p = url.pathname;

  if (p === '/api/auth/state') {
    const me = session?.role === 'member' ? a.members?.[session.uid] : session?.role === 'owner' ? a.owner : null;
    return send(res, 200, {
      ready: !!a.owner?.active, role: session?.role || null, user: me?.username || null, local: auth.isLocal(req),
      // totp: en el login indica si el dueño usa código; para un amigo logueado, que él no lo usa.
      guestEnabled: !!a.guest?.enabled, totp: session?.role !== 'member' && !!a.owner?.totpEnabled,
    });
  }

  // Configuración inicial: solo desde la propia PC y solo si todavía no hay dueño.
  if (p === '/api/auth/setup' && req.method === 'POST') {
    if (a.owner?.active) return send(res, 403, { error: 'La app ya está configurada.' });
    if (!auth.isLocal(req)) return send(res, 403, { error: 'La configuración inicial solo se puede hacer desde la PC donde corre la app (http://localhost:3000).' });
    const { username, password, totp } = await jsonBody(req);
    if (!/^[\w.@-]{3,40}$/.test(username || '') || username.toLowerCase() === auth.GUEST_USER) return send(res, 400, { error: 'Usuario inválido (3 a 40 letras, números o . _ @ -).' });
    const prob = auth.passwordProblem(password);
    if (prob) return send(res, 400, { error: prob });
    const secret = totp ? auth.base32(require('crypto').randomBytes(20)) : null;
    a.owner = { username, password: auth.hashPassword(password), active: !totp, totpEnabled: false, pendingTotp: secret, lastCounter: -1 };
    a.guest ||= { enabled: false };
    auth.save(a);
    if (!totp) {
      const token = auth.newSession('owner');
      return send(res, 200, { ok: true, done: true }, 'application/json', { 'Set-Cookie': auth.sessionCookie(req, token, auth.LIMITS.owner.maxMs / 1000) });
    }
    const uri = `otpauth://totp/${encodeURIComponent('To the Moon:' + username)}?secret=${secret}&issuer=${encodeURIComponent('To the Moon')}`;
    return send(res, 200, { ok: true, secret, uri });
  }
  if (p === '/api/auth/setup/confirm' && req.method === 'POST') {
    if (a.owner?.active || !a.owner?.pendingTotp) return send(res, 403, { error: 'Nada para confirmar.' });
    if (!auth.isLocal(req)) return send(res, 403, { error: 'Solo desde la PC donde corre la app.' });
    const { code } = await jsonBody(req);
    const c = auth.verifyTotp(a.owner.pendingTotp, code);
    if (c == null) return send(res, 400, { error: 'Código incorrecto. Revisá que la hora del celular esté bien y probá con el próximo código.' });
    a.owner.totpSecret = a.owner.pendingTotp; delete a.owner.pendingTotp;
    a.owner.totpEnabled = true; a.owner.active = true; a.owner.lastCounter = c;
    auth.save(a);
    const token = auth.newSession('owner');
    return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': auth.sessionCookie(req, token, auth.LIMITS.owner.maxMs / 1000) });
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const key = auth.clientKey(req);
    const mins = auth.lockedFor(key);
    if (mins) return send(res, 429, { error: `Demasiados intentos. Probá de nuevo en ${mins} min.` });
    const { username, password, code } = await jsonBody(req);
    const u = String(username || '').trim();
    // Mismo mensaje para cualquier error: no revela si falló el usuario, la contraseña o el código.
    let role = null, uid = 'owner';
    const member = a.members?.[u.toLowerCase()];
    if (member?.active && auth.checkPassword(password, member.password)) {
      role = 'member'; uid = u.toLowerCase();
    } else if (a.owner?.active && u.toLowerCase() === a.owner.username.toLowerCase() && auth.checkPassword(password, a.owner.password)) {
      if (!a.owner.totpEnabled) role = 'owner';
      else {
        const c = auth.verifyTotp(a.owner.totpSecret, code, a.owner.lastCounter);
        if (c != null) { a.owner.lastCounter = c; auth.save(a); role = 'owner'; }
      }
    } else if (a.guest?.enabled && u.toLowerCase() === auth.GUEST_USER && auth.checkPassword(password, a.guest.password)) {
      role = 'guest';
    }
    if (!role) { auth.registerFail(key); return send(res, 401, { error: 'Datos incorrectos. Revisá usuario, contraseña y código.' }); }
    auth.fails.delete(key);
    const token = auth.newSession(role, uid);
    return send(res, 200, { ok: true, role }, 'application/json', { 'Set-Cookie': auth.sessionCookie(req, token, auth.LIMITS[role].maxMs / 1000) });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    if (session) auth.dropSessions((s) => s.created === session.created && s.role === session.role && s.uid === session.uid);
    return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': auth.clearCookie(req) });
  }

  // --- Tu propia cuenta (dueño o amigo) ---
  if (session?.role !== 'owner' && session?.role !== 'member') return send(res, 403, { error: 'No autorizado.' });
  const body = req.method === 'POST' ? await jsonBody(req) : {};
  const account = session.role === 'owner' ? a.owner : a.members[session.uid];
  const mine = (s) => s.uid === session.uid && s.role === session.role;
  const confirmAccount = () => {
    if (!auth.checkPassword(body.current, account.password)) return 'La contraseña actual no es correcta.';
    if (account.totpEnabled) {
      const c = auth.verifyTotp(account.totpSecret, body.code, account.lastCounter);
      if (c == null) return 'Código de 6 dígitos incorrecto.';
      account.lastCounter = c;
    }
    return null;
  };
  if (p === '/api/auth/password' && req.method === 'POST') {
    const err = confirmAccount(); if (err) return send(res, 400, { error: err });
    const prob = auth.passwordProblem(body.password); if (prob) return send(res, 400, { error: prob });
    account.password = auth.hashPassword(body.password);
    auth.save(a);
    auth.dropSessions((s) => mine(s) && s.created !== session.created); // cierra tus otras sesiones
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/logout-all' && req.method === 'POST') {
    auth.dropSessions((s) => mine(s) && s.created !== session.created);
    return send(res, 200, { ok: true });
  }

  // --- Solo el dueño (administrador) ---
  if (session.role !== 'owner') return send(res, 403, { error: 'No autorizado.' });
  if (p === '/api/auth/members' && req.method === 'GET') {
    return send(res, 200, Object.entries(a.members || {}).map(([id, m]) => ({ id, username: m.username, active: !!m.active, created: m.created })));
  }
  if (p === '/api/auth/members' && req.method === 'POST') {
    const username = String(body.username || '').trim(), id = username.toLowerCase();
    if (!MEMBER_ID.test(id)) return send(res, 400, { error: 'Usuario inválido: de 3 a 30 letras, números, - o _ (sin espacios ni puntos).' });
    if (id === a.owner.username.toLowerCase() || id === auth.GUEST_USER || a.members?.[id]) return send(res, 400, { error: 'Ese usuario ya existe.' });
    const prob = auth.passwordProblem(body.password); if (prob) return send(res, 400, { error: prob });
    a.members ||= {};
    a.members[id] = { username, password: auth.hashPassword(body.password), active: true, created: new Date().toISOString() };
    auth.save(a);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/members/update' && req.method === 'POST') {
    const m = a.members?.[body.id];
    if (!m) return send(res, 404, { error: 'No existe ese usuario.' });
    if (body.password) {
      const prob = auth.passwordProblem(body.password); if (prob) return send(res, 400, { error: prob });
      m.password = auth.hashPassword(body.password);
      auth.dropSessions((s) => s.role === 'member' && s.uid === body.id);
    }
    if (typeof body.active === 'boolean') {
      m.active = body.active;
      if (!m.active) auth.dropSessions((s) => s.role === 'member' && s.uid === body.id);
    }
    auth.save(a);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/members/delete' && req.method === 'POST') {
    if (!a.members?.[body.id]) return send(res, 404, { error: 'No existe ese usuario.' });
    // Se borra la cuenta y sus claves de exchanges. Sus carteras quedan en data/users/<id> por si se arrepiente.
    for (const ex of Object.keys(EXCHANGES)) keystore.remove(userDir(body.id), ex);
    delete a.members[body.id];
    auth.save(a);
    auth.dropSessions((s) => s.role === 'member' && s.uid === body.id);
    syncStates.delete(body.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/guest' && req.method === 'POST') {
    if (body.enabled && body.password) {
      const prob = auth.passwordProblem(body.password); if (prob) return send(res, 400, { error: prob });
      a.guest = { enabled: true, password: auth.hashPassword(body.password) };
    } else if (body.enabled) {
      if (!a.guest?.password) return send(res, 400, { error: 'Poné una contraseña para el invitado.' });
      a.guest.enabled = true;
    } else {
      a.guest = { ...(a.guest || {}), enabled: false };
      auth.dropSessions((s) => s.role === 'guest');
    }
    auth.save(a);
    return send(res, 200, { ok: true, enabled: a.guest.enabled });
  }
  return send(res, 404, { error: 'No encontrado' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const session = auth.getSession(req);
    const p = url.pathname;

    // Las peticiones que modifican datos tienen que venir de la propia app (protección CSRF extra).
    if (req.method !== 'GET' && req.headers.origin) {
      let originHost = null;
      try { originHost = new URL(req.headers.origin).host; } catch {}
      if (originHost !== String(req.headers.host || '')) return send(res, 403, { error: 'Origen no permitido.' });
    }

    if (p.startsWith('/api/auth/')) return await handleAuth(req, res, url, session);

    // --- Archivos públicos (login, estilos, íconos) ---
    if (PUBLIC_FILES.has(p)) return serveFile(res, p.slice(1));

    // --- Todo lo demás requiere sesión ---
    const ready = !!auth.load().owner?.active;
    if (!session) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'Sesión vencida. Volvé a iniciar sesión.' });
      return redirect(res, ready ? '/login.html' : '/setup.html');
    }
    // El dueño y cada amigo editan solo lo suyo; el invitado ve los datos del dueño, sin poder cambiar nada.
    const canEdit = session.role === 'owner' || session.role === 'member';
    const uid = session.uid || 'owner';

    if (p === '/api/db' && req.method === 'GET') {
      const db = readDb(uid);
      return send(res, 200, canEdit ? db : guestView(db, session.scale));
    }
    if (p === '/api/db' && req.method === 'PUT') {
      if (!canEdit) return send(res, 403, { error: 'El invitado no puede modificar datos.' });
      const db = JSON.parse(await readBody(req));
      if (!Array.isArray(db.portfolios) || !Array.isArray(db.transactions)) return send(res, 400, { error: 'formato inválido' });
      writeDb(mergeFromClient(db, uid), uid);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me') return send(res, 200, { role: session.role });
    if (p === '/api/reglas') return send(res, 200, listReglas());
    if (p === '/api/ratios') return send(res, 200, JSON.parse(fs.readFileSync(RATIOS_PATH, 'utf8')));
    if (p === '/api/ccl') return send(res, 200, await ccl());
    if (p === '/api/bonds/list') return send(res, 200, await bondList());
    if (p === '/api/quotes') return send(res, 200, await quotes(list(url.searchParams.get('stocks')), list(url.searchParams.get('crypto')), list(url.searchParams.get('bonds'))));
    if (p === '/api/dividends') return send(res, 200, await dividends(list(url.searchParams.get('tickers')).slice(0, 60)));
    if (p === '/api/targets') return send(res, 200, await analystTargets(list(url.searchParams.get('tickers')).slice(0, 60)));
    if (p === '/api/watch') {
      // ?s=S:GOOGL,C:BTC  (S = acción/ETF, C = cripto)
      const items = list(url.searchParams.get('s')).map((x) => x.split(':')).filter(([k, s]) => (k === 'S' || k === 'C') && /^[A-Z0-9.^=-]{1,15}$/.test(s || ''));
      return send(res, 200, await watchlist(items.slice(0, 60)));
    }
    if (p === '/api/chart') {
      const kind = url.searchParams.get('kind') === 'C' ? 'C' : 'S', sym = String(url.searchParams.get('sym') || '').toUpperCase();
      if (!/^[A-Z0-9.^=-]{1,15}$/.test(sym)) return send(res, 400, { error: 'Símbolo inválido' });
      const r = url.searchParams.get('range');
      try {
        if (url.searchParams.get('type') === 'candles') return send(res, 200, await candles(kind, sym, url.searchParams.get('tf') === '1h' ? '1h' : '1d'));
        return send(res, 200, await chartOf(kind, sym, RANGES[r] ? r : '1d'));
      }
      catch (e) { return send(res, 502, { error: e.message }); }
    }

    if (p === '/api/history' && req.method === 'GET') {
      const h = readHistory(uid);
      if (canEdit) return send(res, 200, h);
      // Invitado: misma escala secreta que el resto de sus montos (los % y la forma del gráfico son reales)
      const k = session.scale;
      for (const d of Object.values(h.days)) for (const v of Object.values(d.p)) for (let i = 0; i < v.length; i++) v[i] *= k;
      return send(res, 200, h);
    }
    if (p === '/api/history' && req.method === 'POST') {
      if (!canEdit) return send(res, 403, { error: 'No autorizado.' });
      const body = await jsonBody(req);
      const h = readHistory(uid);
      if (body.mode === 'backfill') {
        // Días reconstruidos: solo se agregan donde no hay una foto real
        let n = 0;
        for (const [d, p] of Object.entries(body.days || {}).slice(0, 1200)) {
          const snap = cleanSnapshot(p);
          if (!isoDay(d) || !snap || h.days[d]?.src === 'live') continue;
          h.days[d] = { p: snap, src: 'calc' }; n++;
        }
        h.backfilled = new Date().toISOString();
        writeHistory(uid, h);
        return send(res, 200, { ok: true, added: n });
      }
      // Foto del día: la fecha la pone el cliente (hora local) pero tiene que estar cerca de hoy
      const snap = cleanSnapshot(body.p);
      if (!isoDay(body.date) || Math.abs(Date.parse(body.date) - Date.now()) > 2 * 864e5 || !snap) return send(res, 400, { error: 'Foto inválida' });
      h.days[body.date] = { p: snap, src: 'live' };
      writeHistory(uid, h);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/sync/status') {
      const st = syncStateFor(uid);
      return send(res, 200, Object.fromEntries(Object.keys(SYNCS).map((ex) => {
        const k = exchangeKeys(uid, ex);
        return [ex, { configured: !!k, source: canEdit ? k?.source ?? null : null, error: st[ex].error, updated: st[ex].updated }];
      })));
    }
    if (!canEdit && p.startsWith('/api/')) return send(res, 403, { error: 'No autorizado.' });

    // Copia de seguridad: solo el dueño (incluye los datos de todos los usuarios)
    if (p.startsWith('/api/backup')) {
      if (session.role !== 'owner') return send(res, 403, { error: 'Solo el administrador maneja las copias de seguridad.' });
      try {
        if (p === '/api/backup' && req.method === 'GET') return send(res, 200, { ...backup.status(), telegramReady: alerts.ownerLinked() });
        if (req.method !== 'POST') return send(res, 404, { error: 'No encontrado' });
        const body = await jsonBody(req);
        if (p === '/api/backup/password') { backup.setPassword(body.password); return send(res, 200, { ok: true }); }
        if (p === '/api/backup/run') return send(res, 200, { ok: true, last: await backup.run({ manual: true }) });
        if (p === '/api/backup/options') { backup.setOptions(body); return send(res, 200, { ok: true }); }
        return send(res, 404, { error: 'No encontrado' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // Alertas por Telegram: cada usuario conecta su chat y arma sus reglas; el bot lo configura el dueño
    if (p.startsWith('/api/alerts')) {
      const isOwnerUser = session.role === 'owner';
      try {
        if (p === '/api/alerts' && req.method === 'GET') return send(res, 200, alerts.status(uid, isOwnerUser));
        if (req.method !== 'POST') return send(res, 404, { error: 'No encontrado' });
        const body = await jsonBody(req);
        if (p === '/api/alerts/bot') {
          if (!isOwnerUser) return send(res, 403, { error: 'Solo el administrador configura el bot.' });
          const token = String(body.token || '').trim();
          if (!/^\d{5,15}:[\w-]{30,60}$/.test(token)) return send(res, 400, { error: 'Ese no parece un token de bot (es algo como 123456789:ABC…)' });
          return send(res, 200, { ok: true, username: await alerts.setBot(token) });
        }
        if (p === '/api/alerts/bot/delete') {
          if (!isOwnerUser) return send(res, 403, { error: 'Solo el administrador configura el bot.' });
          alerts.removeBot(); return send(res, 200, { ok: true });
        }
        if (p === '/api/alerts/link') { const r = alerts.linkCode(uid); setTimeout(alerts.poll, 3000); return send(res, 200, r); }
        if (p === '/api/alerts/poll') { await alerts.poll(); return send(res, 200, alerts.status(uid, isOwnerUser)); }
        if (p === '/api/alerts/unlink') { alerts.unlink(uid); return send(res, 200, { ok: true }); }
        if (p === '/api/alerts/test') { await alerts.test(uid); return send(res, 200, { ok: true }); }
        if (p === '/api/alerts/rules') return send(res, 200, { ok: true, rules: alerts.setRules(uid, body) });
        if (p === '/api/alerts/targets') { alerts.addTarget(uid, body); return send(res, 200, { ok: true }); }
        if (p === '/api/alerts/targets/delete') { alerts.removeTarget(uid, String(body.id || '')); return send(res, 200, { ok: true }); }
        return send(res, 404, { error: 'No encontrado' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // Sincronización pedida a mano: /api/<exchange>/sync
    const syncM = p.match(/^\/api\/(pionex|bingx|bitget|binance)\/sync$/);
    if (syncM && req.method === 'POST') {
      try { const r = await runSync(uid, syncM[1], { force: true }); return send(res, 200, { configured: r.configured, updated: r.updated }); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    // Claves desde Ajustes: /api/keys/<exchange> guarda (si funcionan) y /api/keys/<exchange>/delete las borra
    const keysM = p.match(/^\/api\/keys\/(pionex|bingx|bitget|binance)(\/delete)?$/);
    if (keysM && req.method === 'POST') {
      const ex = keysM[1];
      if (keysM[2]) {
        keystore.remove(userDir(uid), ex);
        Object.assign(syncStateFor(uid)[ex], { error: null, updated: null, last: 0 });
        return send(res, 200, { ok: true, configured: !!exchangeKeys(uid, ex) });
      }
      const body = await jsonBody(req);
      const keys = Object.fromEntries(EXCHANGES[ex].fields.map(([k]) => [k, String(body[k] ?? '').trim()]));
      if (Object.values(keys).some((v) => !v || v.length > 200)) return send(res, 400, { error: 'Completá todos los campos.' });
      // Se prueban antes de guardarlas: si el exchange las rechaza, no se guarda nada.
      try { await SYNCS[ex](uid, keys); }
      catch (e) { return send(res, 400, { error: 'El exchange rechazó las claves: ' + e.message }); }
      keystore.set(userDir(uid), ex, keys);
      Object.assign(syncStateFor(uid)[ex], { error: null, updated: new Date().toISOString(), last: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'No encontrado' });

    return serveFile(res, p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, ''));
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Error interno' });
  }
});

function serveFile(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'No encontrado', 'text/plain');
  const extra = rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {};
  return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', extra);
}

// Solo escucha en la propia PC: el acceso externo pasa por Tailscale (https + su propio control).
server.listen(PORT, '127.0.0.1', () => {
  console.log(`To the Moon corriendo en http://localhost:${PORT}`);
});
