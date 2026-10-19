// Claves de exchanges cargadas desde la app (Ajustes), cifradas en disco con AES-256-GCM.
// La llave maestra vive en data/master.key (se crea sola la primera vez). Las claves nunca vuelven al navegador.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MASTER_PATH = path.join(__dirname, 'data', 'master.key');
const FILE = 'keys.enc.json';

function master() {
  if (!fs.existsSync(MASTER_PATH)) fs.writeFileSync(MASTER_PATH, crypto.randomBytes(32).toString('hex'), { flag: 'wx' });
  return Buffer.from(fs.readFileSync(MASTER_PATH, 'utf8').trim(), 'hex');
}

function loadAll(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')); } catch { return {}; }
}
function saveAll(dir, all) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE), tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
}

function get(dir, exchange) {
  const rec = loadAll(dir)[exchange];
  if (!rec) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', master(), Buffer.from(rec.iv, 'hex'));
    d.setAuthTag(Buffer.from(rec.tag, 'hex'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(rec.data, 'hex')), d.final()]).toString('utf8'));
  } catch { return null; } // llave maestra distinta o archivo dañado: como si no hubiera claves
}

function set(dir, exchange, keys) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', master(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(keys), 'utf8'), c.final()]);
  const all = loadAll(dir);
  all[exchange] = { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex'), saved: new Date().toISOString() };
  saveAll(dir, all);
}

function remove(dir, exchange) {
  const all = loadAll(dir);
  if (!(exchange in all)) return;
  delete all[exchange];
  saveAll(dir, all);
}

module.exports = { get, set, remove };
