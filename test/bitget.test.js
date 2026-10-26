// Bitget: posiciones abiertas y cerradas (bitget.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { mapOpen, mapClosed, mapPartials } } = require('../bitget');

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

test('cierre parcial: agrupa las ejecuciones por orden y resta la comisión (coin-M)', () => {
  const open = [{ symbol: 'SOLUSD_CM', side: 'LONG', market: 'COIN-M', open: 1000, entryPrice: 109, leverage: 10 }];
  const fills = [
    { orderId: 'a', symbol: 'SOLUSD_CM', tradeSide: 'close_long', posSide: 'long', execPrice: '100', execQty: '600', execPnl: '-0.5', feeDetail: [{ fee: '0.003' }], createdTime: '5000' },
    { orderId: 'a', symbol: 'SOLUSD_CM', tradeSide: 'close_long', posSide: 'long', execPrice: '102', execQty: '400', execPnl: '-0.2', feeDetail: [{ fee: '0.002' }], createdTime: '5001' },
    { orderId: 'b', symbol: 'SOLUSD_CM', tradeSide: 'open_long', posSide: 'long', execPrice: '101', execQty: '52', execPnl: '0', createdTime: '4000' },
    { orderId: 'c', symbol: 'SOLUSD_CM', tradeSide: 'close_long', posSide: 'long', execPrice: '90', execQty: '10', execPnl: '-1', createdTime: '500' }, // de antes de abrir la actual
  ];
  const [p, ...rest] = mapPartials(fills, open);
  assert.equal(rest.length, 0);
  assert.equal(p.externalId, 'bitget-parcial-a');
  assert.equal(p.partial, true);
  assert.equal(p.qty, 1000);
  close(p.exitPrice, 100.8);
  close(p.pnlBase, -0.705);
  close(p.pnl, (-0.5 - 0.003) * 100 + (-0.2 - 0.002) * 102);
  close(p.fees, -(0.003 * 100 + 0.002 * 102));
  assert.equal(p.margin, 100);
  assert.equal(p.close, 5001);
});
