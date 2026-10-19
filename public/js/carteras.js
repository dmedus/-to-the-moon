'use strict';
// ================= Dividendos (datos de Yahoo) =================
// Se piden al abrir una cartera de acciones o CEDEARs; el servidor los guarda 6 h.
const divInfo = {}, divPending = new Set();
function loadDividends(tickers) {
  const need = tickers.filter((t) => !(t in divInfo) && !divPending.has(t));
  if (!need.length) return;
  need.forEach((t) => divPending.add(t));
  api('/api/dividends?tickers=' + need.join(','))
    .then((r) => { Object.assign(divInfo, r); })
    .catch(() => { for (const t of need) divInfo[t] = { error: 'sin datos' }; })
    .finally(() => { need.forEach((t) => divPending.delete(t)); render(); });
}

// Precio objetivo promedio de los analistas (Yahoo); el servidor lo guarda 12 h
const tgtInfo = {}, tgtPending = new Set();
function loadTargets(tickers) {
  const need = tickers.filter((t) => !(t in tgtInfo) && !tgtPending.has(t));
  if (!need.length) return;
  need.forEach((t) => tgtPending.add(t));
  api('/api/targets?tickers=' + need.join(','))
    .then((r) => { Object.assign(tgtInfo, r); })
    .catch(() => { for (const t of need) tgtInfo[t] = { error: 'sin datos' }; })
    .finally(() => { need.forEach((t) => tgtPending.delete(t)); render(); });
}
const REC = { strong_buy: 'Compra fuerte', buy: 'Compra', hold: 'Mantener', underperform: 'Bajo rendimiento', sell: 'Venta', strong_sell: 'Venta fuerte' };
// Objetivo propio cargado a mano (Ajustes del usuario): pisa al de los analistas
const myTarget = (t) => state.db.settings?.targets?.[t] || null;
// Precio de la acción en dólares para comparar: el de Yahoo; si no hay (ej. ETF), el de la cartera (en CEDEARs, por acción)
const sharePx = (x) => tgtInfo[x.ticker]?.price || (x.px != null ? x.px * (x.ratio || 1) : null);
const upsideOf = (x) => { const tgt = myTarget(x.ticker) || tgtInfo[x.ticker]?.mean, px = sharePx(x); return tgt && px ? tgt / px - 1 : null; };
function targetCell(x, compact) {
  const g = tgtInfo[x.ticker], mine = myTarget(x.ticker);
  const edit = (inner, tip) => `<span class="tgt-edit" data-action="edit-target" data-ticker="${esc(x.ticker)}" title="${esc(tip + (isOwner() ? ' · Tocá para cambiarlo' : ''))}">${inner}</span>`;
  const an = g?.mean ? `Analistas: US$ ${num(g.mean, 2)} (rango ${num(g.low, 2)} – ${num(g.high, 2)})${g.analysts ? ` · ${g.analysts} analistas` : ''}${g.rec ? ` · ${REC[g.rec] || g.rec}` : ''}` : 'Sin objetivo de analistas';
  if (mine) return edit(`${badge(upsideOf(x))}${compact ? '' : `<div class="muted small">US$ ${num(mine, 2)} ✎</div>`}`, `Tu objetivo: US$ ${num(mine, 2)} · ${an}`);
  if (!g) return '<span class="muted">…</span>';
  if (!g.mean) return edit('<span class="muted">—</span>', 'Sin precio objetivo de analistas (los ETF no tienen)');
  return edit(`${badge(upsideOf(x))}${compact ? '' : `<div class="muted small">US$ ${num(g.mean, 2)}</div>`}`, an + ` · precio US$ ${num(g.price, 2)}`);
}
function targetForm(ticker) {
  const g = tgtInfo[ticker], mine = myTarget(ticker);
  const body = `
    ${field(`Precio objetivo de ${esc(ticker)} (US$ por acción)`, `<input name="target" type="number" step="any" min="0" value="${mine ?? ''}" placeholder="${g?.mean ? num(g.mean, 2) : ''}">`,
      { full: true, hint: (g?.mean ? `Analistas: US$ ${num(g.mean, 2)} (rango ${num(g.low, 2)} – ${num(g.high, 2)}). ` : '') + 'Dejalo vacío para usar el de los analistas. En CEDEARs, el precio de la acción en Nueva York.' })}`;
  openModal('Objetivo de ' + ticker, body, (d) => {
    const s = (state.db.settings ||= {}), v = +d.target;
    s.targets ||= {};
    if (v > 0) s.targets[ticker] = v; else delete s.targets[ticker];
    save(); toast(v > 0 ? 'Objetivo guardado' : 'Vuelve el objetivo de los analistas');
  });
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dShort = (ms) => new Date(ms).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });

