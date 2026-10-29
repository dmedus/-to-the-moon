// Panel de trading diario (public/js/trading.js): ganadas/perdidas, racha, por día y por mes
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const stub = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub()), apply: () => stub(), set: () => true });
const ctx = vm.createContext({
  document: stub(), window: stub(), navigator: stub(), location: { hash: '' }, localStorage: { getItem: () => null, setItem() {} },
  fetch: () => new Promise(() => {}), setInterval: () => 0, setTimeout: () => 0, Intl, console,
});
for (const f of ['base', 'trading']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../public/js/${f}.js`), 'utf8'), ctx);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const at = (d, h = 12) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).getTime(); // mediodía local: el día no depende del huso

test('tradeStats: ganadas, perdidas, promedios, factor y racha', () => {
  const s = ctx.tradeStats([
    { symbol: 'BTCUSDT', close: at('2026-10-27'), pnl: 10, fees: -1 },
    { symbol: 'BTCUSDT', close: at('2026-10-28'), pnl: -4, fees: -1 },
    { symbol: 'SOLUSDT', close: at('2026-10-28', 15), pnl: 6, fees: -0.5, funding: 0.2 },
    { symbol: 'ETHUSDT', close: at('2026-10-29'), pnl: 2 },
    { symbol: 'XAUTUSDT', close: at('2026-10-29', 15), pnl: -0.4 }, // menos de US$ 1: pareja
    { symbol: 'X', close: null, pnl: 99 }, // sin fecha de cierre: no cuenta
  ]);
  assert.equal(s.won, 3);
  assert.equal(s.lost, 1);
  assert.equal(s.winRate, 0.75);
  assert.equal(s.even, 1);
  assert.equal(s.ops.length, 5);
  close(s.total, 13.6); // la pareja igual suma al resultado
  assert.equal(s.avgWin, 6);
  assert.equal(s.avgLoss, -4);
  assert.equal(s.profitFactor, 4.5);
  assert.equal(s.streak, 2); // las dos últimas ganadas (la pareja del final no corta la racha)
  assert.equal(s.best.pnl, 10);
  assert.equal(s.worst.pnl, -4);
  assert.equal(ctx.tradeStats([{ close: at('2026-10-28'), pnl: 0.99 }, { close: at('2026-10-28', 13), pnl: -0.5 }]).winRate, null);
  assert.equal(s.fees, -2.5);
});

test('tradeStats: agrupa por día y por mes', () => {
  const s = ctx.tradeStats([
    { close: at('2026-10-28'), pnl: -4 }, { close: at('2026-10-28', 15), pnl: 6 },
    { close: at('2026-10-31'), pnl: -1 }, { close: at('2026-11-02'), pnl: 3 }, { close: at('2026-11-02', 14), pnl: 0.5 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(s.days.map((d) => [d.key, d.ops, d.won, d.lost, d.pnl]))), [['2026-10-28', 2, 1, 1, 2], ['2026-10-31', 1, 0, 1, -1], ['2026-11-02', 2, 1, 0, 3.5]]);
  const [oct, nov] = s.months;
  assert.equal(oct.key, '2026-10');
  assert.equal(oct.ops, 3);
  assert.equal(oct.days, 2);
  assert.equal(oct.greenDays, 1);
  assert.equal(oct.bestDay.key, '2026-10-28');
  assert.equal(nov.pnl, 3.5);
  assert.equal(ctx.tradeStats([{ close: at('2026-10-28'), pnl: -1 }]).streak, -1);
});
