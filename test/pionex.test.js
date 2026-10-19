// Resultado de los bots cerrados de Pionex (pionex.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { pionexClosed } = require('../pionex');

test('bot cerrado común: ganancia = lo devuelto − lo invertido', () => {
  assert.deepEqual(pionexClosed({ unlockUsdtAmount: '120', initUsdtInvestment: '100' }), { invested: 100, profit: 20 });
});

test('no suma profitExited (ya está dentro de lo devuelto)', () => {
  assert.deepEqual(pionexClosed({ unlockUsdtAmount: '120', initUsdtInvestment: '100', profitExited: '15' }), { invested: 100, profit: 20 });
});

test('capital agregado a mano cuenta como inversión, sin las ganancias reinvertidas', () => {
  const r = pionexClosed({ unlockUsdtAmount: '160', initUsdtInvestment: '100', initQuoteInvestment: '100', quoteInvestment: '150', profitExited: '10' });
  assert.deepEqual(r, { invested: 140, profit: 20 });
});

test('margen retirado suma a la ganancia', () => {
  const r = pionexClosed({ unlockUsdtAmount: '100', initUsdtInvestment: '100', initExtraMargin: '30', extraMargin: '10' });
  assert.deepEqual(r, { invested: 100, profit: 20 });
});

test('bot con bono: no hay inversión propia y todo lo devuelto es ganancia', () => {
  assert.deepEqual(pionexClosed({ unlockUsdtAmount: '12', usdtInvestment: '50', investmentFrom: 'FUTURE_GRID_BONUS' }), { invested: 0, profit: 12 });
});

test('grilla spot: el resto en moneda base se valúa al precio de cierre', () => {
  const r = pionexClosed({ unlockUsdtAmount: '80', initUsdtInvestment: '100', baseAmount: '0.5', closedPrice: '50' }, 'spot_grid');
  assert.deepEqual(r, { invested: 100, profit: 5 });
});

test('sin datos de cierre devuelve null', () => {
  assert.equal(pionexClosed({ initUsdtInvestment: '100' }), null);
  assert.equal(pionexClosed({ unlockUsdtAmount: 'abc' }), null);
});
