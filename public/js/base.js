'use strict';

// ================= Estado =================
const state = {
  db: null,
  ratios: {},
  quotes: { stocks: {}, crypto: {}, bonds: {}, errors: {} },
  ccl: null,
  lastUpdate: null,
  pionex: { configured: false, error: null, syncing: false },
  bingx: { configured: false, error: null, syncing: false },
  bitget: { configured: false, error: null, syncing: false },
  binance: { configured: false, error: null, syncing: false },
  role: null, // 'owner' (ve y edita todo) o 'guest' (solo lectura, sin montos)
  hide: false, // ocultar montos en dólares y pesos
  sort: {},
  allocMode: {}, // por cartera: 'value' (valor actual) o 'cost' (invertido)
  reglas: [], // imágenes de app/public/reglas
  filters: { ops: { pid: '', q: '', side: '' } },
};

const TYPES = { cedear: 'CEDEARs (ARS → USD)', stock: 'Acciones en USD', bonds: 'Bonos y ONs (USD)', crypto: 'Cripto', bots: 'Bots de grilla', futures: 'Futuros' };
// Bonos y ONs: la cantidad es valor nominal (VN) y el precio va cada 100 VN, como en el broker.
// Se guardan con ratio 100 y priceBase 100: costo = VN × precio ÷ 100 y valor = VN ÷ 100 × precio actual.
const BOND_BASE = 100;
const SYNCED = new Set(['bots', 'futures']); // carteras que se cargan desde un exchange, sin operaciones manuales
const BOT_KINDS = { futures_grid: 'Grilla futuros', spot_grid: 'Grilla spot', other: 'Otro' };
const TRENDS = { long: 'Long', short: 'Short', neutral: 'Neutral' };
const $ = (sel, root = document) => root.querySelector(sel);

// ================= Formato =================
const nfUSD = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfARS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Con "ocultar montos" (o para el invitado) los importes se muestran como •••; los % siguen visibles.
const MASK = '•••';
const usd = (n) => (n == null || !isFinite(n) ? '—' : state.hide ? MASK : nfUSD.format(n));
const ars = (n) => (n == null || !isFinite(n) ? '—' : state.hide ? MASK : nfARS.format(n));
const qty = (n, max = 4) => (state.hide && n != null ? MASK : num(n, max));
const num = (n, max = 4) => (n == null || !isFinite(n) ? '—' : n.toLocaleString('es-AR', { maximumFractionDigits: max }));
const price = (n) => (n == null || !isFinite(n) ? '—' : n.toLocaleString('es-AR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 }));
const pct = (n) => (n == null || !isFinite(n) ? '—' : (n > 0 ? '+' : '') + (n * 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%');
const signed = (n) => (n == null || !isFinite(n) ? '—' : state.hide ? (n > 0 ? '+' : n < 0 ? '−' : '') + MASK : (n > 0 ? '+' : '') + nfUSD.format(n));
const cls = (n) => (n > 0.000001 ? 'pos' : n < -0.000001 ? 'neg' : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 12);
// Preferencias de pantalla que se recuerdan en este navegador (qué lista ver, qué medias mostrar, período del gráfico…)
const prefGet = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const prefSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento: queda solo en esta sesión */ } };
// Arrastre de filas en la tabla "Cartera" (ver más abajo); mientras se arrastra no se redibuja la pantalla
const rowDrag = { row: null, box: null, active: false, startY: 0, ended: 0, pending: false };
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => (d ? d.split('-').reverse().join('/') : '—');
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const slotColor = (p) => `var(--series-${((p.slot || 1) - 1) % 8 + 1})`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ================= API =================
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Sesión vencida'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
// isOwner: puede editar sus datos (el dueño y cada amigo). isAdmin: el dueño, que administra usuarios.
const isOwner = () => state.role === 'owner' || state.role === 'member';
const isAdmin = () => state.role === 'owner';
async function save() {
  if (!isOwner()) return;
  try {
    await api('/api/db', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.db) });
  } catch (e) { toast('Error al guardar: ' + e.message); }
}

