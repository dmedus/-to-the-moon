'use strict';
// Panel de trading diario (futuros Bitunix): lo puesto vs lo que hay, ganadas vs perdidas, curva de la cuenta,
// diario con filtros y calendario, y resultado por mes. Se arma con las operaciones cerradas que trae la sincronización.

const dayKey = (ms) => new Date(ms).toLocaleDateString('sv-SE'); // AAAA-MM-DD en la hora local
const MESES_LARGO = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Una operación que ganó o perdió menos de esto no cuenta ni como ganada ni como perdida (queda "pareja").
// Se cambia desde el diario; por defecto US$ 1.
const minTrade = () => { const v = state.db?.settings?.minTrade; return v != null && v >= 0 ? +v : 1; };
const outcome = (pnl, min = minTrade()) => (pnl >= min && pnl > 0 ? 1 : pnl <= -min && pnl < 0 ? -1 : 0);

// Estadísticas de las cerradas: ganadas/perdidas, promedios, racha, por día y por mes
function tradeStats(closed) {
  const ops = closed.filter((x) => x.close && x.pnl != null).map((x) => ({ ...x, pnl: +x.pnl })).sort((a, b) => a.close - b.close);
  const won = ops.filter((x) => outcome(x.pnl) > 0), lost = ops.filter((x) => outcome(x.pnl) < 0);
  const sum = (l) => l.reduce((a, x) => a + x.pnl, 0);
  const gW = sum(won), gL = sum(lost);
  let streak = 0; // racha actual: + ganadas seguidas, − perdidas seguidas
  for (let i = ops.length - 1; i >= 0; i--) {
    const s = outcome(ops[i].pnl);
    if (!s) continue;
    if (streak && Math.sign(streak) !== s) break;
    streak += s;
  }
  const group = (keyOf) => {
    const m = new Map();
    for (const x of ops) {
      const k = keyOf(x.close), g = m.get(k) || { key: k, ops: 0, won: 0, lost: 0, pnl: 0, fees: 0, best: null, worst: null };
      g.ops++; if (outcome(x.pnl) > 0) g.won++; else if (outcome(x.pnl) < 0) g.lost++;
      g.pnl += x.pnl; g.fees += +x.fees || 0;
      if (!g.best || x.pnl > g.best.pnl) g.best = x;
      if (!g.worst || x.pnl < g.worst.pnl) g.worst = x;
      m.set(k, g);
    }
    return [...m.values()];
  };
  const days = group(dayKey);
  const months = group((ms) => dayKey(ms).slice(0, 7)).map((g) => {
    const d = days.filter((x) => x.key.startsWith(g.key));
    return { ...g, days: d.length, greenDays: d.filter((x) => x.pnl > 0).length, bestDay: d.reduce((a, x) => (!a || x.pnl > a.pnl ? x : a), null) };
  });
  return {
    ops, won: won.length, lost: lost.length, even: ops.length - won.length - lost.length,
    winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
    total: sum(ops), grossWin: gW, grossLoss: gL, avgWin: won.length ? gW / won.length : null, avgLoss: lost.length ? gL / lost.length : null,
    profitFactor: gL ? gW / -gL : null, best: ops.reduce((a, x) => (!a || x.pnl > a.pnl ? x : a), null), worst: ops.reduce((a, x) => (!a || x.pnl < a.pnl ? x : a), null),
    streak, days, months, fees: ops.reduce((a, x) => a + (+x.fees || 0), 0), funding: ops.reduce((a, x) => a + (+x.funding || 0), 0),
  };
}

