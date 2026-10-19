'use strict';
// ================= Calculadora de balas (reglas Saylor) =================
// Estrategias de las imágenes de /reglas. Cargador = fracción del capital total; bala = cargador / 30.
const STRATS = {
  michael: { name: 'Michael Saylor', short: 'Michael', frac: 1 / 2, fracTxt: '1/2', assets: ['BTC'], inicio: 3 },
  baby: { name: 'Baby Saylor', short: 'Baby', frac: 1 / 5, fracTxt: '1/5', assets: ['BTC', 'SOL'], inicio: 2 },
};
const BALAS_POR_CARGADOR = 30;
const LEVERAGE = 5;
const BINGX_MIN_BALA = 20; // mínimo de BingX por bala (margen): USD 20 → posición USD 100 a 5x

// Recarga regular según cuánto va la posición (en %, positivo o negativo).
function recargaRegular(p) {
  if (p > 5) return { balas: 1, zona: 'Positivo más de 5%' };
  if (p >= 0) return { balas: 2, zona: 'Positivo hasta 5%' };
  if (p >= -5) return { balas: 2, zona: 'Negativo hasta 5%' };
  if (p >= -10) return { balas: 3, zona: 'Negativo hasta 10%' };
  if (p >= -15) return { balas: 4, zona: 'Negativo hasta 15%' };
  return { balas: 5, zona: 'Negativo más de 15%' };
}
// Recargas excepcionales: además de la posición, se agregan balas al margen.
function recargaExcepcional(p) {
  if (p <= -60) return { balas: 6, margen: 6, zona: 'Terminal (más de 60% negativo)', nivel: 'terminal' };
  if (p <= -40) return { balas: 3, margen: 3, zona: 'Crítica (más de 40% negativo)', nivel: 'critica' };
  return null;
}
function takeProfit(p) {
  if (p >= 20) return { txt: 'Take profit recomendado (≥ 20%)', cls: 'pos' };
  if (p >= 15) return { txt: 'Take profit a gusto (≥ 15%)', cls: 'pos' };
  return null;
}

function balasConfig(c) {
  const s = (state.db.settings ||= {});
  const b = (s.balas ||= { basis: 'margin', capital: {}, assign: {} });
  b.capital ||= {}; b.assign ||= {};
  const capital = (k) => (+b.capital[k] > 0 ? +b.capital[k] : c.value); // por defecto: equity total de la cartera
  return { b, capital, manual: (k) => +b.capital[k] > 0 };
}
// Estrategia por defecto de cada posición: BTC coin-M → Michael; el resto (SOL, BTC-USDT) → Baby.
function defaultStrat(x) {
  return x.market === 'COIN-M' && x.symbol.startsWith('BTC') ? 'michael' : 'baby';
}

