// Alertas por Telegram: futuros (ROE y liquidación), precios objetivo, ex-dividendos y cupones del mes.
// El servidor las revisa cada pocos minutos aunque nadie tenga la app abierta. Cada usuario conecta su propio chat.
// El bot es uno solo (lo crea el dueño con @BotFather); su token se guarda cifrado con keystore.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NO_ALERTS = new Set(['futuros-bitunix']);
const DEFAULT_RULES = { roe: [20, 30], liqPct: 10, fundingDayPct: 0.5, exdiv: true, coupons: true };
const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_IDX = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dic: 11 };
const usd = (n) => 'US$ ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n, d = 2) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: d });
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const html = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

module.exports = function createAlerts({ DATA_DIR, userDir, readDb, activeUids, keystore, quotes: { stockQuote, cryptoQuote, bondQuote }, dividendInfo, log = console.error }) {
  // ---------- Archivo de cada usuario: alerts.json ----------
  function load(uid) {
    let a = {};
    try { a = JSON.parse(fs.readFileSync(path.join(userDir(uid), 'alerts.json'), 'utf8')); } catch { /* nuevo */ }
    return { chatId: a.chatId || null, rules: { ...DEFAULT_RULES, ...(a.rules || {}) }, targets: a.targets || [], fired: a.fired || {} };
  }
  function save(uid, a) {
    const dir = userDir(uid), file = path.join(dir, 'alerts.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(a, null, 2));
    fs.renameSync(file + '.tmp', file);
  }

  // ---------- Telegram ----------
  const bot = () => keystore.get(DATA_DIR, 'telegram'); // { token, username }
  async function tg(method, params = {}, token = bot()?.token) {
    if (!token) throw new Error('El bot de Telegram no está configurado');
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    if (!j?.ok) throw new Error('Telegram: ' + (j?.description || 'HTTP ' + r.status));
    return j.result;
  }
  const send = (chatId, text) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });

  async function setBot(token) {
    const me = await tg('getMe', {}, token); // valida el token antes de guardarlo
    keystore.set(DATA_DIR, 'telegram', { token, username: me.username });
    offset = 0;
    return me.username;
  }
  function removeBot() { keystore.remove(DATA_DIR, 'telegram'); }

  // Vincular: el usuario abre t.me/<bot>?start=<código> y el bot recibe "/start <código>"
  const pending = new Map(); // código -> { uid, until }
  function linkCode(uid) {
    for (const [c, v] of pending) if (v.uid === uid || v.until < Date.now()) pending.delete(c);
    const code = crypto.randomBytes(6).toString('hex');
    pending.set(code, { uid, until: Date.now() + 15 * 60e3 });
    return { code, url: `https://t.me/${bot()?.username}?start=${code}` };
  }
  // Si Telegram no responde, se anota una sola vez (y otra cuando vuelve) y las consultas automáticas se espacian
  // de 15 s hasta 5 min. Mientras alguien está conectando su Telegram se consulta siempre.
  let offset = 0, polling = false, pollFails = 0, pollSkip = 0;
  function scheduledPoll() {
    if (pollSkip > 0 && !pending.size) { pollSkip--; return; }
    return poll();
  }
  async function poll() {
    if (polling || !bot()) return;
    polling = true;
    try {
      const updates = await tg('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message, text = String(m?.text || '').trim();
        if (!m?.chat?.id) continue;
        const code = text.match(/^\/start\s+([0-9a-f]{12})$/)?.[1];
        const p = code && pending.get(code);
        if (p && p.until > Date.now()) {
          pending.delete(code);
          const a = load(p.uid); a.chatId = m.chat.id; save(p.uid, a);
          await send(m.chat.id, '✅ <b>Listo, quedaste conectado a To the Moon.</b>\nAcá te van a llegar tus alertas. Las configurás en Ajustes → Alertas.');
        } else if (text.startsWith('/start')) {
          await send(m.chat.id, 'Hola 👋 Para recibir alertas, entrá a To the Moon → <b>Ajustes → Alertas</b> y tocá "Conectar mi Telegram".');
        }
      }
      if (pollFails) log(`Telegram (getUpdates): volvió a responder después de ${pollFails} intentos fallidos`);
      pollFails = 0; pollSkip = 0;
    } catch (e) {
      if (!pollFails) log('Telegram (getUpdates):', e.message, '(se reintenta cada vez más espaciado; no se vuelve a anotar hasta que responda)');
      pollFails++;
      pollSkip = Math.min(2 ** (pollFails - 1), 20) - 1;
    } finally { polling = false; }
  }

  // ---------- Evaluación ----------
  // Cada alerta avisa una vez; se vuelve a activar cuando la condición deja de cumplirse (fired[clave] se borra).
  const fire = (a, key) => { if (a.fired[key]) return false; a.fired[key] = Date.now(); return true; };
  const rearm = (a, key) => { delete a.fired[key]; };

  function roeOf(f) {
    if (f.roe != null) return +f.roe * 100;
    const lev = +f.leverage, notional = f.market === 'COIN-M' ? +f.notional : f.qty && f.entryPrice ? Math.abs(f.qty) * f.entryPrice : null;
    return lev && notional ? (f.pnl / (notional / lev)) * 100 : null;
  }

  function futuresAlerts(db, a, out) {
    // Bitunix es para operar en el día: sus posiciones no mandan alertas
    const open = (db.futures || []).filter((f) => f.status === 'open' && !NO_ALERTS.has(f.portfolioId));
    const live = new Set();
    for (const f of open) {
      const id = f.externalId || f.id, name = `${f.symbol} ${f.side === 'SHORT' ? 'short' : 'long'} ${f.leverage ? f.leverage + 'x' : ''}`.trim();
      const exch = (db.portfolios.find((p) => p.id === f.portfolioId) || {}).broker || '';
      const roe = roeOf(f);
      for (const th of a.rules.roe || []) {
        const key = `roe:${id}:${th}`; live.add(key);
        if (roe != null && roe >= th) { if (fire(a, key)) out.push(`🎯 <b>${html(name)}</b> (${html(exch)}) llegó a <b>ROE ${num(roe, 1)}%</b> (umbral ${th}%).\nPnL ${usd(f.pnl)} · precio ${num(f.markPrice, 4)}`); }
        else if (roe != null && roe < th - 5) rearm(a, key);
      }
      if (a.rules.liqPct > 0 && f.liq && f.markPrice) {
        const dist = (f.side === 'SHORT' ? f.liq / f.markPrice - 1 : 1 - f.liq / f.markPrice) * 100;
        const key = `liq:${id}`; live.add(key);
        if (dist <= a.rules.liqPct) { if (fire(a, key)) out.push(`⚠️ <b>${html(name)}</b> (${html(exch)}) está a <b>${num(dist, 1)}%</b> de la liquidación.\nPrecio ${num(f.markPrice, 4)} · liquidación ${num(f.liq, 4)}`); }
        else if (dist > a.rules.liqPct + 3) rearm(a, key);
      }
      // Funding caro: costo diario estimado con la tasa vigente, como % del margen (igual que en la tarjeta)
      if (a.rules.fundingDayPct > 0 && f.fundingRate != null && +f.notional && +f.margin) {
        const next = (f.side === 'SHORT' ? 1 : -1) * f.fundingRate * Math.abs(f.notional), hours = +f.fundingHours || 8;
        const perDay = next * (24 / hours), dayPct = (-perDay / f.margin) * 100;
        const key = `fund:${id}`; live.add(key);
        if (dayPct >= a.rules.fundingDayPct) {
          const at = f.fundingNextTime ? ` a las ${new Date(f.fundingNextTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}` : '';
          if (fire(a, key)) out.push(`💸 <b>${html(name)}</b> (${html(exch)}): el funding está caro, ≈ <b>${usd(-perDay)} por día</b> (${num(dayPct, 2)}% del margen).
Tasa ${num(f.fundingRate * 100, 4)}% cada ${hours} h · próximo cobro ≈ ${usd(-next)}${at}${f.fundingTotal != null ? `
Llevás ${usd(-f.fundingTotal)} pagados` : ''}`);
        } else if (dayPct < a.rules.fundingDayPct * 0.7) rearm(a, key);
      }
    }
    // Posiciones que ya se cerraron: se olvidan sus avisos
    for (const k of Object.keys(a.fired)) if (/^(roe|liq|fund):/.test(k) && !live.has(k)) delete a.fired[k];
  }

  async function targetAlerts(a, out) {
    for (const t of a.targets.filter((x) => !x.done)) {
      try {
        const q = await (t.kind === 'C' ? cryptoQuote(t.sym) : t.kind === 'B' ? bondQuote(t.sym) : stockQuote(t.sym));
        const px = q?.price;
        if (px == null) continue;
        if (t.op === '>=' ? px >= t.price : px <= t.price) {
          t.done = Date.now(); t.hitPrice = px;
          out.push(`🔔 <b>${html(t.sym)}</b> ${t.op === '>=' ? 'subió a' : 'bajó a'} <b>${num(px, 4)}</b> (tu alerta: ${t.op === '>=' ? '≥' : '≤'} ${num(t.price, 4)}${t.kind === 'B' ? ' cada 100 VN' : ''}).${t.note ? '\n' + html(t.note) : ''}`);
        }
      } catch { /* sin precio ahora: se reintenta */ }
    }
  }

  // Tenencias actuales (cantidad > 0) de las carteras de un tipo, rearmando las operaciones
  function holdings(db, types) {
    const pos = {};
    for (const t of [...(db.transactions || [])].sort((x, y) => x.date.localeCompare(y.date))) {
      const p = db.portfolios.find((x) => x.id === t.portfolioId);
      if (!p || !types.includes(p.type)) continue;
      const k = p.id + '|' + t.ticker;
      pos[k] ||= { pid: p.id, type: p.type, ticker: t.ticker, qty: 0, ratio: +t.ratio || 1 };
      pos[k].qty += t.side === 'buy' ? +t.qty : -t.qty;
      pos[k].ratio = +t.ratio || 1;
    }
    return Object.values(pos).filter((x) => x.qty > 1e-9);
  }

  async function exdivAlerts(db, a, out) {
    if (!a.rules.exdiv) return;
    const tomorrow = localDay(new Date(Date.now() + 864e5));
    const tickers = [...new Set(holdings(db, ['cedear', 'stock']).map((x) => x.ticker))];
    const hits = [];
    for (const tk of tickers) {
      try {
        const d = await dividendInfo(tk);
        const next = d?.upcoming?.[0];
        if (next && localDay(new Date(next.date)) === tomorrow && fire(a, `exdiv:${tk}:${tomorrow}`)) hits.push(`• <b>${html(tk)}</b> · último dividendo US$ ${num(d.last.amount, 4)} por acción`);
      } catch { /* sin datos */ }
    }
    if (hits.length) out.push(`📅 <b>Mañana es ex-dividendo (estimado)</b> de:\n${hits.join('\n')}\nPara cobrarlo tenés que tenerlas antes de esa fecha.`);
  }

  function couponAlerts(db, a, out) {
    const now = new Date();
    if (!a.rules.coupons || now.getDate() !== 1 || now.getHours() < 9) return;
    const key = `cup:${now.getFullYear()}-${now.getMonth()}`;
    if (a.fired[key]) return;
    const info = db.settings?.bondInfo || {};
    const lines = [];
    let total = 0;
    for (const h of holdings(db, ['bonds'])) {
      const i = info[h.ticker];
      if (!i || !(+i.rate > 0) || !(+i.perYear > 0) || /peso/i.test(i.currency || '')) continue;
      if (i.maturity && new Date(i.maturity + 'T12:00') < new Date(now.getFullYear(), now.getMonth(), 1)) continue;
      const months = +i.perYear === 12 || /mensual/i.test(i.months || '') ? [...Array(12).keys()]
        : (String(i.months || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{3}/g) || []).map((m) => MES_IDX[m]);
      if (!months.includes(now.getMonth())) continue;
      const amt = (h.qty * +i.rate) / +i.perYear;
      total += amt;
      lines.push(`• <b>${html(h.ticker)}</b> ${usd(amt)}`);
    }
    a.fired[key] = Date.now();
    if (lines.length) out.push(`💵 <b>Cupones estimados de ${MES[now.getMonth()]}: ${usd(total)}</b>\n${lines.join('\n')}\n(solo interés; el día exacto puede variar)`);
  }

  let running = false, lastExdiv = {};
  async function run() {
    if (running || !bot()) return;
    running = true;
    try {
      for (const uid of activeUids()) {
        const a = load(uid);
        if (!a.chatId) continue;
        const before = JSON.stringify(a), out = [];
        let db;
        try { db = readDb(uid); } catch { continue; }
        futuresAlerts(db, a, out);
        await targetAlerts(a, out);
        // Ex-dividendos: una vez por día, desde las 10
        if (new Date().getHours() >= 10 && lastExdiv[uid] !== localDay()) { await exdivAlerts(db, a, out); lastExdiv[uid] = localDay(); }
        couponAlerts(db, a, out);
        for (const msg of out) { try { await send(a.chatId, msg); } catch (e) { log('Telegram (envío):', e.message); } }
        if (JSON.stringify(a) !== before) save(uid, a);
      }
    } catch (e) { log('Alertas:', e.message); }
    finally { running = false; }
  }

  // ---------- Reglas (desde Ajustes) ----------
  function setRules(uid, r) {
    const a = load(uid);
    const roe = String(r.roe ?? '').split(/[,;\s]+/).map(Number).filter((x) => x > 0 && x <= 1000).slice(0, 5);
    a.rules = { roe, liqPct: Math.max(0, Math.min(90, +r.liqPct || 0)), fundingDayPct: Math.max(0, Math.min(100, +r.fundingDayPct || 0)), exdiv: !!r.exdiv, coupons: !!r.coupons };
    save(uid, a);
    return a.rules;
  }
  function addTarget(uid, t) {
    const sym = String(t.sym || '').trim().toUpperCase(), price = +t.price;
    if (!/^[A-Z0-9.^=-]{1,15}$/.test(sym) || !(price > 0) || !['>=', '<='].includes(t.op) || !['S', 'C', 'B'].includes(t.kind)) throw new Error('Alerta inválida');
    const a = load(uid);
    if (a.targets.filter((x) => !x.done).length >= 50) throw new Error('Máximo 50 alertas de precio activas');
    a.targets.push({ id: crypto.randomBytes(5).toString('hex'), kind: t.kind, sym, op: t.op, price, note: String(t.note || '').slice(0, 120), created: Date.now() });
    save(uid, a);
  }
  function removeTarget(uid, id) { const a = load(uid); a.targets = a.targets.filter((x) => x.id !== id); save(uid, a); }
  function unlink(uid) { const a = load(uid); a.chatId = null; save(uid, a); }
  async function test(uid) {
    const a = load(uid);
    if (!a.chatId) throw new Error('Primero conectá tu Telegram');
    await send(a.chatId, '🚀 <b>Prueba de To the Moon</b>\nSi ves este mensaje, las alertas te van a llegar acá.');
  }
  function status(uid, isAdmin) {
    const a = load(uid), b = bot();
    return { bot: b ? { username: b.username } : null, canSetBot: isAdmin, linked: !!a.chatId, rules: a.rules,
      targets: a.targets.sort((x, y) => (x.done ? 1 : 0) - (y.done ? 1 : 0) || y.created - x.created).slice(0, 80) };
  }

  setInterval(scheduledPoll, 15_000);
  setInterval(run, 3 * 60_000);
  setTimeout(run, 20_000);
  // Manda un archivo al chat del dueño (lo usa el backup diario). Si no conectó Telegram, avisa con un error.
  async function sendFileToOwner(name, buffer, caption) {
    const b = bot(), chatId = load('owner').chatId;
    if (!b || !chatId) throw new Error('el dueño no tiene Telegram conectado');
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('caption', caption || '');
    fd.append('document', new Blob([buffer]), name);
    const r = await fetch(`https://api.telegram.org/bot${b.token}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => null);
    if (!j?.ok) throw new Error('Telegram: ' + (j?.description || 'HTTP ' + r.status));
  }
  const ownerLinked = () => !!(bot() && load('owner').chatId);

  return { status, setBot, removeBot, linkCode, unlink, test, setRules, addTarget, removeTarget, poll, run, sendFileToOwner, ownerLinked, _test: { scheduledPoll } };
};