// Curva de la cuenta: lo aportado + lo ganado con cada operación cerrada; el último punto es el saldo de hoy
function equityChart(s, start, now) {
  if (!s.ops.length) return '';
  const pts = [[s.ops[0].open || s.ops[0].close, start]];
  let acc = start;
  for (const x of s.ops) { acc += x.pnl; pts.push([x.close, acc, x]); }
  pts.push([Date.now(), now]);
  const W = 600, H = 170, P = 8;
  const t0 = pts[0][0], t1 = pts.at(-1)[0], vs = pts.map((p) => p[1]).concat(start);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const X = (t) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P), Y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const line = pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  const up = now >= start, color = up ? 'var(--pos)' : 'var(--neg)';
  const dots = pts.slice(1, -1).map(([t, v, x]) => `<circle cx="${X(t).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3.5" fill="${['var(--neg)', 'var(--text-muted)', 'var(--pos)'][outcome(x.pnl) + 1]}" class="hit"
    data-tip="${esc(`<b>${esc(coinOf(x.symbol))} ${x.side === 'SHORT' ? 'short' : 'long'}</b> · ${new Date(t).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}<br>${signed(x.pnl)} → cuenta ${usd(v)}`)}"/>`).join('');
  return `<svg class="tr-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Curva de la cuenta">
      <line x1="${P}" x2="${W - P}" y1="${Y(start).toFixed(1)}" y2="${Y(start).toFixed(1)}" stroke="var(--text-muted)" stroke-dasharray="4 4" stroke-width="1"/>
      <polygon points="${X(t0).toFixed(1)},${Y(lo).toFixed(1)} ${line} ${X(t1).toFixed(1)},${Y(lo).toFixed(1)}" fill="${color}" opacity=".10"/>
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
      ${dots}
    </svg>
    <div class="chart-axis small muted"><span>${fmtDate(dayKey(t0))}</span><span>- - - lo que pusiste (${usd(start)})</span><span>hoy</span></div>`;
}