function balasCard(p, c) {
  const { b, capital, manual } = balasConfig(c);
  const pctOf = (x) => (b.basis === 'price'
    ? (x.entryPrice && x.markPrice ? (x.markPrice / x.entryPrice - 1) * (x.side === 'SHORT' ? -1 : 1) * 100 : null)
    : (x.margin ? (x.pnl / x.margin) * 100 : null));
  const stratInfo = Object.entries(STRATS).map(([k, s]) => {
    const cap = capital(k), cargador = cap * s.frac, bala = cargador / BALAS_POR_CARGADOR;
    // La bala que se usa de verdad nunca baja del mínimo de BingX
    return { k, s, cap, cargador, bala, balaEf: Math.max(bala, BINGX_MIN_BALA), low: bala < BINGX_MIN_BALA };
  });
  const byKey = Object.fromEntries(stratInfo.map((x) => [x.k, x]));
  const base = (sym) => sym.split('-')[0];

  const rows = c.positions.map((x) => {
    const k = b.assign[x.externalId] || defaultStrat(x);
    const st = byKey[k];
    const pv = pctOf(x);
    const exc = pv != null ? recargaExcepcional(pv) : null;
    const reg = pv != null ? recargaRegular(pv) : null;
    const n = exc ? exc.balas : reg?.balas ?? 0;
    const margenRecarga = n * st.balaEf;
    const posRecarga = margenRecarga * LEVERAGE;
    const usadas = st.balaEf ? (+x.margin || 0) / st.balaEf : null;
    return { x, k, st, pv, exc, reg, n, margenRecarga, posRecarga, usadas, tp: pv != null ? takeProfit(pv) : null, fuera: !STRATS[k].assets.includes(base(x.symbol)) };
  });

  const stratSel = (x, k) => `<select data-bala-assign="${esc(x.externalId)}" aria-label="Estrategia">${Object.entries(STRATS).map(([sk, s]) => `<option value="${sk}" ${sk === k ? 'selected' : ''}>${s.short}</option>`).join('')}</select>`;
  const contratos = (x, usdPos) => (x.market === 'COIN-M' ? ` · ${state.hide ? MASK : num(Math.round(usdPos / 100))} contratos` : '');

  return `<div class="card section balas">
    <div class="card-head">
      <h2>Calculadora de balas <span class="muted small">(reglas Saylor · ${LEVERAGE}x)</span></h2>
      <div class="seg sm" title="Sobre qué se mide el % de la tabla">
        <button type="button" class="${b.basis !== 'price' ? 'on' : ''}" data-bala-basis="margin">% sobre margen</button>
        <button type="button" class="${b.basis === 'price' ? 'on' : ''}" data-bala-basis="price">% de precio</button>
      </div>
    </div>
    <div class="strat-grid">${stratInfo.map(({ k, s, cap, cargador, bala, low }) => `
      <div class="strat">
        <div class="strat-top"><b>${s.name}</b><span class="muted small">${s.assets.join(' + ')} · cargador ${s.fracTxt} del capital</span></div>
        <div class="strat-cap owner-only">
          <label class="small muted" for="cap-${k}">Capital total</label>
          <input id="cap-${k}" type="number" min="0" step="any" data-bala-cap="${k}" value="${manual(k) ? +b.capital[k] : ''}" placeholder="${state.hide ? '' : Math.round(c.value)}">
          <span class="hint">${manual(k) ? 'Valor fijado a mano (vaciá el campo para usar el equity)' : 'Vacío = equity total de la cartera'}</span>
        </div>
        <div class="strat-nums">
          <div><span class="muted small">Capital</span><b>${usd(cap)}</b></div>
          <div><span class="muted small">Cargador</span><b>${usd(cargador)}</b></div>
          <div><span class="muted small">1 bala (margen)</span><b>${usd(bala)}</b></div>
          <div><span class="muted small">Posición por bala</span><b>${usd(bala * LEVERAGE)}</b></div>
        </div>
        ${low ? `<div class="small neg">⚠ La bala queda por debajo del mínimo de BingX (US$ ${BINGX_MIN_BALA} de margen). Usá US$ ${BINGX_MIN_BALA} por bala.</div>` : ''}
        <div class="small muted">Posición nueva ("Inicio"): <b>${s.inicio} balas</b> = ${usd(s.inicio * Math.max(bala, BINGX_MIN_BALA))} de margen · ${usd(s.inicio * Math.max(bala, BINGX_MIN_BALA) * LEVERAGE)} de posición</div>
      </div>`).join('')}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Par</th><th>Estrategia</th><th class="num">${b.basis === 'price' ? '% precio' : '% s/margen'}</th><th>Situación</th>
        <th class="num">Recargar</th><th class="num">Margen</th><th class="num">Posición</th><th class="num">Balas usadas</th><th>Take profit</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr class="${r.exc ? 'row-alert' : ''}">
        <td class="ticker">${esc(r.x.symbol)} <span class="muted small">${esc(r.x.market)}</span></td>
        <td>${isOwner() ? stratSel(r.x, r.k) : STRATS[r.k].short}${r.fuera ? ` <span class="tag" title="Esta estrategia no incluye ${esc(base(r.x.symbol))}">fuera de la regla</span>` : ''}</td>
        <td class="num ${cls(r.pv)}">${r.pv == null ? '—' : pct(r.pv / 100)}</td>
        <td>${r.exc ? `<span class="tag sell">${esc(r.exc.zona)}</span>` : esc(r.reg?.zona || '—')}</td>
        <td class="num"><b>${r.n} ${r.n === 1 ? 'bala' : 'balas'}</b>${r.exc ? ` <span class="small">+ ${r.exc.margen} al margen</span>` : ''}</td>
        <td class="num">${usd(r.margenRecarga)}${r.exc ? ` <span class="muted small">+ ${usd(r.exc.margen * r.st.balaEf)}</span>` : ''}</td>
        <td class="num">${usd(r.posRecarga)}<span class="muted small">${contratos(r.x, r.posRecarga)}</span></td>
        <td class="num">${r.usadas == null ? '—' : `${num(r.usadas, 1)} de ${BALAS_POR_CARGADOR}`}</td>
        <td>${r.tp ? `<span class="${r.tp.cls}">${r.tp.txt}</span>` : '<span class="muted small">Todavía no</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty">Sin posiciones abiertas: para arrancar una, mirá "Posición nueva" en cada estrategia.</td></tr>'}</tbody>
    </table></div>
    <p class="muted small" style="margin:10px 0 0">Referencia, no recomendación: sale de aplicar tus reglas a los datos de BingX. "Balas usadas" = margen actual ÷ valor de la bala.
      ${state.reglas.length ? '<button type="button" class="linkbtn" data-action="ver-regla" data-i="0">Ver reglas</button>' : ''}</p>
  </div>`;
}

