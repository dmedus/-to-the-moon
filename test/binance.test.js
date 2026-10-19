// Binance: operaciones armadas desde los trades (binance.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { reconstruct, mapClosed } } = require('../binance');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const toUsd = (v) => v || 0;
let id = 0;
const tr = (x) => ({ id: ++id, positionSide: 'LONG', realizedPnl: '0', commission: '0.1', commissionAsset: 'USDT', ...x });

test('modo cobertura: abre en dos partes y cierra', () => {
  const r = reconstruct('SOLUSDT', [
    tr({ side: 'BUY', qty: '1', price: '100', time: 1 }),
    tr({ side: 'BUY', qty: '1', price: '80', time: 2 }),
    tr({ side: 'SELL', qty: '2', price: '110', realizedPnl: '40', time: 3 }),
  ], { coinM: false, toUsd });
  assert.equal(r.done.length, 1);
  const [t] = r.done;
  assert.equal(t.entries, 2);
  assert.equal(t.pnl, 40);
  close(t.fee, 0.3);
  assert.deepEqual(r.open, {});
});

test('lo que queda abierto sale en open', () => {
  const r = reconstruct('SOLUSDT', [tr({ side: 'BUY', qty: '2', price: '100', time: 1 }), tr({ side: 'SELL', qty: '1', price: '110', time: 2 })], { coinM: false, toUsd });
  assert.equal(r.done.length, 0);
  assert.equal(r.open.LONG.pos, 1);
});

test('si cierra más de lo que se vio abrir (empezó antes del período) se descarta', () => {
  const r = reconstruct('SOLUSDT', [tr({ side: 'BUY', qty: '1', price: '100', time: 1 }), tr({ side: 'SELL', qty: '3', price: '110', time: 2 })], { coinM: false, toUsd });
  assert.equal(r.done.length, 0);
});

test('modo unidireccional: dar vuelta la posición cierra una y abre la contraria', () => {
  const r = reconstruct('SOLUSDT', [
    tr({ positionSide: 'BOTH', side: 'BUY', qty: '1', price: '100', time: 1 }),
    tr({ positionSide: 'BOTH', side: 'SELL', qty: '3', price: '110', realizedPnl: '10', time: 2 }),
  ], { coinM: false, toUsd });
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].side, 'LONG');
  close(r.open.SHORT.pos, 2);
});

test('mapClosed: resultado neto = PnL − comisiones + funding', () => {
  const r = reconstruct('SOLUSDT', [tr({ side: 'BUY', qty: '1', price: '100', time: 1 }), tr({ side: 'SELL', qty: '1', price: '110', realizedPnl: '10', time: 2 })], { coinM: false, toUsd });
  const c = mapClosed(r.done[0], 'SOLUSDT', 'USDT-M', 10, -0.5, false, 1);
  close(c.pnl, 10 - 0.2 - 0.5);
  assert.equal(c.funding, -0.5);
  assert.equal(c.margin, 10);
});
