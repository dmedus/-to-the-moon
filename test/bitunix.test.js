// Bitunix: firma y posiciones abiertas, cerradas y cierres parciales (bitunix.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { _test: { sign, mapOpen, mapClosed, mapPartial } } = require('../bitunix');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('firma: parámetros ordenados por nombre y pegados, sha256 dos veces', () => {
  const keys = { key: 'K', secret: 'S' };
  const expected = sha(sha('n1' + '1700' + 'K' + 'limit100skip0symbolSOLUSDT') + 'S');
  assert.equal(sign(keys, 'n1', '1700', { symbol: 'SOLUSDT', skip: '0', limit: '100' }), expected);
});

test('abierta: tamaño a precio de marca, ROE sobre el margen, comisión y funding ya pagados', () => {
  const o = mapOpen({ positionId: '1', symbol: 'SOLUSDT', side: 'SHORT', qty: '10', avgOpenPrice: '100', margin: '50', unrealizedPNL: '5', fee: '0.6', funding: '-0.2', liqPrice: '0', leverage: 20, ctime: 1000 }, { markPrice: 99.5, fundingRate: 0.0001 });
  assert.equal(o.side, 'SHORT');
  assert.equal(o.notional, 995);
  assert.equal(o.roe, 0.1);
  assert.equal(o.liq, null); // 0 = sin precio de liquidación
  close(o.feesPaid, -0.8);
  assert.equal(o.fundingTotal, -0.2);
  assert.equal(o.fundingRate, 0.0001);
});

test('cerrada: resultado neto = realizado − comisión + funding', () => {
  const c = mapClosed({ positionId: '9', symbol: 'BTCUSDT', side: 'LONG', maxQty: '0.01', entryPrice: '80000', closePrice: '81000', fee: '0.96', funding: '-0.1', realizedPNL: '10', leverage: 10, ctime: 1, mtime: 2 });
  assert.equal(c.externalId, 'bitunix-9');
  close(c.pnl, 10 - 0.96 - 0.1);
  close(c.fees, -0.96);
  assert.equal(c.margin, 80);
  assert.equal(c.exitPrice, 81000);
});

test('cierre parcial: solo si la abierta ya tiene algo realizado', () => {
  const o = { ...mapOpen({ positionId: '5', symbol: 'SOLUSDT', side: 'LONG', qty: '5', avgOpenPrice: '100', margin: '50', leverage: 10, realizedPNL: '-3', mtime: 777, ctime: 100 }), };
  const p = mapPartial(o);
  assert.equal(p.externalId, 'bitunix-parcial-5');
  assert.equal(p.partial, true);
  assert.equal(p.pnl, -3);
  assert.equal(p.close, 777);
  assert.equal(mapPartial(mapOpen({ positionId: '6', qty: '1', realizedPNL: '0' })), null);
});