// ================= Cálculos =================
const unitUSD = (t) => (t.currency === 'ARS' ? t.price / t.fx : t.price) / (+t.priceBase || 1);
const portfolio = (id) => state.db.portfolios.find((p) => p.id === id);

// Precios: S = acciones/CEDEARs, C = cripto, B = bonos y ONs (cada 100 VN)
const quoteKind = (p) => (p.type === 'crypto' ? 'C' : p.type === 'bonds' ? 'B' : 'S');
function quoteFor(p, ticker) {
  const kind = quoteKind(p);
  const manual = state.db.manualPrices?.[kind + ':' + ticker];
  if (manual != null && manual !== '') return { price: +manual, prevClose: null, manual: true };
  return ({ C: state.quotes.crypto, B: state.quotes.bonds, S: state.quotes.stocks }[kind] || {})[ticker] || null;
}

// Carteras de bots: cada bot es una "posición" con inversión y ganancia informadas por el exchange.
function computeBots(p) {
  const bots = state.db.bots.filter((b) => b.portfolioId === p.id);
  const positions = bots.filter((b) => b.status === 'running').map((b) => {
    const value = +b.invested + +b.profit;
    return { ...b, ticker: b.pair, cost: +b.invested, value, pnl: +b.profit, pnlPct: +b.invested ? +b.profit / +b.invested : null, dayChg: null, days: b.start ? daysBetween(b.start, today()) : null };
  });
  const closed = bots.filter((b) => b.status !== 'running').map((b) => ({ ...b, pnl: +b.profit, pct: +b.invested ? +b.profit / +b.invested : null, days: b.start && b.end ? daysBetween(b.start, b.end) : null }));
  const cost = positions.reduce((a, x) => a + x.cost, 0);
  const value = positions.reduce((a, x) => a + x.value, 0);
  for (const x of positions) x.weight = value ? x.value / value : 0;
  const deposits = state.db.deposits.filter((d) => d.portfolioId === p.id).reduce((a, d) => a + +d.amount, 0);
  return {
    p, positions, closed, cost, value, deposits, missing: [], divTotal: 0, dayChg: 0,
    unrealized: value - cost,
    realized: closed.reduce((a, x) => a + x.pnl, 0),
    grid24h: positions.reduce((a, x) => a + (+x.gridProfit24h || 0), 0),
  };
}

// Carteras de futuros: el valor es el equity de las cuentas; las posiciones valen margen + PnL.
// Comisión taker de cada exchange: se usa para estimar el costo de cerrar a mercado.
const TAKER_FEE = { BingX: 0.0005, Bitget: 0.0006, Binance: 0.0005 };

// ROE: resultado sobre el margen inicial de la posición (tamaño ÷ apalancamiento), como lo muestra el exchange.
// En coin-M el tamaño ya está en USD; en USDT-M se usa el tamaño a precio de entrada.
function roeOf(f) {
  if (f.roe != null) return +f.roe;
  const lev = +f.leverage, notional = f.market === 'COIN-M' ? +f.notional : f.qty && f.entryPrice ? Math.abs(f.qty) * f.entryPrice : null;
  return lev && notional ? f.pnl / (notional / lev) : null;
}

// Próximo funding estimado con la tasa vigente: el long paga si la tasa es positiva y cobra si es negativa (el short al revés).
// Es aproximado: la tasa cambia hasta el momento del cobro y se aplica sobre el tamaño a precio de marca.
function fundingEstimate(f) {
  if (f.fundingRate == null || !+f.notional) return null;
  const next = (f.side === 'SHORT' ? 1 : -1) * +f.fundingRate * Math.abs(+f.notional);
  return { next, perDay: next * (24 / (+f.fundingHours || 8)) };
}

