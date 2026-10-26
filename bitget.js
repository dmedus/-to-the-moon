// Bitget (solo lectura): trae futuros USDT-M (cripto y acciones como MSTR) y los guarda en la base.
// Usa la API v3 de la Cuenta Unificada. Devuelve el mismo "snapshot" que bingx.js, así se guarda y se muestra igual.
const crypto = require('crypto');

const BASE_URL = 'https://api.bitget.com';
const DAY = 864e5;
const DEFAULT_LEVERAGE = 10; // Doble Saylor: si Bitget no informa el apalancamiento de una cerrada
const PORTFOLIO_ID = 'futuros-bitget';

const n = (x) => (x === undefined || x === null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const side = (s) => (String(s).toLowerCase() === 'short' ? 'SHORT' : 'LONG');

function client(keys) {
  return async function request(apiPath, params = {}) {
    for (const [k, v] of Object.entries(params)) if (/[&=?#\r\n]/.test(String(v))) throw new Error(`Valor inválido en ${k}`);
    const qs = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const full = apiPath + (qs ? '?' + qs : '');
    const ts = String(Date.now());
    const sign = crypto.createHmac('sha256', keys.secret).update(ts + 'GET' + full).digest('base64');
    const res = await fetch(BASE_URL + full, {
      headers: {
        'ACCESS-KEY': keys.key, 'ACCESS-SIGN': sign, 'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': keys.passphrase,
        'Content-Type': 'application/json', locale: 'en-US',
      },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.code !== '00000') throw new Error(`Bitget ${res.status} ${data?.code ?? ''}: ${data?.msg ?? ''}`);
    return data.data;
  };
}

// Tasa de funding vigente de un par (pública): la que se cobra en el próximo funding.
async function fundRate(symbol) {
  const res = await fetch(`${BASE_URL}/api/v3/market/current-fund-rate?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const r = (await res?.json().catch(() => null))?.data?.[0];
  return r ? { fundingRate: n(r.fundingRate), fundingNextTime: n(r.nextUpdate), fundingHours: n(r.fundingRateInterval) || 8 } : {};
}

// Posiciones cerradas: Bitget ya las devuelve agrupadas con su resultado neto (comisiones y funding incluidos).
async function closedPositions(request, category, start, end) {
  const out = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const d = await request('/api/v3/position/history-position', { category, startTime: start, endTime: end, limit: 100, cursor });
    const list = d?.list ?? [];
    out.push(...list);
    if (list.length < 100 || !d.cursor) break;
    cursor = d.cursor;
  }
  return out;
}

// USDT-M: tamaño en unidades del activo, margen y resultado en USDT.
// Coin-M (ej. SOLUSD_CM): tamaño en USD, margen y resultado en la moneda (SOL); se pasan a USD con el precio.
// Cierres parciales de una posición que sigue abierta: Bitget recién los incluye en history-position cuando se cierra entera.
// Se arman con las ejecuciones (fills) de cierre, agrupadas por orden. execPnl es el resultado bruto; se le resta la comisión.
async function fillsSince(request, category, start, end) {
  const out = [];
  for (let from = start; from < end; from += 7 * DAY) { // de a 7 días, como piden las consultas de ejecuciones
    let cursor;
    for (let page = 0; page < 10; page++) {
      const d = await request('/api/v3/trade/fills', { category, startTime: from, endTime: Math.min(from + 7 * DAY, end), limit: 100, cursor });
      const list = d?.list ?? [];
      out.push(...list);
      if (list.length < 100 || !d.cursor) break;
      cursor = d.cursor;
    }
  }
  return out;
}
function mapPartials(fills, open) {
  const byOrder = new Map();
  for (const f of fills) {
    if (!/^close/.test(f.tradeSide)) continue;
    const pos = open.find((o) => o.symbol === f.symbol && o.side === side(f.posSide) && n(f.createdTime) >= (o.open ?? 0));
    if (!pos) continue; // de una posición ya cerrada: esa la trae entera history-position
    const g = byOrder.get(f.orderId) || { pos, qty: 0, value: 0, pnl: 0, fee: 0, time: 0 };
    const q = n(f.execQty) ?? 0, px = n(f.execPrice) ?? 0, fee = (f.feeDetail || []).reduce((a, x) => a + (n(x.fee) ?? 0), 0);
    const usd = (v) => (pos.market === 'COIN-M' ? v * px : v);
    g.qty += q; g.value += q * px; g.pnl += usd((n(f.execPnl) ?? 0) - fee); g.fee -= usd(fee); g.pnlBase = (g.pnlBase ?? 0) + (n(f.execPnl) ?? 0) - fee;
    g.time = Math.max(g.time, n(f.createdTime) ?? 0);
    byOrder.set(f.orderId, g);
  }
  return [...byOrder].map(([orderId, g]) => {
    const { pos } = g, coinM = pos.market === 'COIN-M';
    const notional = coinM ? g.qty : g.qty * pos.entryPrice;
    return {
      externalId: 'bitget-parcial-' + orderId, partial: true, market: pos.market, symbol: pos.symbol, side: pos.side, leverage: pos.leverage,
      status: 'closed', open: pos.open, close: g.time, entries: null, qty: g.qty, entryPrice: pos.entryPrice, exitPrice: g.qty ? g.value / g.qty : null,
      notional, margin: pos.leverage ? notional / pos.leverage : null, pnl: g.pnl, fees: g.fee, funding: null, // el funding queda en la posición abierta
      ...(coinM ? { pnlBase: g.pnlBase } : {}),
    };
  });
}

function mapOpen(p, coinM) {
  const total = n(p.total), mark = n(p.markPrice), toUsd = (v) => (v == null ? null : coinM ? v * mark : v);
  return {
    externalId: `bitget-${p.symbol}-${side(p.posSide)}-abierta`, market: coinM ? 'COIN-M' : 'USDT-M', symbol: p.symbol, side: side(p.posSide),
    leverage: n(p.leverage), status: 'open', open: n(p.createdTime), qty: total, entryPrice: n(p.avgPrice), markPrice: mark,
    notional: coinM ? total : total != null && mark != null ? total * mark : null,
    margin: toUsd(n(p.positionBalance)), pnl: toUsd(n(p.unrealisedPnl)), roe: n(p.profitRate), liq: n(p.liquidationPrice),
    // Ya pagado (negativo = costo): comisión de apertura + funding. El PnL no restado de Bitget no los incluye.
    feesPaid: toUsd((n(p.openFeeTotal) ?? 0) + (n(p.totalFunding) ?? 0)),
    fundingTotal: toUsd(n(p.totalFunding)), fundingTotalBase: n(p.totalFunding), // en la moneda del margen
    ...(coinM ? { marginCoin: p.marginCoin, marginBase: n(p.positionBalance), pnlBase: n(p.unrealisedPnl) } : {}),
  };
}

function mapClosed(h, coinM, lev) {
  const s = side(h.posSide), total = n(h.openTotalPos), entry = n(h.openPriceAvg), exit = n(h.closePriceAvg);
  const notional = coinM ? total : total != null && entry != null ? total * entry : null;
  const toUsd = (v) => (v == null ? null : coinM ? v * exit : v); // resultado en moneda: se valúa al precio de cierre
  const net = n(h.netProfit) ?? n(h.cumRealisedPnl);
  return {
    externalId: 'bitget-' + h.positionId, market: coinM ? 'COIN-M' : 'USDT-M', symbol: h.symbol, side: s, leverage: lev, status: 'closed',
    open: n(h.createdTime), close: n(h.updatedTime), entries: null, qty: total, entryPrice: entry, exitPrice: exit,
    notional, margin: notional != null ? notional / lev : null,
    pnl: toUsd(net), fees: toUsd((n(h.openFeeTotal) ?? 0) + (n(h.closeFeeTotal) ?? 0)), funding: toUsd(n(h.totalFunding)),
    ...(coinM ? { pnlBase: net } : {}),
  };
}

async function fetchSnapshot(keys, days = 89) {
  const request = client(keys);
  const end = Date.now(), start = end - days * DAY; // la API acepta como mucho 90 días
  const [assets, usdtPos, coinPos, usdtHist, coinHist] = await Promise.all([
    request('/api/v3/account/assets'),
    request('/api/v3/position/current-position', { category: 'USDT-FUTURES' }),
    request('/api/v3/position/current-position', { category: 'COIN-FUTURES' }),
    closedPositions(request, 'USDT-FUTURES', start, end),
    closedPositions(request, 'COIN-FUTURES', start, end),
  ]);

  const open = [
    ...(usdtPos?.list ?? []).filter((p) => n(p.total) > 0).map((p) => mapOpen(p, false)),
    ...(coinPos?.list ?? []).filter((p) => n(p.total) > 0).map((p) => mapOpen(p, true)),
  ];
  for (const o of open) Object.assign(o, await fundRate(o.symbol));
  // Bitget no informa el apalancamiento de las cerradas: se usa el de la posición abierta del mismo par, o 10x.
  const levOf = (h) => open.find((o) => o.symbol === h.symbol && o.side === side(h.posSide))?.leverage || DEFAULT_LEVERAGE;
  const closed = [
    ...usdtHist.map((h) => mapClosed(h, false, levOf(h))),
    ...coinHist.map((h) => mapClosed(h, true, levOf(h))),
  ];
  // Cierres parciales de las abiertas (hasta 30 días atrás; los ya guardados quedan en la base)
  for (const [category, market] of [['USDT-FUTURES', 'USDT-M'], ['COIN-FUTURES', 'COIN-M']]) {
    const mine = open.filter((o) => o.market === market);
    if (!mine.length) continue;
    const from = Math.max(end - 30 * DAY, Math.min(...mine.map((o) => o.open ?? 0)));
    try { closed.push(...mapPartials(await fillsSince(request, category, from, end), mine)); }
    catch (e) { console.warn(`Bitget: no se pudieron leer los cierres parciales (${category}): ${e.message}`); }
  }

  // La Cuenta Unificada mezcla spot y futuros. Se cuenta solo lo de futuros:
  // USDT libre + margen USDT-M, y en coin-M solo el margen + PnL de las posiciones abiertas
  // (el saldo libre de SOL, HYPE, etc. es spot y no se cuenta acá).
  const coins = assets?.assets ?? [];
  const coinRow = (c) => coins.find((a) => a.coin === c);
  const accounts = [];
  const usdtOpen = open.filter((o) => o.market === 'USDT-M');
  const usdtFree = n(coinRow('USDT')?.equity) ?? 0;
  const usdtMargin = usdtOpen.reduce((a, o) => a + (o.margin ?? 0), 0), usdtPnl = usdtOpen.reduce((a, o) => a + (o.pnl ?? 0), 0);
  accounts.push({ market: 'USDT-M', asset: 'USDT', balance: usdtFree + usdtMargin, unrealized: usdtPnl, equity: usdtFree + usdtMargin + usdtPnl, equityUSD: usdtFree + usdtMargin + usdtPnl });

  const coinOpen = open.filter((o) => o.market === 'COIN-M');
  for (const c of [...new Set(coinOpen.map((o) => o.marginCoin))]) {
    const pos = coinOpen.filter((o) => o.marginCoin === c);
    const price = pos[0].markPrice;
    const margin = pos.reduce((a, o) => a + (o.marginBase ?? 0), 0), pnl = pos.reduce((a, o) => a + (o.pnlBase ?? 0), 0);
    accounts.push({ market: 'COIN-M', asset: c, price, balance: margin, unrealized: pnl, equity: margin + pnl, equityUSD: (margin + pnl) * price });
  }
  return { exchange: 'Bitget', fetched: new Date().toISOString(), accounts, open, closed };
}

module.exports = { fetchSnapshot, PORTFOLIO_ID, _test: { mapOpen, mapClosed, mapPartials, client } }; // _test: para test/
