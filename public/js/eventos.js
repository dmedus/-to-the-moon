'use strict';
// ================= Eventos =================
document.addEventListener('click', (e) => {
  const bb = e.target.closest('[data-bala-basis]');
  if (bb) {
    ((state.db.settings ||= {}).balas ||= { capital: {}, assign: {} }).basis = bb.dataset.balaBasis;
    save(); // para el invitado no guarda: el cambio queda solo en su pantalla
    return render();
  }
  const s = e.target.closest('[data-sort]');
  if (s) {
    const [tid, key] = s.dataset.sort.split(':');
    const cur = state.sort[tid];
    state.sort[tid] = { key, dir: cur?.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
    return render();
  }
  const a = e.target.closest('[data-action]');
  if (!a || a.tagName === 'INPUT') return;
  const { action, id, pid } = a.dataset;
  const db = state.db;
  // El invitado solo puede mirar (el servidor igual rechaza cualquier cambio suyo)
  if (!isOwner() && !['alloc-mode', 'ver-regla', 'watch-sel', 'watch-range', 'watch-hrange', 'watch-mode', 'watch-unsort', 'pos-unsort', 'watch-ma', 'watch-tab', 'hist-range'].includes(action)) return; // el invitado solo mira
  switch (action) {
    case 'new-tx': return txForm({ portfolioId: pid, ticker: a.dataset.ticker, side: a.dataset.side });
    case 'edit-tx': return txForm({ ...db.transactions.find((t) => t.id === id) });
    case 'del-tx':
      if (!confirm('¿Borrar esta operación?')) return;
      db.transactions = db.transactions.filter((t) => t.id !== id); save(); return render();
    case 'new-div': return simpleForm('div', { portfolioId: pid });
    case 'edit-target': return targetForm(a.dataset.ticker);
    case 'edit-div': return simpleForm('div', db.dividends.find((t) => t.id === id));
    case 'del-div':
      if (!confirm('¿Borrar este dividendo?')) return;
      db.dividends = db.dividends.filter((t) => t.id !== id); save(); return render();
    case 'sync-pionex':
    case 'alloc-mode':
      state.allocMode[pid] = a.dataset.mode; return render();
    case 'ver-regla': return showRegla(+a.dataset.i);
    case 'sync-pionex': return syncNow('pionex');
    case 'sync-bingx': return syncNow('bingx');
    case 'sync-bitget': return syncNow('bitget');
    case 'sync-binance': return syncNow('binance');
    case 'check-pionex':
    case 'check-bingx':
    case 'check-bitget': {
      const ex = action.slice('check-'.length);
      return loadSyncStatus().then(() => {
        if (!state[ex].configured) return toast(`No encuentro app\\data\\${ex}.env con las claves`);
        toast('Conectando…');
        return syncNow(ex);
      });
    }
    case 'change-password': return passwordForm();
    case 'guest-on': return guestForm();
    case 'guest-off':
      if (!confirm('¿Desactivar el usuario invitado? Se cierran sus sesiones abiertas.')) return;
      return api('/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
        .then(() => { state.auth.guestEnabled = false; toast('Invitado desactivado'); render(); }).catch((err) => toast(err.message));
    case 'logout-all':
      return api('/api/auth/logout-all', { method: 'POST' }).then(() => toast('Se cerraron las demás sesiones')).catch((err) => toast(err.message));
    case 'edit-bot': return botForm({ ...db.bots.find((b) => b.id === id) });
    case 'del-bot':
      if (!confirm('¿Borrar este bot?')) return;
      db.bots = db.bots.filter((b) => b.id !== id); save(); $('#modal').close(); return render();
    case 'new-aporte': return simpleForm('aporte', { portfolioId: pid });
    case 'edit-aporte': return simpleForm('aporte', db.deposits.find((t) => t.id === id));
    case 'del-aporte':
      if (!confirm('¿Borrar este aporte?')) return;
      db.deposits = db.deposits.filter((t) => t.id !== id); save(); return render();
    case 'add-portfolio': {
      const used = new Set(db.portfolios.map((p) => p.slot));
      let slot = 1; while (used.has(slot) && slot < 8) slot++;
      db.portfolios.push({ id: uid(), name: 'Nueva cartera', type: 'stock', broker: '', slot });
      save(); return render();
    }
    case 'del-portfolio': {
      const n = db.transactions.filter((t) => t.portfolioId === id).length + db.bots.filter((b) => b.portfolioId === id).length;
      if (!confirm(n ? `Esta cartera tiene ${n} operaciones/bots que también se borrarán. ¿Continuar?` : '¿Borrar esta cartera?')) return;
      db.bots = db.bots.filter((b) => b.portfolioId !== id);
      db.futures = (db.futures || []).filter((f) => f.portfolioId !== id);
      if (db.futuresAccounts) delete db.futuresAccounts[id];
      db.portfolios = db.portfolios.filter((p) => p.id !== id);
      db.transactions = db.transactions.filter((t) => t.portfolioId !== id);
      db.dividends = db.dividends.filter((t) => t.portfolioId !== id);
      db.deposits = db.deposits.filter((t) => t.portfolioId !== id);
      save(); return render();
    }
    case 'del-manual':
      delete db.manualPrices[a.dataset.key]; save(); return render();
    case 'export': return download(`mis-carteras-${today()}.json`, JSON.stringify(db, null, 2), 'application/json');
    case 'export-csv': {
      const head = ['fecha', 'cartera', 'tipo', 'ticker', 'cantidad', 'precio', 'moneda', 'ccl', 'ratio', 'usd_unidad', 'total_usd', 'comision', 'nota'];
      const lines = db.transactions.map((t) => [t.date, portfolio(t.portfolioId)?.name, t.side === 'buy' ? 'compra' : 'venta', t.ticker, t.qty, t.price, t.currency, t.fx ?? '', t.ratio, unitUSD(t), unitUSD(t) * t.qty, t.fee, t.note]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'));
      return download(`operaciones-${today()}.csv`, '﻿' + [head.join(';'), ...lines].join('\n'), 'text/csv');
    }
    // --- Cotizaciones ---
    case 'watch-sel':
      if (Date.now() - watchDrag.ended < 400) return; // el clic que sigue a soltar un arrastre no abre el gráfico
      watch.sel = watch.sel === a.dataset.key ? null : a.dataset.key; // tocar de nuevo lo cierra
      watch.hover = null; watch.hover1h = null; watch.tool = null; watch.pending = null;
      render();
      if (watch.sel) { window.scrollTo({ top: 0, behavior: 'smooth' }); loadChart(); }
      return;
    case 'watch-range':
      watch.hover = null;
      if (watch.mode === 'velas') { watch.crange = a.dataset.range; return render(); } // ya están los 2 años de velas
      watch.range = a.dataset.range; render(); return loadChart();
    case 'draw-tool': // elegir de nuevo la misma herramienta la suelta
      watch.tool = a.dataset.tool && watch.tool !== a.dataset.tool ? a.dataset.tool : null; watch.pending = null;
      $('#bigchart').innerHTML = bigChart(); return;
    case 'draw-del':
      setDrawings(drawingsOf().filter((_, i) => i !== +a.dataset.i)); $('#bigchart').innerHTML = bigChart(); return;
    case 'draw-clear':
      if (!confirm('¿Borrar todos los dibujos de este gráfico?')) return;
      setDrawings([]); $('#bigchart').innerHTML = bigChart(); return;
    case 'watch-hrange': // período del gráfico de 1 hora: ya están las velas, no se vuelven a pedir
      watch.hrange = a.dataset.range; watch.hover1h = null; prefSet('watchHRange', watch.hrange); return render();
    case 'watch-ma': {
      const ma = a.dataset.id;
      if (watch.mas.has(ma)) watch.mas.delete(ma); else watch.mas.add(ma);
      prefSet('watchMAs', [...watch.mas]);
      const box = $('#bigchart'); if (box) box.innerHTML = bigChart();
      return;
    }
    case 'watch-tab':
      watch.tab = a.dataset.tab; prefSet('watchTab', watch.tab); return render();
    case 'watch-mode':
      if (watch.mode === a.dataset.mode) return;
      watch.mode = a.dataset.mode; watch.hover = null; watch.hover1h = null; render(); return loadChart();
    case 'pos-unsort':
      delete state.sort[a.dataset.tid]; return render();
    case 'watch-unsort':
      delete state.sort.watchS; delete state.sort.watchC; delete state.sort.watchF; return render();
    case 'watch-swap': {
      const key = a.dataset.key, toFollow = a.dataset.list !== 'F';
      setWatch('watchlist', toFollow ? watchList().filter((k) => k !== key) : [...watchList(), key]);
      setWatch('watchFollow', toFollow ? [...followList(), key] : followList().filter((k) => k !== key));
      toast(`${key.split(':')[1]} pasó a ${toFollow ? 'Seguidas' : key.startsWith('C:') ? 'Cripto' : 'Acciones'}`);
      return render();
    }
    case 'watch-del': {
      const S = SECTIONS[a.dataset.list];
      setWatch(S.set, S.list().filter((k) => k !== a.dataset.key));
      return render();
    }
    case 'bond-info': return bondInfoForm(a.dataset.ticker);
    // --- Copia de seguridad ---
    case 'bk-run':
      backupUI.running = true; render();
      return postJson('/api/backup/run', {})
        .then((r) => toast(`✓ Copia guardada en ${r.last.where.join(' y ')}`)).catch((err) => toast('No se pudo: ' + err.message))
        .finally(() => { backupUI.running = false; loadBackup(); });
    // --- Alertas por Telegram ---
    case 'tg-link':
      return postJson('/api/alerts/link', {}).then((r) => { alertsUI.link = r; render(); waitForLink(); }).catch((err) => toast(err.message));
    case 'tg-test':
      return postJson('/api/alerts/test', {}).then(() => toast('Mensaje de prueba enviado')).catch((err) => toast(err.message));
    case 'tg-unlink':
      if (!confirm('¿Desconectar tu Telegram? No te van a llegar más alertas.')) return;
      return postJson('/api/alerts/unlink', {}).then(loadAlerts).catch((err) => toast(err.message));
    case 'tg-bot-del':
      if (!confirm('¿Quitar el bot? Nadie va a recibir alertas hasta que configures otro.')) return;
      return postJson('/api/alerts/bot/delete', {}).then(loadAlerts).catch((err) => toast(err.message));
    case 'tg-target-del':
      return postJson('/api/alerts/targets/delete', { id }).then(loadAlerts).catch((err) => toast(err.message));
    case 'watch-alert': {
      const [kind, sym] = a.dataset.key.split(':');
      return priceAlertForm(kind, sym, watch.data[a.dataset.key]?.price);
    }
    case 'hist-range':
      hist.range = a.dataset.range; hist.hover = null; prefSet('histRange', hist.range); return render();
    case 'install-app':
      if (!installEvt) return toast('El navegador todavía no permite instalarla: seguí los pasos de la tarjeta');
      installEvt.prompt();
      return installEvt.userChoice.then((c) => { if (c.outcome === 'accepted') installEvt = null; render(); });
    case 'keys-replace': {
      const box = document.querySelector(`.keys-replace[data-ex="${a.dataset.ex}"]`);
      if (box) box.hidden = !box.hidden;
      return;
    }
    case 'keys-del':
      if (!confirm(`¿Desconectar ${EXCHANGE_NAMES[a.dataset.ex]}? Se borran las claves guardadas; tus datos ya sincronizados quedan.`)) return;
      return postJson(`/api/keys/${a.dataset.ex}/delete`, {})
        .then(() => loadSyncStatus()).then(() => { toast(EXCHANGE_NAMES[a.dataset.ex] + ' desconectado'); render(); })
        .catch((err) => toast(err.message));
    // --- Usuarios (solo el administrador) ---
    case 'member-toggle': {
      const m = (state.members || []).find((x) => x.id === id);
      if (!m) return;
      if (m.active && !confirm(`¿Desactivar a ${m.username}? No va a poder entrar ni se sincronizan sus exchanges hasta que lo actives.`)) return;
      return postJson('/api/auth/members/update', { id, active: !m.active }).then(reloadMembers).catch((err) => toast(err.message));
    }
    case 'member-pass':
      return openModal('Nueva contraseña para ' + esc(id), `
        ${field('Contraseña', '<input name="password" type="password" autocomplete="new-password" minlength="8" required>', { hint: 'Mínimo 8 caracteres. Se cierran sus sesiones abiertas.', full: true })}
        <div class="warn" id="mp-err"></div>`, async (d) => {
        try { await postJson('/api/auth/members/update', { id, password: d.password }); toast('Contraseña cambiada'); }
        catch (err) { $('#mp-err').textContent = err.message; return false; }
      });
    case 'member-del':
      if (!confirm(`¿Borrar el usuario ${id}? Se borran su cuenta y sus claves de exchanges. Sus carteras quedan guardadas en data\\users\\${id} por si te arrepentís.`)) return;
      return postJson('/api/auth/members/delete', { id }).then(() => { toast('Usuario borrado'); return reloadMembers(); }).catch((err) => toast(err.message));
  }
});

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const l = document.createElement('a'); l.href = url; l.download = name; l.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.histPid != null) { hist.pid = el.value; hist.hover = null; return render(); } // Evolución: elegir cartera
  if (el.dataset.bkOpt) { // Copia de seguridad: destinos
    return postJson('/api/backup/options', { [el.dataset.bkOpt]: el.checked }).then(loadBackup).catch((err) => toast(err.message));
  }
  if (el.dataset.tabToggle && isOwner()) {
    const s = (state.db.settings ||= {});
    const set = new Set(s.hiddenTabs || []);
    if (el.checked) set.delete(el.dataset.tabToggle); else set.add(el.dataset.tabToggle);
    s.hiddenTabs = [...set];
    save();
    return renderNav();
  }
  if ((el.dataset.balaCap || el.dataset.balaAssign) && isOwner()) {
    const b = ((state.db.settings ||= {}).balas ||= { basis: 'margin', capital: {}, assign: {} });
    b.capital ||= {}; b.assign ||= {};
    if (el.dataset.balaCap) {
      const v = +el.value;
      if (v > 0) b.capital[el.dataset.balaCap] = v; else delete b.capital[el.dataset.balaCap];
    } else b.assign[el.dataset.balaAssign] = el.value;
    save();
    return render();
  }
  if (el.dataset.action === 'import' && el.files[0]) {
    try {
      const data = JSON.parse(await el.files[0].text());
      if (!Array.isArray(data.portfolios) || !Array.isArray(data.transactions)) throw new Error('archivo inválido');
      if (!confirm('Esto reemplaza todos tus datos actuales por los del backup. ¿Continuar?')) return;
      state.db = { dividends: [], deposits: [], bots: [], manualPrices: {}, ...data };
      await save(); toast('Backup restaurado'); render(); refreshQuotes();
    } catch (err) { toast('No se pudo restaurar: ' + err.message); }
  }
  if (el.dataset.pfield) {
    const p = portfolio(el.closest('[data-pid]').dataset.pid);
    p[el.dataset.pfield] = el.value;
    save(); renderNav();
    if (el.dataset.pfield === 'type') refreshQuotes();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'watch-q') { watch.q = e.target.value; return applyWatchFilter(); } // buscador de Cotizaciones
  const f = e.target.dataset.filter;
  if (!f) return;
  state.filters.ops[f] = e.target.value;
  const pos = e.target.selectionStart;
  render();
  const again = document.querySelector(`[data-filter="${f}"]`);
  if (again && f === 'q') { again.focus(); again.setSelectionRange(pos, pos); }
});