function computeFutures(p) {
  const acc = state.db.futuresAccounts?.[p.id];
  const all = (state.db.futures || []).filter((f) => f.portfolioId === p.id);
  const taker = TAKER_FEE[p.broker] ?? 0.0005;
  const positions = all.filter((f) => f.status === 'open').map((f) => {
    // Si la cierro ahora: PnL + lo ya pagado (apertura y funding, si el exchange lo informa) − comisión estimada de cierre
    const closeFee = (+f.notional || 0) * taker;
    return {
      ...f, ticker: f.symbol, cost: +f.margin || 0, value: (+f.margin || 0) + (+f.pnl || 0), pnlPct: f.margin ? f.pnl / f.margin : null,
      roePct: roeOf(f), closeFee, fundEst: fundingEstimate(f), net: (+f.pnl || 0) + (+f.feesPaid || 0) - closeFee,
      days: f.open ? daysBetween(new Date(f.open).toISOString().slice(0, 10), today()) : null,
      liqDist: f.liq && f.markPrice ? f.liq / f.markPrice - 1 : null,
    };
  });
  const closed = all.filter((f) => f.status === 'closed').map((f) => ({ ...f, pct: f.margin ? f.pnl / f.margin : null, hours: f.close && f.open ? (f.close - f.open) / 36e5 : null }));
  const value = (acc?.accounts || []).reduce((a, x) => a + (+x.equityUSD || 0), 0);
  for (const x of positions) x.weight = value ? x.value / value : 0;
  const unrealized = positions.reduce((a, x) => a + (+x.pnl || 0), 0);
  const deposits = state.db.deposits.filter((d) => d.portfolioId === p.id).reduce((a, d) => a + +d.amount, 0);
  return {
    p, acc, positions, closed, value, unrealized, deposits, cost: value - unrealized,
    realized: closed.reduce((a, x) => a + (+x.pnl || 0), 0), divTotal: 0, dayChg: 0, missing: [],
  };
}

// Carteras de acciones (y las marcadas con autoDep): aportes = lo invertido + el efectivo cargado como aporte, que también suma al valor
const AUTO_DEP = new Set(['stock']);
const autoDep = (p) => AUTO_DEP.has(p.type) || !!p.autoDep;

// Variación del día en %: contra el valor de ayer de las posiciones que tienen cierre anterior (bots y futuros no entran)
function dayPctOf(positions, chg) {
  const base = positions.reduce((a, x) => (x.dayChg != null && x.value != null ? a + x.value - x.dayChg : a), 0);
  return base > 0 && chg ? chg / base : null;
}

