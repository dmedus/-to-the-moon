'use strict';
// ================= Seguridad =================
async function postJson(url, body) {
  return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function passwordForm() {
  const needCode = !!state.auth?.totp;
  openModal('Cambiar tu contraseña', `
    ${field('Contraseña actual', '<input name="current" type="password" autocomplete="current-password" required>', { full: true })}
    ${needCode ? field('Código de 6 dígitos', '<input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required>', { full: true }) : ''}
    ${field('Nueva contraseña', '<input name="password" type="password" autocomplete="new-password" minlength="8" required>', { hint: 'Mínimo 8 caracteres', full: true })}
    ${field('Repetí la nueva', '<input name="password2" type="password" autocomplete="new-password" minlength="8" required>', { full: true })}
    <div class="warn" id="pw-err"></div>`, async (d) => {
    if (d.password !== d.password2) { $('#pw-err').textContent = 'Las contraseñas nuevas no coinciden.'; return false; }
    try {
      await postJson('/api/auth/password', { current: d.current, code: d.code, password: d.password });
      toast('Contraseña cambiada. Se cerraron las demás sesiones.');
    } catch (e) { $('#pw-err').textContent = e.message; return false; }
  });
}

function guestForm() {
  const on = !!state.auth?.guestEnabled;
  openModal(on ? 'Contraseña del invitado' : 'Activar usuario invitado', `
    <p class="small full" style="margin:0">Usuario: <code>invitado</code>. Ve tus carteras con porcentajes y distribución, pero <b>nunca montos</b>, y no puede modificar nada. Lo podés desactivar cuando quieras.</p>
    ${field('Contraseña para el invitado', '<input name="password" type="password" autocomplete="new-password" minlength="8" required>', { hint: 'Mínimo 8 caracteres. Distinta de la tuya.', full: true })}
    <div class="warn" id="g-err"></div>`, async (d) => {
    try {
      await postJson('/api/auth/guest', { enabled: true, password: d.password });
      state.auth.guestEnabled = true;
      toast('Invitado activado');
    } catch (e) { $('#g-err').textContent = e.message; return false; }
  });
}

// ================= Formularios (modal) =================
function openModal(title, bodyHtml, onSubmit, onInput) {
  const m = $('#modal');
  m.innerHTML = `<form method="dialog" id="mform">
    <div class="modal-head">${esc(title)}<button type="button" class="btn ghost icon" data-close aria-label="Cerrar">✕</button></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary">Guardar</button></div>
  </form>`;
  const form = $('#mform');
  form.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => m.close()));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const ok = await onSubmit(Object.fromEntries(new FormData(form)), form);
    if (ok !== false) { m.close(); render(); }
  };
  if (onInput) { form.oninput = () => onInput(form); onInput(form); }
  m.showModal();
  form.querySelector('input:not([type=hidden]), select')?.focus();
}