document.addEventListener('submit', (e) => {
  if (e.target.dataset.form !== 'manual') return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  state.db.manualPrices ||= {};
  state.db.manualPrices[d.kind + ':' + d.ticker.trim().toUpperCase()] = +d.price;
  save(); render();
});

// Agregar un símbolo a Cotizaciones
document.addEventListener('submit', (e) => {
  if (e.target.dataset.form !== 'watch-add') return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  let sym = d.sym.trim().toUpperCase().replace(/\s+/g, '');
  let kind = d.kind;
  // "BTCUSDT" o "BTC-USD" escrito como acción: es cripto
  if (kind === 'S' && /^[A-Z0-9]{2,10}(USDT|-USD)$/.test(sym)) kind = 'C';
  if (kind === 'C') sym = sym.replace(/[-/]?(USDT|USDC|USD)$/, '');
  if (!/^[A-Z0-9.^=-]{1,15}$/.test(sym)) return toast('Símbolo inválido');
  const key = kind + ':' + sym;
  if (followList().includes(key)) return toast(sym + ' ya está en Seguidas');
  if (watchList().includes(key)) return toast(`${sym} ya está en ${kind === 'C' ? 'Cripto' : 'Acciones'}`);
  const S = SECTIONS[e.target.dataset.list === 'F' ? 'F' : kind];
  setWatch(S.set, [...S.list(), key]);
  e.target.reset();
  refreshWatch().then(() => { if (watch.data[key]?.error) toast(`${sym}: ${watch.data[key].error}`); });
});

