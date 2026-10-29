'use strict';
// Panel de trading diario (futuros Bitunix): lo puesto vs lo que hay, ganadas vs perdidas, curva de la cuenta,
// resultado por día y por mes. Se arma con las operaciones cerradas que trae la sincronización.

const dayKey = (ms) => new Date(ms).toLocaleDateString('sv-SE'); // AAAA-MM-DD en la hora local
const MESES_LARGO = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Estadísticas de las cerradas: ganadas/perdidas, promedios, racha, por día y por mes
function tradeStats(closed) {
  const ops = closed.filter((x) => x.close && x.pnl != null).map((x) => ({ ...x, pnl: +x.pnl })).sort((a, b) => a.close - b.close);
  const won = ops.filter((x) => x.pnl > 0), lost = ops.filter((x) => x.pnl < 0);
  const sum = (l) => l.reduce((a, x) => a + x.pnl, 0);
  const gW = sum(won), gL = sum(lost);
  let streak = 0; // racha actual: + ganadas seguidas, − perdidas seguidas
  for (let i = ops.length - 1; i >= 0; i--) {
    const s = Math.sign(ops[i].pnl);
    if (!s) continue;
    if (streak && Math.sign(streak) !== s) break;
    streak += s;
  }
  const group = (keyOf) => {
    const m = new Map();
    for (const x of ops) {
      const k = keyOf(x.close), g = m.get(k) || { key: k, ops: 0, won: 0, lost: 0, pnl: 0, fees: 0, best: null, worst: null };
      g.ops++; if (x.pnl > 0) g.won++; else if (x.pnl < 0) g.lost++;
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
  const dots = pts.slice(1, -1).map(([t, v, x]) => `<circle cx="${X(t).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3.5" fill="${x.pnl >= 0 ? 'var(--pos)' : 'var(--neg)'}" class="hit"
    data-tip="${esc(`<b>${esc(coinOf(x.symbol))} ${x.side === 'SHORT' ? 'short' : 'long'}</b> · ${new Date(t).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}<br>${signed(x.pnl)} → cuenta ${usd(v)}`)}"/>`).join('');
  return `<svg class="tr-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Curva de la cuenta">
      <line x1="${P}" x2="${W - P}" y1="${Y(start).toFixed(1)}" y2="${Y(start).toFixed(1)}" stroke="var(--text-muted)" stroke-dasharray="4 4" stroke-width="1"/>
      <polygon points="${X(t0).toFixed(1)},${Y(lo).toFixed(1)} ${line} ${X(t1).toFixed(1)},${Y(lo).toFixed(1)}" fill="${color}" opacity=".10"/>
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
      ${dots}
    </svg>
    <div class="chart-axis small muted"><span>${fmtDate(dayKey(t0))}</span><span>- - - lo que pusiste (${usd(start)})</span><span>hoy</span></div>`;
}

// Barras por día: verde lo ganado, rojo lo perdido (últimos 31 días con operaciones)
function dayBars(days) {
  const list = days.slice(-31);
  if (!list.length) return '';
  const max = Math.max(...list.map((d) => Math.abs(d.pnl))) || 1;
  return `<div class="tr-days">${list.map((d) => {
    const h = Math.max(3, (Math.abs(d.pnl) / max) * 100);
    const [y, m, dd] = d.key.split('-');
    const tip = `<b>${dd}/${m}/${y.slice(2)}</b> · ${signed(d.pnl)}<br>${d.ops} ${d.ops === 1 ? 'operación' : 'operaciones'}: ${d.won} ganadas, ${d.lost} perdidas`;
    return `<div class="tr-day hit" data-tip="${esc(tip)}">
        <div class="tr-day-up">${d.pnl > 0 ? `<span class="pos" style="height:${h}%"></span>` : ''}</div>
        <div class="tr-day-down">${d.pnl < 0 ? `<span class="neg" style="height:${h}%"></span>` : ''}</div>
        <div class="tr-day-lbl">${dd}</div>
      </div>`;
  }).join('')}</div>`;
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
      <div class="tr-facts">
        <div><span class="muted">Ganás en promedio</span><b class="pos">${signed(s.avgWin)}</b></div>
        <div><span class="muted">Perdés en promedio</span><b class="neg">${s.avgLoss != null ? signed(s.avgLoss) : '—'}</b></div>
        <div title="Lo ganado en las ganadoras dividido lo perdido en las perdedoras. Más de 1 = ganás más de lo que perdés"><span class="muted">Factor de ganancia</span><b>${s.profitFactor != null ? num(s.profitFactor, 2) : '∞'}</b></div>
        <div><span class="muted">Racha actual</span><b class="${s.streak > 0 ? 'pos' : s.streak < 0 ? 'neg' : ''}">${s.streak ? `${Math.abs(s.streak)} ${s.streak > 0 ? 'ganada' : 'perdida'}${Math.abs(s.streak) > 1 ? 's' : ''} seguida${Math.abs(s.streak) > 1 ? 's' : ''}` : '—'}</b></div>
        <div><span class="muted">Mejor operación</span><span><b class="pos">${signed(s.best?.pnl)}</b> <span class="muted small">${op(s.best)}</span></span></div>
        <div><span class="muted">Peor operación</span><span><b class="${cls(s.worst?.pnl)}">${signed(s.worst?.pnl)}</b> <span class="muted small">${op(s.worst)}</span></span></div>
        <div><span class="muted">Comisiones pagadas</span><b class="neg">${signed(s.fees)}</b></div>
        <div><span class="muted">Funding</span><b class="${cls(s.funding)}">${signed(s.funding)}</b></div>
      </div>` : '<div class="empty">Todavía no hay operaciones cerradas.</div>'}
    </div>
    <div class="card section">
      <h2>Cómo fue la cuenta <span class="muted small">(cada punto es una operación cerrada)</span></h2>
      ${equityChart(s, put || now - s.total - c.unrealized, now) || '<div class="empty">Todavía no hay operaciones cerradas.</div>'}
    </div>
  </div>

  ${s.days.length ? `<div class="card section">
    <div class="card-head"><h2>Por día</h2><span class="small muted">${s.days.filter((d) => d.pnl > 0).length} días en verde · ${s.days.filter((d) => d.pnl < 0).length} en rojo</span></div>
    ${dayBars(s.days)}
  </div>
  <div class="card section">
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
