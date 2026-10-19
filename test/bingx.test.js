// BingX: armado de operaciones, funding y guardado en la base (bingx.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSnapshot, _test: { reconstructUsdtm, reconstructCoinm, fundingSince } } = require('../bingx');

const H = 36e5;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const ord = (o) => ({ positionID: 'P1', positionSide: 'LONG', leverage: '10x', commission: '-0.1', profit: '0', ...o });

test('USDT-M: dos entradas y un cierre forman una operación con comisiones y funding', () => {
  const orders = [
    ord({ side: 'BUY', executedQty: '1', avgPrice: '100', updateTime: 1000 }),
    ord({ side: 'BUY', executedQty: '1', avgPrice: '80', updateTime: 2000 }),
    ord({ side: 'SELL', executedQty: '2', avgPrice: '110', profit: '40', updateTime: 3000 }),
  ];
  const funding = [
    { symbol: 'SOL-USDT', time: 1500, income: '-0.5' },
    { symbol: 'SOL-USDT', time: 9000, income: '-9' }, // después del cierre: no cuenta
    { symbol: 'BTC-USDT', time: 1500, income: '-9' }, // otro par
  ];
  const [t] = reconstructUsdtm('SOL-USDT', orders, funding);
  assert.equal(t.entries, 2);
  assert.equal(t.entryPrice, 90);
  assert.equal(t.exitPrice, 110);
  assert.equal(t.leverage, 10);
  close(t.fees, -0.3);
  assert.equal(t.funding, -0.5);
  close(t.pnl, 40 - 0.3 - 0.5);
});

test('USDT-M: una posición todavía abierta o que empezó antes del período no sale como cerrada', () => {
  const abierta = [ord({ side: 'BUY', executedQty: '2', avgPrice: '1', updateTime: 1 }), ord({ side: 'SELL', executedQty: '1', avgPrice: '1', updateTime: 2 })];
  assert.equal(reconstructUsdtm('S', abierta, []).length, 0);
  assert.equal(reconstructUsdtm('S', [ord({ side: 'SELL', executedQty: '1', avgPrice: '1', updateTime: 2 })], []).length, 0);
});

test('coin-M: resultado en la moneda y en USD; si queda abierta informa desde cuándo', () => {
  const o = (x) => ({ positionSide: 'LONG', commission: '-0.00001', profit: '0', leverage: '5', ...x });
  const trades = reconstructCoinm('BTC-USD', [
    o({ side: 'BUY', quantity: '10', avgPrice: '50000', updateTime: 1 }),
    o({ side: 'SELL', quantity: '10', avgPrice: '55000', profit: '0.0018', updateTime: 2 }),
    o({ side: 'BUY', quantity: '3', avgPrice: '60000', updateTime: 3 }),
  ], 100);
  assert.equal(trades.length, 1);
  const [t] = trades;
  assert.equal(t.notional, 1000);
  assert.equal(t.margin, 200);
  close(t.pnlBase, 0.0018 - 0.00002);
  close(t.pnl, t.pnlBase * 55000);
  assert.equal(trades.openSince, 3);
});

test('fundingSince: total y último cobro desde que se abrió la posición', () => {
  const rows = [
    { symbol: 'SOL-USDT', time: 100, income: '-5' }, // antes de abrir
    { symbol: 'SOL-USDT', time: 300, income: '-0.2' },
    { symbol: 'SOL-USDT', time: 200, income: '0.1' },
    { symbol: 'ETH-USDT', time: 400, income: '-1' },
  ];
  const r = fundingSince(rows, 'SOL-USDT', 150);
  close(r.fundingTotal, -0.1);
  assert.equal(r.fundingLast, -0.2);
  assert.equal(r.fundingLastTime, 300);
  assert.deepEqual(fundingSince(rows, 'XRP-USDT', 0), {});
});

const base = () => ({ portfolios: [{ id: 'futuros-bingx' }], futures: [] });
const snap = (t, open, closed = [], exchange = 'BingX') => ({ exchange, fetched: new Date(t).toISOString(), accounts: [], open, closed });

test('mergeSnapshot: las cerradas se acumulan y las abiertas se reemplazan', () => {
  const db = base();
  mergeSnapshot(db, snap(0, [{ externalId: 'a', status: 'open' }], [{ externalId: 'c1', status: 'closed', pnl: 1 }]));
  mergeSnapshot(db, snap(H, [{ externalId: 'b', status: 'open' }], [{ externalId: 'c2', status: 'closed', pnl: 2 }]));
  mergeSnapshot(db, snap(2 * H, [], [{ externalId: 'c2', status: 'closed', pnl: 3 }]));
  assert.deepEqual(db.futures.filter((f) => f.status === 'closed').map((f) => [f.externalId, f.pnl]).sort(), [['c1', 1], ['c2', 3]]);
  assert.equal(db.futures.filter((f) => f.status === 'open').length, 0);
});