// Tablas que se ordenan arrastrando (Cartera, Por par). El orden se guarda en la cartera: p.rowOrders[tabla].
const rowOrderOf = (p, T) => p.rowOrders?.[T] || (T === 'pos-' + p.id ? p.rowOrder : null); // p.rowOrder: versión anterior, solo Cartera
// Sin una columna elegida se usa el orden que armaste arrastrando; lo que no está en él va al final, en el orden que traía
function myOrderRows(p, T, rows, keyOf) {
  const order = !state.sort[T] && rowOrderOf(p, T);
  if (!order?.length) return rows;
  const at = new Map(order.map((k, i) => [k, i]));
  return rows.map((r, i) => [r, at.has(keyOf(r)) ? at.get(keyOf(r)) : order.length + i]).sort((a, b) => a[1] - b[1]).map(([r]) => r);
}
const myOrderBtn = (p, T) => (state.sort[T] && rowOrderOf(p, T)?.length ? ` <button class="btn sm" data-action="pos-unsort" data-tid="${T}" style="margin-left:8px">Mi orden</button>` : '');
const grip = () => (isOwner() ? '<span class="grip" title="Arrastrar para ordenar" aria-hidden="true">⠿</span> ' : '');

// Arrastrar filas para ordenarlas, igual que en Cotizaciones.
// Mouse: se agarra la fila entera. Táctil: desde el agarre ⠿, así deslizar la página sigue funcionando normal.
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest?.('tbody[data-reorder] > tr[data-key]');
  if (!row || !isOwner() || e.target.closest('button, a, input, select')) return;
  if (e.pointerType === 'mouse' ? e.button !== 0 : !e.target.closest('.grip')) return;
  Object.assign(rowDrag, { row, box: row.parentElement, startY: e.clientY, active: false, pending: false });
  if (e.pointerType !== 'mouse') startRowDrag();
});
function startRowDrag() {
  const d = rowDrag;
  if (state.sort[d.box.dataset.tid]) { toast('Para arrastrar, volvé a tu orden con "Mi orden"'); d.row = null; return; }
  d.active = true;
  d.row.classList.add('dragging');
  document.body.classList.add('drag-on');
}
document.addEventListener('pointermove', (e) => {
  const d = rowDrag;
  if (!d.row) return;
  if (!d.active) { if (Math.abs(e.clientY - d.startY) < 6) return; startRowDrag(); if (!d.active) return; } // un clic no es un arrastre
  e.preventDefault();
  // La fila va antes de la primera cuyo centro queda debajo del puntero; si no hay ninguna, después de la última (el efectivo queda al final)
  const others = [...d.box.querySelectorAll(':scope > tr[data-key]')].filter((r) => r !== d.row);
  const next = others.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
  if (next) { if (d.row.nextElementSibling !== next) d.box.insertBefore(d.row, next); }
  else if (others.length && others.at(-1).nextElementSibling !== d.row) others.at(-1).after(d.row);
});
function endRowDrag() {
  const d = rowDrag;
  if (!d.row) return;
  const was = d.active;
  d.row.classList.remove('dragging');
  document.body.classList.remove('drag-on');
  if (was) {
    d.ended = Date.now();
    const p = portfolio(d.box.dataset.reorder);
    const order = [...d.box.querySelectorAll(':scope > tr[data-key]')].map((r) => r.dataset.key);
    const T = d.box.dataset.tid;
    if (p && JSON.stringify(order) !== JSON.stringify(rowOrderOf(p, T) || [])) { (p.rowOrders ||= {})[T] = order; delete p.rowOrder; save(); }
  }
  Object.assign(d, { row: null, box: null, active: false, pending: false });
  if (was) render();
}
document.addEventListener('pointerup', endRowDrag);
document.addEventListener('pointercancel', endRowDrag);