function dividendsCard(p, c) {
  const isCedear = p.type === 'cedear';
  const tickers = c.positions.map((x) => x.ticker);
  loadDividends(tickers);
  if (tickers.some((t) => !(t in divInfo))) return `<div class="card section"><h2>Dividendos</h2><div class="muted small">Buscando dividendos…</div></div>`;

  const rows = [], none = [], now = Date.now();
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + i); return { y: d.getFullYear(), m: d.getMonth(), total: 0, who: [] }; });
  for (const x of c.positions) {
    const d = divInfo[x.ticker];
    if (!d?.pays) { none.push(x.ticker); continue; }
    // Acciones reales detrás de tus CEDEARs: cantidad ÷ ratio
    const shares = isCedear ? x.qty / (x.ratio || 1) : x.qty;
    const annual = d.ttm * shares;
    for (const u of d.upcoming || []) {
      const dt = new Date(u.date), b = months.find((mm) => mm.y === dt.getFullYear() && mm.m === dt.getMonth());
      if (b) { b.total += u.amount * shares; b.who.push(x.ticker); }
    }
    rows.push({ x, d, shares, annual, yoc: x.cost ? annual / x.cost : null, next: d.upcoming?.[0] || null, perCedear: isCedear ? d.last.amount / (x.ratio || 1) : null });
  }
  const annualTotal = rows.reduce((a, r) => a + r.annual, 0);
  const next = rows.filter((r) => r.next).sort((a, b) => a.next.date - b.next.date);
  const soon = next.filter((r) => r.next.date - now < 30 * 864e5);
  const max = Math.max(...months.map((mm) => mm.total), 1);
  const sorted = sortRows('div-' + p.id, rows.map((r) => ({ ...r, ticker: r.x.ticker, yield: r.d.yield, nextDate: r.next?.date ?? Infinity })), 'annual');
  const D = 'div-' + p.id;

  return `<div class="card section divs">
    <h2>Dividendos <span class="muted small">(últimos 12 meses, en USD, montos brutos)</span></h2>
    <div class="kpis">
      ${kpi('Cobro anual estimado', usd(annualTotal), `≈ ${usd(annualTotal / 12)} por mes`, 'pos')}
      ${kpi('Dividend yield de la cartera', pct(c.value ? annualTotal / c.value : null).replace('+', ''), `Sobre el valor actual (${usd(c.value)})`)}
      ${kpi('Yield sobre tu costo', pct(c.cost ? annualTotal / c.cost : null).replace('+', ''), `Sobre lo invertido (${usd(c.cost)})`)}
      ${kpi('Próximo ex-dividendo', next[0] ? `${esc(next[0].x.ticker)} · ${dShort(next[0].next.date)}` : '—',
        soon.length ? `${soon.length} en los próximos 30 días` : 'Estimado según pagos anteriores')}
    </div>
    <h3 class="small muted" style="margin:4px 0 8px">Calendario estimado de cobros (próximos 12 meses)</h3>
    <div class="div-cal">${months.map((mm) => `
      <div class="div-month" data-tip="${esc(mm.who.length ? [...new Set(mm.who)].join(', ') : 'Sin pagos estimados')}">
        <div class="div-amt">${mm.total ? usd(mm.total) : ''}</div>
        <div class="div-bar"><span style="height:${(mm.total / max) * 100}%"></span></div>
        <div class="div-lbl">${MESES[mm.m]}${mm.m === 0 ? ` ${String(mm.y).slice(2)}` : ''}</div>
      </div>`).join('')}
    </div>
    <div class="table-wrap" style="margin-top:14px"><table>
      <thead><tr>${th(D, 'ticker', 'Ticker', false)}${th(D, 'yield', 'Yield')}<th>Frecuencia</th><th>Último pago</th>
        ${isCedear ? '<th class="num">Por CEDEAR</th>' : ''}${th(D, 'nextDate', 'Próximo ex-div (est.)')}${th(D, 'annual', 'Tu cobro anual')}${th(D, 'yoc', 'Yield s/costo')}<th class="num">vs año anterior</th></tr></thead>
      <tbody>${sorted.map((r) => `<tr>
        <td class="ticker">${esc(r.ticker)}</td>
        <td class="num"><b>${pct(r.yield).replace('+', '')}</b></td>
        <td>${esc(r.d.freq)}</td>
        <td>${dShort(r.d.last.date)} <span class="muted small">US$ ${num(r.d.last.amount, 4)}/acción</span></td>
        ${isCedear ? `<td class="num">${r.perCedear == null ? '—' : 'US$ ' + num(r.perCedear, 4)}</td>` : ''}
        <td class="num">${r.next ? dShort(r.next.date) + (r.next.date - now < 30 * 864e5 ? ' <span class="tag buy">pronto</span>' : '') : r.d.stale ? '<span class="muted small">sin pagos recientes</span>' : '—'}</td>
        <td class="num pos"><b>${usd(r.annual)}</b></td>
        <td class="num">${pct(r.yoc).replace('+', '')}</td>
        <td class="num">${badge(r.d.growth)}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Ninguna posición paga dividendos.</td></tr>'}</tbody>
    </table></div>
    <p class="muted small" style="margin:10px 0 0">
      ${none.length ? `No pagan dividendos: <b>${none.map(esc).join(', ')}</b>.<br>` : ''}
      Las fechas son <b>ex-dividendo</b>: para cobrar tenés que tener el activo antes de esa fecha, y el pago llega unas semanas después.
      Las próximas fechas y montos son estimados según los pagos anteriores. Montos brutos: el broker puede descontar retenciones de impuestos.
    </p>
  </div>`;
}

// ================= Renta de bonos y ONs =================
// Ficha de cada bono en settings.bondInfo[ticker]: { name, rate (anual, ej. 0.065), perYear, months ("Ene / Jul" o "Mensual"),
// maturity ("AAAA-MM-DD"), currency, note }. Con eso se estima la renta: VN × tasa ÷ pagos por año (solo interés, sin amortizaciones).
const MES_IDX = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dic: 11 };
const bondInfoOf = (t) => state.db.settings?.bondInfo?.[t] || null;
function payMonths(info) {
  if (!info) return [];
  if (+info.perYear === 12 || /mensual/i.test(info.months || '')) return [...Array(12).keys()];
  return [...new Set((searchNorm(info.months || '').match(/[a-z]{3}/g) || []).map((m) => MES_IDX[m]).filter((m) => m != null))].sort((a, b) => a - b);
}
const pesoBond = (info) => /peso/i.test(info?.currency || '');

function bondIncome(x) {
  const info = bondInfoOf(x.ticker);
  if (!info || !(+info.rate > 0) || !(+info.perYear > 0)) return { info, missing: true };
  // En pesos (CER): el VN no está en dólares; el cupón se estima sobre el valor actual, como en la planilla del broker
  const base = pesoBond(info) ? x.value || 0 : x.qty;
  const perPay = (base * +info.rate) / +info.perYear;
  const months = payMonths(info);
  const now = new Date(), mat = info.maturity ? new Date(info.maturity + 'T12:00') : null;
  // Próximos 12 meses (desde el actual), sin pagos después del vencimiento
  const cal = Array.from({ length: 12 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() + i, 1); return { y: d.getFullYear(), m: d.getMonth() }; })
    .filter((mm) => months.includes(mm.m) && (!mat || new Date(mm.y, mm.m, 1) <= mat));
  // Yield corriente = tasa ÷ precio por VN. No tiene sentido en bonos en pesos con CER (el VN no está en dólares)
  const ycur = x.px && !pesoBond(info) ? +info.rate / (x.px / BOND_BASE) : null;
  return { info, missing: false, perPay, annual: perPay * cal.length, cal, next: cal[0] || null, ycur, estimated: pesoBond(info) };
}

function bondIncomeCard(p, c) {
  const rows = c.positions.map((x) => ({ x, ...bondIncome(x) }));
  const withInfo = rows.filter((r) => !r.missing), missing = rows.filter((r) => r.missing);
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + i); return { y: d.getFullYear(), m: d.getMonth(), total: 0, who: [] }; });
  for (const r of withInfo) for (const k of r.cal) { const b = months.find((mm) => mm.y === k.y && mm.m === k.m); if (b) { b.total += r.perPay; b.who.push(r.x.ticker); } }
  const annual = withInfo.reduce((a, r) => a + r.annual, 0);
  const valueWith = withInfo.reduce((a, r) => a + (r.x.value || 0), 0);
  const nextM = months.find((mm) => mm.total > 0);
  const max = Math.max(...months.map((mm) => mm.total), 1);
  const T = 'bi-' + p.id;
  const list = sortRows(T, withInfo.map((r) => ({ ...r, ticker: r.x.ticker, rate: +r.info.rate, ycur: r.ycur, nextKey: r.next ? r.next.y * 12 + r.next.m : Infinity })), 'annual');
  const mesTxt = (k) => `${MESES[k.m]}${k.y !== new Date().getFullYear() ? ' ' + String(k.y).slice(2) : ''}`;
  return `<div class="card section divs">
    <h2>Renta <span class="muted small">(cupones estimados según la ficha de cada bono · solo interés, sin amortizaciones)</span></h2>
    <div class="kpis">
      ${kpi('Renta anual estimada', usd(annual), `≈ ${usd(annual / 12)} por mes`, 'pos')}
      ${kpi('Yield corriente', pct(valueWith ? annual / valueWith : null).replace('+', ''), 'Renta de 12 meses ÷ valor actual')}
      ${kpi('Próximo cobro', nextM ? `${MESES[nextM.m]} · ${usd(nextM.total)}` : '—', nextM ? esc([...new Set(nextM.who)].join(', ')) : null)}
      ${kpi('Bonos sin ficha', String(missing.length), missing.length ? 'Completá tasa y fechas con "Ficha"' : 'Todos tienen ficha', missing.length ? 'neg' : '')}
    </div>
    <h3 class="small muted" style="margin:4px 0 8px">Calendario de cupones (próximos 12 meses)</h3>
    <div class="div-cal">${months.map((mm) => `
      <div class="div-month" data-tip="${esc(mm.who.length ? [...new Set(mm.who)].join(', ') : 'Sin cupones')}">
        <div class="div-amt">${mm.total ? usd(mm.total) : ''}</div>
        <div class="div-bar"><span style="height:${(mm.total / max) * 100}%"></span></div>
        <div class="div-lbl">${MESES[mm.m]}${mm.m === 0 ? ` ${String(mm.y).slice(2)}` : ''}</div>
      </div>`).join('')}
    </div>
    <div class="table-wrap" style="margin-top:14px"><table>
      <thead><tr>${th(T, 'ticker', 'Bono', false)}${th(T, 'rate', 'Tasa')}<th>Pagos</th>${th(T, 'ycur', 'Yield corriente')}
        ${th(T, 'perPay', 'Por cupón')}${th(T, 'annual', 'Renta 12 meses')}${th(T, 'nextKey', 'Próximo')}<th></th></tr></thead>
      <tbody>${list.map((r) => `<tr>
        <td class="ticker">${esc(r.ticker)}${r.info.note ? ` <span class="tag" title="${esc(r.info.note)}">${/baja confianza|verificar/i.test(r.info.note) ? '⚠ ' : ''}nota</span>` : ''}
          ${r.info.name ? `<div class="muted small" style="font-weight:400">${esc(r.info.name)}</div>` : ''}</td>
        <td class="num">${pct(+r.info.rate).replace('+', '')}</td>
        <td>${esc(+r.info.perYear === 12 ? 'Mensual' : r.info.months || '—')}${r.info.maturity ? ` <span class="muted small">· vence ${fmtDate(r.info.maturity)}</span>` : ''}</td>
        <td class="num"><b>${pct(r.ycur).replace('+', '')}</b></td>
        <td class="num">${usd(r.perPay)}${r.estimated ? ' <span class="muted small" title="Bono en pesos: estimado sobre el valor actual">est.</span>' : ''}</td>
        <td class="num pos"><b>${usd(r.annual)}</b></td>
        <td class="num">${r.next ? mesTxt(r.next) : '—'}</td>
        <td class="num">${isOwner() ? `<button class="btn sm" data-action="bond-info" data-ticker="${esc(r.ticker)}">Ficha</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">Ningún bono tiene ficha todavía.</td></tr>'}
      ${missing.map((r) => `<tr class="row-alert"><td class="ticker">${esc(r.x.ticker)}</td><td colspan="6" class="muted small">Sin ficha: cargá tasa del cupón, frecuencia y meses de pago para estimar su renta.</td>
        <td class="num">${isOwner() ? `<button class="btn sm primary" data-action="bond-info" data-ticker="${esc(r.x.ticker)}">Ficha</button>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="muted small" style="margin:10px 0 0">El cupón se estima como VN × tasa ÷ pagos por año, en el mes de pago (el día exacto puede correrse por feriados). No incluye amortizaciones de capital.
      Yield corriente = tasa ÷ precio actual. Los cupones que cobres cargalos con "+ Renta" para que sumen al resultado.</p>
  </div>`;
}

function bondInfoForm(ticker) {
  const i = bondInfoOf(ticker) || {};
  openModal('Ficha de ' + esc(ticker), `
    ${field('Nombre / descripción', `<input name="name" value="${esc(i.name || '')}" placeholder="Ej. ON YPF 8,25% 2034">`, { full: true })}
    ${field('Tasa del cupón anual (%)', `<input name="rate" type="number" step="any" min="0" value="${i.rate != null ? +(i.rate * 100).toFixed(4) : ''}" placeholder="Ej. 6,5">`)}
    ${field('Pagos por año', `<select name="perYear">${[[1, 'Anual'], [2, 'Semestral'], [4, 'Trimestral'], [12, 'Mensual']].map(([v, l]) => `<option value="${v}" ${+i.perYear === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
    ${field('Meses de pago', `<input name="months" value="${esc(i.months || '')}" placeholder="Ej. Ene / Jul">`, { hint: 'Para mensuales no hace falta' })}
    ${field('Vencimiento', `<input name="maturity" type="date" value="${esc(i.maturity || '')}">`, { hint: 'Después de esta fecha no se cuentan cupones' })}
    ${field('Moneda del bono', `<select name="currency"><option value="USD" ${pesoBond(i) ? '' : 'selected'}>Dólares</option><option value="Pesos" ${pesoBond(i) ? 'selected' : ''}>Pesos (CER / tasa)</option></select>`)}
    ${field('Nota', `<input name="note" value="${esc(i.note || '')}">`, { full: true })}`, (d) => {
    const s = (state.db.settings ||= {});
    s.bondInfo ||= {};
    s.bondInfo[ticker] = { ...i, name: d.name.trim(), rate: d.rate === '' ? null : +d.rate / 100, perYear: +d.perYear,
      months: +d.perYear === 12 ? 'Mensual' : d.months.trim(), maturity: d.maturity || null, currency: d.currency, note: d.note.trim() };
    save(); toast('Ficha guardada');
  });
}

// % como etiqueta de color con flecha: se ve de un vistazo si va ganando o perdiendo.
const badge = (v) => (v == null || !isFinite(v) ? '—'
  : `<span class="badge ${cls(v)}">${v > 0.000001 ? '▲' : v < -0.000001 ? '▼' : ''} ${pct(v).replace('+', '')}</span>`);

// Recuadro grande con el resultado de lo abierto, en verde o rojo. Al costado, filas [etiqueta, valor] según la cartera.
function resultBanner(c, { what = 'posiciones abiertas', base = c.cost, baseTxt = 'invertidos', side } = {}) {
  const v = c.unrealized, r = base ? v / base : null;
  const up = c.positions.filter((x) => x.pnl > 0.000001).length, down = c.positions.filter((x) => x.pnl < -0.000001).length;
  side ||= [['Ventas realizadas', c.realized], ...(c.divTotal ? [['Dividendos', c.divTotal]] : []), ['Total histórico', v + c.realized + c.divTotal]];
  return `<div class="card section result-banner ${cls(v)}">
    <div>
      <div class="label">${v > 0.000001 ? 'Ganando' : v < -0.000001 ? 'Perdiendo' : 'Sin resultado'} <span class="muted">· ${what}</span></div>
      <div class="result-big">${signed(v)} <span class="result-pct">${pct(r)}</span></div>
      <div class="small muted">sobre ${usd(base)} ${baseTxt} · <span class="pos">${up} ganando</span> · <span class="neg">${down} perdiendo</span></div>
    </div>
    <div class="result-side small">${side.map(([label, val]) => `<div><span class="muted">${label}</span><b class="${cls(val)}">${signed(val)}</b></div>`).join('')}</div>
  </div>`;
}

function viewPortfolio(p) {
  const c = compute(p);
  const isCedear = p.type === 'cedear', isBond = p.type === 'bonds';
  const divWord = isBond ? 'Renta' : 'Dividendos'; // en bonos y ONs: cupones y amortizaciones cobrados
  const isEq = p.type === 'stock' || p.type === 'cedear'; // acciones: se muestra el objetivo de los analistas
  if (isEq) loadTargets(c.positions.map((x) => x.ticker));
  const T = 'pos-' + p.id;
  const base = isEq ? c.positions.map((x) => ({ ...x, upside: upsideOf(x) })) : c.positions;
  const rows = myOrderRows(p, T, sortRows(T, base, 'value'), (x) => x.ticker);
  const closed = sortRows('cl-' + p.id, c.closed, 'date');
  const C = 'cl-' + p.id;
  const qtyFmt = (n) => qty(n, p.type === 'crypto' ? 8 : 4);

  return `
  <div class="page-head">
    <div><h1><span class="dot" style="display:inline-block;background:${slotColor(p)};margin-right:8px"></span>${esc(p.name)}</h1>
      <div class="sub">${TYPES[p.type]}${p.broker ? ' · ' + esc(p.broker) : ''}</div></div>
    <div class="actions">
      <button class="btn" data-action="new-aporte" data-pid="${p.id}">+ Aporte</button>
      <button class="btn" data-action="new-div" data-pid="${p.id}">${isBond ? '+ Renta' : '+ Dividendo'}</button>
      <button class="btn primary" data-action="new-tx" data-pid="${p.id}">+ Operación</button>
    </div>
  </div>
  ${c.positions.length || c.closed.length ? resultBanner(c, isBond ? { side: [['Ventas realizadas', c.realized], ['Renta cobrada', c.divTotal], ['Total histórico', c.unrealized + c.realized + c.divTotal]] } : {}) : ''}
  <div class="kpis">
    ${kpi('Valor actual', usd(c.value), c.dayChg ? `${signed(c.dayChg)} (${pct(c.dayPct)}) hoy` : null, cls(c.dayChg))}
    ${kpi('Invertido', usd(c.cost))}
    ${kpi('No realizado', signed(c.unrealized), c.cost ? pct(c.unrealized / c.cost) : null, cls(c.unrealized))}
    ${kpi('Realizado', signed(c.realized), `${c.closed.length} ventas`, cls(c.realized))}
    ${kpi(isBond ? 'Renta cobrada' : 'Dividendos', usd(c.divTotal), isBond ? 'Cupones y amortizaciones' : null)}
    ${kpi('Aportes', usd(c.deposits), autoDep(p) ? (c.cashIn ? `Invertido + ${usd(c.cashIn)} de efectivo` : 'Igual a lo invertido') : null)}
  </div>
  ${c.missing.length ? `<div class="card section small">⚠ Sin cotización para <b>${esc(c.missing.join(', '))}</b> — se valúan al costo. Podés fijar un precio manual en <a href="#/ajustes">Ajustes</a>.</div>` : ''}
  ${c.positions.length ? allocationCard(p, c) : ''}
  <div class="card section">
    <h2>Cartera${myOrderBtn(p, T)}</h2>
    <div class="table-wrap"><table>
      <thead><tr>
        ${th(T, 'ticker', 'Ticker', false)}
        ${th(T, 'qty', isCedear ? 'CEDEARs' : isBond ? 'VN' : 'Cantidad')}
        ${th(T, 'avg', isBond ? 'Precio prom. c/100' : 'Precio prom.')}
        ${th(T, 'px', isBond ? 'Precio actual c/100' : 'Precio actual')}
        ${th(T, 'dayPct', 'Hoy')}
        ${th(T, 'cost', 'Invertido')}
        ${th(T, 'value', 'Valor actual')}
        ${th(T, 'pnl', 'Resultado')}
        ${th(T, 'pnlPct', '%')}
        ${isEq ? th(T, 'upside', '<span title="Precio objetivo promedio de los analistas y cuánto le falta (Yahoo)">Objetivo</span>') : ''}
        ${th(T, 'weight', 'Peso')}
        ${th(T, 'days', 'Días')}
      </tr></thead>
      <tbody data-reorder="${p.id}" data-tid="${T}">
      ${rows.length ? rows.map((x) => `<tr data-key="${esc(x.ticker)}">
        <td class="ticker">${grip()}${esc(x.ticker)}${x.div ? ` <span class="tag" title="${divWord} cobrados">${isBond ? 'renta' : 'div'} ${usd(x.div)}</span>` : ''}
          ${isBond && bondInfoOf(x.ticker)?.name ? `<div class="muted small" style="font-weight:400">${esc(bondInfoOf(x.ticker).name)}</div>` : ''}</td>
        <td class="num"${isCedear ? ` title="Ratio ${num(x.ratio)}:1"` : ''}>${qtyFmt(x.qty)}</td>
        <td class="num">${price(x.avg)}</td>
        <td class="num">${price(x.px)}${x.manual ? ' <span class="tag" title="Precio manual">M</span>' : ''}</td>
        <td class="num ${cls(x.dayPct)}">${pct(x.dayPct)}</td>
        <td class="num">${usd(x.cost)}</td>
        <td class="num">${usd(x.value)}</td>
        <td class="num ${cls(x.pnl)}"><b>${signed(x.pnl)}</b></td>
        <td class="num">${badge(x.pnlPct)}</td>
        ${isEq ? `<td class="num">${targetCell(x)}</td>` : ''}
        <td class="num">${pct(x.weight).replace('+', '')}<span class="weightbar"><span style="width:${x.weight * 100}%;background:${slotColor(p)}"></span></span></td>
        <td class="num">${x.days ?? '—'}</td>
      </tr>`).join('') + (c.cashIn ? `<tr>
        <td class="ticker">Efectivo <span class="muted small" style="font-weight:400">USD</span></td><td></td><td></td><td></td><td></td><td></td>
        <td class="num">${usd(c.cashIn)}</td><td></td><td></td>${isEq ? '<td></td>' : ''}
        <td class="num">${pct(c.cashIn / c.value).replace('+', '')}<span class="weightbar"><span style="width:${(c.cashIn / c.value) * 100}%;background:${slotColor(p)}"></span></span></td><td></td>
      </tr>` : '') : `<tr><td colspan="12" class="empty">No hay posiciones abiertas. Cargá tu primera operación con “+ Operación”.</td></tr>`}
      </tbody>
      ${rows.length ? `<tfoot><tr>
        <td>Total</td><td></td><td></td><td></td>
        <td class="num ${cls(c.dayChg)}">${pct(c.dayPct)}<div class="small">${signed(c.dayChg)}</div></td>
        <td class="num">${usd(c.cost)}</td><td class="num">${usd(c.value)}</td>
        <td class="num ${cls(c.unrealized)}"><b>${signed(c.unrealized)}</b></td>
        <td class="num">${badge(c.cost ? c.unrealized / c.cost : null)}</td>${isEq ? '<td></td>' : ''}<td></td><td></td>
      </tr></tfoot>` : ''}
    </table></div>
  </div>
  ${(p.type === 'cedear' || p.type === 'stock') && c.positions.length ? dividendsCard(p, c) : ''}
  ${isBond && c.positions.length ? bondIncomeCard(p, c) : ''}
  <div class="card section">
    <h2>Operaciones cerradas <span class="muted small">(costo promedio)</span></h2>
    <div class="table-wrap"><table>
      <thead><tr>
        ${th(C, 'date', 'Fecha venta', false)}${th(C, 'ticker', 'Ticker', false)}${th(C, 'qty', isBond ? 'VN' : 'Cantidad')}
        ${th(C, 'avgU', isBond ? 'Precio compra c/100' : 'Precio compra')}${th(C, 'sellU', isBond ? 'Precio venta c/100' : 'Precio venta')}${th(C, 'cost', 'Costo')}${th(C, 'proceeds', 'Venta')}
        ${th(C, 'pnl', 'Resultado')}${th(C, 'pct', '%')}${th(C, 'days', 'Días')}
      </tr></thead>
      <tbody>${closed.length ? closed.map((x) => `<tr>
        <td>${fmtDate(x.date)}</td><td class="ticker">${esc(x.ticker)}</td><td class="num">${qtyFmt(x.qty)}</td>
        <td class="num">${price(x.avgU)}</td><td class="num">${price(x.sellU)}</td>
        <td class="num">${usd(x.cost)}</td><td class="num">${usd(x.proceeds)}</td>
        <td class="num ${cls(x.pnl)}"><b>${signed(x.pnl)}</b></td><td class="num">${badge(x.pct)}</td><td class="num">${x.days ?? '—'}</td>
      </tr>`).join('') : '<tr><td colspan="10" class="empty">Todavía no hay ventas.</td></tr>'}</tbody>
      ${closed.length ? `<tfoot><tr><td colspan="5">Total</td>
        <td class="num">${usd(c.closed.reduce((a, x) => a + x.cost, 0))}</td><td class="num">${usd(c.closed.reduce((a, x) => a + x.proceeds, 0))}</td>
        <td class="num ${cls(c.realized)}">${signed(c.realized)}</td><td></td><td></td></tr></tfoot>` : ''}
    </table></div>
  </div>`;
}

// Aviso cuando los datos de un exchange tienen más de una hora: precios, PnL y ROE quedaron viejos.
const STALE_MS = 60 * 60e3;
function staleNotice(iso, ex) {
  if (!iso || iso.length <= 10 || Date.now() - new Date(iso) < STALE_MS) return '';
  const when = new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const name = ex ? EXCHANGE_NAMES[ex] : 'Este exchange';
  const why = !ex ? '' : !state[ex].configured
    ? `<span class="owner-only"> Falta configurar la API de ${name} en <a href="#/ajustes">Ajustes</a>.</span>`
    : state[ex].error ? ` Último error: ${esc(state[ex].error)}` : '';
  return `<div class="card section stale">⚠ <b>Datos del ${when}</b>: ${name} no se está actualizando. Precios, PnL y ROE pueden no ser los de ahora.${why}</div>`;
}

function viewBots(p) {
  const c = computeBots(p);
  const T = 'bots-' + p.id;
  const rows = sortRows(T, c.positions, 'value');
  const lastUpd = c.positions.map((x) => x.updated).filter(Boolean).sort().pop();
  const updTxt = lastUpd ? new Date(lastUpd.length > 10 ? lastUpd : lastUpd + 'T12:00').toLocaleString('es-AR', lastUpd.length > 10 ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  const synced = p.id === 'bots-pionex' && state.pionex.configured;
  const rng = (b) => (b.range ? `${price(+b.range[0])} – ${price(+b.range[1])}` : '—');
  const liq = (b) => [b.liqDown ? '↓ ' + price(+b.liqDown) : '', b.liqUp ? '↑ ' + price(+b.liqUp) : ''].filter(Boolean).join(' · ') || '—';
  return `
  <div class="page-head">
    <div><h1><span class="dot" style="display:inline-block;background:${slotColor(p)};margin-right:8px"></span>${esc(p.name)}</h1>
      <div class="sub">${TYPES.bots}${p.broker ? ' · ' + esc(p.broker) : ''}${updTxt ? ' · actualizado ' + updTxt : ''}${synced ? ' · sincronizado con Pionex' : ''}</div></div>
    <div class="actions">
      <button class="btn" data-action="new-aporte" data-pid="${p.id}">+ Aporte</button>
      <button class="btn primary" data-action="new-bot" data-pid="${p.id}">+ Bot</button>
    </div>
  </div>
  ${p.id === 'bots-pionex' ? staleNotice(lastUpd, 'pionex') : ''}
  ${c.positions.length || c.closed.length ? resultBanner(c, {
    what: 'bots activos',
    side: [['Grilla últimas 24 h', c.grid24h], ['Bots cerrados', c.realized], ['Total histórico', c.unrealized + c.realized]],
  }) : ''}
  <div class="kpis">
    ${kpi('Valor actual', usd(c.value))}
    ${kpi('Invertido', usd(c.cost))}
    ${kpi('Ganancia bots activos', signed(c.unrealized), c.cost ? pct(c.unrealized / c.cost) : null, cls(c.unrealized))}
    ${kpi('Ganancia de grilla 24h', signed(c.grid24h), 'Solo trades de la grilla', cls(c.grid24h))}
    ${kpi('Bots cerrados', signed(c.realized), `${c.closed.length} bots`, cls(c.realized))}
    ${c.deposits
      ? kpi('Resultado vs aportes', signed(c.value - c.deposits), `${pct((c.value - c.deposits) / c.deposits)} sobre ${usd(c.deposits)} aportados`, cls(c.value - c.deposits))
      : kpi('Aportes', usd(0), 'Cargá tu capital con “+ Aporte”')}
  </div>
  ${c.deposits && Math.abs(c.value - c.deposits - (c.unrealized + c.realized)) > 1 ? `<div class="card section small muted">
    Suma bot por bot (activos ${signed(c.unrealized)} + cerrados ${signed(c.realized)}) = ${signed(c.unrealized + c.realized)}.
    Diferencia con el resultado contra aportes: <b>${signed(c.value - c.deposits - c.unrealized - c.realized)}</b>.
    Puede ser saldo suelto en spot, un aporte o retiro sin cargar, o un bono de Pionex. El resultado contra aportes es el confiable.
  </div>` : ''}
  ${synced
    ? (state.pionex.error ? `<div class="card section small">⚠ Última sincronización con Pionex falló: ${esc(state.pionex.error)}</div>` : '')
    : `<div class="card section small muted owner-only">Estos valores no se actualizan solos. ${p.id === 'bots-pionex' ? 'Configurá tu API de solo lectura en <a href="#/ajustes">Ajustes</a> para sincronizar con Pionex.' : 'Editalos a mano cuando cambien.'}</div>`}
  <div class="card section">
    <h2>Bots activos</h2>
    <div class="table-wrap"><table>
      <thead><tr>
        ${th(T, 'pair', 'Par', false)}<th>Tipo</th>${th(T, 'leverage', 'Apal.')}<th class="num">Rango</th>${th(T, 'grids', 'Grillas')}
        ${th(T, 'entryPrice', 'Precio entrada')}<th class="num">Liquidación</th>
        ${th(T, 'cost', 'Invertido')}${th(T, 'value', 'Valor actual')}${th(T, 'pnl', 'Ganancia')}${th(T, 'pnlPct', '%')}
        ${th(T, 'gridProfit', 'Gan. grilla')}${th(T, 'days', 'Días')}<th></th>
      </tr></thead>
      <tbody>${rows.length ? rows.map((b) => `<tr>
        <td class="ticker">${esc(b.pair)}${b.copy ? ` <span class="tag" title="Bot copiado / bono">${esc(b.copy)}</span>` : ''}</td>
        <td>${BOT_KINDS[b.kind] || esc(b.kind)}${b.trend ? ` <span class="tag">${TRENDS[b.trend] || esc(b.trend)}</span>` : ''}</td>
        <td class="num">${b.leverage ? num(+b.leverage) + 'x' : '—'}</td>
        <td class="num">${rng(b)}</td><td class="num">${b.grids ?? '—'}</td>
        <td class="num">${price(+b.entryPrice || null)}</td><td class="num neg">${liq(b)}</td>
        <td class="num">${usd(b.cost)}</td><td class="num">${usd(b.value)}</td>
        <td class="num ${cls(b.pnl)}"><b>${signed(b.pnl)}</b></td><td class="num">${badge(b.pnlPct)}</td>
        <td class="num ${cls(+b.gridProfit)}">${b.gridProfit != null ? signed(+b.gridProfit) : '—'}</td>
        <td class="num">${b.days ?? '—'}</td>
        <td class="num"><button class="btn sm" data-action="edit-bot" data-id="${b.id}">Editar</button></td>
      </tr>`).join('') : '<tr><td colspan="14" class="empty">No hay bots activos.</td></tr>'}</tbody>
      ${rows.length ? `<tfoot><tr><td colspan="7">Total</td><td class="num">${usd(c.cost)}</td><td class="num">${usd(c.value)}</td>
        <td class="num ${cls(c.unrealized)}"><b>${signed(c.unrealized)}</b></td><td class="num">${badge(c.cost ? c.unrealized / c.cost : null)}</td>
        <td class="num">${signed(c.positions.reduce((a, x) => a + (+x.gridProfit || 0), 0))}</td><td></td><td></td></tr></tfoot>` : ''}
    </table></div>
  </div>
  <div class="card section">
    <h2>Bots cerrados</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Par</th><th>Tipo</th><th>Inicio</th><th>Cierre</th><th class="num">Invertido</th><th class="num">Resultado</th><th class="num">%</th><th class="num">Días</th><th></th></tr></thead>
      <tbody>${c.closed.length ? c.closed.map((b) => `<tr>
        <td class="ticker">${esc(b.pair)}</td><td>${BOT_KINDS[b.kind] || esc(b.kind)}</td><td>${fmtDate(b.start)}</td><td>${fmtDate(b.end)}</td>
        <td class="num">${usd(+b.invested)}</td><td class="num ${cls(b.pnl)}"><b>${signed(b.pnl)}</b></td><td class="num">${badge(b.pct)}</td><td class="num">${b.days ?? '—'}</td>
        <td class="num"><button class="btn sm" data-action="edit-bot" data-id="${b.id}">Editar</button></td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty">Todavía no cerraste bots.</td></tr>'}</tbody>
    </table></div>
  </div>`;
}

function viewFutures(p) {
  const c = computeFutures(p);
  const T = 'fut-' + p.id, C = 'futc-' + p.id;
  const rows = sortRows(T, c.positions, 'value');
  const closed = sortRows(C, c.closed, 'close');
  const upd = c.acc?.updated ? new Date(c.acc.updated).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const ex = FUTURES_EXCHANGE[p.id];
  const synced = ex && state[ex].configured;
  const wins = c.closed.filter((x) => x.pnl > 0).length;
  // Capital medido por operación: el margen que pusiste en cada una (no depende de depósitos y retiros)
  const openMargin = c.positions.reduce((a, x) => a + x.cost, 0);
  const free = c.value - c.positions.reduce((a, x) => a + x.value, 0);
  const closedMargin = c.closed.reduce((a, x) => a + (+x.margin || 0), 0);
  const fundingFrom = Math.min(...c.positions.map((x) => +x.fundingFrom || Infinity)); // coin-M de BingX: se sigue desde esa fecha
  const closedCost = c.costs.fees + c.costs.funding, closedGross = c.realized - closedCost; // resultado antes de comisiones y funding
  const bySym = {};
  for (const x of c.closed) {
    const k = x.symbol + '|' + x.market;
    const g = (bySym[k] ||= { symbol: x.symbol, market: x.market, ops: 0, wins: 0, margin: 0, pnl: 0, openMargin: 0, openPnl: 0 });
    g.ops++; if (x.pnl > 0) g.wins++; g.margin += +x.margin || 0; g.pnl += +x.pnl || 0;
  }
  for (const x of c.positions) {
    const k = x.symbol + '|' + x.market;
    const g = (bySym[k] ||= { symbol: x.symbol, market: x.market, ops: 0, wins: 0, margin: 0, pnl: 0, openMargin: 0, openPnl: 0 });
    g.openMargin += x.cost; g.openPnl += +x.pnl || 0;
  }
  const S = 'futs-' + p.id;
  const symRows = myOrderRows(p, S, sortRows(S, Object.values(bySym).map((g) => ({ ...g, pct: g.margin ? g.pnl / g.margin : null, avgMargin: g.ops ? g.margin / g.ops : null })), 'pnl'), (g) => g.symbol + '|' + g.market);
  const dt = (ms) => (ms ? new Date(ms).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
  const dur = (h) => (h == null ? '—' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`);
  const side = (s) => `<span class="tag ${s === 'LONG' ? 'buy' : 'sell'}">${s === 'LONG' ? 'Long' : 'Short'}</span>`;
  return `
  <div class="page-head">
    <div><h1><span class="dot" style="display:inline-block;background:${slotColor(p)};margin-right:8px"></span>${esc(p.name)}</h1>
      <div class="sub">${TYPES.futures}${p.broker ? ' · ' + esc(p.broker) : ''}${upd ? ' · actualizado ' + upd : ''}${synced ? ' · sincronizado' : ''}</div></div>
    <div class="actions"><button class="btn" data-action="new-aporte" data-pid="${p.id}">+ Aporte</button></div>
  </div>
  ${staleNotice(c.acc?.updated, ex)}
  ${c.positions.length || c.closed.length ? resultBanner(c, {
    base: openMargin, baseTxt: 'de margen',
    side: [['Si cierro todo ahora', c.positions.reduce((a, x) => a + x.net, 0)], ['Operaciones cerradas', c.realized], ['Total (abiertas + cerradas)', c.unrealized + c.realized]],
  }) : ''}
  <div class="section">
    <h2 class="pos-title">Posiciones abiertas <span class="muted small">${rows.length || ''}</span></h2>
    ${rows.length ? `<div class="postiles">${rows.map((x) => `
      <div class="card postile">
        <div class="postile-head">
          <span class="ticker">${esc(x.symbol)}</span>${side(x.side)}
          <span class="muted small">${x.leverage ? num(+x.leverage) + 'x · ' : ''}${esc(x.market)}</span>
          ${x.days != null ? `<span class="muted small postile-days">${x.days} d</span>` : ''}
        </div>
        <div class="postile-main">
          <div><div class="label">ROE</div><div class="roe ${cls(x.roePct)}">${pct(x.roePct)}</div></div>
          <div class="postile-money">
            <div><span class="label">PnL</span><b class="${cls(+x.pnl)}">${signed(+x.pnl)}</b></div>
            <div title="PnL ${x.feesPaid != null ? '+ comisión de apertura y funding ya pagados ' : ''}− comisión estimada de cierre (${usd(x.closeFee)})">
              <span class="label">Si cierro ahora</span><b class="${cls(x.net)}">${signed(x.net)}</b></div>
          </div>
        </div>
        <div class="postile-grid small">
          <div><span class="muted">Entrada</span>${price(+x.entryPrice || null)}</div>
          <div><span class="muted">Actual</span>${price(+x.markPrice || null)}</div>
          <div><span class="muted">Liquidación</span><span class="neg">${price(+x.liq || null)}</span>${x.liqDist != null ? ` <span class="muted">(${pct(x.liqDist)})</span>` : ''}</div>
          <div><span class="muted">Margen</span>${usd(x.cost)}</div>
          <div><span class="muted">Tamaño</span>${usd(+x.notional)}</div>
          <div><span class="muted">% s/margen total</span><span class="${cls(x.pnlPct)}">${pct(x.pnlPct)}</span></div>
          ${x.fundingTotal != null ? `<div title="Funding cobrado (+) o pagado (−) desde que abriste la posición"><span class="muted">Funding acumulado${x.fundingFrom ? ` <span title="BingX no informa el funding de coin-M: se calcula desde que la app sigue la posición">desde ${new Date(x.fundingFrom).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}</span>` : ''}</span><span class="${cls(+x.fundingTotal)}">${signed(+x.fundingTotal)}</span></div>` : ''}
          ${x.fundEst ? `<div title="Con la tasa vigente (${num(+x.fundingRate * 100, 4)}% cada ${+x.fundingHours || 8} h). Puede cambiar hasta el cobro."><span class="muted">Próximo funding</span><span><span class="${cls(x.fundEst.next)}">≈ ${signed(x.fundEst.next)}</span>${x.fundingNextTime ? ` <span class="muted">(${new Date(+x.fundingNextTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })})</span>` : ''}</span></div>
          <div title="Próximo funding × cobros por día, si la tasa se mantiene"><span class="muted">Funding por día</span><span><span class="${cls(x.fundEst.perDay)}">≈ ${signed(x.fundEst.perDay)}</span>${x.cost ? ` <span class="muted">(${pct(x.fundEst.perDay / x.cost)} del margen)</span>` : ''}</span></div>` : ''}
          ${x.fundingLast != null ? `<div title="${x.fundingLastTime ? new Date(x.fundingLastTime).toLocaleString('es-AR') : ''}"><span class="muted">Último funding</span><span><span class="${cls(+x.fundingLast)}">${signed(+x.fundingLast)}</span>${x.fundingLastTime ? ` <span class="muted">(${x.fundingLastCount > 1 ? `${x.fundingLastCount} cobros juntos hasta ` : ''}${new Date(x.fundingLastTime).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})</span>` : ''}</span></div>` : ''}
          ${x.fundingMissed ? `<div title="El saldo cambió más de lo que puede cobrar un funding (seguramente una transferencia), así que esos cobros no se sumaron al acumulado"><span class="muted">Funding sin dato</span><span class="muted">${x.fundingMissed} ${x.fundingMissed === 1 ? 'cobro' : 'cobros'}</span></div>` : ''}
        </div>
      </div>`).join('')}</div>` : '<div class="card empty">No hay posiciones abiertas.</div>'}
  </div>
  <div class="kpis">
    ${kpi('Equity total', usd(c.value), 'Saldo + PnL abierto de todas las cuentas')}
    ${kpi('Margen en posiciones', usd(openMargin), `Libre sin usar: ${usd(free)}`)}
    ${kpi('PnL abierto', signed(c.unrealized), openMargin ? `${pct(c.unrealized / openMargin)} sobre el margen` : `${c.positions.length} posiciones`, cls(c.unrealized))}
    ${kpi('Resultado cerradas', signed(c.realized), closedMargin ? `${pct(c.realized / closedMargin)} sobre ${usd(closedMargin)} de margen` : null, cls(c.realized))}
    ${kpi('Operaciones cerradas', String(c.closed.length), c.closed.length ? `${Math.round((wins / c.closed.length) * 100)}% ganadoras` : null)}
    ${c.closed.length ? kpi('Costos de las cerradas', signed(closedCost), `Comisiones ${signed(c.costs.fees)} · funding ${signed(c.costs.funding)}${c.costs.fundingUnknown ? '*' : ''}${closedGross > 0 && closedCost < 0 ? ` · se llevaron el ${num((-closedCost / closedGross) * 100, 1)}% de la ganancia bruta` : ''}`, cls(closedCost)) : ''}
    ${c.costs.openFunding != null ? kpi('Funding de las abiertas', signed(c.costs.openFunding), `pagado hasta ahora${c.costs.openFundingPerDay != null ? ` · ≈ ${signed(c.costs.openFundingPerDay)} por día` : ''}${isFinite(fundingFrom) ? ` · coin-M desde ${dt(fundingFrom)}` : ''}`, cls(c.costs.openFunding)) : ''}
    ${c.deposits ? kpi('Resultado vs aportes', signed(c.value - c.deposits), `${pct((c.value - c.deposits) / c.deposits)} sobre ${usd(c.deposits)} aportados`, cls(c.value - c.deposits)) : ''}
  </div>
  <div class="card section">
    <h2>Por par${myOrderBtn(p, S)} <span class="muted small">(capital medido como el margen que pusiste en cada operación)</span></h2>
    <div class="table-wrap"><table>
      <thead><tr>${th(S, 'symbol', 'Par', false)}<th>Cuenta</th>${th(S, 'ops', 'Operaciones')}${th(S, 'wins', 'Ganadoras')}
        ${th(S, 'margin', 'Margen puesto')}${th(S, 'avgMargin', 'Margen prom.')}${th(S, 'pnl', 'Resultado')}${th(S, 'pct', '% s/margen')}
        ${th(S, 'openMargin', 'Margen abierto')}${th(S, 'openPnl', 'PnL abierto')}</tr></thead>
      <tbody data-reorder="${p.id}" data-tid="${S}">${symRows.map((g) => `<tr data-key="${esc(g.symbol + '|' + g.market)}">
        <td class="ticker">${grip()}${esc(g.symbol)}</td><td>${esc(g.market)}</td><td class="num">${g.ops}</td>
        <td class="num">${g.ops ? `${g.wins} (${Math.round((g.wins / g.ops) * 100)}%)` : '—'}</td>
        <td class="num">${g.ops ? usd(g.margin) : '—'}</td><td class="num">${g.ops ? usd(g.avgMargin) : '—'}</td>
        <td class="num ${cls(g.pnl)}"><b>${g.ops ? signed(g.pnl) : '—'}</b></td><td class="num">${badge(g.pct)}</td>
        <td class="num">${g.openMargin ? usd(g.openMargin) : '—'}</td><td class="num ${cls(g.openPnl)}">${g.openMargin ? signed(g.openPnl) : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="10" class="empty">Sin operaciones.</td></tr>'}</tbody>
      ${symRows.length ? `<tfoot><tr><td colspan="4">Total</td><td class="num">${usd(closedMargin)}</td><td></td>
        <td class="num ${cls(c.realized)}"><b>${signed(c.realized)}</b></td><td class="num">${badge(closedMargin ? c.realized / closedMargin : null)}</td>
        <td class="num">${usd(openMargin)}</td><td class="num ${cls(c.unrealized)}">${signed(c.unrealized)}</td></tr></tfoot>` : ''}
    </table></div>
  </div>
  ${synced
    ? (state[ex].error ? `<div class="card section small">⚠ Última sincronización con ${EXCHANGE_NAMES[ex]} falló: ${esc(state[ex].error)}</div>` : '')
    : `<div class="card section small muted owner-only">Estos datos no se actualizan solos. Configurá tu API de solo lectura${ex ? ' de ' + EXCHANGE_NAMES[ex] : ''} en <a href="#/ajustes">Ajustes</a>.</div>`}
  ${state.reglas.length ? `<div class="card section reglas-strip">
    <div class="card-head"><h2>Mis reglas</h2><a href="#/reglas" class="linkbtn">Ver todas →</a></div>
    <div class="reglas-row">${state.reglas.map((r, i) => reglaCard(r, i, true)).join('')}</div>
  </div>` : ''}
  <div class="card section">
    <h2>Cuentas</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Cuenta</th><th class="num">Moneda</th><th class="num">Saldo</th><th class="num">PnL abierto</th><th class="num">Equity</th><th class="num">Equity USD</th></tr></thead>
      <tbody>${(c.acc?.accounts || []).map((a) => {
        const f = (v) => (v == null ? '—' : a.asset === 'USDT' ? num(v, 2) : num(v, 8));
        return `<tr><td>${esc(a.market)}${a.market === 'COIN-M' ? ` <span class="tag" title="Margen en ${esc(a.asset)}: su valor en USD se mueve con el precio">margen en ${esc(a.asset)}</span>` : ''}</td>
          <td class="num">${esc(a.asset)}</td><td class="num">${f(a.balance)}</td><td class="num ${cls(a.unrealized)}">${f(a.unrealized)}</td>
          <td class="num">${f(a.equity)}</td><td class="num">${usd(a.equityUSD)}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="empty">Sin datos todavía.</td></tr>'}</tbody>
    </table></div>
  </div>
  ${ex === 'bitget' ? dobleSaylorCard(p, c) : balasCard(p, c)}
  <div class="card section">
    <h2>Operaciones cerradas <span class="muted small">(resultado neto de comisiones y funding)</span></h2>
    ${c.costs.fundingUnknown ? `<p class="small muted" style="margin-top:0">* ${c.costs.fundingUnknown === 1 ? 'Una operación no tiene' : c.costs.fundingUnknown + ' operaciones no tienen'} el funding informado (BingX no lo da en coin-M): su resultado ya lo incluye, pero no se puede separar.</p>` : ''}
    <div class="table-wrap"><table>
      <thead><tr>${th(C, 'close', 'Cierre', false)}${th(C, 'symbol', 'Par', false)}<th>Cuenta</th><th>Lado</th>${th(C, 'leverage', 'Apal.')}
        ${th(C, 'entries', 'Entradas')}${th(C, 'entryPrice', 'Precio entrada')}${th(C, 'exitPrice', 'Precio salida')}${th(C, 'notional', 'Tamaño máx.')}${th(C, 'margin', 'Margen')}
        ${th(C, 'fees', 'Comisiones')}${th(C, 'funding', 'Funding')}${th(C, 'pnl', 'Resultado')}${th(C, 'pct', '% s/margen')}${th(C, 'hours', 'Duración')}</tr></thead>
      <tbody>${closed.length ? closed.map((x) => `<tr>
        <td>${dt(x.close)}</td><td class="ticker">${esc(x.symbol)}</td><td>${esc(x.market)}</td><td>${side(x.side)}</td>
        <td class="num">${x.leverage ? num(+x.leverage) + 'x' : '—'}</td><td class="num">${x.entries ?? '—'}</td>
        <td class="num">${price(+x.entryPrice || null)}</td><td class="num">${price(+x.exitPrice || null)}</td><td class="num">${usd(+x.notional)}</td><td class="num">${usd(+x.margin)}</td>
        <td class="num ${cls(+x.fees)}">${x.fees != null ? signed(+x.fees) : '—'}</td>
        <td class="num ${cls(+x.funding)}">${x.funding != null ? signed(+x.funding) : '<span class="muted" title="BingX no informa el funding de coin-M">—*</span>'}</td>
        <td class="num ${cls(+x.pnl)}"><b>${signed(+x.pnl)}</b>${x.pnlBase != null ? ` <span class="muted small">(${num(+x.pnlBase, 6)} ${esc(x.symbol.split(/[-_]|USD/)[0])})</span>` : ''}</td>
        <td class="num">${badge(x.pct)}</td><td class="num">${dur(x.hours)}</td></tr>`).join('') : '<tr><td colspan="15" class="empty">Sin operaciones cerradas.</td></tr>'}</tbody>
      ${closed.length ? `<tfoot><tr><td colspan="9">Total</td><td class="num">${usd(closedMargin)}</td>
        <td class="num ${cls(c.costs.fees)}">${signed(c.costs.fees)}</td><td class="num ${cls(c.costs.funding)}">${signed(c.costs.funding)}${c.costs.fundingUnknown ? '*' : ''}</td>
        <td class="num ${cls(c.realized)}"><b>${signed(c.realized)}</b></td>
        <td class="num">${badge(closedMargin ? c.realized / closedMargin : null)}</td><td></td></tr></tfoot>` : ''}
    </table></div>
  </div>`;
}

function botForm(rec = {}) {
  const pid = rec.portfolioId || route().id;
  const editing = !!rec.id;
  const b = { kind: 'futures_grid', trend: 'long', leverage: 1, start: today(), status: 'running', profit: 0, ...rec };
  const opt = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  const body = `
    ${field('Par', `<input name="pair" required value="${esc(b.pair || '')}" placeholder="BTC/USDT" style="text-transform:uppercase">`)}
    ${field('Tipo', `<select name="kind">${opt(BOT_KINDS, b.kind)}</select>`)}
    ${field('Dirección', `<select name="trend">${opt(TRENDS, b.trend)}</select>`)}
    ${field('Apalancamiento', `<input name="leverage" type="number" step="any" min="1" value="${b.leverage}">`)}
    ${field('Inversión (USD)', `<input name="invested" type="number" step="any" min="0" required value="${b.invested ?? ''}">`)}
    ${field('Ganancia total actual (USD)', `<input name="profit" type="number" step="any" required value="${b.profit}">`, { hint: 'Negativa si va perdiendo' })}
    ${field('Fecha inicio', `<input name="start" type="date" value="${b.start || ''}">`)}
    ${field('Estado', `<select name="status">${opt({ running: 'Activo', finished: 'Cerrado' }, b.status)}</select>`)}
    ${field('Fecha cierre', `<input name="end" type="date" value="${b.end || ''}">`)}
    ${field('Nota', `<input name="note" value="${esc(b.note || '')}">`)}
    ${editing ? `<div class="field full"><button type="button" class="btn sm danger" data-action="del-bot" data-id="${b.id}" style="align-self:flex-start">Borrar bot</button></div>` : ''}`;
  openModal(editing ? 'Editar bot' : 'Nuevo bot', body, (d) => {
    const r = {
      ...b, id: b.id || uid(), portfolioId: pid, pair: d.pair.trim().toUpperCase(), kind: d.kind, trend: d.trend,
      leverage: +d.leverage || 1, invested: +d.invested, profit: +d.profit, start: d.start, status: d.status,
      end: d.status === 'running' ? null : d.end || today(), note: d.note.trim(), updated: today(),
    };
    if (editing) Object.assign(state.db.bots.find((x) => x.id === b.id), r); else state.db.bots.push(r);
    save(); toast('Bot guardado');
  });
}

function viewOps() {
  const f = state.filters.ops;
  const q = f.q.trim().toUpperCase();
  let rows = state.db.transactions.filter((t) => (!f.pid || t.portfolioId === f.pid) && (!f.side || t.side === f.side) && (!q || t.ticker.includes(q)));
  rows = rows.map((t) => ({ ...t, unit: unitUSD(t), total: +t.qty * unitUSD(t), pname: portfolio(t.portfolioId)?.name || '?' }));
  rows = sortRows('ops', rows, 'date');
  return `
  <div class="page-head"><div><h1>Operaciones</h1><div class="sub">${state.db.transactions.length} registradas</div></div>
    <div class="actions"><button class="btn primary" data-action="new-tx">+ Operación</button></div></div>
  <div class="filters">
    <select data-filter="pid"><option value="">Todas las carteras</option>${state.db.portfolios.map((p) => `<option value="${p.id}" ${f.pid === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <select data-filter="side"><option value="">Compras y ventas</option><option value="buy" ${f.side === 'buy' ? 'selected' : ''}>Compras</option><option value="sell" ${f.side === 'sell' ? 'selected' : ''}>Ventas</option></select>
    <input data-filter="q" placeholder="Buscar ticker…" value="${esc(f.q)}">
  </div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr>${th('ops', 'date', 'Fecha', false)}${th('ops', 'pname', 'Cartera', false)}<th>Tipo</th>${th('ops', 'ticker', 'Ticker', false)}
      ${th('ops', 'qty', 'Cantidad')}${th('ops', 'price', 'Precio')}<th class="num">CCL</th>${th('ops', 'unit', 'USD/unidad')}${th('ops', 'total', 'Total USD')}<th>Nota</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map((t) => `<tr>
      <td>${fmtDate(t.date)}</td><td>${esc(t.pname)}</td>
      <td><span class="tag ${t.side}">${t.side === 'buy' ? 'Compra' : 'Venta'}</span></td>
      <td class="ticker">${esc(t.ticker)}</td><td class="num">${qty(+t.qty, 8)}</td>
      <td class="num">${t.currency === 'ARS' ? ars(+t.price) : price(+t.price)}</td>
      <td class="num">${t.currency === 'ARS' ? num(+t.fx, 2) : '—'}</td>
      <td class="num">${price(t.unit)}</td><td class="num">${usd(t.total)}</td>
      <td class="muted small">${esc(t.note || '')}</td>
      <td class="num">${t.externalId ? '<span class="muted small" title="Viene del exchange: se actualiza sola en cada sincronización">sincronizada</span>' : `<button class="btn sm" data-action="edit-tx" data-id="${t.id}">Editar</button> <button class="btn sm danger" data-action="del-tx" data-id="${t.id}">Borrar</button>`}</td>
    </tr>`).join('') : '<tr><td colspan="11" class="empty">Sin resultados</td></tr>'}</tbody>
  </table></div></div>`;
}

function simpleList(kind) {
  const isDiv = kind === 'divs';
  const list = isDiv ? state.db.dividends : state.db.deposits;
  const rows = sortRows(kind, list.map((d) => ({ ...d, amount: +d.amount, pname: portfolio(d.portfolioId)?.name || '?' })), 'date');
  const byYear = {};
  for (const d of list) { const y = d.date.slice(0, 4); byYear[y] = (byYear[y] || 0) + +d.amount; }
  const years = Object.keys(byYear).sort().reverse();
  return `
  <div class="page-head"><div><h1>${isDiv ? 'Dividendos' : 'Aportes'}</h1>
    <div class="sub">${isDiv ? 'Dividendos cobrados en USD (netos de impuestos)' : 'Dinero que ingresaste (positivo) o retiraste (negativo) de cada cartera, en USD'}</div></div>
    <div class="actions"><button class="btn primary" data-action="${isDiv ? 'new-div' : 'new-aporte'}">+ ${isDiv ? 'Dividendo' : 'Aporte'}</button></div></div>
  ${years.length ? `<div class="kpis">${years.map((y) => kpi(`Total ${y}`, usd(byYear[y]))).join('')}</div>` : ''}
  <div class="card"><div class="table-wrap"><table>
    <thead><tr>${th(kind, 'date', 'Fecha', false)}${th(kind, 'pname', 'Cartera', false)}${isDiv ? th(kind, 'ticker', 'Ticker', false) : ''}${th(kind, 'amount', 'Monto USD')}<th>Nota</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map((d) => `<tr>
      <td>${fmtDate(d.date)}</td><td>${esc(d.pname)}</td>${isDiv ? `<td class="ticker">${esc(d.ticker)}</td>` : ''}
      <td class="num ${isDiv ? '' : cls(d.amount)}">${usd(d.amount)}</td><td class="muted small">${esc(d.note || '')}</td>
      <td class="num"><button class="btn sm" data-action="${isDiv ? 'edit-div' : 'edit-aporte'}" data-id="${d.id}">Editar</button> <button class="btn sm danger" data-action="${isDiv ? 'del-div' : 'del-aporte'}" data-id="${d.id}">Borrar</button></td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">Todavía no cargaste ${isDiv ? 'dividendos' : 'aportes'}.</td></tr>`}</tbody>
  </table></div></div>`;
}
const viewDivs = () => simpleList('divs');
const viewAportes = () => simpleList('aportes');