function compute(p) {
  if (p.type === 'bots') return computeBots(p);
  if (p.type === 'futures') return computeFutures(p);
  const txs = state.db.transactions
    .filter((t) => t.portfolioId === p.id)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.side === 'buy' ? -1 : 1));
  const pos = {};
  const closed = [];
  let realized = 0;
  for (const t of txs) {
    const s = (pos[t.ticker] ||= { ticker: t.ticker, qty: 0, cost: 0, ratio: 1, since: null });
    const ratio = +t.ratio || 1;
    s.ratio = ratio;
    const q = +t.qty, u = unitUSD(t), fee = +t.fee || 0;
    if (t.side === 'buy') {
      if (s.qty <= 1e-12) s.since = t.date;
      s.qty += q; s.cost += q * u + fee;
    } else {
      const avg = s.qty > 0 ? s.cost / s.qty : 0;
      const qq = Math.min(q, s.qty);
      const costOut = qq * avg;
      const proceeds = qq * u - fee;
      const pnl = proceeds - costOut;
      realized += pnl;
      closed.push({ id: t.id, date: t.date, ticker: t.ticker, qty: qq, ratio, avgU: avg * ratio, sellU: u * ratio, cost: costOut, proceeds, pnl, pct: costOut ? pnl / costOut : null, days: s.since ? daysBetween(s.since, t.date) : null });
      s.cost -= costOut; s.qty -= qq;
      if (s.qty < 1e-9) { s.qty = 0; s.cost = 0; }
    }
  }
  const divs = state.db.dividends.filter((d) => d.portfolioId === p.id);
  const divBy = {};
  for (const d of divs) divBy[d.ticker] = (divBy[d.ticker] || 0) + +d.amount;
  const divTotal = divs.reduce((a, d) => a + +d.amount, 0);

  const positions = Object.values(pos).filter((s) => s.qty > 0).map((s) => {
    const nominal = s.qty / s.ratio;
    const q = quoteFor(p, s.ticker);
    const px = q?.price ?? null;
    const value = px != null ? nominal * px : null;
    const div = divBy[s.ticker] || 0;
    return {
      ...s, nominal, px, manual: !!q?.manual,
      avg: s.cost / nominal,
      value,
      pnl: value != null ? value - s.cost : null,
      pnlPct: value != null && s.cost ? value / s.cost - 1 : null,
      dayChg: value != null && q?.prevClose ? nominal * (px - q.prevClose) : null,
      dayPct: q?.prevClose ? px / q.prevClose - 1 : null,
      div,
      days: s.since ? daysBetween(s.since, today()) : null,
    };
  });
  const cost = positions.reduce((a, x) => a + x.cost, 0);
  const cash = state.db.deposits.filter((d) => d.portfolioId === p.id).reduce((a, d) => a + +d.amount, 0);
  const deposits = autoDep(p) ? cost + cash : cash;
  const cashIn = autoDep(p) && cash > 0 ? cash : 0;
  const value = positions.reduce((a, x) => a + (x.value ?? x.cost), 0) + cashIn;
  const missing = positions.filter((x) => x.value == null).map((x) => x.ticker);
  for (const x of positions) x.weight = value ? (x.value ?? x.cost) / value : 0;
  const unrealized = positions.reduce((a, x) => a + (x.pnl ?? 0), 0);
  const dayChg = positions.reduce((a, x) => a + (x.dayChg ?? 0), 0);
  const dayPct = dayPctOf(positions, dayChg);
  return { p, txs, positions, closed, realized, divTotal, cost, value, unrealized, dayChg, dayPct, deposits, cash, cashIn, missing };
}

const computeAll = () => state.db.portfolios.map(compute);

// ================= Sincronización de exchanges =================
// El servidor sincroniza Pionex, BingX, Bitget y Binance solo cada 3 minutos; la app recarga los datos y el estado.
const EXCHANGE_NAMES = { pionex: 'Pionex', bingx: 'BingX', bitget: 'Bitget', binance: 'Binance' };
const FUTURES_EXCHANGE = { 'futuros-bingx': 'bingx', 'futuros-bitget': 'bitget', 'futuros-binance': 'binance' }; // cartera sincronizada → exchange
async function loadSyncStatus() {
  try {
    const s = await api('/api/sync/status');
    for (const ex of Object.keys(EXCHANGE_NAMES)) {
      if (s[ex]) Object.assign(state[ex], { configured: s[ex].configured, source: s[ex].source, error: s[ex].error, updated: s[ex].updated });
    }
  } catch { /* sin estado: se mantiene el anterior */ }
}

async function reloadDb() {
  // No recargar con un formulario abierto: se perdería lo que se está editando
  if ($('#modal').open) return;
  const db = await api('/api/db');
  state.db = { dividends: [], deposits: [], bots: [], futures: [], manualPrices: {}, ...db };
}

// Sincronización pedida a mano (botón en Ajustes). Solo el dueño.
async function syncNow(exchange) {
  const st = state[exchange];
  if (st.syncing) return;
  st.syncing = true;
  try {
    await api(`/api/${exchange}/sync`, { method: 'POST' });
    st.error = null;
    await reloadDb();
    toast(EXCHANGE_NAMES[exchange] + ' sincronizado');
  } catch (e) {
    st.error = e.message;
    toast('No se pudo sincronizar: ' + e.message);
  } finally {
    st.syncing = false;
    render();
  }
}