// Cotizaciones: arrastrar filas para ordenarlas, como en TradingView.
// Mouse: se agarra la fila entera. Táctil: desde el agarre ⠿, así deslizar la lista sigue funcionando normal.
const watchDrag = { row: null, box: null, active: false, startY: 0, ended: 0 };
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest?.('.watch-rows .watch-row');
  if (!row || !isOwner() || e.target.closest('button')) return;
  if (watch.q) { if (e.pointerType !== 'mouse' || e.target.closest('.grip')) toast('Para ordenar, borrá la búsqueda'); return; } // con filas ocultas el orden sería confuso
  if (e.pointerType === 'mouse' ? e.button !== 0 : !e.target.closest('.grip')) return;
  Object.assign(watchDrag, { row, box: row.parentElement, startY: e.clientY, active: false });
  if (e.pointerType !== 'mouse') startWatchDrag(); // desde el agarre arranca enseguida
});
function startWatchDrag() {
  const d = watchDrag;
  if (state.sort['watch' + d.box.dataset.list]) { toast('Para arrastrar, volvé a tu orden con "Mi orden"'); d.row = null; return; }
  d.active = true;
  d.row.classList.add('dragging');
  document.body.classList.add('drag-on');
}
document.addEventListener('pointermove', (e) => {
  const d = watchDrag;
  if (!d.row) return;
  if (!d.active) { if (Math.abs(e.clientY - d.startY) < 6) return; startWatchDrag(); if (!d.active) return; } // un clic no es un arrastre
  e.preventDefault();
  // La fila va antes de la primera cuyo centro queda debajo del puntero; si no hay ninguna, al final
  const others = [...d.box.querySelectorAll('.watch-row')].filter((r) => r !== d.row);
  const next = others.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
  if (next) { if (d.row.nextElementSibling !== next) d.box.insertBefore(d.row, next); }
  else if (d.box.lastElementChild !== d.row) d.box.appendChild(d.row);
});
function endWatchDrag() {
  const d = watchDrag;
  if (!d.row) return;
  const was = d.active;
  d.row.classList.remove('dragging');
  document.body.classList.remove('drag-on');
  if (was) {
    d.ended = Date.now();
    // Nuevo orden de esta sección; las de la otra sección (en la misma lista guardada) quedan donde estaban
    const S = SECTIONS[d.box.dataset.list], cur = S.list();
    const order = [...d.box.querySelectorAll('.watch-row')].map((r) => r.dataset.key);
    let j = 0;
    const full = cur.map((k) => (S.has(k) ? order[j++] : k));
    if (full.some((k, i) => k !== cur[i])) setWatch(S.set, full);
  }
  Object.assign(d, { row: null, box: null, active: false });
  if (was) render();
}
document.addEventListener('pointerup', endWatchDrag);
document.addEventListener('pointercancel', endWatchDrag);

