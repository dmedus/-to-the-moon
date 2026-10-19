'use strict';
// ================= Cotizaciones (lista de seguimiento) =================
// Cada usuario tiene su lista en settings.watchlist: ['S:GOOGL', 'C:BTC', ...] (S = acción/ETF, C = cripto).
const WATCH_DEFAULT = ['S:GOOGL', 'S:WDC', 'S:NVDA', 'S:CAT', 'S:BABA', 'S:AVGO', 'S:NFLX', 'S:AMZN', 'S:GS', 'S:SPY', 'C:BTC', 'C:SOL', 'C:HYPE', 'S:QQQ'];
const RANGE_LABELS = [['1d', '1D'], ['5d', '5D'], ['1mo', '1M'], ['6mo', '6M'], ['1y', '1A'], ['5y', '5A']];
const CANDLE_LABELS = [['1mo', '1M'], ['3mo', '3M'], ['6mo', '6M'], ['1y', '1A']]; // velas diarias
// mode: 'velas' (velas japonesas de 1 día) o 'linea' (intradía y períodos largos); cada modo recuerda su período
const watch = { data: {}, loading: false, updated: null, sel: null, mode: 'velas', range: '1d', crange: '6mo', chart: null, chartErr: null, hover: null, q: '' };
// En velas se ven dos temporalidades a la vez: la diaria y, debajo, la de 1 hora (con su propio período y su propio puntero)
const HOUR_LABELS = [['2d', '2D'], ['5d', '5D'], ['10d', '10D']];
Object.assign(watch, { chart1h: null, chart1hErr: null, hover1h: null, hrange: prefGet('watchHRange', '5d') });
// Buscador: compara sin mayúsculas ni acentos contra símbolo y nombre
const searchNorm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const watchMatch = (text) => !watch.q || searchNorm(text).includes(searchNorm(watch.q));
// Filtra las filas ya dibujadas sin redibujar la pantalla (así no se pierde el cursor del buscador)
function applyWatchFilter() {
  for (const box of document.querySelectorAll('.watch-rows')) {
    let shown = 0;
    for (const row of box.querySelectorAll('.watch-row')) { row.hidden = !watchMatch(row.dataset.search); if (!row.hidden) shown++; }
    const none = box.parentElement.querySelector('.watch-nomatch');
    if (none) none.hidden = !(watch.q && !shown && box.children.length);
  }
}
// Las velas traen ~2 años de una vez: cambiar el período (1M…1A) no vuelve a pedir datos
const chartKey = () => (watch.mode === 'velas' ? `${watch.sel}|velas` : `${watch.sel}|linea|${watch.range}`);
watch.tab = prefGet('watchTab', 'S'); // 'S' acciones, 'C' cripto, 'all' todas