// ================= Cotizaciones =================
async function refreshQuotes() {
  try { await Promise.all([reloadDb(), loadSyncStatus()]); } catch { /* se sigue con lo que hay */ }
  const sets = { S: new Set(), C: new Set(), B: new Set() };
  for (const c of computeAll()) if (!SYNCED.has(c.p.type)) for (const x of c.positions) sets[quoteKind(c.p)].add(x.ticker);
  const btn = $('#btn-refresh');
  btn.disabled = true; btn.classList.add('spin');
  try {
    const [q, ccl] = await Promise.all([
      api(`/api/quotes?stocks=${[...sets.S].join(',')}&crypto=${[...sets.C].join(',')}&bonds=${[...sets.B].join(',')}`),
      api('/api/ccl').catch(() => null),
    ]);
    state.quotes = q;
    if (ccl) state.ccl = ccl;
    state.lastUpdate = new Date();
    saveSnapshot(); // foto del día para la Evolución
    const errs = Object.keys(q.errors || {});
    if (errs.length && isOwner()) toast('Sin cotización para: ' + errs.join(', ') + ' (podés fijar un precio manual en Ajustes)');
  } catch (e) {
    toast('No se pudieron actualizar precios: ' + e.message);
  } finally {
    btn.disabled = false; btn.classList.remove('spin');
  }
  renderTop();
  render();
}

function renderTop() {
  // El CCL es un dato público: se muestra aunque los montos estén ocultos
  $('#ccl-pill').textContent = state.ccl ? `CCL ${nfARS.format(state.ccl.venta)}` : 'CCL —';
  $('#last-update').textContent = state.lastUpdate ? 'Actualizado ' + state.lastUpdate.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
  const hideBtn = $('#btn-hide');
  hideBtn.textContent = state.hide ? '🙈' : '👁';
  hideBtn.setAttribute('aria-pressed', String(state.hide));
  hideBtn.title = state.hide ? 'Mostrar montos' : 'Ocultar montos';
  hideBtn.hidden = !isOwner(); // el invitado nunca ve montos
  const pill = $('#user-pill');
  pill.hidden = isOwner();
  pill.textContent = 'Invitado · solo lectura';
}

// ================= Navegación =================
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  return { name: a || 'resumen', id: b };
}

// Pestañas del menú que cada usuario puede ocultar (Ajustes → Pestañas del menú). Se guardan en su propia base.
// Operaciones y Dividendos solo existen si hay carteras de acciones, CEDEARs o cripto spot (las que se cargan a mano).
function navTabs() {
  const manual = state.db.portfolios.some((p) => ['cedear', 'stock', 'crypto'].includes(p.type));
  return [
    { key: 'cotiz', label: 'Cotizaciones', sec: 'Mercado' },
    ...state.db.portfolios.map((p) => ({ key: 'p:' + p.id, label: p.name, sec: 'Carteras' })),
    ...(state.reglas.length ? [{ key: 'reglas', label: 'Reglas', sec: 'Estrategia' }] : []),
    ...(manual ? [{ key: 'ops', label: 'Operaciones', sec: 'Registro' }, { key: 'divs', label: 'Dividendos', sec: 'Registro' }] : []),
    { key: 'aportes', label: 'Aportes', sec: 'Registro' },
  ];
}
const hiddenTabs = () => new Set(state.db.settings?.hiddenTabs || []);