// Gráfico de Cotizaciones: al pasar el mouse (o el dedo) muestra precio y fecha de ese punto
function chartHover(e) {
  const svg = e.target.closest?.('[data-chart]');
  if (!svg || drawDrag.d || editingDraw()) return; // arrastrando un dibujo o escribiendo un precio: el puntero no cambia de vela
  const pt = e.touches ? e.touches[0] : e;
  const r = svg.getBoundingClientRect(), n = +svg.dataset.chart, f = (pt.clientX - r.left) / r.width;
  // Velas: cada una ocupa una franja; línea: el punto más cercano
  const i = Math.max(0, Math.min(n - 1, svg.dataset.mode === 'candles' ? Math.floor(f * n) : Math.round(f * (n - 1))));
  const prop = svg.dataset.tf === '1h' ? 'hover1h' : 'hover'; // cada gráfico de velas tiene su propio puntero
  if (i === watch[prop]) return;
  watch[prop] = i;
  $('#bigchart').innerHTML = bigChart();
}
document.addEventListener('mousemove', chartHover);
// Evolución: valor e invertido del día bajo el puntero
function histHover(e) {
  const svg = e.target.closest?.('[data-hchart]');
  if (!svg) { if (hist.hover != null && e.type === 'mousemove') { hist.hover = null; const b = $('#histchart'); if (b) b.innerHTML = histChart(); } return; }
  const pt = e.touches ? e.touches[0] : e, r = svg.getBoundingClientRect(), n = +svg.dataset.hchart;
  const i = Math.max(0, Math.min(n - 1, Math.round(((pt.clientX - r.left) / r.width) * (n - 1))));
  if (i === hist.hover) return;
  hist.hover = i;
  $('#histchart').innerHTML = histChart();
}
document.addEventListener('mousemove', histHover);
document.addEventListener('touchmove', histHover, { passive: true });
document.addEventListener('touchmove', chartHover, { passive: true });
document.addEventListener('mouseout', (e) => {
  if ((watch.hover == null && watch.hover1h == null) || editingDraw() || !e.target.closest?.('[data-chart]') || e.relatedTarget?.closest?.('[data-chart]')) return;
  watch.hover = null; watch.hover1h = null;
  const box = $('#bigchart'); if (box) box.innerHTML = bigChart();
});