// ---- Medias móviles e indicadores (calculados sobre los cierres diarios) ----
const MAS = [
  { id: 'ema21', label: 'EMA21', type: 'ema', n: 21, color: '#b8a23a' },
  { id: 'wma50', label: 'WMA50', type: 'wma', n: 50, color: '#c04bc8' },
  { id: 'ema150', label: 'EMA150', type: 'ema', n: 150, color: '#1fb5cc' },
  { id: 'ema200', label: 'EMA200', type: 'ema', n: 200, color: '#3a6fe0' },
];
watch.mas = new Set(prefGet('watchMAs', MAS.map((m) => m.id)));
// Devuelve una serie del mismo largo que los cierres, con null mientras no hay datos suficientes
function maSeries(cl, type, n) {
  const out = new Array(cl.length).fill(null);
  if (cl.length < n) return out;
  if (type === 'wma') {
    const den = (n * (n + 1)) / 2;
    for (let i = n - 1; i < cl.length; i++) { let s = 0; for (let j = 0; j < n; j++) s += cl[i - j] * (n - j); out[i] = s / den; }
    return out;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += cl[i];
  out[n - 1] = sum / n;
  if (type === 'sma') { for (let i = n; i < cl.length; i++) { sum += cl[i] - cl[i - n]; out[i] = sum / n; } return out; }
  const k = 2 / (n + 1); // EMA: arranca con el promedio simple de las primeras n velas
  for (let i = n; i < cl.length; i++) out[i] = cl[i] * k + out[i - 1] * (1 - k);
  return out;
}
// RSI de Wilder (14 períodos), como el de TradingView
function rsiLast(cl, n = 14) {
  if (cl.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
// Dos listas guardadas en la cuenta: la principal (lo que tenés: Acciones y Cripto) y Seguidas (lo que querés controlar).
const watchList = () => state.db.settings?.watchlist || WATCH_DEFAULT;
const followList = () => state.db.settings?.watchFollow || [];
const allWatchKeys = () => [...watchList(), ...followList()];
// Secciones: S = acciones de la principal, C = cripto de la principal, F = Seguidas (acciones y cripto mezcladas)
const SECTIONS = {
  S: { title: 'Acciones y ETFs', empty: 'acciones', list: watchList, set: 'watchlist', has: (k) => k.startsWith('S:') },
  C: { title: 'Cripto', empty: 'criptos', list: watchList, set: 'watchlist', has: (k) => k.startsWith('C:') },
  F: { title: 'Seguidas', empty: 'símbolos para seguir', list: followList, set: 'watchFollow', has: () => true },
};
const setWatch = (prop, arr) => { (state.db.settings ||= {})[prop] = arr; save(); };

async function refreshWatch() {
  if (watch.loading) return;
  watch.loading = true;
  try { watch.data = await api('/api/watch?s=' + encodeURIComponent(allWatchKeys().join(','))); watch.updated = new Date(); }
  catch { /* se reintenta en el próximo ciclo */ }
  finally { watch.loading = false; }
  // No redibujar en medio de un arrastre ni mientras se escribe en el buscador (los datos nuevos llegan al minuto siguiente)
  if (route().name === 'cotiz' && !$('#modal').open && !watchDrag.row && document.activeElement?.id !== 'watch-q' && !editingDraw()) render();
}
async function loadChart() {
  if (!watch.sel) return;
  const [kind, sym] = watch.sel.split(':');
  const key = chartKey(), velas = watch.mode === 'velas';
  watch.chartErr = null;
  const base = `/api/chart?kind=${kind}&sym=${encodeURIComponent(sym)}&`;
  const hour = velas && api(base + 'type=candles&tf=1h').then((data) => { if (key === chartKey()) Object.assign(watch, { chart1h: { key, ...data }, chart1hErr: null }); },
    (e) => { if (key === chartKey()) Object.assign(watch, { chart1h: null, chart1hErr: e.message }); });
  try {
    const q = velas ? `type=candles&range=${watch.crange}` : `range=${watch.range}`;
    const data = await api(base + q);
    if (key === chartKey()) watch.chart = { key, ...data }; // si mientras tanto cambió la selección, se descarta
  } catch (e) { watch.chart = null; watch.chartErr = e.message; }
  await hour;
  if (route().name === 'cotiz' && !editingDraw()) render();
}
// Se actualiza sola cada minuto mientras la solapa está abierta (la vela de hoy y el intradía cambian)
setInterval(() => {
  if (route().name !== 'cotiz' || document.hidden) return;
  refreshWatch();
  if (watch.sel && (watch.mode === 'velas' || watch.range === '1d') && watch.hover == null && watch.hover1h == null) loadChart();
}, 60e3);

const symColor = (s) => `var(--series-${([...s].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 8) + 1})`;
function sparkline(vals, up) {
  if (!vals?.length || vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), w = 90, h = 26, span = max - min || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" class="${up ? 'pos' : 'neg'}"/></svg>`;
}

// Velas japonesas: diarias (tf '1d') o de 1 hora (tf '1h'). Verde si cerró arriba de la apertura, roja si cerró abajo.
// Las medias se calculan sobre toda la historia traída y se dibujan solo en el período visible.
function candleChart(c, tf = '1d') {
  const all = c.candles, hourly = tf === '1h';
  if (all.length < 2) return '<div class="muted small">Sin datos para este período.</div>';
  const closes = all.map((v) => v[4]);
  const series = Object.fromEntries(MAS.map((m) => [m.id, maSeries(closes, m.type, m.n)]));
  const days = hourly ? parseInt(watch.hrange, 10) || 5 : { '1mo': 30, '3mo': 91, '6mo': 182, '1y': 365 }[watch.crange] || 182;
  // 1H: se cuentan días con velas (las acciones no operan de noche ni el fin de semana); 1D: días corridos
  const from = hourly ? (() => { const ds = [...new Set(all.map((v) => new Date(v[0]).toDateString()))]; return new Date(ds[Math.max(0, ds.length - days)]).getTime(); })()
    : Date.now() - days * 864e5;
  const s = Math.max(0, Math.min(all.length - 2, all.findIndex((v) => v[0] >= from)));
  const k = all.slice(s), n = k.length;
  const on = MAS.filter((m) => watch.mas.has(m.id));
  const maVis = (m) => series[m.id].slice(s);
  const hover = hourly ? watch.hover1h : watch.hover;

  const W = 640, H = hourly ? 220 : 260, pad = 6;
  const vals = [...k.map((v) => v[3]), ...k.map((v) => v[2]), ...on.flatMap((m) => maVis(m).filter((v) => v != null))];
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const slot = (W - 2 * pad) / n, bw = Math.max(1, slot * 0.66);
  const x = (i) => pad + slot * (i + 0.5), y = (v) => pad + (1 - (v - min) / span) * (H - 2 * pad);
  // Fecha → posición: dentro del período, entre las velas que la rodean; fuera, se extiende con el largo de una vela
  const dt = hourly ? 36e5 : 864e5;
  const xt = (time) => {
    if (time <= k[0][0]) return x((time - k[0][0]) / dt);
    if (time >= k[n - 1][0]) return x(n - 1 + (time - k[n - 1][0]) / dt);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m][0] <= time) lo = m; else hi = m; }
    return x(lo + (time - k[lo][0]) / (k[hi][0] - k[lo][0]));
  };
  // Posición → fecha y precio (lo inverso de xt e y), para tocar y arrastrar dibujos
  const tAt = (px) => {
    const i = (px - pad) / slot - 0.5;
    if (i <= 0) return k[0][0] + i * dt;
    if (i >= n - 1) return k[n - 1][0] + (i - n + 1) * dt;
    const lo = Math.floor(i);
    return k[lo][0] + (i - lo) * (k[lo + 1][0] - k[lo][0]);
  };
  const pAt = (py) => min + (1 - (py - pad) / (H - 2 * pad)) * span;
  chartGeom[tf] = { k, min, span, pad, W, H, slot, dt, xt, y, tAt, pAt };
  const h = hover != null && k[hover] ? hover : null;
  const idx = h ?? n - 1;
  const [t, o, hi, lo, cl] = k[idx];
  const prevClose = s + idx > 0 ? all[s + idx - 1][4] : o;
  const day = cl - prevClose;
  const fmt = (ms) => (hourly
    ? new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : new Date(ms).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }));
  const when = hourly
    ? new Date(t).toLocaleString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' · en la hora'
    : new Date(t).toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' }) + ' · en el día';
  const per = k.at(-1)[4] / k[0][1] - 1;
  const short = !hourly && all[0][0] > from + 7 * 864e5; // cotiza hace poco (ej. un par nuevo en Binance)
  const rsi = hourly ? rsiLast(closes) : null;
  // Cada media como una línea; se corta donde todavía no hay datos suficientes
  const maLine = (m) => {
    const pts = maVis(m).map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
    return pts.length > 1 ? `<polyline class="ma" style="stroke:${m.color}" points="${pts.join(' ')}"/>` : '';
  };
  return `<div class="chart-read"><b>${price(cl)}</b> <span class="${cls(day)}">${day > 0 ? '+' : ''}${num(day, 2)} (${pct(prevClose ? cl / prevClose - 1 : null)})</span>
      <span class="muted small">${when}</span></div>
    <div class="ohlc small"><span><span class="muted">A</span> ${price(o)}</span><span><span class="muted">Máx</span> ${price(hi)}</span>
      <span><span class="muted">Mín</span> ${price(lo)}</span><span><span class="muted">C</span> ${price(cl)}</span>
      <span><span class="muted">En el período</span> <span class="${cls(per)}">${pct(per)}</span></span>
      ${rsi != null ? `<span title="RSI de 14 velas de 1 hora: más de 70 = sobrecompra, menos de 30 = sobreventa"><span class="muted">RSI 14</span> <b class="${rsi >= 70 ? 'neg' : rsi <= 30 ? 'pos' : ''}">${Math.round(rsi)}</b></span>` : ''}</div>
    <div class="ma-legend small">${MAS.map((m) => {
      const v = series[m.id][s + idx];
      return `<button type="button" class="ma-chip ${watch.mas.has(m.id) ? 'on' : ''}" data-action="watch-ma" data-id="${m.id}" title="Mostrar u ocultar ${m.label}">
        <i style="background:${m.color}"></i>${m.label} <b>${v == null ? '—' : price(v)}</b></button>`;
    }).join('')}</div>
    <svg class="bigchart candles ${drawingsOf().length && isOwner() ? 'has-draw' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-chart="${n}" data-mode="candles" data-tf="${tf}">
      ${h != null ? `<rect class="hl" x="${x(h) - slot / 2}" y="0" width="${slot}" height="${H}"/>` : ''}
      ${k.map((v, i) => {
        const up = v[4] >= v[1], top = y(Math.max(v[1], v[4])), bot = y(Math.min(v[1], v[4]));
        return `<g class="${up ? 'up' : 'down'}"><line x1="${x(i)}" x2="${x(i)}" y1="${y(v[2]).toFixed(1)}" y2="${y(v[3]).toFixed(1)}"/>`
          + `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}"/></g>`;
      }).join('')}
      ${on.map(maLine).join('')}
      ${drawingsSvg(xt, y, W)}
    </svg>
    <div class="chart-axis small muted"><span>${fmt(k[0][0])}</span><span>Máx ${price(max)} · Mín ${price(min)}</span><span>${fmt(k.at(-1)[0])}</span></div>
    ${short ? `<div class="small muted" style="margin-top:4px">Hay datos solo desde el ${fmt(all[0][0])} (${all.length} días): las medias largas necesitan más historia.</div>` : ''}
    ${hourly ? '' : indicatorsPanel(c, closes, series)}`;
}

// ---- Dibujos sobre las velas, como en TradingView ----
// Línea de tendencia (dos puntos), línea horizontal (un precio), rayo horizontal (desde una vela hacia la derecha) y
// Comprar y Vender: entrada con su franja de take profit (verde) y de stop (rojo), como las posiciones larga y corta de TradingView.
// Se guardan por símbolo en la cuenta (settings.drawings) con fecha y precio, así se ven en el diario y en el de 1 hora.
// Sin herramienta elegida, cualquier dibujo se arrastra: entero, o de una punta (tendencia) o del TP / stop (Comprar).
const DRAW_TOOLS = [['trend', '╱', 'Línea de tendencia'], ['hline', '―', 'Línea horizontal'], ['hray', '→', 'Rayo horizontal'], ['long', 'Comprar', 'Comprar: entrada con take profit y stop'], ['short', 'Vender', 'Vender: entrada con take profit y stop']];
const LONG_DEFAULT = { tp: 0.10, sl: 0.05, bars: 20, gap: 0.005 }; // al ponerla (en Vender, al revés): TP +10 %, stop −5 %, 20 velas de ancho (después se arrastran); TP y stop quedan siempre a 0,5 % o más de la entrada
const chartGeom = {}; // geometría del último dibujo de cada gráfico de velas, para pasar un toque a fecha y precio
const drawDrag = { d: null, i: -1, part: null, tf: null, t0: 0, p0: 0, orig: null, moved: false, raf: 0 };
Object.assign(watch, { tool: null, pending: null });
const drawingsOf = (key = watch.sel) => state.db.settings?.drawings?.[key] || [];
function setDrawings(list) {
  const all = ((state.db.settings ||= {}).drawings ||= {});
  if (list.length) all[watch.sel] = list; else delete all[watch.sel];
  save();
}
const longPct = (d, p) => (p / d.p1 - 1);
const isPos = (d) => d.type === 'long' || d.type === 'short'; // posiciones: el TP queda arriba en Comprar y abajo en Vender
function drawingsSvg(xt, y, W) {
  const f = (v) => v.toFixed(1);
  const L = (x1, y1, x2, y2, extra = '') => `<line class="draw ${extra}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
  const box = (x1, x2, ya, yb, c) => `<rect class="${c}" x="${f(Math.min(x1, x2))}" y="${f(Math.min(ya, yb))}" width="${f(Math.abs(x2 - x1))}" height="${f(Math.max(1, Math.abs(yb - ya)))}"/>`;
  const out = drawingsOf().map((d, i) => {
    const on = drawDrag.d && drawDrag.i === i ? 'active' : '';
    if (d.type === 'trend') return L(xt(d.t1), y(d.p1), xt(d.t2), y(d.p2), on);
    if (d.type === 'hline') return L(0, y(d.p1), W, y(d.p1), on);
    if (d.type === 'hray') return L(xt(d.t1), y(d.p1), W, y(d.p1), on);
    if (isPos(d)) {
      const x1 = xt(d.t1), x2 = xt(d.t2), ye = y(d.p1);
      return box(x1, x2, ye, y(d.tp), 'tp-zone') + box(x1, x2, ye, y(d.sl), 'sl-zone')
        + L(x1, y(d.tp), x2, y(d.tp), 'tp ' + on) + L(x1, y(d.sl), x2, y(d.sl), 'sl ' + on) + L(x1, ye, x2, ye, 'entry ' + on);
    }
    return '';
  });
  if (watch.pending) { const px = xt(watch.pending.t1), py = y(watch.pending.p1); out.push(L(px, py, px, py, 'pending')); } // primer punto de la tendencia
  return out.join('');
}
// TP y stop también se escriben: el campo muestra el precio y al confirmar (Enter o salir del campo) se aplica
const editingDraw = () => !!document.activeElement?.classList?.contains('draw-num'); // mientras se escribe no se redibuja
const inDec = (v) => (v >= 1000 ? 2 : v >= 1 ? 4 : 8);
const drawInput = (i, part, v) => `<input class="draw-num" type="number" step="any" min="0" inputmode="decimal" data-i="${i}" data-part="${part}"
  value="${+v.toFixed(inDec(v))}" aria-label="${part === 'tp' ? 'Precio del take profit' : 'Precio del stop'}" title="Escribí el precio y apretá Enter">`;
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.classList?.contains('draw-num') || !isOwner()) return;
  const list = drawingsOf().slice(), i = +el.dataset.i, part = el.dataset.part, d = list[i], p = +String(el.value).replace(',', '.');
  if (!d || !isPos(d)) return;
  // Comprar: TP arriba de la entrada y stop abajo; Vender: al revés. Siempre a 0,5 % o más de la entrada.
  const up = (part === 'tp') === (d.type === 'long'), lim = d.p1 * (1 + (up ? 1 : -1) * LONG_DEFAULT.gap);
  if (!(p > 0) || (up ? p < lim : p > lim)) {
    toast(`El ${part === 'tp' ? 'TP' : 'stop'} de una ${d.type === 'long' ? 'compra' : 'venta'} va ${up ? 'arriba' : 'abajo'} de la entrada (${up ? 'desde' : 'hasta'} ${price(lim)})`);
    el.value = +d[part].toFixed(inDec(d[part]));
    return;
  }
  list[i] = { ...d, [part]: p };
  setDrawings(list);
  // Si se pasó a otro campo (Tab o clic), redibujar y devolverle el foco con lo que ya tenía escrito
  const next = document.activeElement?.classList?.contains('draw-num') && document.activeElement !== el
    ? { i: document.activeElement.dataset.i, part: document.activeElement.dataset.part, value: document.activeElement.value } : null;
  if (document.activeElement === el) el.blur();
  const b = $('#bigchart'); if (b) b.innerHTML = bigChart();
  if (next) {
    const n = document.querySelector(`.draw-num[data-i="${next.i}"][data-part="${next.part}"]`);
    if (n) { n.value = next.value; n.focus(); n.select(); }
  }
});
// En un campo numérico Chrome no confirma con Enter: Enter aplica (al salir del campo) y Esc deja el precio como estaba
document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (!el.classList?.contains('draw-num')) return;
  if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
  else if (e.key === 'Escape') {
    const d = drawingsOf()[+el.dataset.i];
    if (d) el.value = +d[el.dataset.part].toFixed(inDec(d[el.dataset.part]));
    el.blur();
  }
});