function renderNav() {
  const r = route();
  const hidden = hiddenTabs();
  const link = (href, label, active, dot) => `<a href="#/${href}" class="${active ? 'active' : ''}">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}${esc(label)}</a>`;
  // La pestaña abierta se muestra aunque esté oculta, para no perderse
  const tabs = navTabs().filter((t) => !hidden.has(t.key) || (t.key === 'p:' + r.id && r.name === 'p') || t.key === r.name);
  // El invitado no ve el registro de operaciones ni los ajustes
  const visible = tabs.filter((t) => t.sec !== 'Registro' || isOwner());
  const out = [link('', 'Resumen', r.name === 'resumen')];
  let sec = null;
  for (const t of visible) {
    if (t.sec !== sec) { out.push(`<div class="sec">${t.sec}</div>`); sec = t.sec; }
    if (t.key.startsWith('p:')) {
      const p = portfolio(t.key.slice(2));
      out.push(link('p/' + p.id, p.name, r.name === 'p' && r.id === p.id, slotColor(p)));
    } else out.push(link(t.key, t.label, r.name === t.key));
  }
  if (isOwner()) out.push('<div class="sec">Config</div>', link('ajustes', 'Ajustes', r.name === 'ajustes'));
  $('#nav').innerHTML = out.join('');
}

function tabsCard() {
  const hidden = hiddenTabs();
  return `<div class="card section">
    <h2>Pestañas del menú</h2>
    <p class="muted small" style="margin-top:0">Elegí qué ver en el menú. Ocultar una cartera no la borra ni la saca del Resumen.</p>
    <div class="tabs-list">${navTabs().map((t) => `<label class="check"><input type="checkbox" data-tab-toggle="${esc(t.key)}" ${hidden.has(t.key) ? '' : 'checked'}>
      ${esc(t.label)} <span class="muted small">${t.sec}</span></label>`).join('')}</div>
  </div>`;
}

function render() {
  if (rowDrag.active) { rowDrag.pending = true; return; } // se redibuja al soltar
  renderNav();
  const r = route();
  const v = $('#view');
  if (!isOwner() && ['ops', 'divs', 'aportes', 'ajustes'].includes(r.name)) { location.hash = '#/'; return; }
  if (r.name === 'p' && portfolio(r.id)) {
    const p = portfolio(r.id);
    v.innerHTML = p.type === 'bots' ? viewBots(p) : p.type === 'futures' ? viewFutures(p) : viewPortfolio(p);
  }
  else if (r.name === 'ops') v.innerHTML = viewOps();
  else if (r.name === 'divs') v.innerHTML = viewDivs();
  else if (r.name === 'aportes') v.innerHTML = viewAportes();
  else if (r.name === 'ajustes') v.innerHTML = viewSettings();
  else if (r.name === 'reglas') v.innerHTML = viewReglas();
  else if (r.name === 'cotiz') v.innerHTML = viewWatch();
  else v.innerHTML = viewSummary();
  labelTableCells(v);
}

// En pantallas chicas las tablas se muestran como tarjetas: cada celda lleva el nombre de su columna.
function labelTableCells(root) {
  for (const table of root.querySelectorAll('.table-wrap table')) {
    const heads = [...table.querySelectorAll('thead th')].map((h) => h.textContent.replace(/[▲▼]/g, '').trim());
    for (const row of table.querySelectorAll('tbody tr, tfoot tr')) {
      let col = 0;
      for (const td of row.children) {
        if (heads[col] && !td.hasAttribute('data-label')) td.setAttribute('data-label', heads[col]);
        col += td.colSpan || 1;
      }
    }
  }
}

// ================= Componentes =================
function kpi(label, value, delta, deltaCls = '') {
  return `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div>${delta != null ? `<div class="delta ${deltaCls}">${delta}</div>` : ''}</div>`;
}

