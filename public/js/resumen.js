'use strict';
// ================= Vistas =================
// ================= Evolución del patrimonio =================
// El servidor guarda una foto por día ({ idCartera: [valor, invertido, realizado acumulado] }); "realizado" = ventas +
// dividendos/renta cobrados desde el principio. La de hoy se manda cada vez que se actualizan precios.
// Para acciones, CEDEARs y cripto se reconstruye hacia atrás con las operaciones y los cierres diarios (hasta 2 años).
const hist = { data: null, busy: false, range: prefGet('histRange', '6mo'), pid: 'all', hover: null };
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const RECON_TYPES = ['cedear', 'stock', 'crypto'];

async function loadHistory() {
  try { hist.data = await api('/api/history'); } catch { hist.data = hist.data || { days: {} }; }
}
function saveSnapshot() {
  if (!isOwner() || !state.db.portfolios.length) return;
  const p = Object.fromEntries(computeAll().map((c) => [c.p.id, [(c.value || 0) - (c.cashIn || 0), c.cost || 0, (c.realized || 0) + (c.divTotal || 0)]]));
  const date = localDay();
  api('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, p }) })
    .then(() => { if (hist.data) hist.data.days[date] = { p, src: 'live' }; })
    .catch(() => { /* se reintenta en la próxima actualización */ });
}

// Reconstruye el valor y lo invertido de cada día, con el mismo método de costo promedio que el resto de la app
async function backfillHistory() {
  if (hist.busy || !isOwner()) return;
  const ports = state.db.portfolios.filter((p) => RECON_TYPES.includes(p.type));
  const txs = state.db.transactions.filter((t) => ports.some((p) => p.id === t.portfolioId)).sort((a, b) => a.date.localeCompare(b.date) || (a.side === 'buy' ? -1 : 1));
  if (!txs.length) return;
  hist.busy = true; render();
  try {
    // Cierres diarios de cada ticker (las mismas velas de 2 años de Cotizaciones)
    const need = [...new Set(txs.map((t) => (portfolio(t.portfolioId).type === 'crypto' ? 'C:' : 'S:') + t.ticker))];
    const closes = {};
    await Promise.all(need.map(async (k) => {
      const [kind, sym] = k.split(':');
      try { closes[k] = (await api(`/api/chart?type=candles&kind=${kind}&sym=${encodeURIComponent(sym)}`)).candles.map((c) => [localDay(new Date(c[0])), c[4]]); }
      catch { closes[k] = []; }
    }));
    const today = localDay(), start = new Date(Math.max(Date.parse(txs[0].date + 'T12:00'), Date.now() - 730 * 864e5));
    const days = {};
    for (const p of ports) {
      const ptx = txs.filter((t) => t.portfolioId === p.id);
      if (!ptx.length) continue;
      const divs = (state.db.dividends || []).filter((x) => x.portfolioId === p.id).sort((a, b) => a.date.localeCompare(b.date));
      const pos = {}, ptr = {}, last = {};
      let i = 0, di = 0, realized = 0;
      for (let d = new Date(start); localDay(d) < today; d.setDate(d.getDate() + 1)) {
        const day = localDay(d);
        for (; i < ptx.length && ptx[i].date <= day; i++) {
          const t = ptx[i], s = (pos[t.ticker] ||= { qty: 0, cost: 0, ratio: 1 });
          const q = +t.qty, u = unitUSD(t);
          s.ratio = +t.ratio || 1;
          if (t.side === 'buy') { s.qty += q; s.cost += q * u + (+t.fee || 0); }
          else {
            const qq = Math.min(q, s.qty), out = s.qty ? (s.cost / s.qty) * qq : 0;
            realized += qq * u - (+t.fee || 0) - out; // mismo cálculo que "Operaciones cerradas"
            s.cost -= out; s.qty -= qq; if (s.qty < 1e-9) { s.qty = 0; s.cost = 0; }
          }
        }
        for (; di < divs.length && divs[di].date <= day; di++) realized += +divs[di].amount || 0;
        let value = 0, cost = 0;
        for (const [tk, s] of Object.entries(pos)) {
          if (s.qty <= 0) continue;
          const k = (p.type === 'crypto' ? 'C:' : 'S:') + tk, cl = closes[k] || [];
          ptr[k] ??= 0;
          while (ptr[k] < cl.length && cl[ptr[k]][0] <= day) last[k] = cl[ptr[k]++][1];
          const px = last[k];
          value += px != null ? (s.qty / (p.type === 'cedear' ? s.ratio : 1)) * px : s.cost; // sin precio todavía: al costo
          cost += s.cost;
        }
        if (value || cost || realized) (days[day] ||= {})[p.id] = [value, cost, realized];
      }
    }
    await api('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'backfill', days }) });
    await loadHistory();
    toast('Historia reconstruida');
  } catch (e) { toast('No se pudo reconstruir la historia: ' + e.message); }
  finally { hist.busy = false; if (route().name === 'resumen') render(); }
}

function histSeries() {
  const days = Object.keys(hist.data?.days || {}).sort();
  const span = { '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366 }[hist.range];
  const from = span ? localDay(new Date(Date.now() - span * 864e5)) : '';
  return days.filter((d) => d >= from).map((d) => {
    const e = hist.data.days[d];
    const entries = Object.entries(e.p).filter(([id]) => hist.pid === 'all' ? portfolio(id) : id === hist.pid);
    return { d, src: e.src, v: entries.reduce((a, [, x]) => a + x[0], 0), c: entries.reduce((a, [, x]) => a + x[1], 0), n: entries.length, p: Object.fromEntries(entries) };
  }).filter((x) => x.n);
}
// Ganancia del período: cartera por cartera, desde el primer día que cada una tiene datos (así una cartera que
// empieza a registrarse a mitad del período no distorsiona el total). Sin contar plata que entró o salió.
function histGain(s, upto) {
  const first = {}, last = {};
  for (const x of s.slice(0, upto + 1)) for (const [id, v] of Object.entries(x.p)) { first[id] ??= v; last[id] = v; }
  // Resultado total de una cartera en un día = (valor − invertido) + lo ya realizado (ventas, dividendos, renta)
  const res = (v) => v[0] - v[1] + (v[2] || 0);
  let gain = 0;
  for (const id of Object.keys(last)) gain += res(last[id]) - res(first[id]);
  // El % es sobre el capital invertido promedio del período: si se fue agregando plata, el primer día no sirve de base
  const span = s.slice(0, upto + 1), base = span.reduce((a, x) => a + x.c, 0) / (span.length || 1);
  return { gain, pct: base > 0 ? gain / base : null };
}

function histChart() {
  const s = histSeries();
  if (s.length < 2) return `<div class="chart-box muted small">${s.length ? 'Hay una sola foto: el gráfico aparece desde mañana.' : 'Todavía no hay historia para este período.'}</div>`;
  const W = 640, H = 220, pad = 6;
  const all = s.flatMap((x) => [x.v, x.c]), min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const x = (i) => pad + (i / (s.length - 1)) * (W - 2 * pad), y = (v) => pad + (1 - (v - min) / span) * (H - 2 * pad);
  const line = (k) => s.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const h = hist.hover != null && s[hist.hover] ? hist.hover : null;
  const cur = s[h ?? s.length - 1], first = s[0];
  const { gain, pct: gainPct } = histGain(s, h ?? s.length - 1);
  const fmt = (d) => new Date(d + 'T12:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const firstLive = s.findIndex((p) => p.src === 'live');
  const lastCalc = firstLive > 0 ? firstLive - 1 : firstLive === -1 ? s.length - 1 : -1;
  return `<div class="chart-read"><b>${usd(cur.v)}</b> <span class="muted small">invertido ${usd(cur.c)} · ${fmt(cur.d)}${cur.src === 'calc' ? ' · reconstruido' : ''}</span></div>
    <div class="ohlc small"><span><span class="muted">Ganancia en el período</span> <b class="${cls(gain)}">${signed(gain)}</b>${gainPct != null ? ` <span class="${cls(gain)}">(${pct(gainPct)})</span>` : ''}</span>
      <span><span class="muted">Valor</span> ${usd(first.v)} → ${usd(cur.v)}</span><span><span class="muted">Máximo</span> ${usd(Math.max(...s.map((p) => p.v)))}</span></div>
    <svg class="bigchart histchart ${gain >= 0 ? 'pos' : 'neg'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-hchart="${s.length}">
      <polygon class="area" points="${x(0)},${H - pad} ${line('v')} ${x(s.length - 1)},${H - pad}"/>
      <polyline class="costline" points="${line('c')}"/>
      <polyline class="line" points="${line('v')}"/>
      ${lastCalc >= 0 && lastCalc < s.length - 1 ? `<line class="prevline" x1="${x(lastCalc)}" x2="${x(lastCalc)}" y1="${pad}" y2="${H - pad}"/>` : ''}
      ${h != null ? `<line class="cross" x1="${x(h)}" x2="${x(h)}" y1="${pad}" y2="${H - pad}"/><circle class="dot" cx="${x(h)}" cy="${y(s[h].v)}" r="4"/>` : ''}
    </svg>
    <div class="chart-axis small muted"><span>${fmt(first.d)}</span><span><span class="legend-line"></span> Valor · <span class="legend-line cost"></span> Invertido</span><span>${fmt(s.at(-1).d)}</span></div>
    ${lastCalc >= 0 ? `<p class="muted small" style="margin:6px 0 0">${lastCalc < s.length - 1 ? `Hasta el ${fmt(s[lastCalc].d)} (línea punteada) es` : 'Todo el período es'} historia reconstruida con tus operaciones y los precios de cierre: incluye solo acciones, CEDEARs y cripto spot.${hist.pid === 'all' ? ' Futuros, bots y bonos se suman desde que la app los registra.' : ''}</p>` : ''}`;
}

function evolutionCard(all) {
  if (!hist.data) { loadHistory().then(() => { if (route().name === 'resumen') render(); }); return '<div class="card section"><h2>Evolución</h2><div class="muted small">Cargando…</div></div>'; }
  // La primera vez se reconstruye sola la historia de las carteras que se pueden calcular
  if (isOwner() && !hist.data.backfilled && !hist.busy && state.db.transactions.length) setTimeout(backfillHistory, 0);
  return `<div class="card section">
    <div class="card-head chart-head">
      <h2>Evolución ${hist.busy ? '<span class="muted small">reconstruyendo historia…</span>' : ''}</h2>
      <div class="chart-ctrls">
        <select data-hist-pid aria-label="Cartera"><option value="all">Todas las carteras</option>${all.map((c) => `<option value="${c.p.id}" ${hist.pid === c.p.id ? 'selected' : ''}>${esc(c.p.name)}</option>`).join('')}</select>
        <div class="seg sm">${[['1mo', '1M'], ['3mo', '3M'], ['6mo', '6M'], ['1y', '1A'], ['all', 'Todo']].map(([r, l]) => `<button type="button" class="${hist.range === r ? 'on' : ''}" data-action="hist-range" data-range="${r}">${l}</button>`).join('')}</div>
      </div>
    </div>
    <div id="histchart">${histChart()}</div>
  </div>`;
}

function viewSummary() {
  const all = computeAll();
  const value = all.reduce((a, c) => a + c.value, 0);
  const cost = all.reduce((a, c) => a + c.cost, 0);
  const unreal = all.reduce((a, c) => a + c.unrealized, 0);
  const realized = all.reduce((a, c) => a + c.realized, 0);
  const divs = all.reduce((a, c) => a + c.divTotal, 0);
  const day = all.reduce((a, c) => a + c.dayChg, 0);
  const dayPct = dayPctOf(all.flatMap((c) => c.positions), day);
  const deposits = all.reduce((a, c) => a + c.deposits, 0);

  const allPos = all.flatMap((c) => c.positions.map((x) => ({ ...x, pname: c.p.name })));
  const top = [...allPos].sort((a, b) => (b.value ?? b.cost) - (a.value ?? a.cost)).slice(0, 10);

  return `
  <div class="page-head">
    <div><h1>Resumen</h1><div class="sub">Todas tus carteras en USD</div></div>
    <div class="actions"><button class="btn primary" data-action="new-tx">+ Operación</button></div>
  </div>
  <div class="kpis">
    ${kpi('Valor actual', usd(value), day ? `${signed(day)} (${pct(dayPct)}) hoy` : null, cls(day))}
    ${kpi('Invertido (posiciones abiertas)', usd(cost))}
    ${kpi('Resultado no realizado', signed(unreal), cost ? pct(unreal / cost) : null, cls(unreal))}
    ${kpi('Realizado + dividendos', signed(realized + divs), `Ventas ${signed(realized)} · Div ${usd(divs)}`, cls(realized + divs))}
    ${kpi('Aportes netos', usd(deposits))}
  </div>
  ${evolutionCard(all)}
  <div class="pcards">
    ${all.map((c) => `
      <a class="card pcard" href="#/p/${c.p.id}">
        <div class="top"><span class="dot" style="background:${slotColor(c.p)}"></span>${esc(c.p.name)}<span class="type">${TYPES[c.p.type]}</span></div>
        <div class="big">${usd(c.value)}</div>
        <div class="row"><span>No realizado</span><span class="${cls(c.unrealized)}">${signed(c.unrealized)} (${pct(c.cost ? c.unrealized / c.cost : null)})</span></div>
        <div class="row"><span>Hoy</span><span class="${cls(c.dayChg)}">${signed(c.dayChg)}${c.dayPct != null ? ` (${pct(c.dayPct)})` : ''}</span></div>
        <div class="row"><span>Realizado</span><span class="${cls(c.realized)}">${signed(c.realized)}</span></div>
        <div class="row"><span>Posiciones</span><span>${c.positions.length}</span></div>
      </a>`).join('')}
  </div>
  <div class="grid-2">
    <div class="card"><h2>Distribución por cartera</h2>
      ${donut(all.map((c) => ({ label: c.p.name, value: c.value, color: slotColor(c.p) })), value)}
    </div>
    <div class="card"><h2>Mayores posiciones</h2>
      ${hbars(top.map((x) => ({
        label: x.ticker,
        value: x.value ?? x.cost,
        sub: `${usd(x.value ?? x.cost)} · ${pct(value ? (x.value ?? x.cost) / value : 0).replace('+', '')}`,
        tip: `<b>${esc(x.ticker)}</b> · ${esc(x.pname)}<br>Valor ${usd(x.value)}<br>Resultado <b>${signed(x.pnl)}</b> (${pct(x.pnlPct)})`,
      })))}
    </div>
  </div>`;
}

// Torta de distribución de una cartera. Hasta 8 porciones con color (paleta validada);
// si hay más posiciones, las 7 mayores y el resto agrupado en "Otros".
function allocationCard(p, c) {
  const mode = state.allocMode[p.id] || 'value';
  const val = (x) => (mode === 'value' ? x.value ?? x.cost : x.cost);
  const total = c.positions.reduce((a, x) => a + val(x), 0);
  const sorted = [...c.positions].sort((a, b) => val(b) - val(a));
  const top = sorted.length > 8 ? sorted.slice(0, 7) : sorted;
  const rest = sorted.slice(top.length);
  const tipFor = (x) => `<b>${esc(x.ticker)}</b><br>${mode === 'value' ? 'Valor' : 'Invertido'} <b>${usd(val(x))}</b> · ${pct(val(x) / total).replace('+', '')}` +
    `<br>Invertido ${usd(x.cost)} → hoy ${usd(x.value)}<br>Resultado <b>${signed(x.pnl)}</b> (${pct(x.pnlPct)})`;
  const items = top.map((x, i) => ({
    label: x.ticker, value: val(x), color: `var(--series-${i + 1})`, tip: tipFor(x),
    sub: x.pnlPct != null ? `<span class="${cls(x.pnlPct)}">${pct(x.pnlPct)}</span>` : '',
  }));
  if (rest.length) {
    const rv = rest.reduce((a, x) => a + val(x), 0);
    items.push({
      label: `Otros (${rest.length})`, value: rv, color: 'var(--series-other)',
      tip: `<b>Otros</b> · ${usd(rv)} · ${pct(rv / total).replace('+', '')}<br>${rest.map((x) => `${esc(x.ticker)} ${pct(val(x) / total).replace('+', '')}`).join('<br>')}`,
      sub: `<span>${esc(rest.map((x) => x.ticker).join(', '))}</span>`,
    });
  }
  const res = mode === 'value' ? c.unrealized : null;
  const seg = (m, label) => `<button type="button" class="${mode === m ? 'on' : ''}" data-action="alloc-mode" data-pid="${p.id}" data-mode="${m}">${label}</button>`;
  return `<div class="card section">
    <div class="card-head"><h2>¿En qué tengo invertido?</h2><div class="seg sm">${seg('value', 'Valor actual')}${seg('cost', 'Invertido')}</div></div>
    ${donut(items, total, {
      size: 240, stroke: 34, big: true, legendUsd: true, aria: 'Distribución de ' + p.name,
      centerLabel: mode === 'value' ? 'Valor actual' : 'Invertido',
      centerSub: res != null && c.cost ? `${signed(res)} (${pct(res / c.cost)})` : '',
      centerSubColor: res > 0 ? 'var(--pos)' : res < 0 ? 'var(--neg)' : undefined,
    })}
  </div>`;
}