function drawToolbar() {
  const list = drawingsOf();
  const label = (d, i) => (d.type === 'trend' ? `╱ ${price(d.p1)} → ${price(d.p2)}`
    : isPos(d) ? `${d.type === 'long' ? 'Compra' : 'Venta'} ${price(d.p1)} · <span class="pos">TP ${drawInput(i, 'tp', d.tp)} (${pct(longPct(d, d.tp))})</span> · <span class="neg">Stop ${drawInput(i, 'sl', d.sl)} (${pct(longPct(d, d.sl))})</span> · R:R ${num(Math.abs(d.tp - d.p1) / Math.abs(d.p1 - d.sl), 2)}`
    : `${d.type === 'hline' ? '―' : '→'} ${price(d.p1)}`);
  const hint = watch.tool === 'trend' ? (watch.pending ? 'Tocá el segundo punto' : 'Tocá el primer punto')
    : isPos({ type: watch.tool }) ? 'Tocá el precio de entrada' : watch.tool ? 'Tocá el precio en el gráfico'
    : list.length ? 'Arrastrá un dibujo para moverlo' : '';
  return `<div class="draw-bar small">
    <div class="seg sm" title="Herramientas de dibujo">${DRAW_TOOLS.map(([id, ico, tip]) => `<button type="button" class="${watch.tool === id ? 'on' : ''}" data-action="draw-tool" data-tool="${id}" title="${tip}" aria-label="${tip}">${ico}</button>`).join('')}</div>
    ${hint ? `<span class="muted">${hint}${watch.tool ? ' · <button type="button" class="linkbtn" data-action="draw-tool" data-tool="">cancelar</button>' : ''}</span>` : ''}
    ${list.map((d, i) => `<span class="draw-chip">${label(d, i)}<button type="button" data-action="draw-del" data-i="${i}" title="Borrar este dibujo" aria-label="Borrar dibujo">✕</button></span>`).join('')}
    ${list.length > 1 ? '<button type="button" class="linkbtn" data-action="draw-clear">Borrar todos</button>' : ''}
  </div>`;
}

