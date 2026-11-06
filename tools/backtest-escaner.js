// Backtest del escáner de zonas (escaner.js): vela por vela de 4 h, sin mirar el futuro.
// En cada cierre arma el plan con las velas conocidas hasta ahí; las órdenes límite se prueban desde la vela siguiente.
// Uso: node tools/backtest-escaner.js [días=730]   (las velas se guardan en data/backtest/ para no bajarlas de nuevo)
const fs = require('fs');
const path = require('path');
const { _test: { analyze, CFG } } = require('../escaner');

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'HYPEUSDT', 'TAOUSDT'];
const DAYS = +process.argv[2] || 730;
const DIR = path.join(__dirname, '..', 'data', 'backtest');
const H4 = 4 * 36e5, D1 = 864e5;
const ACCOUNT = 1000; // cuenta fija (sin interés compuesto) para comparar operaciones entre sí
const FEE = 0.0006; // comisión por lado (taker, conservador: las límite pagan menos)
const WINDOW = 600; // velas de 4 h que ve el escáner (igual que en vivo)
const TIMEOUT = 60; // si en 10 días no tocó stop ni TP, se cierra al precio
// Variantes (variables de entorno): RR_MIN=1.5 (riesgo/beneficio mínimo), TENDENCIA=1 (solo a favor), NIVEL3=1 (entrada 1 de nivel 3), MAX_ENTRADAS=2
const RR_MIN = +process.env.RR_MIN || 0, TREND_ONLY = !!process.env.TENDENCIA, LEVEL3 = !!process.env.NIVEL3, MAX_ENTRIES = +process.env.MAX_ENTRADAS || 3;

async function klines(symbol, interval, from) {
  const file = path.join(DIR, `${symbol}-${interval}.json`);
  let have = [];
  try { have = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primera vez */ }
  const out = [...have];
  let end = Date.now();
  const oldest = have.length ? have[0].t : Infinity, newest = have.length ? have.at(-1).t : 0;
  // baja lo que falta: lo más nuevo y, si hace falta, más hacia atrás
  for (let guard = 0; guard < 60; guard++) {
    const r = await fetch(`https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=${interval}&limit=200&endTime=${end}`);
    const j = await r.json();
    if (j.code !== 0) throw new Error(`${symbol}: ${j.msg}`);
    const rows = (j.data || []).map((x) => ({ t: +x.time, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.baseVol }));
    out.push(...rows);
    if (rows.length < 200) break;
    end = Math.min(...rows.map((x) => x.t)) - 1;
    if (end < from || (end < newest && oldest <= from)) break;
  }
  const seen = new Set();
  const all = out.filter((x) => !seen.has(x.t) && seen.add(x.t)).sort((a, b) => a.t - b.t);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all));
  return all.filter((x) => x.t >= from - 260 * H4); // un poco antes del inicio para que las EMAs ya estén armadas
}

// Tamaño: 10% de la cuenta repartido 15/30/55, con el apalancamiento más alto (hasta 10x) que deja la pérdida en 2%
function sizeOf(plan) {
  const lossAt1x = plan.entries.reduce((a, e) => a + ((ACCOUNT * CFG.coinPct * e.pct) / e.price) * Math.abs(e.price - plan.stop), 0);
  const lev = Math.min(CFG.leverage, Math.floor((ACCOUNT * CFG.maxRisk) / lossAt1x));
  return lev >= 1 ? lev : 0;
}

function simulate(symbol, c4, c1d, start) {
  const trades = [];
  let plans = null, trade = null;
  let d = 0;
  for (let i = WINDOW; i < c4.length; i++) {
    const bar = c4[i];
    // 1) la vela i ejecuta lo que estaba puesto desde el cierre anterior
    if (trade) {
      const long = trade.side === 'long', dir = long ? 1 : -1;
      for (const e of trade.entries) if (!e.filled && (long ? bar.l <= e.price : bar.h >= e.price)) { e.filled = true; e.at = i; }
      const hitStop = long ? bar.l <= trade.stop : bar.h >= trade.stop, hitTp = long ? bar.h >= trade.tp : bar.l <= trade.tp;
      let exit = null, why = null;
      if (hitStop) { exit = trade.stop; why = 'stop'; } // si en la misma vela toca stop y TP, se asume el stop
      else if (hitTp && i > trade.open) { exit = trade.tp; why = 'tp'; }
      else if (i - trade.open >= TIMEOUT) { exit = bar.c; why = 'tiempo'; }
      if (exit != null) {
        const f = trade.entries.filter((e) => e.filled);
        const pnl = f.reduce((a, e) => {
          const notional = ACCOUNT * CFG.coinPct * e.pct * trade.lev, qty = notional / e.price;
          return a + dir * qty * (exit - e.price) - FEE * (notional + qty * exit);
        }, 0);
        trades.push({ symbol, side: trade.side, open: c4[trade.open].t, close: bar.t, why, fills: f.length, lev: trade.lev, level: trade.entries[0].level,
          withTrend: trade.withTrend, pnl, pct: pnl / ACCOUNT });
        trade = null;
      }
    } else if (plans) {
      const hits = plans.filter((p) => (p.side === 'long' ? bar.l <= p.entries[0].price : bar.h >= p.entries[0].price));
      if (hits.length === 1) {
        const p = hits[0], long = p.side === 'long';
        trade = { ...p, open: i, entries: p.entries.map((e) => ({ ...e, filled: long ? bar.l <= e.price : bar.h >= e.price })) };
        // si en la vela de entrada ya toca el stop, sale ahí mismo
        if (long ? bar.l <= p.stop : bar.h >= p.stop) {
          const f = trade.entries.filter((e) => e.filled), dir = long ? 1 : -1;
          const pnl = f.reduce((a, e) => { const n = ACCOUNT * CFG.coinPct * e.pct * p.lev, q = n / e.price; return a + dir * q * (p.stop - e.price) - FEE * (n + q * p.stop); }, 0);
          trades.push({ symbol, side: p.side, open: bar.t, close: bar.t, why: 'stop', fills: f.length, lev: p.lev, level: p.entries[0].level, withTrend: p.withTrend, pnl, pct: pnl / ACCOUNT });
          trade = null;
        }
      }
      plans = null; // con dos lados tocados en la misma vela no se sabe cuál fue primero: no se opera
    }
    // 2) al cierre de la vela i, el escáner arma el plan para las próximas velas (si no hay operación abierta)
    if (!trade && bar.t >= start) {
      while (d < c1d.length && c1d[d].t + D1 <= bar.t + H4) d++;
      const r = analyze(symbol, c4.slice(i - WINDOW + 1, i + 1), c1d.slice(Math.max(0, d - 200), d), ACCOUNT);
      plans = [r.long, r.short].filter((p) => p && p.tp).map((p) => {
        if (p.entries.length > MAX_ENTRIES) { // menos entradas: se queda con las primeras y reparte el capital entre ellas
          const e = p.entries.slice(0, MAX_ENTRIES), w = CFG.split[e.length], q = e.map((x, k) => ((ACCOUNT * CFG.coinPct * w[k] * CFG.leverage) / x.price));
          const avg = e.reduce((a, x, k) => a + q[k] * x.price, 0) / q.reduce((a, x) => a + x, 0);
          p = { ...p, entries: e.map((x, k) => ({ ...x, pct: w[k] })), avg, rr: Math.abs(p.tp - avg) / Math.abs(avg - p.stop) };
        }
        const withTrend = (p.side === 'long') === (r.trend === 'alcista');
        if ((p.rr ?? 0) < RR_MIN || (TREND_ONLY && !withTrend) || (LEVEL3 && p.entries[0].level < 3)) return null;
        const lev = sizeOf(p);
        return lev ? { ...p, lev, withTrend } : null;
      }).filter(Boolean);
      if (!plans.length) plans = null;
    }
  }
  return trades;
}

