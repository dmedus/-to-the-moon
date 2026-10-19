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