test('mergeSnapshot crea la cartera si no existe', () => {
  const db = { portfolios: [{ id: 'x', slot: 1 }] };
  mergeSnapshot(db, snap(0, []));
  assert.deepEqual(db.portfolios[1], { id: 'futuros-bingx', name: 'Futuros BingX', type: 'futures', broker: 'BingX', slot: 2 });
});

// Funding de coin-M deducido del saldo de la billetera (BingX no da el historial)
const T = Date.UTC(2026, 9, 19, 15, 55); // 5 minutos antes del funding de las 16:00 UTC
const coin = (bal, orders = [], extra = {}) => ({ externalId: 'btc', status: 'open', open: 1, markPrice: 100000, walletBase: bal, _orders: orders, ...extra });

test('coin-M: el funding es lo que cambió el saldo menos lo realizado por órdenes, solo si pasó una hora de funding', () => {
  const db = base();
  mergeSnapshot(db, snap(T, [coin(0.02)]));
  assert.equal(db.futures[0].fundingTotal, 0);
  assert.equal(db.futures[0].fundingFrom, T);
  // sin hora de funding en el medio: lo que cambió el saldo no es funding
  mergeSnapshot(db, snap(T + 3 * 6e4, [coin(0.0201, [[T + 2 * 6e4, 0.0001]])]));
  assert.equal(db.futures[0].fundingLast, undefined);
  // cruza las 16:00: el saldo bajó 0,000001 y una orden sumó 0,0000005 → funding −0,0000015 BTC
  mergeSnapshot(db, snap(T + 6 * 6e4, [coin(0.020099, [[T + 5 * 6e4, 0.0000005]])]));
  const f = db.futures[0];
  close(f.fundingLast, -0.0000015 * 100000);
  assert.equal(f.fundingLastTime, Date.UTC(2026, 9, 19, 16));
  assert.equal(f.fundingTotal, f.fundingLast);
  assert.equal('_orders' in f, false);
  // la sincronización siguiente lo conserva
  mergeSnapshot(db, snap(T + 9 * 6e4, [coin(0.020099)]));
  assert.equal(db.futures[0].fundingLast, f.fundingLast);
  assert.equal(db.futures[0].fundingFrom, T);
});

test('coin-M: si se cierra y se abre otra posición, el funding vuelve a empezar', () => {
  const db = base();
  mergeSnapshot(db, snap(T, [coin(0.02)]));
  mergeSnapshot(db, snap(T + 6 * 6e4, [coin(0.0199)]));
  assert.ok(db.futures[0].fundingTotal < 0);
  mergeSnapshot(db, snap(T + 9 * 6e4, [coin(0.0199, [], { open: 2 })]));
  assert.equal(db.futures[0].fundingTotal, 0);
  assert.equal(db.futures[0].fundingLast, undefined);
});

// Bitget: solo da el acumulado; el último sale de la diferencia en la moneda del margen
const bg = (t, totalBase, mark) => snap(t, [{ externalId: 's', status: 'open', market: 'COIN-M', markPrice: mark, fundingTotalBase: totalBase, fundingTotal: totalBase * mark }], [], 'Bitget');

test('Bitget coin-M: un cambio de precio no se toma como funding', () => {
  const db = { portfolios: [{ id: 'futuros-bitget' }] };
  mergeSnapshot(db, bg(T, -0.1, 100), 'futuros-bitget');
  mergeSnapshot(db, bg(T + 3 * 6e4, -0.1, 105), 'futuros-bitget');
  assert.equal(db.futures[0].fundingLast, undefined);
});

test('Bitget coin-M: al cruzar una hora de funding, el último es la diferencia valuada al precio', () => {
  const db = { portfolios: [{ id: 'futuros-bitget' }] };
  mergeSnapshot(db, bg(T, -0.1, 100), 'futuros-bitget');
  mergeSnapshot(db, bg(T + 6 * 6e4, -0.105, 101), 'futuros-bitget');
  close(db.futures[0].fundingLast, -0.505);
  mergeSnapshot(db, bg(T + 9 * 6e4, -0.105, 102), 'futuros-bitget');
  close(db.futures[0].fundingLast, -0.505);
});
