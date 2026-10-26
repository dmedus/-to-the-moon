// BingX (solo lectura): trae futuros USDT-M y coin-M y los guarda en la base.
// Lógica de firma y reconstrucción de operaciones adaptada del conector bingx-mcp.
const crypto = require('crypto');

const BASE_URLS = ['https://open-api.bingx.com', 'https://open-api.bingx.pro'];
const DAY = 864e5;
// Coin-M: los pares se descubren solos (posiciones abiertas + monedas con saldo) y cada uno tiene su
// tamaño de contrato en USD (BTC-USD = 100, HYPE-USD = 10…), que informa /market/contracts como minTradeValue.
const PORTFOLIO_ID = 'futuros-bingx';

const n = (x) => (x === undefined || x === null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const canonical = (p) => Object.keys(p).filter((k) => p[k] != null && p[k] !== '').sort().map((k) => `${k}=${p[k]}`).join('&');
// Los IDs de BingX superan la precisión de Number: se pasan a string antes de parsear.
const parseJson = (t) => JSON.parse(t.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));

function client(keys) {
  return async function request(path, params = {}, { signed = true } = {}) {
    const p = { ...params };
    for (const [k, v] of Object.entries(p)) if (/[&=?#\r\n]/.test(String(v))) throw new Error(`Valor inválido en ${k}`);
    const headers = {};
    let qs;
    if (signed) {
      p.timestamp = Date.now();
      p.recvWindow = 10000;
      const base = canonical(p);
      qs = `${base}&signature=${crypto.createHmac('sha256', keys.secret).update(base).digest('hex')}`;
      headers['X-BX-APIKEY'] = keys.key;
    } else qs = canonical(p);
    let lastErr;
    for (const host of BASE_URLS) {
      try {
        const res = await fetch(`${host}${path}${qs ? '?' + qs : ''}`, { headers, signal: AbortSignal.timeout(10000) });
        const data = parseJson(await res.text());
        if (!res.ok || (data.code !== undefined && Number(data.code) !== 0)) throw new Error(`BingX ${res.status} ${data.code ?? ''}: ${data.msg ?? ''}`);
        return data.data ?? data;
      } catch (e) {
        lastErr = e;
        if (String(e.message).startsWith('BingX')) throw e; // BingX respondió: no reintentar
      }
    }
    throw lastErr;
  };
}

// Funding de una posición abierta desde que se abrió: total y último cobro (negativo = pagado).
function fundingSince(funding, sym, from) {
  const rows = funding.filter((r) => r.symbol === sym && (!from || Number(r.time) >= from)).sort((a, b) => Number(a.time) - Number(b.time));
  if (!rows.length) return {};
  const last = rows.at(-1);
  return { fundingTotal: rows.reduce((s, r) => s + Number(r.income), 0), fundingLast: Number(last.income), fundingLastTime: Number(last.time) };
}

async function inWindows(start, end, win, fn) {
  const out = [];
  for (let s = start; s < end; s += win) out.push(...(await fn(s, Math.min(s + win, end))));
  return out;
}

// Operaciones USDT-M agrupadas por positionID (entradas escalonadas dentro de la misma operación).
function reconstructUsdtm(sym, orders, funding) {
  const groups = new Map();
  for (const o of orders) {
    const key = o.positionID || `${o.positionSide}-sin-id`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => Number(a.updateTime) - Number(b.updateTime));
    const side = list[0].positionSide;
    let qtyIn = 0, cost = 0, qtyOut = 0, sold = 0, gross = 0, fees = 0, pos = 0, maxNotional = 0, entries = 0;
    const lev = n(String(list[0].leverage ?? '').replace(/x/i, ''));
    for (const o of list) {
      const opening = (side === 'LONG' && o.side === 'BUY') || (side === 'SHORT' && o.side === 'SELL');
      const qty = Number(o.executedQty), price = Number(o.avgPrice);
      fees += Number(o.commission || 0);
      if (opening) { entries++; qtyIn += qty; cost += qty * price; pos += qty; maxNotional = Math.max(maxNotional, pos * (cost / qtyIn)); }
      else { qtyOut += qty; sold += qty * price; pos -= qty; gross += Number(o.profit || 0); }
    }
    if (!entries) continue; // el período empieza a mitad de la posición
    if (qtyOut < qtyIn * (1 - 1e-6)) continue; // abierta: sale de /positions
    const open = Number(list[0].updateTime), close = Number(list.at(-1).updateTime);
    const fund = funding.filter((r) => r.symbol === sym && Number(r.time) >= open && Number(r.time) <= close).reduce((s, r) => s + Number(r.income), 0);
    out.push({
      externalId: 'usdtm-' + list[0].positionID, market: 'USDT-M', symbol: sym, side, leverage: lev, status: 'closed',
      open, close, entries, qty: qtyIn, entryPrice: cost / qtyIn, exitPrice: sold / qtyOut,
      notional: maxNotional, margin: lev ? maxNotional / lev : null,
      pnl: gross + fees + fund, fees, funding: fund,
    });
  }
  return out;
}

// Operaciones coin-M: se abren y cierran siguiendo los contratos; el resultado está en la moneda (BTC, HYPE…).
function reconstructCoinm(sym, orders, contractUsd) {
  const out = [];
  let tr = null;
  for (const o of orders) {
    const c = Number(o.quantity), px = Number(o.avgPrice), usd = c * contractUsd;
    const opening = (o.positionSide === 'LONG' && o.side === 'BUY') || (o.positionSide === 'SHORT' && o.side === 'SELL');
    if (!tr) {
      if (!opening) continue;
      tr = { side: o.positionSide, open: Number(o.updateTime), contracts: 0, usd: 0, base: 0, maxUsd: 0, entries: 0, profit: 0, fees: 0, exitUsd: 0, exitBase: 0, lev: n(String(o.leverage ?? '').replace(/x/i, '')) || 5 };
    }
    tr.fees += Number(o.commission || 0);
    if (opening) {
      tr.entries++; tr.contracts += c; tr.usd += usd; tr.base += usd / px; tr.maxUsd = Math.max(tr.maxUsd, tr.usd);
      tr.inUsd = (tr.inUsd || 0) + usd; tr.inBase = (tr.inBase || 0) + usd / px;
    } else {
      tr.profit += Number(o.profit || 0); tr.exitUsd += usd; tr.exitBase += usd / px;
      const f = (tr.contracts - c) / tr.contracts;
      tr.contracts -= c; tr.usd *= f; tr.base *= f;
      if (tr.contracts <= 0) {
        const exitPrice = tr.exitUsd / tr.exitBase;
        const netBtc = tr.profit + tr.fees;
        out.push({
          externalId: `coinm-${sym}-${tr.open}`, market: 'COIN-M', symbol: sym, side: tr.side, leverage: tr.lev, status: 'closed',
          open: tr.open, close: Number(o.updateTime), entries: tr.entries, qty: tr.maxUsd / contractUsd,
          entryPrice: tr.inUsd / tr.inBase, exitPrice, notional: tr.maxUsd, margin: tr.maxUsd / tr.lev,
          pnl: netBtc * exitPrice, pnlBase: netBtc, fees: tr.fees * exitPrice, funding: null,
        });
        tr = null;
      }
    }
  }
  out.openSince = tr?.open ?? null; // si quedó una operación abierta, desde cuándo
  return out;
}

// Descarga todo y devuelve un "snapshot" normalizado (el mismo formato que usa cargar_bingx.js).
async function fetchSnapshot(keys, days = 90) {
  const request = client(keys);
  const end = Date.now(), start = end - days * DAY;

  // --- USDT-M ---
  const [balances, positions, income] = await Promise.all([
    request('/openApi/swap/v3/user/balance'),
    request('/openApi/swap/v2/user/positions'),
    inWindows(start, end, 7 * DAY, async (s, e) => {
      const r = await request('/openApi/swap/v2/user/income', { startTime: s, endTime: e, limit: 1000 });
      return Array.isArray(r) ? r : [];
    }),
  ]);
  const usdt = (balances ?? []).find((b) => b.asset === 'USDT') || {};
  const funding = income.filter((r) => r.incomeType === 'FUNDING_FEE');
  const symbols = [...new Set([...income.map((r) => r.symbol), ...(positions ?? []).map((p) => p.symbol)].filter(Boolean))];
  const closed = [];
  for (const sym of symbols) {
    const orders = await inWindows(start, end, 7 * DAY, async (s, e) => {
      const r = await request('/openApi/swap/v2/trade/allOrders', { symbol: sym, startTime: s, endTime: e, limit: 1000 });
      return (r.orders ?? []).filter((o) => Number(o.executedQty) > 0);
    });
    closed.push(...reconstructUsdtm(sym, [...new Map(orders.map((o) => [o.orderId, o])).values()], funding));
  }
  const open = [];
  for (const p of positions ?? []) {
    const [q, fr] = await Promise.all([
      request('/openApi/swap/v2/quote/price', { symbol: p.symbol }, { signed: false }).catch(() => null),
      request('/openApi/swap/v2/quote/premiumIndex', { symbol: p.symbol }, { signed: false }).catch(() => null),
    ]);
    open.push({
      externalId: 'usdtm-' + p.positionId, market: 'USDT-M', symbol: p.symbol, side: p.positionSide, leverage: n(p.leverage),
      status: 'open', open: n(p.createTime) || null, qty: n(p.positionAmt), entryPrice: n(p.avgPrice), markPrice: n(q?.price),
      notional: n(p.positionValue), margin: n(p.initialMargin), pnl: n(p.unrealizedProfit), liq: n(p.liquidationPrice),
      ...fundingSince(funding, p.symbol, n(p.createTime)),
      fundingRate: n(fr?.lastFundingRate), fundingNextTime: n(fr?.nextFundingTime), fundingHours: n(fr?.fundingIntervalHours) || 8,
    });
  }
  const accounts = [{
    market: 'USDT-M', asset: 'USDT', equity: n(usdt.equity), balance: n(usdt.balance), unrealized: n(usdt.unrealizedProfit), equityUSD: n(usdt.equity),
  }];

  // --- Coin-M ---
  const [cBal, cPos, contracts] = await Promise.all([
    request('/openApi/cswap/v1/user/balance'),
    request('/openApi/cswap/v1/user/positions'),
    request('/openApi/cswap/v1/market/contracts', { timestamp: Date.now() }, { signed: false }),
  ]);
  const contractUsd = Object.fromEntries((contracts ?? []).map((c) => [c.symbol, n(c.minTradeValue) || 100]));
  const coinSymbols = [...new Set([
    ...(cPos ?? []).map((p) => p.symbol),
    ...(cBal ?? []).filter((b) => n(b.equity) > 0 && contractUsd[`${b.asset}-USD`]).map((b) => `${b.asset}-USD`),
  ])];
  for (const sym of coinSymbols) {
    const asset = sym.split('-')[0], size = contractUsd[sym] || 100;
    const t = await request('/openApi/cswap/v1/market/ticker', { symbol: sym }, { signed: false });
    const price = n((Array.isArray(t) ? t[0] : t)?.lastPrice);
    const pi = await request('/openApi/cswap/v1/market/premiumIndex', { symbol: sym, timestamp: Date.now() }, { signed: false }).catch(() => null);
    const fr = Array.isArray(pi) ? pi[0] : pi;
    const b = (cBal ?? []).find((x) => x.asset === asset);
    if (b) accounts.push({ market: 'COIN-M', asset, price, equity: n(b.equity), balance: n(b.balance), unrealized: n(b.unrealizedProfit), equityUSD: n(b.equity) * price });
    const orders = await inWindows(start, end, 7 * DAY, async (s, e) => {
      const r = await request('/openApi/cswap/v1/trade/orderHistory', { symbol: sym, startTime: s, endTime: e, limit: 1000 });
      return (r.orders ?? []).filter((o) => Number(o.executedQty) > 0);
    });
    const trades = reconstructCoinm(sym, [...new Map(orders.map((o) => [o.orderId, o])).values()].sort((a, b) => Number(a.updateTime) - Number(b.updateTime)), size);
    closed.push(...trades);
    for (const p of (cPos ?? []).filter((x) => x.symbol === sym)) {
      const mark = n(p.markPrice) ?? price;
      open.push({
        externalId: `coinm-${sym}-${p.positionSide}-abierta`, market: 'COIN-M', symbol: sym, side: p.positionSide, leverage: n(p.leverage),
        status: 'open', open: trades.openSince, qty: n(p.positionAmt), entryPrice: n(p.avgPrice), markPrice: mark,
        notional: n(p.positionAmt) * size, margin: n(p.initialMargin) * mark,
        pnl: n(p.unrealizedProfit) * mark, pnlBase: n(p.unrealizedProfit), liq: n(p.liquidationPrice),
        // BingX no da el historial de funding de coin-M: se deduce del saldo entre sincronizaciones (ver coinmFunding)
        fundingRate: n(fr?.lastFundingRate), fundingNextTime: n(fr?.nextFundingTime), fundingHours: 8,
        walletBase: n(b?.balance),
        _orders: orders.map((o) => [Number(o.updateTime), Number(o.profit || 0) + Number(o.commission || 0)]),
      });
    }
  }
  return { exchange: 'BingX', fetched: new Date().toISOString(), accounts, open, closed };
}

// Funding de coin-M deducido: si entre la sincronización anterior y esta hubo cobros de funding (cada 8 h, 00/08/16 UTC),
// lo que cambió el saldo de la billetera menos el resultado y las comisiones de las órdenes de ese lapso es el funding.
// Se acumula desde que la app empieza a seguir la posición (fundingFrom). Si la PC estuvo apagada, el cambio junta
// varios cobros (fundingLastCount). Si es más de lo que puede cobrar un funding (seguramente una transferencia),
// no se suma: esos cobros quedan sin dato (fundingMissed).
const FUNDING_EVERY = 8 * 36e5;
const MAX_FUNDING_RATE = 0.01; // por cobro; los exchanges limitan la tasa muy por debajo
const fundingSlots = (since, now) => Math.floor(now / FUNDING_EVERY) - Math.floor(since / FUNDING_EVERY);
function coinmFunding(t, prev, fetched) {
  const orders = t._orders;
  delete t._orders;
  if (t.walletBase == null) return;
  const now = Date.parse(fetched);
  if (!prev || prev.open !== t.open || prev.walletBase == null || !prev.updated) {
    Object.assign(t, { fundingTotal: 0, fundingFrom: now });
    return;
  }
  const since = Date.parse(prev.updated);
  Object.assign(t, {
    fundingTotal: prev.fundingTotal ?? 0, fundingFrom: prev.fundingFrom ?? since, fundingLast: prev.fundingLast, fundingLastTime: prev.fundingLastTime,
    fundingLastCount: prev.fundingLastCount, fundingMissed: prev.fundingMissed,
  });
  const slots = fundingSlots(since, now);
  if (slots <= 0) return;
  const realized = (orders || []).filter(([time]) => time > since && time <= now).reduce((s, [, v]) => s + v, 0);
  const delta = t.walletBase - prev.walletBase - realized;
  if (Math.abs(delta) <= 1e-10) return;
  const usd = delta * t.markPrice;
  if (t.notional && Math.abs(usd) > slots * Math.abs(t.notional) * MAX_FUNDING_RATE) { t.fundingMissed = (t.fundingMissed || 0) + slots; return; }
  Object.assign(t, { fundingTotal: t.fundingTotal + usd, fundingLast: usd, fundingLastCount: slots, fundingLastTime: Math.floor(now / FUNDING_EVERY) * FUNDING_EVERY });
}

// Guarda un snapshot en la base: cuentas y abiertas se reemplazan; las cerradas se acumulan
// (la API solo da 90 días, así que el historial viejo se conserva).
// También la usa Bitget (mismo formato de snapshot, con su propio id de cartera).
function mergeSnapshot(db, snap, pid = PORTFOLIO_ID) {
  if (!db.portfolios.some((p) => p.id === pid)) {
    const used = new Set(db.portfolios.map((p) => p.slot));
    let slot = 1; while (used.has(slot) && slot < 8) slot++;
    db.portfolios.push({ id: pid, name: 'Futuros ' + snap.exchange, type: 'futures', broker: snap.exchange, slot });
  }
  db.futures ||= [];
  db.futuresAccounts ||= {};
  db.futuresAccounts[pid] = { exchange: snap.exchange, updated: snap.fetched, accounts: snap.accounts };
  const prevOpen = new Map(db.futures.filter((f) => f.portfolioId === pid && f.status === 'open').map((f) => [f.externalId, f]));
  const kept = db.futures.filter((f) => f.portfolioId !== pid || f.status === 'closed');
  const byExt = new Map(kept.filter((f) => f.portfolioId === pid).map((f) => [f.externalId, f]));
  for (const t of snap.closed) {
    const rec = byExt.get(t.externalId) || { id: crypto.randomUUID().slice(0, 10), portfolioId: pid, note: '' };
    Object.assign(rec, t, { updated: snap.fetched });
    if (!byExt.has(t.externalId)) { kept.push(rec); byExt.set(t.externalId, rec); }
  }
  // Un cierre parcial (Bitget) queda guardado hasta que llega la posición entera: esa ya lo incluye en su resultado
  const full = kept.filter((f) => f.portfolioId === pid && f.status === 'closed' && !f.partial);
  const covered = (p) => full.some((f) => f.symbol === p.symbol && f.side === p.side && p.close >= (f.open ?? 0) - 60e3 && p.close <= (f.close ?? 0) + 60e3);
  for (let i = kept.length - 1; i >= 0; i--) if (kept[i].portfolioId === pid && kept[i].partial && covered(kept[i])) kept.splice(i, 1);
  for (const t of snap.open) if ('_orders' in t) coinmFunding(t, prevOpen.get(t.externalId), snap.fetched);
  // Si el exchange da solo el funding acumulado (Bitget), el último cobro sale de cuánto cambió desde la sincronización anterior.
  // Se compara en la moneda del margen (en coin-M el total en USD cambia con el precio) y solo si pasó una hora de funding.
  for (const t of snap.open) {
    const prev = prevOpen.get(t.externalId);
    if (t.fundingLast != null || t.fundingTotalBase == null || prev?.fundingTotalBase == null) continue;
    const now = Date.parse(snap.fetched), diff = t.fundingTotalBase - prev.fundingTotalBase;
    const slots = fundingSlots(Date.parse(prev.updated), now);
    if (slots > 0 && Math.abs(diff) > 1e-10) {
      Object.assign(t, { fundingLast: t.market === 'COIN-M' ? diff * t.markPrice : diff, fundingLastCount: slots, fundingLastTime: Math.floor(now / FUNDING_EVERY) * FUNDING_EVERY });
    } else if (prev.fundingLast != null) Object.assign(t, { fundingLast: prev.fundingLast, fundingLastCount: prev.fundingLastCount, fundingLastTime: prev.fundingLastTime });
  }
  for (const t of snap.open) kept.push({ id: crypto.randomUUID().slice(0, 10), portfolioId: pid, note: '', ...t, updated: snap.fetched });
  db.futures = kept;
  return db;
}

module.exports = { fetchSnapshot, mergeSnapshot, PORTFOLIO_ID, _test: { reconstructUsdtm, reconstructCoinm, fundingSince } }; // _test: para test/