// ---------- Setup de cada operación ----------
// Se guarda aparte (settings.setups: id de la operación → nombre), porque la sincronización reescribe las operaciones
const setupKey = (x) => x.externalId || x.id;
const setupOf = (x) => state.db?.settings?.setups?.[setupKey(x)] || '';
const setupNames = () => [...new Set(Object.values(state.db?.settings?.setups || {}).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
// Casilla para escribir el setup (sugiere los ya usados); al cambiarla se guarda
const setupInput = (x) => `<input class="jr-setup" list="jr-setups" data-setup="${esc(setupKey(x))}" value="${esc(setupOf(x))}" placeholder="sin setup" maxlength="40"${isOwner() ? '' : ' disabled'}>`;
const setupDatalist = () => `<datalist id="jr-setups">${setupNames().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;

// ---------- Diario: filtros, indicadores del período y calendario ----------
// Lo que se elige en el diario queda en esta pantalla (el período se recuerda en el navegador)
const diario = { period: prefGet('diarioPeriod', 'mes'), from: '', to: '', side: 'all', pair: 'all', setup: 'all', month: null, shown: null };
const DIARIO_PERIODS = [['hoy', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes'], ['30d', '30d'], ['90d', '90d'], ['año', 'Año'], ['todo', 'Todo'], ['rango', 'Rango']];
const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

// [desde, hasta] en ms (hora local) del período elegido; la semana empieza el lunes
function periodRange(period, from, to, now = Date.now()) {
  const d = new Date(now), midnight = (y, m, dd) => new Date(y, m, dd).getTime();
  const today = midnight(d.getFullYear(), d.getMonth(), d.getDate());
  const ymd = (s) => { const [y, m, dd] = s.split('-').map(Number); return midnight(y, m - 1, dd); };
  switch (period) {
    case 'hoy': return [today, Infinity];
    case 'semana': return [today - ((d.getDay() + 6) % 7) * 864e5, Infinity];
    case 'mes': return [midnight(d.getFullYear(), d.getMonth(), 1), Infinity];
    case '30d': return [now - 30 * 864e5, Infinity];
    case '90d': return [now - 90 * 864e5, Infinity];
    case 'año': return [midnight(d.getFullYear(), 0, 1), Infinity];
    case 'rango': return [from ? ymd(from) : -Infinity, to ? ymd(to) + 864e5 - 1 : Infinity];
    default: return [-Infinity, Infinity];
  }
}

// Indicadores de un grupo de operaciones (ya filtradas y ordenadas por cierre). base = la cuenta al empezar el período.
function journalStats(ops, base) {
  const won = ops.filter((x) => outcome(x.pnl) > 0), lost = ops.filter((x) => outcome(x.pnl) < 0);
  const sum = (l, f = (x) => x.pnl) => l.reduce((a, x) => a + (+f(x) || 0), 0);
  const gW = sum(won), gL = sum(lost), total = sum(ops);
  let eq = base, peak = base, dd = 0, ddPct = 0, run = 0, maxW = 0, maxL = 0;
  for (const x of ops) {
    eq += x.pnl; peak = Math.max(peak, eq);
    if (peak - eq > dd) { dd = peak - eq; ddPct = peak > 0 ? dd / peak : null; }
    const s = outcome(x.pnl);
    if (!s) continue; // las parejas no cortan ni suman a la racha
    run = Math.sign(run) === s ? run + s : s;
    maxW = Math.max(maxW, run); maxL = Math.max(maxL, -run);
  }
  const days = new Map();
  for (const x of ops) days.set(dayKey(x.close), (days.get(dayKey(x.close)) || 0) + x.pnl);
  const timed = ops.filter((x) => x.open && x.close >= x.open);
  const avgWin = won.length ? gW / won.length : null, avgLoss = lost.length ? gL / lost.length : null;
  return {
    n: ops.length, won: won.length, lost: lost.length, even: ops.length - won.length - lost.length, total,
    winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
    profitFactor: gL ? gW / -gL : null, expectancy: ops.length ? total / ops.length : null,
    payoff: avgWin != null && avgLoss ? avgWin / -avgLoss : null, avgWin, avgLoss,
    drawdown: dd, drawdownPct: ddPct,
    best: ops.reduce((a, x) => (!a || x.pnl > a.pnl ? x : a), null), worst: ops.reduce((a, x) => (!a || x.pnl < a.pnl ? x : a), null),
    days: days.size, greenDays: [...days.values()].filter((v) => v > 0).length,
    hours: timed.length ? sum(timed, (x) => x.close - x.open) / timed.length / 36e5 : null,
    fees: sum(ops, (x) => x.fees), funding: sum(ops, (x) => x.funding), maxWinStreak: maxW, maxLossStreak: maxL,
  };
}

// Calendario de un mes: resultado de cada día y total de cada semana (de lunes a domingo)
function journalCalendar(ops, month, base) {
  const [y, m] = month.split('-').map(Number);
  const byDay = new Map();
  for (const x of ops) {
    const k = dayKey(x.close);
    if (!k.startsWith(month)) continue;
    const g = byDay.get(k) || { pnl: 0, n: 0 };
    g.pnl += x.pnl; g.n++; byDay.set(k, g);
  }
  const first = new Date(y, m - 1, 1), daysIn = new Date(y, m, 0).getDate(), lead = (first.getDay() + 6) % 7;
  const today = dayKey(Date.now()), cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const pctOf = (v) => (base > 0 ? ` <span class="muted">${pct(v / base)}</span>` : '');
  const cell = (k) => {
    if (!k) return '<div class="jr-cell jr-empty"></div>';
    const g = byDay.get(k), dd = +k.slice(8);
    return `<button type="button" class="jr-cell ${g ? (g.pnl > 0 ? 'jr-pos' : g.pnl < 0 ? 'jr-neg' : 'jr-even') : ''}${k === today ? ' jr-today' : ''}" ${g ? `data-action="diario-dia" data-day="${k}" title="Ver solo este día"` : 'disabled'}>
        <span class="jr-d">${dd}</span>
        ${g ? `<b class="${cls(g.pnl)}">${signed(g.pnl)}</b><span class="small">${pctOf(g.pnl)}</span><span class="small muted">${g.n} op.</span>` : ''}
      </button>`;
  };
  let html = '';
  for (let w = 0; w < cells.length / 7; w++) {
    const week = cells.slice(w * 7, w * 7 + 7), gs = week.map((k) => k && byDay.get(k)).filter(Boolean);
    const pnl = gs.reduce((a, g) => a + g.pnl, 0), n = gs.reduce((a, g) => a + g.n, 0);
    html += week.map(cell).join('') + `<div class="jr-cell jr-week ${n ? (pnl > 0 ? 'jr-pos' : pnl < 0 ? 'jr-neg' : 'jr-even') : ''}">
        <span class="jr-d">Sem ${w + 1}</span>${n ? `<b class="${cls(pnl)}">${signed(pnl)}</b><span class="small">${pctOf(pnl)}</span><span class="small muted">${n} op.</span>` : ''}</div>`;
  }
  return `<div class="jr-cal">${DIAS_SEMANA.map((d) => `<div class="jr-head">${d}</div>`).join('')}<div class="jr-head">Semana</div>${html}</div>`;
}

// Resultado por setup en el período (las sin setup van al final)
function setupTable(ops) {
  const m = new Map();
  for (const x of ops) { const k = setupOf(x); (m.get(k) || m.set(k, []).get(k)).push(x); }
  if (m.size < 2 && m.has('')) return ''; // todavía nada clasificado
  const rows = [...m.entries()].map(([k, l]) => ({ k, s: journalStats(l, 0) })).sort((a, b) => (!a.k) - (!b.k) || b.s.total - a.s.total);
  return `<div class="table-wrap jr-setups"><table>
    <thead><tr><th>Setup</th><th class="num">Operaciones</th><th class="num">Ganadas</th><th class="num">Perdidas</th><th class="num">Acierto</th>
      <th class="num">Factor</th><th class="num">Promedio</th><th class="num">Resultado</th></tr></thead>
    <tbody>${rows.map(({ k, s }) => `<tr><td>${k ? `<b>${esc(k)}</b>` : '<span class="muted">Sin setup</span>'}</td><td class="num">${s.n}</td>
      <td class="num pos">${s.won}</td><td class="num neg">${s.lost}</td><td class="num">${s.winRate != null ? num(s.winRate * 100, 1) + '%' : '—'}</td>
      <td class="num">${s.profitFactor != null ? num(s.profitFactor, 2) : s.won ? '∞' : '—'}</td><td class="num ${cls(s.expectancy)}">${signed(s.expectancy)}</td>
      <td class="num ${cls(s.total)}"><b>${signed(s.total)}</b></td></tr>`).join('')}</tbody>
  </table></div>`;
}

function journalCard(p, c, start) {
  const all = c.closed.filter((x) => x.close && x.pnl != null).map((x) => ({ ...x, pnl: +x.pnl, close: +x.close, open: +x.open || null })).sort((a, b) => a.close - b.close);
  const pairs = [...new Set(all.map((x) => coinOf(x.symbol)))].sort();
  const setups = setupNames();
  if (diario.setup !== 'all' && diario.setup !== 'none' && !setups.includes(diario.setup)) diario.setup = 'all'; // ese setup ya no se usa
  const pick = all.filter((x) => (diario.side === 'all' || x.side === diario.side) && (diario.pair === 'all' || coinOf(x.symbol) === diario.pair)
    && (diario.setup === 'all' || (diario.setup === 'none' ? !setupOf(x) : setupOf(x) === diario.setup)));
  const [t0, t1] = periodRange(diario.period, diario.from, diario.to);
  const ops = pick.filter((x) => x.close >= t0 && x.close <= t1);
  // La cuenta al empezar el período: lo puesto + lo ganado antes (con todas las operaciones, no solo las filtradas)
  const base = start + all.filter((x) => x.close < t0).reduce((a, x) => a + x.pnl, 0);
  const s = journalStats(ops, base), pending = ops.filter((x) => !setupOf(x));
  const month = diario.month || dayKey(Math.min(Date.now(), isFinite(t1) ? t1 : Date.now())).slice(0, 7);
  diario.shown = month; // el mes que se ve: desde acá se mueven ◀ ▶
  const [cy, cm] = month.split('-').map(Number);
  const op = (x) => (x ? `${esc(coinOf(x.symbol))} ${x.side === 'SHORT' ? 'short' : 'long'} · ${fmtDate(dayKey(x.close))}` : '');
  const ofBase = (v) => (base > 0 && v != null ? pct(v / base) + ' de la cuenta' : '');
  const pc = (v) => (v == null ? '—' : num(v * 100, 1) + '%');
  const tile = (label, value, sub, vcls = '', tip = '') => `<div class="card jr-kpi"${tip ? ` title="${esc(tip)}"` : ''}><div class="label">${label}</div><div class="value ${vcls}">${value}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>`;
  const dur = (h) => (h == null ? '—' : h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? num(h, 1) + ' h' : num(h / 24, 1) + ' d');
  const btn = (act, key, val, on, label) => `<button type="button" class="${on ? 'on' : ''}" data-action="${act}" data-${key}="${val}">${label}</button>`;
  return `
  <div class="card section jr">
    <div class="card-head"><h2>Diario</h2><span class="small muted">${s.n} ${s.n === 1 ? 'operación' : 'operaciones'} en el período</span></div>
    <div class="jr-filters">
      <div class="seg sm">${DIARIO_PERIODS.map(([k, l]) => btn('diario-period', 'period', k, diario.period === k, l)).join('')}</div>
      ${diario.period === 'rango' ? `<span class="jr-range"><input type="date" data-diario="from" value="${esc(diario.from)}"> – <input type="date" data-diario="to" value="${esc(diario.to)}"></span>` : ''}
      <div class="seg sm">${[['all', 'Todas'], ['LONG', 'Long'], ['SHORT', 'Short']].map(([k, l]) => btn('diario-side', 'side', k, diario.side === k, l)).join('')}</div>
      <select data-diario="pair"><option value="all">Todos los pares</option>${pairs.map((x) => `<option value="${esc(x)}"${diario.pair === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <select data-diario="setup"><option value="all">Todos los setups</option><option value="none"${diario.setup === 'none' ? ' selected' : ''}>Sin setup</option>${setups.map((x) => `<option value="${esc(x)}"${diario.setup === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>
    </div>
    ${s.n ? `<div class="jr-kpis">
      ${tile('Resultado neto', signed(s.total), ofBase(s.total), cls(s.total))}
      ${tile('Acierto', pc(s.winRate), `${s.won} G · ${s.lost} P${s.even ? ` · ${s.even} parejas` : ''}`)}
      ${tile('Factor de ganancia', s.profitFactor != null ? num(s.profitFactor, 2) : s.won ? '∞' : '—', 'lo ganado ÷ lo perdido', '', 'Más de 1 = ganás más de lo que perdés')}
      ${tile('Promedio por operación', signed(s.expectancy), ofBase(s.expectancy), cls(s.expectancy), 'Lo que deja, en promedio, cada operación (expectativa)')}
      ${tile('Ganancia / pérdida media', s.payoff != null ? num(s.payoff, 2) : '—', `${signed(s.avgWin)} / ${s.avgLoss != null ? signed(s.avgLoss) : '—'}`, '', 'Payoff: cuánto ganás en promedio en una ganadora por cada dólar que perdés en una perdedora')}
      ${tile('Máx. caída', s.drawdown ? signed(-s.drawdown) : '—', s.drawdownPct ? pct(-s.drawdownPct) + ' desde el máximo' : 'sin caídas', s.drawdown ? 'neg' : '', 'La mayor baja de la cuenta desde un máximo, operación por operación (drawdown)')}
      ${tile('Mejor / peor', `<span class="${cls(s.best.pnl)}">${signed(s.best.pnl)}</span><span class="${cls(s.worst.pnl)}">${signed(s.worst.pnl)}</span>`, `${op(s.best)}<br>${op(s.worst)}`, 'jr-two')}
      ${tile('Días en verde', s.days ? pc(s.greenDays / s.days) : '—', `${s.greenDays} de ${s.days} ${s.days === 1 ? 'día operado' : 'días operados'}`)}
      ${tile('Operaciones por día', s.days ? num(s.n / s.days, 1) : '—', `${s.n} en ${s.days} ${s.days === 1 ? 'día' : 'días'}`)}
      ${tile('Duración media', dur(s.hours), 'de la apertura al cierre')}
      ${tile('Comisiones + funding', signed(s.fees + s.funding), `comisiones ${signed(s.fees)} · funding ${signed(s.funding)}`, cls(s.fees + s.funding))}
      ${tile('Mayor racha', `<span class="pos">${s.maxWinStreak}G</span> / <span class="neg">${s.maxLossStreak}P</span>`, 'ganadas / perdidas seguidas')}
    </div>
    <div class="jr-class">
      <div><b class="pos">${s.won}</b><span>Ganadoras</span></div>
      <div><b class="muted">${s.even}</b><span>Parejas</span></div>
      <div><b class="neg">${s.lost}</b><span>Perdedoras</span></div>
      <div><b class="jr-pend">${pending.length}</b><span>Sin setup</span></div>
      <label class="jr-min small muted" title="Una operación que ganó o perdió menos de esto no cuenta ni como ganada ni como perdida">Pareja si gana o pierde menos de US$
        <input type="number" min="0" step="0.5" data-diario="minTrade" value="${minTrade()}"></label>
    </div>
    ${setupTable(ops)}
    ${pending.length ? `<details class="jr-pending"${pending.length <= 12 ? ' open' : ''}><summary><b>Clasificá ${pending.length === 1 ? 'la operación' : `las ${pending.length} operaciones`} sin setup</b> <span class="small muted">escribí el setup o elegí uno que ya usaste</span></summary>
      <div class="table-wrap"><table><tbody>${pending.slice().reverse().map((x) => `<tr><td>${new Date(x.close).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
        <td class="ticker">${esc(coinOf(x.symbol))}</td><td><span class="tag ${x.side === 'LONG' ? 'buy' : 'sell'}">${x.side === 'LONG' ? 'Long' : 'Short'}</span></td>
        <td class="num ${cls(x.pnl)}"><b>${signed(x.pnl)}</b></td><td>${setupInput(x)}</td></tr>`).join('')}</tbody></table></div>
    </details>` : ''}
    ${setupDatalist()}` : '<div class="empty">No hay operaciones cerradas en este período.</div>'}
    <div class="card-head jr-cal-head">
      <h2>Calendario</h2>
      <div class="jr-nav"><button type="button" class="btn sm" data-action="diario-mes" data-step="-1" aria-label="Mes anterior">◀</button>
        <b>${MESES_LARGO[cm - 1]} ${cy}</b>
        <button type="button" class="btn sm" data-action="diario-mes" data-step="1" aria-label="Mes siguiente">▶</button></div>
    </div>
    ${journalCalendar(pick, month, start + all.filter((x) => x.close < new Date(cy, cm - 1, 1).getTime()).reduce((a, x) => a + x.pnl, 0))}
    <p class="small muted" style="margin:8px 0 0">El calendario usa el lado, el par y el setup elegidos. Tocá un día para ver solo ese día arriba. El % es sobre la cuenta al empezar el período (o el mes).</p>
  </div>`;
}

// ---------- Escáner de zonas (escaner.js en el servidor): solo el dueño ----------
const escanerUI = { data: null, loading: false, at: 0 };
async function loadEscaner(force) {
  if (escanerUI.loading) return;
  escanerUI.loading = true;
  try { escanerUI.data = await (force ? postJson('/api/escaner/run', {}) : api('/api/escaner')); escanerUI.at = Date.now(); }
  catch { /* queda lo anterior */ }
  finally { escanerUI.loading = false; }
  render();
}
function escanerCard() {
  if (!isAdmin()) return '';
  if (!escanerUI.data || Date.now() - escanerUI.at > 5 * 60e3) setTimeout(loadEscaner, 0);
  const d = escanerUI.data;
  const px = (v) => (v == null ? '—' : num(v, v >= 1000 ? 1 : v >= 10 ? 2 : 4));
  const plan = (pl) => `<div class="esc-plan${pl.alert === false ? ' esc-off' : ''}"><div class="esc-side ${pl.side === 'long' ? 'pos' : 'neg'}">${pl.side === 'long' ? 'Long' : 'Short'}
        <span class="esc-flag">${pl.alert === false ? `no avisa: ${esc(pl.skip)}` : pl.alert ? '🔔 avisa por Telegram' : ''}</span></div>
      ${pl.entries.map((e, i) => `<div class="hit" data-tip="${esc(e.why.join(' · '))}">${i + 1}) <b>${px(e.price)}</b> <span class="muted">${Math.round(e.pct * 100)}%</span> <span class="tag ${e.level === 3 ? 'buy' : ''}">N${e.level}</span></div>`).join('')}
      <div class="small"><span class="muted">Prom.</span> ${px(pl.avg)} · <span class="muted">Stop</span> <span class="neg">${px(pl.stop)}</span> · <span class="muted">TP</span> <span class="pos">${px(pl.tp)}</span>${pl.rr ? ` · R/B ${num(pl.rr, 1)}` : ''}</div>
      <div class="small ${pl.risk > 0.02 ? 'neg' : 'muted'}">Riesgo ${pct(pl.risk).replace('+', '')} de la cuenta a ${pl.leverage}x${pl.risk > 0.02 ? ` · máx. ${pl.maxLeverage}x para quedar en 2%` : ''}</div></div>`;
  return `<div class="card section">
    <div class="card-head"><h2>Escáner de zonas <span class="muted small">(velas de 4 h · niveles 1/2/3)</span></h2>
      <span class="small muted">${d?.updated ? 'actualizado ' + new Date(d.updated).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : ''}
        <button class="btn sm" data-action="escaner-run"${escanerUI.loading ? ' disabled' : ''}>${escanerUI.loading ? 'Revisando…' : 'Revisar ahora'}</button></span></div>
    ${!d ? '<div class="muted small">Cargando…</div>' : `<div class="esc-grid">${d.results.map((r) => `<div class="esc-pair">
      <div class="esc-head"><b>${esc(coinOf(r.symbol))}</b> <span>${px(r.price)}</span>
        <span class="tag ${r.trend === 'alcista' ? 'buy' : 'sell'}">${r.trend}</span> <span class="muted small">RSI ${Math.round(r.rsi)}</span></div>
      ${r.long || r.short ? [r.long, r.short].filter(Boolean).map(plan).join('') : '<div class="muted small">Sin zonas de nivel 2 sólido o 3 cerca.</div>'}
    </div>`).join('')}</div>`}
    <p class="small muted" style="margin:8px 0 0">Entradas límite 15/30/55% del 10% de la cuenta; stop detrás de la zona siguiente; TP en la zona opuesta. Pasá el mouse por cada entrada para ver sus confirmaciones. Por Telegram solo avisa de los setups a favor de la tendencia con R/B ≥ 1,5 (en el backtest, los demás perdían): cuando aparece uno nuevo y cuando el precio se acerca a la entrada 1. No opera solo: antes de entrar esperá la vela de confirmación.</p>
  </div>`;
}

function tradingDashboard(p, c) {
  const s = tradeStats(c.closed);
  const put = c.deposits, now = c.value, res = put ? now - put : null;
  const pctTxt = (v) => (v == null ? '—' : Math.round(v * 100) + '%'); // acierto: sin decimales
  const op = (x) => (x ? `${esc(coinOf(x.symbol))} ${x.side === 'SHORT' ? 'short' : 'long'} · ${fmtDate(dayKey(x.close))}` : '');
  const decided = s.won + s.lost;
  return `
  <div class="card section tr-hero">
    <div class="tr-flow">
      <div><div class="label">Pusiste</div><div class="tr-big">${put ? usd(put) : '—'}</div>
        ${put ? '' : `<button class="btn sm" data-action="new-aporte" data-pid="${p.id}">+ Cargar lo que pusiste</button>`}</div>
      <div class="tr-arrow" aria-hidden="true">→</div>
      <div><div class="label">Hoy tenés</div><div class="tr-big">${usd(now)}</div>
        <div class="small muted">${c.unrealized ? `incluye ${signed(c.unrealized)} de lo abierto` : 'sin posiciones abiertas'}</div></div>
      <div class="tr-arrow" aria-hidden="true">=</div>
      <div><div class="label">${res == null || res >= 0 ? 'Ganaste' : 'Perdiste'}</div>
        <div class="tr-big ${cls(res)}">${res == null ? '—' : signed(res)}</div>
        <div class="small ${cls(res)}">${res == null ? '' : pct(res / put) + ' sobre lo puesto'}</div></div>
    </div>
  </div>

  <div class="tr-grid">
    <div class="card section">
      <h2>Ganadas vs perdidas</h2>
      ${decided ? `
      <div class="tr-wl">
        <div class="tr-wl-n pos"><b>${s.won}</b><span>ganadas</span></div>
        <div class="tr-wl-rate"><b>${pctTxt(s.winRate)}</b><span>de acierto</span></div>
        <div class="tr-wl-n neg"><b>${s.lost}</b><span>perdidas</span></div>
      </div>
      <div class="tr-split"><span class="pos" style="width:${(s.won / decided) * 100}%"></span><span class="neg" style="width:${(s.lost / decided) * 100}%"></span></div>
      ${s.even ? `<div class="small muted" style="margin-top:6px">+ ${s.even} ${s.even === 1 ? 'pareja' : 'parejas'}: ${s.even === 1 ? 'ganó o perdió' : 'ganaron o perdieron'} menos de US$ ${num(minTrade(), 2)}, no cuentan ni como ganadas ni como perdidas</div>` : ''}
      <div class="tr-facts">
        <div><span class="muted">Ganás en promedio</span><b class="pos">${signed(s.avgWin)}</b></div>
        <div><span class="muted">Perdés en promedio</span><b class="neg">${s.avgLoss != null ? signed(s.avgLoss) : '—'}</b></div>
        <div title="Lo ganado en las ganadoras dividido lo perdido en las perdedoras. Más de 1 = ganás más de lo que perdés"><span class="muted">Factor de ganancia</span><b>${s.profitFactor != null ? num(s.profitFactor, 2) : '∞'}</b></div>
        <div><span class="muted">Racha actual</span><b class="${s.streak > 0 ? 'pos' : s.streak < 0 ? 'neg' : ''}">${s.streak ? `${Math.abs(s.streak)} ${s.streak > 0 ? 'ganada' : 'perdida'}${Math.abs(s.streak) > 1 ? 's' : ''} seguida${Math.abs(s.streak) > 1 ? 's' : ''}` : '—'}</b></div>
        <div><span class="muted">Mejor operación</span><span><b class="pos">${signed(s.best?.pnl)}</b> <span class="muted small">${op(s.best)}</span></span></div>
        <div><span class="muted">Peor operación</span><span><b class="${cls(s.worst?.pnl)}">${signed(s.worst?.pnl)}</b> <span class="muted small">${op(s.worst)}</span></span></div>
        <div><span class="muted">Comisiones pagadas</span><b class="neg">${signed(s.fees)}</b></div>
        <div><span class="muted">Funding</span><b class="${cls(s.funding)}">${signed(s.funding)}</b></div>
      </div>` : `<div class="empty">${s.ops.length ? `Ninguna operación ganó o perdió más de US$ ${num(minTrade(), 2)} todavía.` : 'Todavía no hay operaciones cerradas.'}</div>`}
    </div>
    <div class="card section">
      <h2>Cómo fue la cuenta <span class="muted small">(cada punto es una operación cerrada)</span></h2>
      ${equityChart(s, put || now - s.total - c.unrealized, now) || '<div class="empty">Todavía no hay operaciones cerradas.</div>'}
    </div>
  </div>

  ${escanerCard()}

  ${s.ops.length ? journalCard(p, c, put || now - s.total - c.unrealized) : ''}

  ${s.days.length ? `<div class="card section">
    <h2>Por mes</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Mes</th><th class="num">Operaciones</th><th class="num">Ganadas</th><th class="num">Perdidas</th><th class="num">Acierto</th>
        <th class="num">Días operados</th><th class="num">Días en verde</th><th class="num">Mejor día</th><th class="num">Comisiones</th><th class="num">Resultado</th></tr></thead>
      <tbody>${s.months.slice().reverse().map((m) => {
        const [y, mm] = m.key.split('-');
        return `<tr><td><b>${MESES_LARGO[+mm - 1]} ${y}</b></td><td class="num">${m.ops}</td>
          <td class="num pos">${m.won}</td><td class="num neg">${m.lost}</td><td class="num">${m.won + m.lost ? pctTxt(m.won / (m.won + m.lost)) : '—'}</td>
          <td class="num">${m.days}</td><td class="num">${m.greenDays} de ${m.days}</td>
          <td class="num">${m.bestDay ? `${signed(m.bestDay.pnl)} <span class="muted small">(${m.bestDay.key.slice(8)}/${mm})</span>` : '—'}</td>
          <td class="num neg">${signed(m.fees)}</td><td class="num ${cls(m.pnl)}"><b>${signed(m.pnl)}</b></td></tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>` : ''}`;
}