// Puntero → coordenadas del gráfico (las del viewBox) y en píxeles de pantalla
function chartPoint(svg, e) {
  const g = chartGeom[svg.dataset.tf], r = svg.getBoundingClientRect();
  return { g, fx: ((e.clientX - r.left) / r.width) * g.W, fy: ((e.clientY - r.top) / r.height) * g.H, sx: r.width / g.W, sy: r.height / g.H };
}
// Qué dibujo (y qué parte) queda bajo el puntero, con una tolerancia de unos 8 px en pantalla
function drawingAt(svg, e) {
  const { g, fx, fy, sx, sy } = chartPoint(svg, e);
  const near = 8, X = (v) => v * sx, Y = (v) => v * sy;
  const segDist = (x1, y1, x2, y2) => { // distancia en pantalla del puntero a un segmento
    const [ax, ay, bx, by, px, py] = [X(x1), Y(y1), X(x2), Y(y2), X(fx), Y(fy)];
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2)) : 0;
    return Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay));
  };
  const list = drawingsOf();
  for (let i = list.length - 1; i >= 0; i--) { // el de arriba primero
    const d = list[i];
    if (d.type === 'trend') {
      const a = [g.xt(d.t1), g.y(d.p1)], b = [g.xt(d.t2), g.y(d.p2)];
      if (Math.hypot(X(fx - a[0]), Y(fy - a[1])) < near + 2) return { i, part: 'a' };
      if (Math.hypot(X(fx - b[0]), Y(fy - b[1])) < near + 2) return { i, part: 'b' };
      if (segDist(...a, ...b) < near) return { i, part: 'all' };
    } else if (d.type === 'hline') {
      if (Math.abs(Y(fy - g.y(d.p1))) < near) return { i, part: 'all' };
    } else if (d.type === 'hray') {
      if (fx >= g.xt(d.t1) - near / sx && Math.abs(Y(fy - g.y(d.p1))) < near) return { i, part: 'all' };
    } else if (isPos(d)) {
      const x1 = g.xt(d.t1), x2 = g.xt(d.t2);
      if (fx < Math.min(x1, x2) - near / sx || fx > Math.max(x1, x2) + near / sx) continue;
      if (Math.abs(Y(fy - g.y(d.tp))) < near) return { i, part: 'tp' };
      if (Math.abs(Y(fy - g.y(d.sl))) < near) return { i, part: 'sl' };
      if (Math.abs(X(fx - x2)) < near) return { i, part: 'end' };
      if (fy >= Math.min(g.y(d.tp), g.y(d.sl)) && fy <= Math.max(g.y(d.tp), g.y(d.sl))) return { i, part: 'all' };
    }
  }
  return null;
}
// Aplica el arrastre al dibujo original: corre todo, o mueve solo una punta, el TP, el stop o el largo
function dragged(o, part, t, p, dT, dP) {
  const d = { ...o };
  if (part === 'all') {
    for (const k of ['t1', 't2']) if (d[k] != null) d[k] += dT;
    for (const k of ['p1', 'p2', 'tp', 'sl']) if (d[k] != null) d[k] += dP;
  } else if (part === 'a') Object.assign(d, { t1: t, p1: p });
  else if (part === 'b') Object.assign(d, { t2: t, p2: p });
  else if (part === 'tp' || part === 'sl') { // Comprar: TP arriba de la entrada y stop abajo; Vender: al revés
    const up = (part === 'tp') === (d.type === 'long');
    d[part] = up ? Math.max(p, d.p1 * (1 + LONG_DEFAULT.gap)) : Math.max(0, Math.min(p, d.p1 * (1 - LONG_DEFAULT.gap)));
  }
  else if (part === 'end') d.t2 = Math.max(t, d.t1);
  return d;
}