// ================= Calculadora Doble Saylor (Bitget) =================
// 2 cargadores de 50% del capital; 2 balas por cargador. Cada bala: 1/5 para el trade y 4/5 de margen adicional. 10x.
const DOBLE = { leverage: 10, cargadores: 2, balasPorCargador: 2, trade: 1 / 5, tpGusto: 20, tpRec: 30, assets: ['MSTR', 'BTC', 'otras acciones'] };

function dobleSaylorCard(p, c) {
  const { b, capital, manual } = balasConfig(c);
  const cap = capital('doble');
  const cargador = cap / DOBLE.cargadores, bala = cargador / DOBLE.balasPorCargador;
  const tradeM = bala * DOBLE.trade, extraM = bala - tradeM;
  const totalBalas = DOBLE.cargadores * DOBLE.balasPorCargador;
  const nombreBala = (i) => `Bala ${(i % DOBLE.balasPorCargador) + 1} · Cargador ${Math.floor(i / DOBLE.balasPorCargador) + 1}`;

  const rows = c.positions.map((x) => {
    const lev = +x.leverage || DOBLE.leverage;
    // ROE: PnL sobre el margen de la posición (sin el margen adicional que solo baja la liquidación)
    const roe = x.roePct != null ? x.roePct * 100 : null;
    const precio = x.entryPrice && x.markPrice ? (x.markPrice / x.entryPrice - 1) * (x.side === 'SHORT' ? -1 : 1) * 100 : null;
    const usadas = bala ? (+x.margin || 0) / bala : null;
    const sig = usadas == null ? null : Math.floor(usadas + 0.05); // tolerancia por comisiones y redondeos
    const tp = roe == null ? null : roe >= DOBLE.tpRec ? { txt: `Take profit recomendado (≥ ${DOBLE.tpRec}%)`, cls: 'pos' }
      : roe >= DOBLE.tpGusto ? { txt: `Take profit a gusto (≥ ${DOBLE.tpGusto}%)`, cls: 'pos' } : null;
    return { x, lev, roe, precio, usadas, sig, tp };
  });

  return `<div class="card section balas">
    <div class="card-head"><h2>Calculadora Doble Saylor <span class="muted small">(${DOBLE.assets.join(', ')} · ${DOBLE.leverage}x)</span></h2></div>
    <div class="strat-grid"><div class="strat">
      <div class="strat-top"><b>Doble Saylor</b><span class="muted small">${DOBLE.cargadores} cargadores de 50% · ${DOBLE.balasPorCargador} balas por cargador</span></div>
      <div class="strat-cap owner-only">
        <label class="small muted" for="cap-doble">Capital total de la estrategia</label>
        <input id="cap-doble" type="number" min="0" step="any" data-bala-cap="doble" value="${manual('doble') ? +b.capital.doble : ''}" placeholder="${state.hide ? '' : Math.round(c.value)}">
        <span class="hint">${manual('doble') ? 'Valor fijado a mano (vaciá el campo para usar el equity)' : 'Vacío = equity total de la cartera'}</span>
      </div>
      <div class="strat-nums">
        <div><span class="muted small">Capital</span><b>${usd(cap)}</b></div>
        <div><span class="muted small">Cargador (50%)</span><b>${usd(cargador)}</b></div>
        <div><span class="muted small">1 bala</span><b>${usd(bala)}</b></div>
        <div><span class="muted small">Posición por bala (${DOBLE.leverage}x)</span><b>${usd(tradeM * DOBLE.leverage)}</b></div>
      </div>
      <div class="small muted">Cada bala: <b>${usd(tradeM)}</b> de margen para el trade (1/5) + <b>${usd(extraM)}</b> de margen adicional (4/5) para bajar el precio de liquidación.
        Primera entrada: Bala 1 del Cargador 1; el Cargador 2 queda para cuando el mercado lo justifique.</div>
    </div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Par</th><th class="num">% precio</th><th class="num">ROE</th><th class="num">Margen</th>
        <th class="num">Balas usadas</th><th>Próxima bala</th><th class="num">Liquidación</th><th>Take profit</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr>
        <td class="ticker">${esc(r.x.symbol)} <span class="muted small">${esc(r.x.market)}</span> <span class="tag ${r.x.side === 'LONG' ? 'buy' : 'sell'}">${r.x.side === 'LONG' ? 'Long' : 'Short'}</span>${r.lev !== DOBLE.leverage ? ` <span class="tag" title="La regla es ${DOBLE.leverage}x">${r.lev}x</span>` : ''}</td>
        <td class="num ${cls(r.precio)}">${r.precio == null ? '—' : pct(r.precio / 100)}</td>
        <td class="num ${cls(r.roe)}">${r.roe == null ? '—' : pct(r.roe / 100)}</td>
        <td class="num">${usd(r.x.margin)}</td>
        <td class="num">${r.usadas == null ? '—' : `${num(r.usadas, 1)} de ${totalBalas}`}</td>
        <td>${r.sig == null ? '—' : r.sig >= totalBalas ? '<span class="neg">Sin balas: ya usaste las 4</span>'
          : `${nombreBala(r.sig)} <span class="muted small">${usd(tradeM)} trade + ${usd(extraM)} margen</span>`}</td>
        <td class="num">${r.x.liq ? `${num(r.x.liq, 2)}${r.x.liqDist != null ? ` <span class="muted small">(${pct(r.x.liqDist)})</span>` : ''}` : '—'}</td>
        <td>${r.tp ? `<span class="${r.tp.cls}">${r.tp.txt}</span>` : '<span class="muted small">Todavía no</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="8" class="empty">Sin posiciones abiertas: para arrancar, usá la Bala 1 del Cargador 1.</td></tr>'}</tbody>
    </table></div>
    <p class="muted small" style="margin:10px 0 0">Referencia, no recomendación: sale de aplicar tus reglas a los datos de Bitget. "Balas usadas" = margen actual ÷ valor de la bala.
      ROE = resultado sobre el margen de la posición, sin contar el margen adicional (igual que en Bitget).
      ${state.reglas.length ? '<a href="#/reglas" class="linkbtn">Ver reglas</a>' : ''}</p>
  </div>`;
}

