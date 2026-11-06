// Escáner de zonas (escaner.js): indicadores, zonas por cuerpo de vela, Fibonacci y plan de entradas
const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { ema, rsi, zonesOf, fibOf, scoreZone, planOf, CFG } } = require('../escaner');

const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const bar = (t, o, c, h = Math.max(o, c), l = Math.min(o, c)) => ({ t, o, c, h, l, v: 1 });

test('EMA: arranca con el promedio simple y después pondera', () => {
  const e = ema([1, 2, 3, 4], 3);
  assert.equal(e[1], null);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // 4·0,5 + 2·0,5
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 100); // solo subas
});

test('zonas: rebotes en el mismo cuerpo de vela se juntan en una zona', () => {
  // Precio que baja a 100 tres veces (cuerpos) y sube a 110 entre medio
  const c = [];
  let t = 0;
  for (let k = 0; k < 3; k++) {
    for (const p of [110, 108, 105, 102, 100, 102, 105, 108, 110]) c.push(bar(t++, p + 0.5, p, p + 1, p - (p === 100 ? 2 : 0.5)));
  }
  const z = zonesOf(c, 1).find((x) => Math.abs(x.price - 100) < 0.5);
  assert.ok(z, 'falta la zona de 100');
  assert.equal(z.touches, 3);
  assert.equal(z.low, 98); // la mecha más baja, para poner el stop detrás
  assert.ok(z.react >= 0.09); // después de tocar 100 sube a ~111
});

test('Fibonacci: impulso alcista de 100 a 200 → 0,618 en 138,2', () => {
  const d = [bar(0, 120, 110, 120, 100), bar(1, 150, 190, 200, 150), bar(2, 190, 180)];
  const f = fibOf(d);
  assert.equal(f.up, true);
  close(f.levels.find(([r]) => r === 0.618)[1], 138.2, 1e-9);
});

test('nivel: EMA 200 + Fibo 0,66 + toques = nivel 3; sin EMA no pasa de 2', () => {
  const ctx = { price: 120, atr: 1, ema200: 100.2, ema50: 115, bb: { low: 90, up: 130 }, macd: { hist: 1, prev: 0.5 }, fib: { levels: [[0.66, 100.1]] } };
  const z = { price: 100, touches: 3, react: 0.1, low: 99, high: 101 };
  assert.equal(scoreZone(z, 'long', ctx).level, 3);
  assert.equal(scoreZone(z, 'long', { ...ctx, ema200: 80 }).level, 2);
  // cruce de EMAs en contra (EMA 50 abajo de la 200 y precio abajo de la 50) le resta
  assert.ok(scoreZone(z, 'long', { ...ctx, ema50: 125, ema200: 130 }).score < scoreZone(z, 'long', ctx).score);
});

test('plan: 15/30/55 del 10% de la cuenta, stop detrás de la zona siguiente y riesgo en % de la cuenta', () => {
  const ctx = { price: 100, atr: 1, ema200: 96, ema50: 98, bb: { low: 0, up: 999 }, macd: { hist: 1, prev: 0 }, fib: { levels: [[0.66, 94]] } };
  const zones = [98, 96, 94, 90, 110].map((p) => ({ price: p, touches: 2, react: 0.1, low: p - 0.5, high: p + 0.5 }));
  const pl = planOf('long', zones, ctx, 1000);
  assert.deepEqual(pl.entries.map((e) => e.price), [98, 96, 94]);
  assert.deepEqual(pl.entries.map((e) => Math.round(e.margin * 100) / 100), [15, 30, 55]);
  close(pl.stop, 90 - 0.5 - 0.3); // detrás de la zona de 90 (mecha) con un colchón de 0,3 ATR
  assert.equal(pl.tp, 110);
  const qty = pl.entries.reduce((a, e) => a + e.qty, 0);
  close(pl.risk, ((pl.avg - pl.stop) * qty) / 1000);
  assert.equal(pl.leverage, CFG.leverage);
  assert.ok(pl.maxLeverage <= CFG.leverage);
});