// Con una herramienta elegida, tocar el gráfico marca el punto; sin herramienta, tocar un dibujo empieza a arrastrarlo.
// (pointerdown y no click: el puntero redibuja el gráfico y un "click" se perdería)
document.addEventListener('pointerdown', (e) => {
  const svg = e.target.closest?.('svg[data-tf]');
  if (!svg || !isOwner() || !chartGeom[svg.dataset.tf] || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (!watch.tool) {
    const hit = drawingAt(svg, e);
    if (!hit) return;
    e.preventDefault();
    const { g, fx, fy } = chartPoint(svg, e);
    Object.assign(drawDrag, { d: drawingsOf()[hit.i], i: hit.i, part: hit.part, tf: svg.dataset.tf, t0: g.tAt(fx), p0: g.pAt(fy), orig: drawingsOf()[hit.i], moved: false });
    document.body.classList.add('drag-on');
    return;
  }
  e.preventDefault();
  const { g, fx, fy } = chartPoint(svg, e);
  const i = Math.max(0, Math.min(g.k.length - 1, Math.floor((fx - g.pad) / g.slot)));
  const pt = { t1: g.k[i][0], p1: g.pAt(fy) };
  if (watch.tool === 'trend' && !watch.pending) { watch.pending = pt; }
  else {
    const d = watch.tool === 'trend' ? { type: 'trend', ...watch.pending, t2: pt.t1, p2: pt.p1 }
      : isPos({ type: watch.tool }) ? (() => { const k = watch.tool === 'long' ? 1 : -1;
        return { type: watch.tool, ...pt, t2: pt.t1 + LONG_DEFAULT.bars * g.dt, tp: pt.p1 * (1 + k * LONG_DEFAULT.tp), sl: pt.p1 * (1 - k * LONG_DEFAULT.sl) }; })()
      : { type: watch.tool, ...pt };
    if (d.type === 'hline') delete d.t1;
    setDrawings([...drawingsOf(), d]);
    watch.tool = null; watch.pending = null;
  }
  $('#bigchart').innerHTML = bigChart();
});
document.addEventListener('pointermove', (e) => {
  const svg = e.target.closest?.('svg[data-tf]');
  if (!drawDrag.d) { // sin arrastre: la manito avisa que el dibujo se puede agarrar
    if (svg && !watch.tool && isOwner() && chartGeom[svg.dataset.tf]) {
      const hit = drawingAt(svg, e);
      svg.style.cursor = !hit ? '' : hit.part === 'tp' || hit.part === 'sl' ? 'ns-resize' : hit.part === 'end' ? 'ew-resize' : 'move';
    }
    return;
  }
  e.preventDefault();
  const box = document.querySelector(`svg[data-tf="${drawDrag.tf}"]`);
  if (!box) return;
  const { g, fx, fy } = chartPoint(box, e);
  const t = g.tAt(fx), p = g.pAt(fy);
  const list = drawingsOf().slice();
  list[drawDrag.i] = drawDrag.d = dragged(drawDrag.orig, drawDrag.part, t, p, t - drawDrag.t0, p - drawDrag.p0);
  state.db.settings.drawings[watch.sel] = list; // se guarda al soltar
  drawDrag.moved = true;
  if (!drawDrag.raf) drawDrag.raf = requestAnimationFrame(() => { drawDrag.raf = 0; const b = $('#bigchart'); if (b) b.innerHTML = bigChart(); });
}, { passive: false });
function endDrawDrag() {
  if (!drawDrag.d) return;
  const moved = drawDrag.moved;
  Object.assign(drawDrag, { d: null, i: -1, part: null, orig: null, moved: false });
  document.body.classList.remove('drag-on');
  if (moved) save();
  const b = $('#bigchart'); if (b) b.innerHTML = bigChart();
}
document.addEventListener('pointerup', endDrawDrag);
document.addEventListener('pointercancel', endDrawDrag);

// Segundo gráfico: velas de 1 hora del mismo símbolo, debajo del diario
function hourChart() {
  const c = watch.chart1h;
  const body = watch.chart1hErr ? `<div class="muted small">No se pudo cargar el gráfico de 1 hora: ${esc(watch.chart1hErr)}</div>`
    : !c || c.key !== chartKey() ? '<div class="chart-box muted small">Cargando velas de 1 hora…</div>'
    : candleChart(c, '1h');
  return `<div class="tf2">
    <div class="card-head chart-head"><h3 style="margin:0">Velas 1H</h3>
      <div class="seg sm" title="Período del gráfico de 1 hora">${HOUR_LABELS.map(([r, l]) => `<button type="button" class="${watch.hrange === r ? 'on' : ''}" data-action="watch-hrange" data-range="${r}">${l}</button>`).join('')}</div>
    </div>
    ${body}
  </div>`;
}

// Cuadro como el de TradingView: distancia del precio a cada media (verde arriba, rojo abajo), RSI y dividend yield
function indicatorsPanel(c, closes, series) {
  const px = c.price ?? closes.at(-1);
  const rsi = rsiLast(closes);
  const [kind, sym] = watch.sel.split(':');
  if (kind === 'S') loadDividends([sym]);
  const dy = kind === 'S' ? divInfo[sym] : null;
  const cell = (label, value, cl, tip) => `<div class="ind" title="${esc(tip)}"><span>${label}</span><b class="${cl}">${value}</b></div>`;
  return `<div class="ind-panel">
    ${MAS.map((m) => {
      const v = series[m.id].at(-1), d = v ? px / v - 1 : null;
      return cell(m.label, d == null ? '—' : pct(d).replace('+', ''), d == null ? '' : d >= 0 ? 'up' : 'down',
        d == null ? `Faltan datos para la ${m.label}` : `Precio ${d >= 0 ? 'arriba' : 'abajo'} de la ${m.label} (${price(v)})`);
    }).join('')}
    ${cell('RSI 14', rsi == null ? '—' : Math.round(rsi), rsi == null ? '' : rsi >= 70 ? 'down' : rsi <= 30 ? 'up' : 'neutral',
      'RSI diario: más de 70 = sobrecompra, menos de 30 = sobreventa')}
    ${kind === 'S' ? (() => { loadTargets([sym]); const g = tgtInfo[sym], mine = myTarget(sym), t = mine || g?.mean, u = upsideOf({ ticker: sym, px });
      return cell('Objetivo', !g && !mine ? '…' : t ? pct(u) : '—', u == null ? '' : u >= 0 ? 'up' : 'down',
        t ? `${mine ? 'Tu objetivo' : 'Objetivo promedio de los analistas'}: US$ ${num(t, 2)}${g?.mean && !mine ? ` (rango ${num(g.low, 2)} – ${num(g.high, 2)}, ${g.analysts} analistas)` : ''}` : 'Sin precio objetivo de analistas'); })() : ''}
    ${kind === 'S' ? cell('Div Yield', !dy ? '…' : dy.pays ? pct(dy.yield).replace('+', '') : '0%', 'info', 'Dividendos de los últimos 12 meses ÷ precio') : ''}
  </div>`;
}

function bigChart() {
  const c = watch.chart;
  if (watch.chartErr) return `<div class="muted small">No se pudo cargar el gráfico: ${esc(watch.chartErr)}</div>`;
  if (!c || c.key !== chartKey()) return '<div class="chart-box muted small">Cargando gráfico…</div>';
  if (c.candles) return (isOwner() ? drawToolbar() : '') + candleChart(c) + hourChart();
  const pts = c.points;
  if (pts.length < 2) return '<div class="muted small">Sin datos para este período.</div>';
  const W = 640, H = 220, pad = 6;
  const vals = pts.map((p) => p[1]), min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad), y = (v) => pad + (1 - (v - min) / span) * (H - 2 * pad);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const up = c.price >= c.prev;
  const prevY = c.prev >= min && c.prev <= max ? y(c.prev) : null;
  const h = watch.hover != null && pts[watch.hover] ? watch.hover : null;
  const fmt = (ms) => new Date(ms).toLocaleString('es-AR', watch.range === '1d' || watch.range === '5d'
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: '2-digit' });
  const shown = h != null ? pts[h] : pts.at(-1);
  const chg = shown[1] - c.prev;
  // Cripto opera las 24 h: en 1D se compara contra hace 24 h, no contra un cierre
  const vs = watch.range !== '1d' ? 'en el período' : watch.sel.startsWith('C:') ? 'últimas 24 h' : 'vs. cierre anterior';
  return `<div class="chart-read"><b>${price(shown[1])}</b> <span class="${cls(chg)}">${chg > 0 ? '+' : ''}${num(chg, 2)} (${pct(c.prev ? shown[1] / c.prev - 1 : null)})</span>
      <span class="muted small">${fmt(shown[0])} · ${vs}</span></div>
    <svg class="bigchart ${up ? 'pos' : 'neg'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-chart="${pts.length}">
      <polygon class="area" points="${x(0)},${H - pad} ${line} ${x(pts.length - 1)},${H - pad}"/>
      ${prevY != null ? `<line class="prevline" x1="${pad}" x2="${W - pad}" y1="${prevY}" y2="${prevY}"/>` : ''}
      <polyline class="line" points="${line}"/>
      ${h != null ? `<line class="cross" x1="${x(h)}" x2="${x(h)}" y1="${pad}" y2="${H - pad}"/><circle class="dot" cx="${x(h)}" cy="${y(pts[h][1])}" r="4"/>` : ''}
    </svg>
    <div class="chart-axis small muted"><span>${fmt(pts[0][0])}</span><span>Máx ${price(max)} · Mín ${price(min)}</span><span>${fmt(pts.at(-1)[0])}</span></div>`;
}

