// Bitunix (solo lectura): trae los futuros USDT-M y los guarda en la base.
// Devuelve el mismo "snapshot" que bingx.js y bitget.js, así se guarda y se muestra igual.
const crypto = require('crypto');

const BASE_URL = 'https://fapi.bitunix.com';
const DAY = 864e5;
const PORTFOLIO_ID = 'futuros-bitunix';

const n = (x) => (x === undefined || x === null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const side = (s) => (/SHORT|SELL/i.test(String(s)) ? 'SHORT' : 'LONG'); // en los short Bitunix puede mandar SELL
const cost = (fee) => (fee == null ? null : -Math.abs(fee)); // la comisión siempre es un costo (negativo)

// Firma de Bitunix: sha256(sha256(nonce + timestamp + apiKey + params ordenados + body) + secret), en hex.
// Los parámetros van ordenados por nombre y pegados sin separadores (ej. limit100skip0).
function sign(keys, nonce, ts, params, body = '') {
  const qp = Object.keys(params).sort().map((k) => k + params[k]).join('');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  return sha(sha(nonce + ts + keys.key + qp + body) + keys.secret);
}
function client(keys) {
  return async function request(apiPath, params = {}) {
    for (const [k, v] of Object.entries(params)) if (/[&=?#\r\n]/.test(String(v))) throw new Error(`Valor inválido en ${k}`);
    const p = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
    const qs = Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const nonce = crypto.randomBytes(16).toString('hex'), ts = String(Date.now());
    const res = await fetch(BASE_URL + apiPath + (qs ? '?' + qs : ''), {
      headers: { 'api-key': keys.key, nonce, timestamp: ts, sign: sign(keys, nonce, ts, p), 'Content-Type': 'application/json', language: 'en-US' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.code !== 0) throw new Error(`Bitunix ${res.status} ${data?.code ?? ''}: ${data?.msg ?? ''}`);
    return data.data;
  };
}

// Precio de marca y funding vigente de un par (público). Bitunix da la tasa en porcentaje (0.045146 = 0,045%; el tope es ±2%):
// se pasa a fracción como en los otros exchanges.
async function market(symbol) {
  const res = await fetch(`${BASE_URL}/api/v1/futures/market/funding_rate?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const r = (await res?.json().catch(() => null))?.data;
  const d = Array.isArray(r) ? r[0] : r;
  return d ? { markPrice: n(d.markPrice), fundingRate: n(d.fundingRate) == null ? null : n(d.fundingRate) / 100, fundingNextTime: n(d.nextFundingTime), fundingHours: n(d.fundingInterval) || 8 } : {};
}

// Posiciones cerradas: Bitunix las devuelve agrupadas. Aunque la documentación dice lo contrario, realizedPNL ya
// trae restadas la comisión y el funding (se comprobó contra los precios de entrada y salida).
async function closedPositions(request, start, end) {
  const out = [];
  for (let page = 0; page < 50; page++) {
    const d = await request('/api/v1/futures/position/get_history_positions', { startTime: start, endTime: end, skip: page * 100, limit: 100 });
    const list = d?.positionList ?? [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

function mapOpen(p, m = {}) {
  const qty = n(p.qty), entry = n(p.avgOpenPrice), mark = m.markPrice ?? entry;
  const margin = n(p.margin), pnl = n(p.unrealizedPNL), fee = cost(n(p.fee)), funding = n(p.funding), liq = n(p.liqPrice);
  return {
    externalId: `bitunix-${p.positionId}`, market: 'USDT-M', symbol: p.symbol, side: side(p.side),
    leverage: n(p.leverage), status: 'open', open: n(p.ctime), qty, entryPrice: entry, markPrice: mark,
    notional: qty != null && mark != null ? qty * mark : null,
    margin, pnl, roe: margin ? pnl / margin : null, liq: liq > 0 ? liq : null,
    // Ya pagado (negativo = costo): comisiones + funding de la posición. El PnL no realizado no los incluye.
    feesPaid: (fee ?? 0) + (funding ?? 0), fundingTotal: funding, fundingTotalBase: funding,
    fundingRate: m.fundingRate ?? null, fundingNextTime: m.fundingNextTime ?? null, fundingHours: m.fundingHours ?? null,
    // realizedPNL de una abierta ya trae restadas la comisión y el funding: lo cerrado de verdad es lo que sobra
    _realized: n(p.realizedPNL) == null ? null : n(p.realizedPNL) - (fee ?? 0) - (funding ?? 0), _mtime: n(p.mtime), _positionId: p.positionId,
  };
}

// Lo ya cerrado de una posición que sigue abierta (cierre parcial). Cuando se cierra entera, llega en el historial
// con todo el resultado y mergeSnapshot borra este renglón.
function mapPartial(o) {
  if (o._realized == null || Math.abs(o._realized) < 1e-6) return null;
  const notional = o.qty != null && o.entryPrice != null ? o.qty * o.entryPrice : null;
  return {
    externalId: `bitunix-parcial-${o._positionId}`, partial: true, market: o.market, symbol: o.symbol, side: o.side, leverage: o.leverage,
    status: 'closed', open: o.open, close: o._mtime, entries: null, qty: null, entryPrice: o.entryPrice, exitPrice: null,
    notional: null, margin: o.leverage && notional != null ? notional / o.leverage : null,
    pnl: o._realized, fees: null, funding: null, // sin la comisión ni el funding: quedan en la abierta
  };
}

function mapClosed(h) {
  const qty = n(h.maxQty), entry = n(h.entryPrice), lev = n(h.leverage) || null;
  const notional = qty != null && entry != null ? qty * entry : null;
  const fee = cost(n(h.fee)), funding = n(h.funding), net = n(h.realizedPNL);
  return {
    externalId: `bitunix-${h.positionId}`, market: 'USDT-M', symbol: h.symbol, side: side(h.side), leverage: lev, status: 'closed',
    open: n(h.ctime), close: n(h.mtime), entries: null, qty, entryPrice: entry, exitPrice: n(h.closePrice),
    notional, margin: lev && notional != null ? notional / lev : null,
    pnl: net, fees: fee, funding,
  };
}

async function fetchSnapshot(keys, days = 89) {
  const request = client(keys);
  const end = Date.now(), start = end - days * DAY;
  const [acc, pos, hist] = await Promise.all([
    request('/api/v1/futures/account', { marginCoin: 'USDT' }),
    request('/api/v1/futures/position/get_pending_positions'),
    closedPositions(request, start, end),
  ]);
  const open = [];
  for (const p of (Array.isArray(pos) ? pos : pos?.positionList ?? []).filter((p) => n(p.qty) > 0)) open.push(mapOpen(p, await market(p.symbol)));
  // Solo las cerradas del todo: Bitunix pone en el historial también las que tuvieron un cierre parcial y siguen
  // abiertas (con el mismo positionId). Esas se ven recién cuando se cierran enteras, con el resultado completo.
  const openIds = new Set(open.map((o) => String(o._positionId)));
  const closed = hist.filter((h) => !openIds.has(String(h.positionId))).map(mapClosed);
  for (const o of open) { delete o._realized; delete o._mtime; delete o._positionId; }

  const a = (Array.isArray(acc) ? acc : [acc]).find((x) => x?.marginCoin === 'USDT') || {};
  const balance = (n(a.available) ?? 0) + (n(a.frozen) ?? 0) + (n(a.margin) ?? 0);
  const unrealized = (n(a.crossUnrealizedPNL) ?? 0) + (n(a.isolationUnrealizedPNL) ?? 0);
  const accounts = [{ market: 'USDT-M', asset: 'USDT', balance, unrealized, equity: balance + unrealized, equityUSD: balance + unrealized }];
  return { exchange: 'Bitunix', fetched: new Date().toISOString(), accounts, open, closed };
}

// ---------- Spot (solo lectura) ----------
// Otro dominio y la misma firma. Las consultas privadas que se usan no llevan parámetros en la URL:
// el saldo es un GET sin parámetros y el historial es un POST con el JSON (sin espacios) dentro de la firma.
const SPOT_URL = 'https://openapi.bitunix.com';
const SPOT_ID = 'spot-bitunix';
const STABLE = new Set(['USDT', 'USDC', 'FDUSD']);
const day = (t) => new Date(t).toISOString().slice(0, 10);
const time = (x) => (/^\d+$/.test(String(x)) ? Number(x) : Date.parse(x));

function spotClient(keys) {
  return async function request(method, apiPath, body = null) {
    const raw = body ? JSON.stringify(body) : '';
    const nonce = crypto.randomBytes(16).toString('hex'), ts = String(Date.now());
    const res = await fetch(SPOT_URL + apiPath, {
      method, body: raw || undefined,
      headers: { 'api-key': keys.key, nonce, timestamp: ts, sign: sign(keys, nonce, ts, {}, raw), 'Content-Type': 'application/json', language: 'en-US' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || Number(data.code) !== 0) throw new Error(`Bitunix spot ${res.status} ${data?.code ?? ''}: ${data?.msg ?? ''}`);
    return data.data;
  };
}
async function spotPrice(symbol) {
  const res = await fetch(`${SPOT_URL}/api/spot/v1/market/last_price?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const d = await res?.json().catch(() => null);
  return Number(d?.code) === 0 ? n(d.data) : null;
}

// Arma las operaciones de una moneda a partir de las órdenes llenadas y el saldo actual. Lo que el historial no
// explica se ajusta: si sobra, una compra al costo promedio (o al precio de hoy); si falta (se movió, p. ej. a Nexo),
// una venta al costo promedio, que no genera ganancia ni pérdida.
function spotTxs(a, balance, price, orders, firstSeen, now) {
  const txs = [];
  const tx = (ext, side, t, qty, p, fee, note) => txs.push({
    id: ext, externalId: ext, portfolioId: SPOT_ID, side, ticker: a, date: day(t), qty, ratio: 1, price: p, currency: 'USD', fee, note,
  });
  if (STABLE.has(a)) { tx(`bitunix-spot-${a}`, 'buy', firstSeen, balance, 1, 0, 'Saldo en Bitunix'); return txs; }
  const ev = [];
  for (const o of orders) {
    const qty = n(o.dealVolume), amount = n(o.dealAmount);
    if (!qty || !amount) continue;
    const p = amount / qty, buy = String(o.side) === '2', t = time(o.ctime);
    const fee = n(o.fee) ?? 0, feeUsd = o.feeCoin === a ? fee * p : fee; // la comisión viene en la moneda recibida
    ev.push(buy
      ? { ext: `bitunix-spot-${o.orderId}`, side: 'buy', t, qty: o.feeCoin === a ? qty - fee : qty, p, fee: feeUsd, note: `Compra en Bitunix (${o.symbol})` }
      : { ext: `bitunix-spot-${o.orderId}`, side: 'sell', t, qty, p, fee: feeUsd, note: `Venta en Bitunix (${o.symbol})` });
  }
  ev.sort((x, y) => day(x.t).localeCompare(day(y.t)) || (x.side === y.side ? x.t - y.t : x.side === 'buy' ? -1 : 1));
  let qty = 0, cost = 0;
  for (const e of ev) {
    if (e.side === 'buy') { qty += e.qty; cost += e.qty * e.p + e.fee; }
    else { const q = Math.min(e.qty, qty), avg = qty ? cost / qty : 0; cost -= q * avg; qty -= q; if (qty < 1e-9) { qty = 0; cost = 0; } }
    tx(e.ext, e.side, e.t, e.qty, e.p, e.fee, e.note);
  }
  const diff = balance - qty, avg = qty ? cost / qty : null;
  if (Math.abs(diff) * (price ?? 0) >= 1) {
    if (diff > 0) tx(`bitunix-spot-${a}-ajuste`, 'buy', firstSeen, diff, avg ?? price, 0, 'Ajuste al saldo de Bitunix (depósito o transferencia): costo estimado');
    else tx(`bitunix-spot-${a}-ajuste`, 'sell', now, -diff, avg ?? price, 0, 'Ajuste al saldo de Bitunix (retiro o transferencia, p. ej. a Nexo): sin resultado');
  }
  return txs;
}

async function fetchSpot(keys, prev = {}) {
  const request = spotClient(keys), now = Date.now();
  const list = await request('GET', '/api/spot/v1/user/account');
  const bal = {};
  for (const b of list ?? []) { const q = (n(b.balance) ?? 0) + (n(b.balanceLocked) ?? 0); if (q) bal[b.coin] = (bal[b.coin] || 0) + q; }
  const firstSeen = { ...(prev.firstSeen || {}) }, txs = [];
  for (const a of Object.keys(bal)) {
    const price = STABLE.has(a) ? 1 : await spotPrice(a + 'USDT');
    if (price == null || bal[a] * price < 1) continue; // polvo o moneda sin par contra USDT
    firstSeen[a] ||= day(now);
    const orders = [];
    if (!STABLE.has(a)) {
      for (let page = 1; page <= 20; page++) {
        const d = await request('POST', '/api/spot/v1/order/history/page', { symbol: a + 'USDT', page, pageSize: 100 });
        const rows = d?.data ?? [];
        orders.push(...rows);
        if (rows.length < 100) break;
      }
    }
    txs.push(...spotTxs(a, bal[a], price, orders, firstSeen[a], now));
  }
  return { exchange: 'Bitunix', fetched: new Date(now).toISOString(), txs, state: { firstSeen } };
}

module.exports = { fetchSnapshot, fetchSpot, PORTFOLIO_ID, SPOT_ID, _test: { sign, mapOpen, mapClosed, mapPartial, spotTxs } }; // _test: para test/
