// Copia de seguridad diaria de toda la carpeta data/ (carteras, usuarios, claves, historia, alertas), fuera de la PC.
// Se cifra con una contraseña del dueño (AES-256-GCM con clave derivada por scrypt) y se guarda en la carpeta de
// OneDrive (que la sube sola a la nube) y, opcionalmente, se manda por Telegram. Se restaura con restaurar-backup.js.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('TTMBK1');
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEEP_DAYS = 30;
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Formato del archivo: "TTMBK1" + sal(16) + iv(12) + tag(16) + datos cifrados (JSON con los archivos, comprimido)
function encrypt(plain, key, salt) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(zlib.gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), data]);
}
function decrypt(buf, password) {
  if (!buf.subarray(0, 6).equals(MAGIC)) throw new Error('No es un backup de To the Moon');
  const salt = buf.subarray(6, 22), iv = buf.subarray(22, 34), tag = buf.subarray(34, 50);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try { return zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(50)), d.final()])); }
  catch { throw new Error('Contraseña incorrecta o archivo dañado'); }
}

// Todos los archivos de data/ menos las copias diarias locales, temporales y el log
function collect(dataDir) {
  const files = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name), rel = path.relative(dataDir, full).split(path.sep).join('/');
      if (e.isDirectory()) { if (e.name !== 'backups') walk(full); continue; }
      if (/\.tmp$|\.log$/.test(e.name)) continue;
      files[rel] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(dataDir);
  return files;
}

module.exports = function createBackup({ DATA_DIR, keystore, sendTelegramFile, log = console.error }) {
  const CFG = path.join(DATA_DIR, 'backup.json');
  const defaultFolder = () => (process.env.OneDrive ? path.join(process.env.OneDrive, 'To the Moon - backups') : null);
  function cfg() {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { /* nuevo */ }
    // folder: undefined = nunca se configuró (se usa OneDrive); null = el dueño lo desactivó
    return { folder: 'folder' in c ? c.folder : defaultFolder(), telegram: c.telegram ?? true, last: c.last || null, error: c.error || null };
  }
  function saveCfg(c) { fs.writeFileSync(CFG + '.tmp', JSON.stringify(c, null, 2)); fs.renameSync(CFG + '.tmp', CFG); }

  // La contraseña no se guarda: se guarda la clave derivada (cifrada con keystore) y su sal
  function setPassword(password) {
    if (typeof password !== 'string' || password.length < 10) throw new Error('La contraseña del backup tiene que tener al menos 10 caracteres');
    const salt = crypto.randomBytes(16);
    keystore.set(DATA_DIR, 'backup', { salt: salt.toString('hex'), key: crypto.scryptSync(password, salt, 32, SCRYPT).toString('hex') });
  }
  const configured = () => !!keystore.get(DATA_DIR, 'backup');

  let running = false;
  async function run({ manual = false } = {}) {
    if (running) throw new Error('Ya se está haciendo una copia');
    const k = keystore.get(DATA_DIR, 'backup');
    if (!k) throw new Error('Primero elegí la contraseña del backup');
    running = true;
    const c = cfg();
    try {
      const day = localDay(), name = `to-the-moon-${day}.ttmbak`;
      const bundle = JSON.stringify({ app: 'To the Moon', created: new Date().toISOString(), files: collect(DATA_DIR) });
      const file = encrypt(Buffer.from(bundle), Buffer.from(k.key, 'hex'), Buffer.from(k.salt, 'hex'));
      const where = [];
      if (c.folder) {
        fs.mkdirSync(c.folder, { recursive: true });
        fs.writeFileSync(path.join(c.folder, name), file);
        where.push('OneDrive');
        // Se guardan los últimos 30 días
        const old = fs.readdirSync(c.folder).filter((f) => /^to-the-moon-\d{4}-\d{2}-\d{2}\.ttmbak$/.test(f)).sort().slice(0, -KEEP_DAYS);
        for (const f of old) fs.unlinkSync(path.join(c.folder, f));
      }
      if (c.telegram && sendTelegramFile) {
        try { await sendTelegramFile(name, file, `🗄 Backup de To the Moon del ${day.split('-').reverse().join('/')}`); where.push('Telegram'); }
        catch (e) { log('Backup por Telegram:', e.message); }
      }
      if (!where.length) throw new Error('No hay ningún destino: activá OneDrive o Telegram');
      c.last = { at: new Date().toISOString(), day, size: file.length, where, manual };
      c.error = null;
      saveCfg(c);
      return c.last;
    } catch (e) {
      c.error = { at: new Date().toISOString(), message: e.message };
      saveCfg(c);
      throw e;
    } finally { running = false; }
  }

  // Una vez por día, desde las 3 de la mañana (o apenas prende la PC si ya pasó esa hora)
  async function tick() {
    if (!configured() || running) return;
    const c = cfg();
    if (new Date().getHours() < 3 || c.last?.day === localDay()) return;
    try { await run(); } catch (e) { log('Backup:', e.message); }
  }
  setInterval(tick, 30 * 60e3);
  setTimeout(tick, 60e3);

  function status() {
    const c = cfg();
    let files = [];
    try { files = c.folder ? fs.readdirSync(c.folder).filter((f) => f.endsWith('.ttmbak')).sort().reverse().slice(0, 5) : []; } catch { /* carpeta inexistente */ }
    return { configured: configured(), folder: c.folder, oneDrive: !!process.env.OneDrive, telegram: c.telegram, last: c.last, error: c.error, files };
  }
  function setOptions({ telegram, oneDrive }) {
    const c = cfg();
    if (typeof telegram === 'boolean') c.telegram = telegram;
    if (typeof oneDrive === 'boolean') c.folder = oneDrive ? defaultFolder() : null;
    saveCfg(c);
  }
  return { status, setPassword, run, setOptions };
};
module.exports.decrypt = decrypt;
