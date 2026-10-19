// Alerta de funding caro por Telegram (alerts.js), con Telegram simulado
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sent = [];
global.fetch = async (url, opts) => {
  if (String(url).endsWith('/sendMessage')) sent.push(JSON.parse(opts.body).text);
  return { ok: true, json: async () => ({ ok: true, result: [] }) };
};
// alerts.js programa sus revisiones con timers al crearse: se anulan para que la prueba termine
const timers = { setInterval: global.setInterval, setTimeout: global.setTimeout };
global.setInterval = () => 0;
global.setTimeout = () => 0;
const createAlerts = require('../alerts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alertas-'));
let db;
const alerts = createAlerts({
  DATA_DIR: dir, userDir: () => dir, readDb: () => db, activeUids: () => ['owner'],
  keystore: { get: () => ({ token: 'x', username: 'bot' }) }, quotes: {}, dividendInfo: async () => ({}), log: () => {},
});
Object.assign(global, timers);
fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify({ chatId: 1, rules: { roe: [], liqPct: 0, fundingDayPct: 0.5, exdiv: false, coupons: false } }));

const pos = (rate, extra = {}) => ({
  portfolioId: 'f', externalId: 'sol', status: 'open', symbol: 'SOL-USDT', side: 'LONG', leverage: 10,
  notional: 10000, margin: 1000, pnl: 0, fundingRate: rate, fundingHours: 8, fundingTotal: -12, ...extra,
});
async function check(rate, extra) {
  db = { portfolios: [{ id: 'f', broker: 'BingX' }], futures: [pos(rate, extra)], transactions: [] };
  sent.length = 0;
  await alerts.run();
  return [...sent];
}

test('avisa cuando el costo diario supera el umbral, una sola vez', async () => {
  // 0,02% cada 8 h sobre 10.000 = 2 por cobro, 6 por día = 0,6% de 1.000 de margen
  const msgs = await check(0.0002);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /SOL-USDT long 10x/);
  assert.match(msgs[0], /US\$ 6,00 por día/);
  assert.match(msgs[0], /0,6% del margen/);
  assert.match(msgs[0], /Llevás US\$ 12,00 pagados/);
  assert.deepEqual(await check(0.0002), []);
});

test('se rearma solo cuando baja del 70% del umbral', async () => {
  assert.deepEqual(await check(0.00015), []); // 0,45%: abajo del umbral pero arriba del 70%
  assert.deepEqual(await check(0.0002), []); // todavía no se rearmó
  assert.deepEqual(await check(0.0001), []); // 0,3%: se rearma
  assert.equal((await check(0.0002)).length, 1);
});

test('no avisa si la posición cobra funding (short con tasa positiva)', async () => {
  await check(0.0001); // rearma
  assert.deepEqual(await check(0.0005, { side: 'SHORT' }), []);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
