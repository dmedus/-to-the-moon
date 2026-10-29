// Cálculos de la pantalla de futuros (public/js/base.js), cargado como en el navegador
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Un "DOM" que acepta cualquier cosa: alcanza para cargar el archivo y usar sus funciones de cálculo
const stub = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub()), apply: () => stub(), set: () => true });
const ctx = vm.createContext({
  document: stub(), window: stub(), navigator: stub(), location: { hash: '' }, localStorage: { getItem: () => null, setItem() {} },
  fetch: () => new Promise(() => {}), setInterval: () => 0, setTimeout: () => 0, Intl, console,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/base.js'), 'utf8'), ctx);
const run = (code) => vm.runInContext(code, ctx);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('próximo funding: el long paga con tasa positiva y el short cobra', () => {
  const e = ctx.fundingEstimate({ side: 'LONG', fundingRate: 0.0001, notional: 10000, fundingHours: 8 });
  close(e.next, -1);
  close(e.perDay, -3);
  close(ctx.fundingEstimate({ side: 'SHORT', fundingRate: 0.0001, notional: 10000 }).next, 1);
  close(ctx.fundingEstimate({ side: 'LONG', fundingRate: 0.0001, notional: 10000, fundingHours: 4 }).perDay, -6);
});

test('próximo funding: sin tasa o sin tamaño no hay estimación', () => {
  assert.equal(ctx.fundingEstimate({ side: 'LONG', notional: 100 }), null);
  assert.equal(ctx.fundingEstimate({ side: 'LONG', fundingRate: 0.0001, notional: 0 }), null);
});

test('ROE: usa el del exchange si viene; si no, PnL sobre el margen inicial', () => {
  assert.equal(ctx.roeOf({ roe: 0.25, pnl: 1 }), 0.25);
  assert.equal(ctx.roeOf({ market: 'USDT-M', leverage: 10, qty: 2, entryPrice: 100, pnl: 5 }), 0.25);
  assert.equal(ctx.roeOf({ market: 'COIN-M', leverage: 5, notional: 1000, pnl: 50 }), 0.25);
});

test('computeFutures: valor, PnL abierto, "si cierro ahora" y realizado', () => {
  run(`state.db = { deposits: [], futuresAccounts: { f: { accounts: [{ equityUSD: 1000 }] } }, futures: [
    { portfolioId: 'f', status: 'open', margin: 100, pnl: 20, notional: 1000, feesPaid: -2, fundingRate: 0.0001, side: 'LONG' },
    { portfolioId: 'f', status: 'closed', margin: 50, pnl: 10, fees: -1, funding: -0.5 },
    { portfolioId: 'f', status: 'closed', margin: 50, pnl: 5, fees: -2, funding: null },
    { portfolioId: 'otra', status: 'closed', margin: 50, pnl: 99 } ] };`);
  const c = run(`computeFutures({ id: 'f', broker: 'BingX' })`);
  assert.equal(c.value, 1000);
  assert.equal(c.unrealized, 20);
  assert.equal(c.realized, 15);
  assert.equal(c.costs.fees, -3);
  assert.equal(c.costs.funding, -0.5);
  assert.equal(c.costs.fundingUnknown, 1); // la de funding desconocido no se cuenta como 0 pagado
  assert.equal(c.costs.openFunding, null);
  close(c.costs.openFundingPerDay, -0.3);
  const [x] = c.positions;
  close(x.net, 20 - 2 - 1000 * 0.0005); // PnL + ya pagado − comisión de cierre estimada
  close(x.fundEst.next, -0.1);
  close(x.weight, 0.12);
});

test('sector: nombre en castellano, ETF aparte y las ligadas a Bitcoin juntas', () => {
  assert.equal(ctx.sectorOf('GOOGL', { sector: 'Communication Services' }), 'Comunicaciones');
  assert.equal(ctx.sectorOf('SPXL', { kind: 'ETF' }), 'ETF / índice');
  assert.equal(ctx.sectorOf('HUT', { sector: 'Financial Services' }), 'Bitcoin / cripto');
  assert.equal(ctx.sectorOf('XYZ', { error: 'sin datos' }), 'Sin dato');
  assert.equal(ctx.sectorOf('XYZ', undefined), null); // todavía no llegó el dato
});

test('sectorGroups: suma por sector y ordena de mayor a menor', () => {
  const info = { NVDA: { sector: 'Technology' }, AVGO: { sector: 'Technology' }, GS: { sector: 'Financial Services' } };
  const g = ctx.sectorGroups([{ ticker: 'GS', value: 50 }, { ticker: 'NVDA', value: 100 }, { ticker: 'AVGO', value: 30 }, { ticker: 'MSTR', value: 70 }], (t) => info[t], (x) => x.value);
  assert.deepEqual(JSON.parse(JSON.stringify(g.map((x) => [x.sector, x.value]))), [['Tecnología', 130], ['Bitcoin / cripto', 70], ['Financiero', 50]]);
  assert.deepEqual([...g[0].tickers.map((t) => t.ticker)], ['NVDA', 'AVGO']);
});

test('coinOf: la moneda del par, sea cual sea el exchange o la cuenta', () => {
  for (const s of ['SOLUSDT', 'SOL-USDT', 'SOLUSD_CM', 'SOL-USD', 'SOLUSD_PERP', 'solusdt']) assert.equal(run('coinOf')(s), 'SOL', s);
  assert.equal(run('coinOf')('XAUTUSDT'), 'XAUT');
  assert.equal(run('coinOf')('MSTRUSDT'), 'MSTR');
});