// Alertas por Telegram: token del bot, reglas y precios objetivo
document.addEventListener('submit', async (e) => {
  const f = e.target, kind = f.dataset.form;
  if (!['tg-bot', 'tg-rules', 'tg-target', 'bk-password'].includes(kind)) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('button[type="submit"]');
  if (kind === 'bk-password') {
    if (d.password !== d.password2) return toast('Las contraseñas no coinciden');
    btn.disabled = true;
    try {
      await postJson('/api/backup/password', { password: d.password });
      toast('Contraseña guardada. Haciendo la primera copia…');
      await postJson('/api/backup/run', {}).then((r) => toast(`✓ Copia guardada en ${r.last.where.join(' y ')}`)).catch((err) => toast('Copia: ' + err.message));
    } catch (err) { toast(err.message); btn.disabled = false; }
    return loadBackup();
  }
  btn.disabled = true;
  try {
    if (kind === 'tg-bot') { const r = await postJson('/api/alerts/bot', { token: d.token }); toast(`✓ Bot @${r.username} activado`); }
    if (kind === 'tg-rules') { await postJson('/api/alerts/rules', { roe: d.roe, liqPct: d.liqPct, fundingDayPct: d.fundingDayPct, exdiv: !!d.exdiv, coupons: !!d.coupons }); toast('Alertas guardadas'); }
    if (kind === 'tg-target') { await postJson('/api/alerts/targets', { ...d, price: +d.price }); toast('🔔 Alerta creada'); }
    await loadAlerts();
  } catch (err) { toast(err.message); btn.disabled = false; }
});

