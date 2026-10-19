// Bitget: posiciones abiertas y cerradas (bitget.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { mapOpen, mapClosed } } = require('../bitget');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('USDT-M abierta: tamaño a precio de marca, funding y lo ya pagado', () => {
  const o = mapOpen({ symbol: 'MSTRUSDT', posSide: 'long', total: '10', markPrice: '300', avgPrice: '280', positionBalance: '300', unrealisedPnl: '200', openFeeTotal: '-1', totalFunding: '-2', leverage: '10' }, false);
  assert.equal(o.side, 'LONG');
  assert.equal(o.notional, 3000);
  assert.equal(o.fundingTotal, -2);
  assert.equal(o.fundingTotalBase, -2);
  assert.equal(o.feesPaid, -3);
});

test('coin-M abierta: margen, PnL y funding pasan a USD con el precio; el funding queda también en la moneda', () => {
  const o = mapOpen({ symbol: 'SOLUSD_CM', posSide: 'long', total: '4000', markPrice: '100', positionBalance: '4', unrealisedPnl: '0.5', totalFunding: '-0.2', marginCoin: 'SOL' }, true);
  assert.equal(o.notional, 4000);
  assert.equal(o.margin, 400);
  assert.equal(o.pnl, 50);
  close(o.fundingTotal, -20);
  assert.equal(o.fundingTotalBase, -0.2);
  assert.equal(o.marginBase, 4);
});

test('cerrada: usa el resultado neto y el margen con el apalancamiento dado', () => {
  const c = mapClosed({ positionId: '9', symbol: 'MSTRUSDT', posSide: 'short', openTotalPos: '10', openPriceAvg: '300', closePriceAvg: '290', netProfit: '95', openFeeTotal: '-2', closeFeeTotal: '-2', totalFunding: '-1' }, false, 10);
  assert.equal(c.side, 'SHORT');
  assert.equal(c.pnl, 95);
  assert.equal(c.margin, 300);
  assert.equal(c.fees, -4);
  assert.equal(c.funding, -1);
});