function donut(items, total, opts = {}) {
  // items: [{label, value, color, tip?, sub?}]
  const size = opts.size || 180, sw = opts.stroke || 26, r = size / 2 - sw / 2 - 4, c = size / 2;
  const sum = items.reduce((a, x) => a + Math.max(0, x.value), 0);
  if (!sum) return '<div class="empty">Sin datos todavía</div>';
  const shown = items.filter((x) => x.value > 0);
  let a0 = -Math.PI / 2;
  const arcs = shown.map((x, i) => {
    const frac = x.value / sum;
    const a1 = a0 + frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a) => `${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`;
    const d = frac >= 0.9999 ? `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r}` : `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
    a0 = a1;
    const tip = x.tip || `<b>${esc(x.label)}</b><br>${usd(x.value)} · ${pct(frac).replace('+', '')}`;
    return `<path d="${d}" fill="none" stroke="${x.color}" stroke-width="${sw}" class="hit slice" data-slice="${i}" data-tip="${esc(tip)}"/>`;
  });
  // Separación de 2px con el color de la superficie entre porciones
  const seps = shown.length > 1 ? arcsSeparators(shown, sum, c, r, sw) : '';
  const legend = shown.map((x, i) => `<div class="item" data-slice="${i}">
      <span class="dot" style="background:${x.color}"></span>
      <span class="lbl">${esc(x.label)}${x.sub ? `<span class="muted small"> ${x.sub}</span>` : ''}</span>
      <span class="v">${opts.legendUsd ? `<span class="usd">${usd(x.value)}</span>` : ''}<b>${pct(x.value / sum).replace('+', '')}</b></span>
    </div>`).join('');
  return `<div class="donut-wrap ${opts.big ? 'big' : ''}">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(opts.aria || 'Distribución')}">
      ${arcs.join('')}${seps}
      <text x="${c}" y="${c - 6}" text-anchor="middle" font-size="${opts.big ? 12 : 11}" fill="var(--text-muted)">${esc(opts.centerLabel || 'Total')}</text>
      <text x="${c}" y="${c + (opts.big ? 16 : 14)}" text-anchor="middle" font-size="${opts.big ? 18 : 14}" font-weight="700" fill="var(--text-primary)">${esc(usd(total ?? sum))}</text>
      ${opts.centerSub ? `<text x="${c}" y="${c + 34}" text-anchor="middle" font-size="12" font-weight="600" fill="${opts.centerSubColor || 'var(--text-secondary)'}">${esc(opts.centerSub)}</text>` : ''}
    </svg>
    <div class="legend">${legend}</div>
  </div>`;
}
function arcsSeparators(items, sum, c, r, sw) {
  let a = -Math.PI / 2; const out = [];
  for (const x of items.filter((i) => i.value > 0)) {
    const x1 = c + (r - sw / 2 - 1) * Math.cos(a), y1 = c + (r - sw / 2 - 1) * Math.sin(a);
    const x2 = c + (r + sw / 2 + 1) * Math.cos(a), y2 = c + (r + sw / 2 + 1) * Math.sin(a);
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--surface-1)" stroke-width="2" pointer-events="none"/>`);
    a += (x.value / sum) * Math.PI * 2;
  }
  return out.join('');
}

function hbars(rows) {
  // rows: [{label, value, sub, tip}] — una sola serie, un solo tono
  if (!rows.length) return '<div class="empty">Sin posiciones abiertas</div>';
  const max = Math.max(...rows.map((r) => Math.abs(r.value)));
  return `<div class="bars">${rows.map((r) => `
    <div class="b hit" data-tip="${esc(r.tip)}">
      <span class="ticker">${esc(r.label)}</span>
      <div class="track"><div class="fill" style="width:${(Math.abs(r.value) / max) * 100}%"></div></div>
      <span class="v">${r.sub}</span>
    </div>`).join('')}</div>`;
}

function sortRows(tableId, rows, defKey, defDir = 'desc') {
  const s = state.sort[tableId] || { key: defKey, dir: defDir };
  const k = s.key, m = s.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * m;
  });
}
function th(tableId, key, label, isNum = true) {
  const s = state.sort[tableId];
  const arrow = s?.key === key ? (s.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th class="sortable ${isNum ? 'num' : ''}" data-sort="${tableId}:${key}">${label}${arrow}</th>`;
}

