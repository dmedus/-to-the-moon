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

// Precio de marca y funding vigente de un par (público)
async function market(symbol) {
  const res = await fetch(`${BASE_URL}/api/v1/futures/market/funding_rate?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const r = (await res?.json().catch(() => null))?.data;
  const d = Array.isArray(r) ? r[0] : r;
  return d ? { markPrice: n(d.markPrice), fundingRate: n(d.fundingRate), fundingNextTime: n(d.nextFundingTime), fundingHours: n(d.fundingInterval) || 8 } : {};
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
  const closed = [...hist.map(mapClosed), ...open.map(mapPartial).filter(Boolean)];
  for (const o of open) { delete o._realized; delete o._mtime; delete o._positionId; }

  const a = (Array.isArray(acc) ? acc : [acc]).find((x) => x?.marginCoin === 'USDT') || {};
  const balance = (n(a.available) ?? 0) + (n(a.frozen) ?? 0) + (n(a.margin) ?? 0);
  const unrealized = (n(a.crossUnrealizedPNL) ?? 0) + (n(a.isolationUnrealizedPNL) ?? 0);
  const accounts = [{ market: 'USDT-M', asset: 'USDT', balance, unrealized, equity: balance + unrealized, equityUSD: balance + unrealized }];
  return { exchange: 'Bitunix', fetched: new Date().toISOString(), accounts, open, closed };
}

module.exports = { fetchSnapshot, PORTFOLIO_ID, _test: { sign, mapOpen, mapClosed, mapPartial } }; // _test: para test/