function stats(list) {
  const n = list.length, won = list.filter((t) => t.pnl > 0), lost = list.filter((t) => t.pnl <= 0);
  const gw = won.reduce((a, t) => a + t.pnl, 0), gl = -lost.reduce((a, t) => a + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...list].sort((a, b) => a.close - b.close)) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, win: n ? won.length / n : 0, pnl: gw - gl, pf: gl ? gw / gl : null, avg: n ? (gw - gl) / n : 0, dd };
}
const row = (name, s) => `${name.padEnd(22)} ${String(s.n).padStart(5)}  ${(s.win * 100).toFixed(1).padStart(5)}%  ${s.pnl.toFixed(2).padStart(9)}  ${(s.pnl / ACCOUNT * 100).toFixed(1).padStart(6)}%  ${s.pf == null ? '   ∞' : s.pf.toFixed(2).padStart(5)}  ${s.avg.toFixed(2).padStart(7)}  ${s.dd.toFixed(2).padStart(8)}`;

(async () => {
  const start = Date.now() - DAYS * D1;
  const all = [];
  for (const s of PAIRS) {
    const c4 = (await klines(s, '4h', start)).filter((x) => x.t + H4 <= Date.now());
    const c1d = await klines(s, '1d', start - 200 * D1);
    if (c4.length <= WINDOW) { console.log(`${s}: pocas velas (${c4.length}), se saltea`); continue; }
    const t = simulate(s, c4, c1d, start);
    console.error(`${s}: ${c4.length} velas desde ${new Date(c4[WINDOW].t).toISOString().slice(0, 10)}, ${t.length} operaciones`);
    all.push(...t);
  }
  const by = (f) => { const m = {}; for (const t of all) (m[f(t)] ||= []).push(t); return m; };
  console.log(`\nBacktest del escáner · últimos ${DAYS} días${RR_MIN ? ` · R/B ≥ ${RR_MIN}` : ''}${TREND_ONLY ? ' · solo a favor de tendencia' : ''}${LEVEL3 ? ' · entrada 1 nivel 3' : ''}${MAX_ENTRIES < 3 ? ` · máx. ${MAX_ENTRIES} entradas` : ''} · cuenta fija US$ ${ACCOUNT} · comisión ${FEE * 100}% por lado\n`);
  console.log(`${''.padEnd(22)}   ops  acierto  resultado   s/cuenta  factor  prom/op  máx.caída`);
  console.log(row('TOTAL', stats(all)));
  for (const [k, v] of Object.entries(by((t) => t.symbol))) console.log(row(k, stats(v)));
  for (const [k, v] of Object.entries(by((t) => t.side))) console.log(row(k, stats(v)));
  for (const [k, v] of Object.entries(by((t) => (t.withTrend ? 'a favor de tendencia' : 'contra tendencia')))) console.log(row(k, stats(v)));
  for (const [k, v] of Object.entries(by((t) => `entrada 1 nivel ${t.level}`))) console.log(row(k, stats(v)));
  for (const [k, v] of Object.entries(by((t) => `${t.fills} entrada(s)`))) console.log(row(k, stats(v)));
  for (const [k, v] of Object.entries(by((t) => `salida: ${t.why}`))) console.log(row(k, stats(v)));
  for (const [k, v] of Object.entries(by((t) => new Date(t.close).toISOString().slice(0, 7)))) console.log(row(k, stats(v)));
  fs.writeFileSync(path.join(DIR, 'resultado.json'), JSON.stringify(all, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