// Una tarjeta por sección (Acciones, Cripto, Seguidas). Cada una con su orden y su formulario para agregar.
function watchSection(id) {
  const S = SECTIONS[id], T = 'watch' + id;
  const tg = id !== 'C'; // columna Objetivo (solo acciones; en Seguidas las cripto quedan vacías)
  if (tg) loadTargets(S.list().filter(S.has).filter((k) => k[0] === 'S').map((k) => k.split(':')[1]));
  const rows = sortRows(T, S.list().filter(S.has).map((key, order) => {
    const [kind, sym] = key.split(':'), d = watch.data[key] || {};
    return { key, kind, sym, order, label: kind === 'C' ? sym + 'USD' : sym, ...d, upside: kind === 'S' ? upsideOf({ ticker: sym, px: d.price }) : null };
  }), 'order', 'asc');
  const arrow = (k) => (state.sort[T]?.key === k ? (state.sort[T].dir === 'asc' ? ' ▲' : ' ▼') : '');
  const head = (k, label, num = true) => `<span class="${num ? 'num ' : ''}sortable" data-sort="${T}:${k}">${label}${arrow(k)}</span>`;
  // ⇄ pasa el símbolo a la otra lista: de Acciones/Cripto a Seguidas, y de Seguidas a la que corresponda
  const swapTitle = (r) => (id !== 'F' ? 'Pasar a Seguidas' : r.kind === 'C' ? 'Pasar a Cripto' : 'Pasar a Acciones');
  return `<div class="card section watch">
    <h2>${S.title} <span class="muted small">${rows.length}</span></h2>
    ${id === 'F' ? '<p class="muted small" style="margin:0 6px 6px">Lo que no tenés pero querés controlar. Cuando compres una, pasala a tu lista con ⇄.</p>' : ''}
    <div class="watch-row watch-head ${tg ? 'tg' : ''}">
      ${head('label', 'Símbolo', false)}${head('price', 'Última')}${head('chg', 'Cbo')}${head('chgPct', 'Cambio%')}${tg ? head('upside', 'Objetivo') : ''}<span class="hide-sm">${id === 'C' ? '24 h' : 'Hoy'}</span><span></span>
    </div>
    ${rows.length ? '' : `<div class="muted small" style="padding:10px 6px">Todavía no agregaste ${S.empty}.</div>`}
    <div class="muted small watch-nomatch" style="padding:10px 6px" ${watch.q && rows.length && !rows.some((r) => watchMatch(`${r.label} ${r.sym} ${r.name || ''}`)) ? '' : 'hidden'}>Ningún símbolo coincide con la búsqueda.</div>
    <div class="watch-rows" data-list="${id}">
    ${rows.map((r) => `<div class="watch-row ${tg ? 'tg' : ''} ${r.key === watch.sel ? 'sel' : ''}" data-action="watch-sel" data-key="${esc(r.key)}"
      data-search="${esc(`${r.label} ${r.sym} ${r.name || ''}`)}" ${watchMatch(`${r.label} ${r.sym} ${r.name || ''}`) ? '' : 'hidden'}>
      <span class="watch-sym">${isOwner() ? '<span class="grip" title="Arrastrar para ordenar" aria-hidden="true">⠿</span>' : ''}<span class="sym-ico" style="background:${symColor(r.sym)}">${esc(r.sym.slice(0, 2))}</span>
        <span><b>${esc(r.label)}</b><span class="muted small watch-name">${esc(r.error ? r.error : r.name && r.name !== r.sym ? r.name : r.kind === 'C' ? 'Cripto' : '')}</span></span></span>
      <span class="num">${r.price != null ? price(r.price).replace('US$', '').trim() : '—'}</span>
      <span class="num ${cls(r.chg)}">${r.chg != null ? num(r.chg, Math.abs(r.chg) < 1 ? 4 : 2) : '—'}</span>
      <span class="num">${badge(r.chgPct)}</span>
      ${tg ? `<span class="num">${r.kind === 'S' ? targetCell({ ticker: r.sym, px: r.price }, true) : ''}</span>` : ''}
      <span class="hide-sm">${sparkline(r.spark, r.chg >= 0)}</span>
      <span class="watch-tools">${isOwner() ? `
        <button class="btn sm ghost" data-action="watch-swap" data-list="${id}" data-key="${esc(r.key)}" title="${swapTitle(r)}" aria-label="${swapTitle(r)}: ${esc(r.label)}">⇄</button>
        <button class="btn sm ghost" data-action="watch-del" data-list="${id}" data-key="${esc(r.key)}" title="Quitar de la lista" aria-label="Quitar ${esc(r.label)}">✕</button>` : ''}</span>
    </div>`).join('')}
    </div>
    ${isOwner() ? `<form class="filters" style="margin-top:12px" data-form="watch-add" data-list="${id}" autocomplete="off">
      ${id === 'F' ? '<select name="kind" aria-label="Tipo"><option value="S">Acción / ETF</option><option value="C">Cripto</option></select>' : `<input type="hidden" name="kind" value="${id}">`}
      <input name="sym" placeholder="${id === 'C' ? 'Cripto (ej. ETH, XRP)' : id === 'F' ? 'Símbolo (ej. TSLA, ETH)' : 'Símbolo (ej. TSLA, MELI)'}" required maxlength="15" autocapitalize="characters" spellcheck="false" style="text-transform:uppercase">
      <button class="btn primary" type="submit">+ Agregar</button>
    </form>` : ''}
    <p class="muted small" style="margin:10px 0 0">${id === 'C' ? 'Datos de Binance, contra USDT. Opera las 24 h: el cambio es de las últimas 24 horas.'
      : id === 'F' ? 'Acciones: Yahoo Finance (pueden tener unos minutos de demora). Cripto: Binance, contra USDT (cambio de 24 h).'
      : 'Datos de Yahoo Finance: pueden tener unos minutos de demora.'}</p>
  </div>`;
}

