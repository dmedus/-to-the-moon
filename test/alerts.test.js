// Alerta de funding caro por Telegram (alerts.js), con Telegram simulado
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sent = [];
let telegramDown = false, getUpdatesCalls = 0;
global.fetch = async (url, opts) => {
  if (String(url).endsWith('/getUpdates')) { getUpdatesCalls++; if (telegramDown) throw new Error('fetch failed'); }
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
const logs = [];
const alerts = createAlerts({
  DATA_DIR: dir, userDir: () => dir, readDb: () => db, activeUids: () => ['owner'],
  keystore: { get: () => ({ token: 'x', username: 'bot' }) }, quotes: {}, dividendInfo: async () => ({}), log: (...a) => logs.push(a.join(' ')),
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

test('Telegram caído: se anota una vez, se espacian los reintentos y se avisa cuando vuelve', async () => {
  const { scheduledPoll } = alerts._test;
  telegramDown = true; logs.length = 0; getUpdatesCalls = 0;
  for (let i = 0; i < 40; i++) await scheduledPoll(); // 40 ticks de 15 s = 10 minutos
  assert.equal(logs.length, 1);
  assert.match(logs[0], /fetch failed/);
  // intentos en los ticks 1, 2, 4, 8, 16, 32 (esperas de 15 s, 30 s, 1, 2, 4 min) y después cada 5 min
  assert.equal(getUpdatesCalls, 6);
  telegramDown = false;
  for (let i = 0; i < 20 && getUpdatesCalls === 6; i++) await scheduledPoll();
  assert.match(logs[1], /volvió a responder después de 6 intentos fallidos/);
  getUpdatesCalls = 0;
  for (let i = 0; i < 3; i++) await scheduledPoll(); // de nuevo cada 15 s
  assert.equal(getUpdatesCalls, 3);
  assert.equal(logs.length, 2);
});

test('mientras alguien conecta su Telegram no se espera', async () => {
  const { scheduledPoll } = alerts._test;
  telegramDown = true;
  for (let i = 0; i < 5; i++) await scheduledPoll();
  alerts.linkCode('owner');
  getUpdatesCalls = 0;
  for (let i = 0; i < 3; i++) await scheduledPoll();
  assert.equal(getUpdatesCalls, 3);
  telegramDown = false;
  await scheduledPoll();
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
