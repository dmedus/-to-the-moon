// Binance (solo lectura): trae futuros USDT-M (fapi) y coin-M (dapi) y los guarda en la base.
// Devuelve el mismo "snapshot" que bingx.js, así se guarda y se muestra igual.
// Binance no tiene historial de posiciones: las operaciones cerradas se reconstruyen con los trades de cada par.
const crypto = require('crypto');

const HOSTS = { usdt: 'https://fapi.binance.com', coin: 'https://dapi.binance.com', spot: 'https://api.binance.com' };
const PREFIX = { usdt: '/fapi', coin: '/dapi', spot: '' }; // en spot la ruta va completa (/api/v3/… o /sapi/v1/…)
const TIME = { usdt: '/fapi/v1/time', coin: '/dapi/v1/time', spot: '/api/v3/time' };
const DAY = 864e5;
const WINDOW = 7 * DAY; // trades e ingresos: Binance acepta como mucho 7 días por pedido
const PORTFOLIO_ID = 'futuros-binance';
const SPOT_ID = 'spot-binance';

const n = (x) => (x === undefined || x === null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'BNFCR']);

function client(keys) {
  const offset = {}; // diferencia de reloj con cada host (Binance rechaza pedidos con la hora corrida)
  return async function request(mkt, apiPath, params = {}, { signed = true, method = 'GET' } = {}) {
    for (const [k, v] of Object.entries(params)) if (/[&=?#\r\n]/.test(String(v))) throw new Error(`Valor inválido en ${k}`);
    const host = HOSTS[mkt], full = PREFIX[mkt] + apiPath;
    const headers = {};
    let qs = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (signed) {
      if (offset[mkt] == null) {
        const t = await fetch(`${host}${TIME[mkt]}`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => null);
        offset[mkt] = t?.serverTime ? t.serverTime - Date.now() : 0;
      }
      qs += `${qs ? '&' : ''}recvWindow=10000&timestamp=${Date.now() + offset[mkt]}`;
      qs += `&signature=${crypto.createHmac('sha256', keys.secret).update(qs).digest('hex')}`;
      headers['X-MBX-APIKEY'] = keys.key;
    }
    const res = await fetch(`${host}${full}${qs ? '?' + qs : ''}`, { method, headers, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => null);
    if (!res.ok || data == null || (data.code != null && Number(data.code) < 0)) throw new Error(`Binance ${res.status} ${data?.code ?? ''}: ${data?.msg ?? ''}`);
    return data;
  };
}

// Pide en ventanas de 7 días, y dentro de cada una pagina por tiempo si llega al límite de 1000.
// `skip(s, e)` permite saltear ventanas sin actividad.
async function inWindows(start, end, fn, idOf, skip = () => false) {
  const out = new Map();
  for (let s = start; s < end; s += WINDOW) {
    const e = Math.min(s + WINDOW, end) - 1;
    if (skip(s, e)) continue;
    let from = s;
    for (let page = 0; page < 20; page++) {
      const list = await fn(from, e);
      let added = 0;
      for (const x of list) if (!out.has(idOf(x))) { out.set(idOf(x), x); added++; }
      if (list.length < 1000 || !added) break;
      from = Math.max(...list.map((x) => Number(x.time)));
    }
  }
  return [...out.values()];
}

// Arma las operaciones de un par a partir de sus trades. Cada operación va de posición 0 a posición 0.
// Modo cobertura (positionSide LONG/SHORT): cada lado por separado. Modo unidireccional (BOTH): el lado sale del primer trade.
// coin-M: la cantidad está en contratos de `size` USD y el resultado y las comisiones en la moneda del margen.
function reconstruct(sym, trades, { coinM, size = 1, toUsd }) {
  const done = [], open = {};
  const groups = new Map();
  for (const t of trades) {
    if (!groups.has(t.positionSide)) groups.set(t.positionSide, []);
    groups.get(t.positionSide).push(t);
  }
  for (const [ps, list] of groups) {
    list.sort((a, b) => a.time - b.time || a.id - b.id);
    let tr = null;
    const start = (t, side) => ({ side, open: t.time, entries: 0, pos: 0, inQty: 0, inUsd: 0, inBase: 0, outQty: 0, outUsd: 0, outBase: 0, maxUsd: 0, pnl: 0, fee: 0, bad: false });
    const apply = (t, qty, opening) => {
      const px = n(t.price), part = qty / n(t.qty);
      const usd = coinM ? qty * size : qty * px, base = coinM ? usd / px : qty;
      tr.pnl += n(t.realizedPnl) * part;
      tr.fee += toUsd(n(t.commission), t.commissionAsset, px) * part; // linear: USD; coin-M: en la moneda
      if (opening) {
        tr.entries++; tr.pos += qty; tr.inQty += qty; tr.inUsd += usd; tr.inBase += base;
        tr.maxUsd = Math.max(tr.maxUsd, coinM ? tr.pos * size : tr.pos * (tr.inUsd / tr.inQty));
      } else { tr.pos -= qty; tr.outQty += qty; tr.outUsd += usd; tr.outBase += base; }
      tr.close = t.time;
    };
    for (const t of list) {
      const buy = t.side === 'BUY';
      let qty = n(t.qty);
      if (ps !== 'BOTH') {
        const opening = (ps === 'LONG') === buy;
        if (!tr) { if (!opening) continue; tr = start(t, ps); } // cierre de algo abierto antes del período
        if (!opening && qty > tr.pos * (1 + 1e-9)) tr.bad = true; // cierra más de lo que vimos abrir: empezó antes del período
        apply(t, opening ? qty : Math.min(qty, tr.pos), opening);
      } else {
        if (!tr) { if (n(t.realizedPnl)) continue; tr = start(t, buy ? 'LONG' : 'SHORT'); }
        const opening = (tr.side === 'LONG') === buy;
        if (opening) apply(t, qty, true);
        else {
          const c = Math.min(qty, tr.pos);
          apply(t, c, false);
          qty -= c;
          if (qty > 1e-12 && tr.pos <= 1e-12) { // da vuelta la posición: cierra esta y abre la contraria con el resto
            done.push(tr); tr = start(t, buy ? 'LONG' : 'SHORT'); apply(t, qty, true);
          }
        }
      }
      if (tr && tr.pos <= tr.inQty * 1e-9) { done.push(tr); tr = null; }
    }
    if (tr) open[tr.side] = tr;
  }
  return { done: done.filter((x) => !x.bad), open };
}

function fundingIn(funding, sym, from, to) {
  return funding.filter((r) => r.symbol === sym && r.time >= from && r.time <= to).reduce((a, r) => a + n(r.income), 0);
}

// Último funding de una posición abierta (negativo = pagado), en la moneda del margen.
function fundingLastIn(funding, sym, from) {
  const rows = funding.filter((r) => r.symbol === sym && r.time >= from);
  return rows.length ? rows.reduce((a, r) => (r.time > a.time ? r : a)) : null;
}

function mapClosed(tr, sym, market, lev, fund, coinM, size) {
  const exitPrice = coinM ? tr.outUsd / tr.outBase : tr.outUsd / tr.outQty;
  const net = tr.pnl - tr.fee + fund; // en coin-M, en la moneda del margen
  const usd = (v) => (coinM ? v * exitPrice : v);
  return {
    externalId: `binance-${sym}-${tr.side}-${tr.open}`, market, symbol: sym, side: tr.side, leverage: lev, status: 'closed',
    open: tr.open, close: tr.close, entries: tr.entries, qty: tr.inQty,
    entryPrice: coinM ? tr.inUsd / tr.inBase : tr.inUsd / tr.inQty, exitPrice,
    notional: tr.maxUsd, margin: lev ? tr.maxUsd / lev : null,
    pnl: usd(net), fees: usd(-tr.fee), funding: usd(fund),
    ...(coinM ? { pnlBase: net } : {}),
  };
}

async function fetchMarket(request, mkt, start, end, prices) {
  const coinM = mkt === 'coin', market = coinM ? 'COIN-M' : 'USDT-M';
  const [account, risk, info] = await Promise.all([
    request(mkt, coinM ? '/v1/account' : '/v2/account'),
    request(mkt, coinM ? '/v1/positionRisk' : '/v2/positionRisk'),
    coinM ? request(mkt, '/v1/exchangeInfo', {}, { signed: false }) : null,
  ]);
  // Tasa de funding vigente (pública) e intervalo de los pares que no cobran cada 8 h
  const [premium, fundInfo] = await Promise.all([
    request(mkt, '/v1/premiumIndex', {}, { signed: false }).catch(() => []),
    coinM ? [] : request(mkt, '/v1/fundingInfo', {}, { signed: false }).catch(() => []),
  ]);
  const rateOf = Object.fromEntries((premium ?? []).map((r) => [r.symbol, r]));
  const hoursOf = Object.fromEntries((fundInfo ?? []).map((r) => [r.symbol, n(r.fundingIntervalHours)]));
  const income = await inWindows(start, end, (s, e) => request(mkt, '/v1/income', { startTime: s, endTime: e, limit: 1000 }), (r) => r.tranId + r.incomeType + r.symbol);
  for (const r of income) r.time = Number(r.time);
  const funding = income.filter((r) => r.incomeType === 'FUNDING_FEE');
  const sizeOf = Object.fromEntries((info?.symbols ?? []).map((s) => [s.symbol, n(s.contractSize) || 100]));
  const levOf = Object.fromEntries(risk.map((p) => [p.symbol, n(p.leverage)]));
  const positions = risk.filter((p) => n(p.positionAmt));
  const symbols = [...new Set([
    ...income.filter((r) => r.incomeType === 'REALIZED_PNL' || r.incomeType === 'COMMISSION').map((r) => r.symbol),
    ...positions.map((p) => p.symbol),
  ].filter(Boolean))];

  const open = [], closed = [];
  for (const sym of symbols) {
    const size = sizeOf[sym] || 100;
    // Cada trade cobra comisión: solo se piden las semanas en que el par tuvo comisiones o resultados.
    const active = income.filter((r) => r.symbol === sym && r.incomeType !== 'FUNDING_FEE').map((r) => r.time);
    const trades = await inWindows(start, end, (s, e) => request(mkt, '/v1/userTrades', { symbol: sym, startTime: s, endTime: e, limit: 1000 }), (t) => t.id,
      (s, e) => !active.some((t) => t >= s && t <= e));
    for (const t of trades) { t.time = Number(t.time); t.id = Number(t.id); }
    const toUsd = (v, asset, px) => {
      if (!v) return 0;
      if (coinM) return asset === sym.split('USD')[0] ? v : (v * (prices[asset] ?? 0)) / px; // se pasa a la moneda del margen
      return STABLE.has(asset) ? v : v * (prices[asset] ?? 0);
    };
    const r = reconstruct(sym, trades, { coinM, size, toUsd });
    // Las que empiezan en la primera semana del período pueden venir de antes: se descartan (las viejas ya quedaron guardadas).
    for (const tr of r.done) if (tr.open >= start + WINDOW) closed.push(mapClosed(tr, sym, market, levOf[sym], fundingIn(funding, sym, tr.open, tr.close), coinM, size));

    for (const p of positions.filter((x) => x.symbol === sym)) {
      const amt = n(p.positionAmt), side = p.positionSide === 'BOTH' ? (amt > 0 ? 'LONG' : 'SHORT') : p.positionSide;
      const mark = n(p.markPrice), lev = n(p.leverage), qty = Math.abs(amt);
      const notional = coinM ? qty * size : Math.abs(n(p.notional) ?? qty * mark);
      const iso = p.marginType === 'isolated' && n(p.isolatedWallet);
      const tr = r.open[side];
      const fund = tr ? fundingIn(funding, sym, tr.open, end) : null, lastFund = tr ? fundingLastIn(funding, sym, tr.open) : null;
      const paid = tr ? -tr.fee + fund : null; // en coin-M, en la moneda
      const marginBase = coinM ? (iso || (lev ? notional / lev / n(p.entryPrice) : null)) : null;
      open.push({
        externalId: `binance-${sym}-${side}-abierta`, market, symbol: sym, side, leverage: lev, status: 'open',
        open: tr?.open ?? null, qty, entryPrice: n(p.entryPrice), markPrice: mark, notional,
        margin: coinM ? (marginBase != null ? marginBase * mark : null) : iso || (lev ? notional / lev : null),
        pnl: coinM ? n(p.unRealizedProfit) * mark : n(p.unRealizedProfit), liq: n(p.liquidationPrice) || null,
        feesPaid: paid == null ? null : coinM ? paid * mark : paid,
        fundingRate: n(rateOf[sym]?.lastFundingRate), fundingNextTime: n(rateOf[sym]?.nextFundingTime), fundingHours: hoursOf[sym] || 8,
        ...(lastFund ? { fundingTotal: coinM ? fund * mark : fund, fundingLast: coinM ? n(lastFund.income) * mark : n(lastFund.income), fundingLastTime: lastFund.time } : {}),
        ...(coinM ? { marginCoin: sym.split('USD')[0], marginBase, pnlBase: n(p.unRealizedProfit) } : {}),
      });
    }
  }

  const accounts = [];
  if (!coinM) {
    const bal = n(account.totalWalletBalance) ?? 0, upnl = n(account.totalUnrealizedProfit) ?? 0;
    accounts.push({ market, asset: 'USDT', balance: bal, unrealized: upnl, equity: bal + upnl, equityUSD: bal + upnl });
  } else {
    for (const a of account.assets ?? []) {
      const bal = n(a.walletBalance) ?? 0, upnl = n(a.unrealizedProfit) ?? 0;
      if (!bal && !upnl) continue;
      const price = open.find((o) => o.marginCoin === a.asset)?.markPrice ?? prices[a.asset] ?? null;
      accounts.push({ market, asset: a.asset, price, balance: bal, unrealized: upnl, equity: bal + upnl, equityUSD: price != null ? (bal + upnl) * price : null });
    }
  }
  return { accounts, open, closed };
}

async function fetchSnapshot(keys, days = 90) {
  const request = client(keys);
  const end = Date.now(), start = end - days * DAY;
  // Precios en USD (para comisiones en BNB y saldos coin-M sin posición)
  const tick = await request('usdt', '/v1/ticker/price', {}, { signed: false }).catch(() => []);
  const prices = {};
  for (const t of tick) if (t.symbol.endsWith('USDT')) prices[t.symbol.slice(0, -4)] = n(t.price);

  const usdt = await fetchMarket(request, 'usdt', start, end, prices);
  // Coin-M es opcional: si la cuenta no lo tiene habilitado, se sigue solo con USDT-M.
  const coin = await fetchMarket(request, 'coin', start, end, prices).catch((e) => {
    if (/-2015|-2014|-1002/.test(e.message)) return { accounts: [], open: [], closed: [] };
    throw e;
  });
  return {
    exchange: 'Binance', fetched: new Date().toISOString(),
    accounts: [...usdt.accounts, ...coin.accounts], open: [...usdt.open, ...coin.open], closed: [...usdt.closed, ...coin.closed],
  };
}

// ================= Spot =================
// Arma la cartera cripto como operaciones de compra y venta, así se muestra igual que cualquier cartera cripto:
// - Saldo = spot + Funding + Simple Earn (flexible y bloqueado).
// - Compras y ventas: trades contra USDT, USDC o FDUSD, y conversiones (Convert) contra stablecoins.
// - Lo que no se explica con esas operaciones (depósitos, P2P, recompensas, retiros) va como ajuste para que la cantidad
//   coincida con Binance: si sobra, se suma al costo promedio de sus compras (o al precio del día si no hay ninguna);
//   si falta, se descuenta al costo promedio (sin ganancia ni pérdida).
// `prev` es lo guardado de la sincronización anterior (historial de Convert, fecha en que se vio cada moneda).
const SPOT_QUOTES = ['USDT', 'USDC', 'FDUSD'];
const CONVERT_WINDOW = 30 * DAY; // Convert: como mucho 30 días por pedido
const CONVERT_EVERY = 30 * 60e3; // y es caro (peso 3000): se consulta cada 30 minutos
const day = (t) => new Date(t).toISOString().slice(0, 10);

async function fetchSpot(keys, prev = {}) {
  const request = client(keys);
  const now = Date.now();
  const tick = await request('spot', '/api/v3/ticker/price', {}, { signed: false });
  const px = Object.fromEntries(tick.map((t) => [t.symbol, n(t.price)]));
  const usdOf = (a) => (STABLE.has(a) ? 1 : px[a + 'USDT'] ?? null);

  // --- Saldos ---
  const bal = {}, ld = {};
  const add = (a, q) => { q = n(q); if (q) bal[a] = (bal[a] || 0) + q; };
  const account = await request('spot', '/api/v3/account', { omitZeroBalances: 'true' });
  for (const b of account.balances ?? []) {
    const q = (n(b.free) ?? 0) + (n(b.locked) ?? 0);
    if (/^LD./.test(b.asset)) ld[b.asset.slice(2)] = q; // Earn flexible "espejado" en spot: solo si falla la consulta de Earn
    else add(b.asset, q);
  }
  const flex = await request('spot', '/sapi/v1/simple-earn/flexible/position', { size: 100 }).catch(() => null);
  if (flex) for (const r of flex.rows ?? []) add(r.asset, r.totalAmount);
  else for (const [a, q] of Object.entries(ld)) add(a, q);
  const locked = await request('spot', '/sapi/v1/simple-earn/locked/position', { size: 100 }).catch(() => null);
  for (const r of locked?.rows ?? []) add(r.asset, r.amount);
  const funding = await request('spot', '/sapi/v1/asset/get-funding-asset', {}, { method: 'POST' }).catch(() => []);
  for (const r of funding ?? []) add(r.asset, (n(r.free) ?? 0) + (n(r.locked) ?? 0) + (n(r.freeze) ?? 0));

  // Se ignoran pesos u otras monedas sin precio en USDT, y el polvo de menos de 1 USD
  const assets = Object.keys(bal).filter((a) => usdOf(a) != null && bal[a] * usdOf(a) >= 1);

  // --- Convert (incremental) ---
  let convert = prev.convert || [], convertUntil = prev.convertUntil || 0;
  if (now - convertUntil > CONVERT_EVERY) {
    const from = convertUntil ? convertUntil - DAY : now - 365 * DAY;
    const got = [];
    try {
      for (let s = from; s < now; s += CONVERT_WINDOW) {
        const r = await request('spot', '/sapi/v1/convert/tradeFlow', { startTime: s, endTime: Math.min(s + CONVERT_WINDOW, now), limit: 1000 });
        got.push(...(r.list ?? []).filter((c) => c.orderStatus === 'SUCCESS'));
      }
      const byId = new Map(convert.map((c) => [String(c.orderId), c]));
      for (const c of got) byId.set(String(c.orderId), { orderId: String(c.orderId), from: c.fromAsset, to: c.toAsset, fromAmount: n(c.fromAmount), toAmount: n(c.toAmount), time: Number(c.createTime) });
      convert = [...byId.values()];
      convertUntil = now;
    } catch { /* sin permiso o límite: se reintenta la próxima vez con lo que ya había */ }
  }

  // --- Operaciones por moneda ---
  const firstSeen = { ...(prev.firstSeen || {}) };
  const txs = [];
  const tx = (a, ext, side, time, qty, price, fee, note) => txs.push({
    id: ext, externalId: ext, portfolioId: SPOT_ID, side, ticker: a, date: day(time), qty, ratio: 1, price, currency: 'USD', fee, note,
  });
  for (const a of assets) {
    firstSeen[a] ||= day(now);
    if (STABLE.has(a)) { tx(a, `binance-spot-${a}`, 'buy', firstSeen[a], bal[a], 1, 0, 'Saldo en Binance'); continue; }
    const ev = [];
    for (const q of SPOT_QUOTES) {
      const sym = a + q;
      if (px[sym] == null) continue;
      const trades = [];
      for (let fromId = 0, page = 0; page < 50; page++) {
        const r = await request('spot', '/api/v3/myTrades', { symbol: sym, fromId, limit: 1000 });
        trades.push(...r);
        if (r.length < 1000) break;
        fromId = Number(r.at(-1).id) + 1;
      }
      const orders = new Map(); // un pedido llenado en varios trades = una operación
      for (const t of trades) {
        const o = orders.get(t.orderId) || { buy: t.isBuyer, time: Number(t.time), qty: 0, quote: 0, commBase: 0, feeUsd: 0 };
        o.qty += n(t.qty); o.quote += n(t.quoteQty);
        if (t.commissionAsset === a) o.commBase += n(t.commission);
        else o.feeUsd += n(t.commission) * (usdOf(t.commissionAsset) ?? 0);
        orders.set(t.orderId, o);
      }
      for (const [id, o] of orders) {
        const price = o.quote / o.qty;
        ev.push(o.buy
          ? { ext: `binance-spot-${sym}-${id}`, side: 'buy', time: o.time, qty: o.qty - o.commBase, price, fee: o.commBase * price + o.feeUsd, note: `Compra en Binance (${sym})` }
          : { ext: `binance-spot-${sym}-${id}`, side: 'sell', time: o.time, qty: o.qty, price, fee: o.feeUsd, note: `Venta en Binance (${sym})` });
      }
    }
    for (const c of convert) {
      if (c.to === a && STABLE.has(c.from)) ev.push({ ext: 'binance-convert-' + c.orderId, side: 'buy', time: c.time, qty: c.toAmount, price: c.fromAmount / c.toAmount, fee: 0, note: 'Convert desde ' + c.from });
      if (c.from === a && STABLE.has(c.to)) ev.push({ ext: 'binance-convert-' + c.orderId, side: 'sell', time: c.time, qty: c.fromAmount, price: c.toAmount / c.fromAmount, fee: 0, note: 'Convert a ' + c.to });
    }
    // Mismo cálculo que la app (por fecha, compras antes que ventas) para saber cantidad y costo promedio
    ev.sort((x, y) => day(x.time).localeCompare(day(y.time)) || (x.side === y.side ? x.time - y.time : x.side === 'buy' ? -1 : 1));
    let qty = 0, cost = 0;
    for (const e of ev) {
      if (e.side === 'buy') { qty += e.qty; cost += e.qty * e.price + e.fee; }
      else { const q = Math.min(e.qty, qty), avg = qty ? cost / qty : 0; cost -= q * avg; qty -= q; if (qty < 1e-9) { qty = 0; cost = 0; } }
      tx(a, e.ext, e.side, e.time, e.qty, e.price, e.fee, e.note);
    }
    const diff = bal[a] - qty, avg = qty ? cost / qty : null;
    if (Math.abs(diff) * usdOf(a) >= 1) {
      if (diff > 0) {
        const buys = ev.filter((e) => e.side === 'buy'), bq = buys.reduce((s, e) => s + e.qty, 0);
        const p = avg ?? (bq ? buys.reduce((s, e) => s + e.qty * e.price, 0) / bq : usdOf(a));
        tx(a, `binance-spot-${a}-ajuste`, 'buy', firstSeen[a], diff, p, 0, 'Ajuste al saldo de Binance (depósito, P2P, Earn…): costo estimado');
      } else tx(a, `binance-spot-${a}-ajuste`, 'sell', now, -diff, avg ?? usdOf(a), 0, 'Ajuste al saldo de Binance (retiro o transferencia): sin resultado');
    }
  }
  return {
    exchange: 'Binance', fetched: new Date(now).toISOString(), txs,
    holdings: assets.map((a) => ({ asset: a, qty: bal[a], price: usdOf(a) })),
    state: { convert, convertUntil, firstSeen },
  };
}

module.exports = { fetchSnapshot, fetchSpot, PORTFOLIO_ID, SPOT_ID, _test: { reconstruct, mapClosed } }; // _test: para test/