function viewWatch() {
  if (!watch.updated && !watch.loading) refreshWatch();
  if (watch.sel && !allWatchKeys().includes(watch.sel)) watch.sel = null;
  const sel = watch.sel && { sym: watch.sel.split(':')[1], kind: watch.sel[0], ...(watch.data[watch.sel] || {}) };
  const velas = watch.mode === 'velas';
  const ranges = velas ? CANDLE_LABELS : RANGE_LABELS, cur = velas ? watch.crange : watch.range;
  const tabs = [['S', 'Acciones'], ['C', 'Cripto'], ['F', 'Seguidas'], ['all', 'Todas']];
  return `
  <div class="page-head">
    <div><h1>Cotizaciones</h1><div class="sub">${watch.updated ? 'Actualizado ' + watch.updated.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + ' · se actualiza solo cada minuto · tocá un símbolo para ver su gráfico' : 'Cargando…'}</div></div>
    <div class="actions">${state.sort.watchS || state.sort.watchC || state.sort.watchF ? '<button class="btn" data-action="watch-unsort">Mi orden</button>' : ''}</div>
  </div>
  <div class="watch-bar">
    <div class="seg watch-tabs" role="tablist" aria-label="Qué lista ver">${tabs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${watch.tab === k}"
      class="${watch.tab === k ? 'on' : ''}" data-action="watch-tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <input id="watch-q" class="watch-search" type="search" placeholder="Buscar símbolo o nombre…" value="${esc(watch.q)}" autocomplete="off" spellcheck="false" aria-label="Buscar en las listas">
  </div>
  ${sel ? `<div class="card section">
    <div class="card-head chart-head">
      <h2><span class="sym-ico" style="background:${symColor(sel.sym)}">${esc(sel.sym.slice(0, 2))}</span> ${esc(sel.kind === 'C' ? sel.sym + 'USD' : sel.sym)} <span class="muted small">${esc(sel.name && sel.name !== sel.sym ? sel.name : '')}</span></h2>
      <div class="chart-ctrls">
        <div class="seg sm" title="Tipo de gráfico">
          <button type="button" class="${velas ? 'on' : ''}" data-action="watch-mode" data-mode="velas" title="Velas diarias y, debajo, de 1 hora">Velas 1D + 1H</button>
          <button type="button" class="${velas ? '' : 'on'}" data-action="watch-mode" data-mode="linea">Línea</button>
        </div>
        <div class="seg sm" title="Período">${ranges.map(([r, l]) => `<button type="button" class="${cur === r ? 'on' : ''}" data-action="watch-range" data-range="${r}">${l}</button>`).join('')}</div>
        ${isOwner() ? `<button type="button" class="btn sm" data-action="watch-alert" data-key="${esc(watch.sel)}" title="Avisarme por Telegram cuando llegue a un precio">🔔 Alerta</button>` : ''}
        <button type="button" class="btn sm ghost" data-action="watch-sel" data-key="${esc(watch.sel)}" title="Cerrar gráfico" aria-label="Cerrar gráfico">✕</button>
      </div>
    </div>
    <div id="bigchart">${bigChart()}</div>
  </div>` : ''}
  ${['S', 'C', 'F'].filter((id) => watch.tab === 'all' || watch.tab === id).map(watchSection).join('')}`;
}