// ================= Reglas (imágenes de estrategia) =================
function reglaCard(r, i, small = false) {
  return `<figure class="regla ${small ? 'small' : ''}">
    <button type="button" class="regla-img" data-action="ver-regla" data-i="${i}" aria-label="Ampliar ${esc(r.title)}">
      <img src="${esc(r.src)}" alt="${esc(r.title)}" loading="lazy">
    </button>
    <figcaption>${esc(r.title)}</figcaption>
  </figure>`;
}

function viewReglas() {
  return `
  <div class="page-head"><div><h1>Reglas</h1><div class="sub">Tu estrategia a mano. Tocá una imagen para verla en grande.</div></div></div>
  <div class="reglas-grid">${state.reglas.map((r, i) => reglaCard(r, i)).join('')}</div>
  <p class="muted small owner-only">Para agregar más: poné la imagen (JPG o PNG) en la carpeta <code>app\\public\\reglas</code> y recargá la página.</p>`;
}

function showRegla(i) {
  const r = state.reglas[i];
  if (!r) return;
  const m = $('#modal');
  m.innerHTML = `<div class="lightbox">
    <div class="modal-head">${esc(r.title)}<button type="button" class="btn ghost icon" data-close aria-label="Cerrar">✕</button></div>
    <div class="lightbox-body"><img src="${esc(r.src)}" alt="${esc(r.title)}"></div>
  </div>`;
  m.classList.add('wide');
  m.querySelector('[data-close]').onclick = () => m.close();
  m.onclick = (e) => { if (e.target === m) m.close(); }; // clic fuera de la imagen
  m.addEventListener('close', () => m.classList.remove('wide'), { once: true });
  m.showModal();
}