// Claves de exchanges y alta de usuarios (Ajustes)
document.addEventListener('submit', async (e) => {
  const f = e.target, kind = f.dataset.form;
  if (kind !== 'keys' && kind !== 'member-add') return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('button[type="submit"]'), label = btn.textContent;
  btn.disabled = true;
  try {
    if (kind === 'keys') {
      const ex = f.dataset.ex;
      btn.textContent = 'Probando…';
      await postJson('/api/keys/' + ex, d);
      f.reset();
      await loadSyncStatus(); await reloadDb();
      toast(`✓ ${EXCHANGE_NAMES[ex]} conectado`);
      render();
    } else {
      await postJson('/api/auth/members', d);
      toast(`Usuario ${d.username} creado`);
      await reloadMembers();
    }
  } catch (err) {
    toast(err.message);
    btn.disabled = false; btn.textContent = label;
  }
});

// Resaltado de la torta: al pasar por una porción o su fila de la leyenda, se atenúa el resto
document.addEventListener('mouseover', (e) => {
  const s = e.target.closest?.('[data-slice]');
  const wrap = e.target.closest?.('.donut-wrap');
  document.querySelectorAll('.donut-wrap.hovering').forEach((w) => {
    if (w !== wrap || !s) { w.classList.remove('hovering'); w.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl')); }
  });
  if (!s || !wrap) return;
  wrap.classList.add('hovering');
  wrap.querySelectorAll('[data-slice]').forEach((x) => x.classList.toggle('hl', x.dataset.slice === s.dataset.slice));
});

// Tooltip para gráficos
const tip = $('#tooltip');
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});