const field = (label, inner, opts = {}) => `<div class="field ${opts.full ? 'full' : ''}" ${opts.id ? `id="${opts.id}"` : ''}><label>${label}</label>${inner}${opts.hint ? `<span class="hint">${opts.hint}</span>` : ''}</div>`;
const tradable = () => state.db.portfolios.filter((p) => !SYNCED.has(p.type));
const portfolioSelect = (sel, all = false, only = () => true) => `<select name="portfolioId" required>${(all ? state.db.portfolios : tradable()).filter(only).map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;

function txForm(tx = {}) {
  tx = Object.fromEntries(Object.entries(tx).filter(([, v]) => v !== undefined)); // los botones pueden mandar campos vacíos
  const rid = SYNCED.has(portfolio(route().id)?.type) ? null : route().id;
  const pid = tx.portfolioId || rid || tradable()[0]?.id;
  if (!pid) return toast('Primero creá una cartera en Ajustes');
  const editing = !!tx.id;
  const p0 = portfolio(pid);
  const t = {
    side: '', date: today(), // compra o venta: hay que elegirlo sí o sí qty: '', price: '', fee: 0, note: '',
    currency: p0.type === 'cedear' ? 'ARS' : 'USD', // bonos y ONs: en dólares (MEP/cable)
    fx: state.ccl?.venta ? Math.round(state.ccl.venta * 100) / 100 : '',
    ratio: 1,
    ...tx,
  };
  if (!editing && t.ticker && p0.type === 'cedear') t.ratio = state.ratios[t.ticker] || t.ratio;
  // Bonos: se guarda el precio cada 100 VN; al editar se muestra así. Para cargar nuevos se recuerda la última escala usada.
  const bondUnit = editing ? '100' : prefGet('bondPriceUnit', '100');
  const mkt = {}; // precio de mercado de cada bono consultado mientras se escribe el ticker

  const body = `
    ${field('Cartera', portfolioSelect(pid))}
    ${field('Tipo', `<div class="seg"><button type="button" data-side="buy" class="${t.side === 'buy' ? 'on' : ''}">Compra</button><button type="button" data-side="sell" class="${t.side === 'sell' ? 'on' : ''}">Venta</button><button type="button" data-side="del">Borrar</button></div><input type="hidden" name="side" value="${t.side}">`)}
    ${field('Ticker', `<input name="ticker" list="tickers" required value="${esc(t.ticker || '')}" autocomplete="off" style="text-transform:uppercase">`, { hint: '<span id="ticker-hint">Para CEDEARs usá el ticker de NY (ej. DIS, no DISN)</span>' })}
    ${field('Fecha', `<input name="date" type="date" required value="${t.date}">`)}
    ${field('<span id="qty-label">Cantidad</span>', `<input name="qty" type="number" step="any" min="0" required value="${t.qty}">`, { hint: '<span id="qty-hint"></span>' })}
    ${field('<span id="price-label">Precio por unidad</span>', `<input name="price" type="number" step="any" min="0" required value="${t.price}">`, { hint: '<span id="mkt-hint"></span>' })}
    ${field('El precio que cargás es', `<select name="priceUnit"><option value="100" ${bondUnit === '100' ? 'selected' : ''}>Cada 100 VN (IOL, mercado)</option>
      <option value="1" ${bondUnit === '1' ? 'selected' : ''}>Por 1 VN (como lo muestra Balanz)</option></select>`, { id: 'f-unit' })}
    ${field('Moneda del precio', `<select name="currency"><option value="ARS" ${t.currency === 'ARS' ? 'selected' : ''}>Pesos (ARS)</option><option value="USD" ${t.currency === 'USD' ? 'selected' : ''}>Dólares (USD)</option></select>`)}
    ${field('Dólar CCL', `<input name="fx" type="number" step="any" min="0" value="${t.fx ?? ''}">`, { id: 'f-fx', hint: 'Fijo al momento de la operación' })}
    ${field('Ratio CEDEAR', `<input name="ratio" type="number" step="any" min="0" value="${t.ratio}">`, { id: 'f-ratio', hint: 'CEDEARs por acción' })}
    ${field('Comisión (USD)', `<input name="fee" type="number" step="any" min="0" value="${t.fee || 0}">`)}
    ${field('Nota', `<input name="note" value="${esc(t.note || '')}">`, { full: true })}
    <div class="preview" id="tx-preview"></div>
    <div class="warn" id="tx-warn"></div>
    <div class="field full" id="tx-del" style="display:none"></div>
    <datalist id="tickers">${Object.keys(state.ratios).map((k) => `<option value="${k}">`).join('')}</datalist>`;

  openModal(editing ? 'Editar operación' : 'Nueva operación', body, (d) => {
    if (d.side === 'del') { // "Borrar": se elige una operación ya cargada de la lista
      const del = state.db.transactions.find((x) => x.id === d.delId);
      if (!del) { $('#tx-warn').textContent = 'Elegí qué operación borrar.'; return false; }
      if (!confirm(`¿Borrar ${del.side === 'buy' ? 'la compra' : 'la venta'} de ${num(+del.qty, 8)} ${del.ticker} del ${fmtDate(del.date)}?`)) return false;
      state.db.transactions = state.db.transactions.filter((x) => x.id !== del.id);
      save(); toast('Operación borrada'); return;
    }
    const p = portfolio(d.portfolioId);
    const rec = {
      id: tx.id || uid(), portfolioId: d.portfolioId, side: d.side,
      ticker: d.ticker.trim().toUpperCase(), date: d.date,
      qty: +d.qty, price: +d.price, currency: d.currency,
      fx: d.currency === 'ARS' ? +d.fx : null,
      ratio: p.type === 'cedear' ? +d.ratio || 1 : p.type === 'bonds' ? BOND_BASE : 1,
      fee: +d.fee || 0, note: d.note.trim(),
    };
    if (p.type === 'bonds') {
      rec.priceBase = BOND_BASE; // se guarda el precio cada 100 VN
      if (d.priceUnit === '1') rec.price = +d.price * BOND_BASE;
      prefSet('bondPriceUnit', d.priceUnit);
    } else delete rec.priceBase;
    if (rec.side !== 'buy' && rec.side !== 'sell') { $('#tx-warn').textContent = 'Elegí si es Compra o Venta.'; return false; }
    if (rec.currency === 'ARS' && !rec.fx) { $('#tx-warn').textContent = 'Falta el dólar CCL para convertir el precio en pesos.'; return false; }
    if (editing) Object.assign(state.db.transactions.find((x) => x.id === tx.id), rec);
    else state.db.transactions.push(rec);
    save(); toast(editing ? 'Operación actualizada' : 'Operación guardada');
  }, (form) => {
    const d = Object.fromEntries(new FormData(form));
    const p = portfolio(d.portfolioId);
    const tk = d.ticker.trim().toUpperCase();
    // Modo "Borrar": se esconden los datos de la operación y se muestran las ya cargadas de esa cartera (filtradas por ticker)
    const del = d.side === 'del', extra = [...form.querySelectorAll('.modal-body > .field')].slice(3).filter((f) => f.id !== 'tx-del');
    for (const k of ['ticker', 'date', 'qty', 'price']) form[k].required = !del;
    form.querySelector('[type=submit]').textContent = del ? 'Borrar' : 'Guardar';
    form.querySelector('[type=submit]').classList.toggle('danger', del);
    $('#tx-del').style.display = del ? '' : 'none';
    $('#tx-preview').style.display = del ? 'none' : '';
    if (del) {
      extra.forEach((f) => (f.style.display = 'none'));
      $('#tx-warn').textContent = '';
      if (form.dataset.delKey === p.id + '|' + tk) return; // marcar una opción no rearma la lista (no salta el scroll)
      form.dataset.delKey = p.id + '|' + tk;
      const list = state.db.transactions.filter((x) => x.portfolioId === p.id && !x.externalId && (!tk || x.ticker.startsWith(tk)))
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
      const sel = d.delId || (editing ? tx.id : '');
      $('#tx-del').innerHTML = `<label>¿Cuál borrar? <span class="muted">(${list.length === 50 ? 'las 50 más recientes' : list.length}${tk ? ' de ' + esc(tk) : ''})</span></label>
        <div class="del-list">${list.length ? list.map((x) => `<label class="del-item"><input type="radio" name="delId" value="${x.id}" ${x.id === sel ? 'checked' : ''}>
          <span>${fmtDate(x.date)} · <span class="tag ${x.side}">${x.side === 'buy' ? 'Compra' : 'Venta'}</span> <b>${num(+x.qty, 8)} ${esc(x.ticker)}</b> a ${x.currency === 'ARS' ? ars(+x.price) : price(+x.price)}${x.note ? ` <span class="muted small">${esc(x.note)}</span>` : ''}</span></label>`).join('')
          : '<div class="empty">No hay operaciones cargadas a mano en esta cartera' + (tk ? ' para ' + esc(tk) : '') + '.</div>'}</div>
        <span class="hint">Escribí el ticker arriba para achicar la lista.</span>`;
      return;
    }
    delete form.dataset.delKey;
    extra.forEach((f) => (f.style.display = ''));
    const isCed = p.type === 'cedear', isBond = p.type === 'bonds';
    $('#f-ratio').style.display = isCed ? '' : 'none';
    $('#f-fx').style.display = d.currency === 'ARS' ? '' : 'none';
    $('#qty-label').textContent = isBond ? 'Valor nominal (VN)' : 'Cantidad';
    $('#price-label').textContent = isBond ? 'Precio' : 'Precio por unidad';
    $('#f-unit').style.display = isBond ? '' : 'none';
    const sugg = isBond ? (state.bondList ? 'bonds1' : 'bonds') : 'ratios';
    if ($('#tickers').dataset.kind !== sugg) {
      $('#tickers').dataset.kind = sugg;
      $('#tickers').innerHTML = (isBond ? state.bondList || [] : Object.keys(state.ratios)).map((k) => `<option value="${k}">`).join('');
    }
    // Autocompletar ratio al elegir ticker
    if (isCed && form.ticker === document.activeElement && state.ratios[tk]) form.ratio.value = state.ratios[tk];
    $('#ticker-hint').textContent = isCed ? (state.ratios[tk] ? `Ratio ${state.ratios[tk]}:1` : 'Para CEDEARs usá el ticker de NY (ej. DIS, no DISN)')
      : isBond ? 'Ej: AL30D, GD30D, MGCOD, IRCPD (los de pesos como IRCPO también sirven)' : p.type === 'crypto' ? 'Ej: BTC, ETH, SOL' : 'Ticker de NY';
    const ratio = isCed ? +d.ratio || 1 : 1;
    // Bonos: el precio se pasa a "cada 100 VN" según la escala elegida
    const px = isBond && d.priceUnit === '1' ? +d.price * BOND_BASE : +d.price;
    const unit = (d.currency === 'ARS' ? (+d.fx ? px / +d.fx : null) : px);
    const total = unit != null ? (unit * +d.qty) / (isBond ? BOND_BASE : 1) : null;
    const held = compute(p).positions.find((x) => x.ticker === tk)?.qty || 0;
    $('#qty-hint').textContent = held ? `Tenés ${qty(held, 8)}${isCed ? ' CEDEARs' : isBond ? ' VN' : ''}` : '';
    $('#tx-preview').innerHTML = `<span>${isBond ? 'USD cada 100 VN' : 'USD por unidad'} <b>${price(unit)}</b></span>${isCed ? `<span>Precio acción implícito <b>${price(unit != null ? unit * ratio : null)}</b></span>` : ''}<span>Total <b>${usd(total)}</b></span>`;
    let warn = !d.side ? 'Elegí si es Compra o Venta.' : d.side === 'sell' && +d.qty > held + 1e-9 && !editing ? `Estás vendiendo más de lo que tenés (${num(held, 8)}).` : '';
    // Bonos: precio de mercado de hoy como referencia, y aviso si el precio cargado parece estar en otra escala o moneda
    if (isBond && tk.length >= 3) {
      if (!(tk in mkt)) {
        mkt[tk] = null;
        api('/api/quotes?bonds=' + encodeURIComponent(tk)).then((r) => { mkt[tk] = r.bonds?.[tk] || false; form.dispatchEvent(new Event('input')); }).catch(() => { mkt[tk] = false; });
      }
      const m = mkt[tk];
      $('#mkt-hint').textContent = m ? `Mercado hoy: US$ ${num(m.price, 2)}${m.ars ? ` · $ ${num(m.ars, 2)}` : ''} cada 100 VN (${m.symbol})` : m === false ? 'Sin precio de mercado para este ticker' : 'Buscando precio de mercado…';
      const ref = m ? (d.currency === 'ARS' ? m.ars : m.price) : null;
      if (ref && px > 0) {
        const r = px / ref;
        if (r < 0.05) warn = `El precio parece estar por 1 VN (el mercado está en ${num(ref, 2)} cada 100). Elegí "Por 1 VN".`;
        else if (r > 20) warn = `El precio parece demasiado alto para "cada 100 VN" (mercado: ${num(ref, 2)}). ¿Es en pesos? Revisá la moneda.`;
      }
    } else if (isBond) $('#mkt-hint').textContent = '';
    $('#tx-warn').textContent = warn;
  });

  // Toggle compra/venta
  $('#mform').querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => {
    $('#mform').side.value = b.dataset.side;
    $('#mform').querySelectorAll('[data-side]').forEach((x) => x.classList.toggle('on', x === b));
    $('#mform').dispatchEvent(new Event('input'));
  }));
  // Cambiar de cartera ajusta la moneda por defecto
  // Bonos y ONs: sugerencias con todos los bonos y ONs que cotizan (se piden una sola vez)
  if (!state.bondList) api('/api/bonds/list').then((l) => { state.bondList = l; $('#mform')?.dispatchEvent(new Event('input')); }).catch(() => {});
  $('#mform').portfolioId.addEventListener('change', (e) => {
    if (!editing) $('#mform').currency.value = portfolio(e.target.value).type === 'cedear' ? 'ARS' : 'USD';
    $('#mform').dispatchEvent(new Event('input'));
  });
}

function simpleForm(kind, rec = {}) {
  const isDiv = kind === 'div';
  const pid = rec.portfolioId || route().id || state.db.portfolios[0]?.id;
  if (!pid) return toast('Primero creá una cartera en Ajustes');
  const editing = !!rec.id;
  const body = `
    ${field('Cartera', portfolioSelect(pid, !isDiv))}
    ${field('Fecha', `<input name="date" type="date" required value="${rec.date || today()}">`)}
    ${isDiv ? field('Ticker', `<input name="ticker" required value="${esc(rec.ticker || '')}" style="text-transform:uppercase">`) : ''}
    ${field('Monto (USD)', `<input name="amount" type="number" step="any" required value="${rec.amount ?? ''}">`, { hint: isDiv ? 'Neto de retenciones' : 'Negativo si es un retiro. En carteras de Acciones, solo el efectivo sin invertir (lo invertido ya se suma solo)' })}
    ${field('Nota', `<input name="note" value="${esc(rec.note || '')}">`, { full: true })}`;
  const list = isDiv ? state.db.dividends : state.db.deposits;
  const bond = portfolio(pid)?.type === 'bonds'; // en bonos y ONs el "dividendo" es renta (cupón o amortización)
  openModal(isDiv && bond ? (editing ? 'Editar renta' : 'Nueva renta (cupón o amortización)') : (editing ? 'Editar ' : 'Nuevo ') + (isDiv ? 'dividendo' : 'aporte'), body, (d) => {
    const r = { id: rec.id || uid(), portfolioId: d.portfolioId, date: d.date, amount: +d.amount, note: d.note.trim() };
    if (isDiv) r.ticker = d.ticker.trim().toUpperCase();
    if (editing) Object.assign(list.find((x) => x.id === rec.id), r); else list.push(r);
    save(); toast('Guardado');
  });
}