// Tema
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('theme')); } catch {}
$('#btn-theme').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch {}
};
$('#btn-refresh').onclick = refreshQuotes;
$('#btn-hide').onclick = () => {
  state.hide = !state.hide;
  try { localStorage.setItem('hideAmounts', state.hide ? '1' : '0'); } catch {}
  renderTop(); render();
};
$('#btn-logout').onclick = async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  location.replace('/login.html');
};
window.addEventListener('hashchange', render);

// ================= Inicio =================
(async function init() {
  try {
    const st = await (await fetch('/api/auth/state')).json();
    if (!st.role) { location.replace(st.ready ? '/login.html' : '/setup.html'); return; }
    state.role = st.role;
    state.auth = { totp: st.totp, guestEnabled: st.guestEnabled, user: st.user };
    // El invitado siempre ve los montos ocultos; el dueño y los amigos eligen (se recuerda en este navegador)
    try { state.hide = !isOwner() || localStorage.getItem('hideAmounts') === '1'; } catch { state.hide = !isOwner(); }
    document.body.classList.toggle('guest', !isOwner());
    [state.db, state.ratios, state.reglas] = await Promise.all([api('/api/db'), api('/api/ratios'), api('/api/reglas').catch(() => [])]);
    await loadSyncStatus();
    if (isAdmin()) state.members = await api('/api/auth/members').catch(() => []);
  } catch (e) {
    $('#view').innerHTML = `<div class="card empty">No se pudo conectar con el servidor (${esc(e.message)}). ¿Está prendida la PC con la app?</div>`;
    return;
  }
  renderTop();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  state.db.manualPrices ||= {};
  state.db.dividends ||= [];
  state.db.deposits ||= [];
  state.db.bots ||= [];
  state.db.futures ||= [];
  render();
  await refreshQuotes();
  setInterval(refreshQuotes, 3 * 60 * 1000);
})();
