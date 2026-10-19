'use strict';
// ================= Instalar como app (celular o PC) =================
// Chrome avisa con "beforeinstallprompt" cuando se puede instalar: se guarda ese aviso para abrirlo desde el botón de Ajustes.
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (route().name === 'ajustes') render(); });
window.addEventListener('appinstalled', () => { installEvt = null; toast('✓ To the Moon quedó instalada'); if (route().name === 'ajustes') render(); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function installCard() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  let body;
  if (isStandalone()) body = '<p style="margin:0">✓ Estás usando To the Moon instalada como app.</p>';
  else if (installEvt) body = `<p class="muted small" style="margin-top:0">Queda con el ícono del cohete en tu ${android ? 'celular' : 'escritorio'} y se abre a pantalla completa, sin el navegador.</p>
    <button class="btn primary" data-action="install-app">🚀 Instalar To the Moon</button>`;
  else if (ios) body = `<ol class="small" style="margin:0;padding-left:18px;line-height:1.8">
      <li>Abrí esta página en <b>Safari</b> (en otros navegadores de iPhone no se puede).</li>
      <li>Tocá <b>Compartir</b> (el cuadrado con la flecha hacia arriba).</li>
      <li>Elegí <b>"Agregar a pantalla de inicio"</b> y después <b>Agregar</b>.</li></ol>`;
  else body = `<p class="muted small" style="margin-top:0">${android
      ? 'El navegador todavía no ofreció instalarla. Probá así:'
      : 'Para tenerla en el celular, abrí esta misma dirección en Chrome (Android) o Safari (iPhone) y volvé a esta pantalla. En la PC:'}</p>
    <ol class="small" style="margin:0;padding-left:18px;line-height:1.8">
      ${android ? `<li>Usá <b>Chrome</b> (en Samsung Internet u otros, la opción tiene otro nombre).</li>
      <li>Tocá el menú <b>⋮</b> y elegí <b>"Instalar app"</b> o <b>"Agregar a la pantalla principal"</b>.</li>
      <li>Si no aparece, recargá la página, esperá unos segundos y volvé a Ajustes: puede aparecer el botón para instalarla.</li>`
      : `<li>En Chrome o Edge, tocá el ícono de instalar (un monitor con una flecha) a la derecha de la barra de direcciones.</li>`}
    </ol>`;
  return `<div class="card section">
    <h2>Instalar en el celular</h2>
    ${body}
    <p class="muted small" style="margin:10px 0 0">Dirección para abrirla: <code>${esc(location.origin)}</code> · Tu PC tiene que estar prendida para que funcione.</p>
  </div>`;
}

// ================= Alertas por Telegram =================
const alertsUI = { data: null, loading: false, link: null, pollTimer: null };
async function loadAlerts() {
  if (alertsUI.loading) return;
  alertsUI.loading = true;
  try { alertsUI.data = await api('/api/alerts'); } catch { alertsUI.data = alertsUI.data || null; }
  finally { alertsUI.loading = false; }
  if (route().name === 'ajustes') render();
}
// Después de abrir el link de Telegram, se consulta cada pocos segundos hasta que el bot reciba el "Iniciar"
function waitForLink() {
  clearInterval(alertsUI.pollTimer);
  let tries = 0;
  alertsUI.pollTimer = setInterval(async () => {
    tries++;
    try {
      const s = await api('/api/alerts/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (s.linked) { clearInterval(alertsUI.pollTimer); alertsUI.data = s; alertsUI.link = null; toast('✓ Telegram conectado'); if (route().name === 'ajustes') render(); }
    } catch { /* se reintenta */ }
    if (tries > 45) { clearInterval(alertsUI.pollTimer); alertsUI.link = null; if (route().name === 'ajustes') render(); }
  }, 4000);
}

function alertsCard() {
  if (!alertsUI.data) { loadAlerts(); return '<div class="card section"><h2>Alertas por Telegram</h2><div class="muted small">Cargando…</div></div>'; }
  const s = alertsUI.data, r = s.rules;
  let body;
  if (!s.bot) {
    body = s.canSetBot ? `<p class="muted small" style="margin-top:0">Para activar las alertas, creá un bot de Telegram (es gratis y lleva 2 minutos):</p>
      <ol class="small" style="margin:0 0 10px;padding-left:18px;line-height:1.8">
        <li>En Telegram, buscá <b>@BotFather</b> y mandale <code>/newbot</code>.</li>
        <li>Elegí un nombre (ej. <i>To the Moon</i>) y un usuario que termine en <i>bot</i> (ej. <i>tothemoon_tunombre_bot</i>).</li>
        <li>BotFather te da un <b>token</b> (algo como <code>123456789:ABC…</code>). Pegalo acá abajo.</li></ol>
      <form class="filters" data-form="tg-bot" autocomplete="off"><input name="token" type="password" placeholder="Token del bot" required style="min-width:260px">
        <button class="btn primary" type="submit">Activar</button></form>
      <p class="muted small" style="margin:8px 0 0">El token queda cifrado en el servidor. Un solo bot sirve para todos los usuarios: cada uno conecta su propio chat.</p>`
      : '<p class="muted small" style="margin:0">El administrador todavía no activó las alertas por Telegram.</p>';
  } else if (!s.linked) {
    body = alertsUI.link
      ? `<p style="margin-top:0">1. Abrí este link en el celular (o donde tengas Telegram) y tocá <b>Iniciar</b>:</p>
         <p><a class="btn primary" href="${esc(alertsUI.link.url)}" target="_blank" rel="noopener">Abrir @${esc(s.bot.username)} en Telegram</a></p>
         <p class="muted small" style="margin:0">2. Esta pantalla se actualiza sola cuando el bot te reciba (el link vence en 15 minutos).</p>`
      : `<p class="muted small" style="margin-top:0">Recibí en Telegram avisos de tus futuros, precios objetivo, ex-dividendos y cupones, aunque la app esté cerrada.</p>
         <button class="btn primary" data-action="tg-link">Conectar mi Telegram</button>`;
  } else {
    const active = s.targets.filter((t) => !t.done), done = s.targets.filter((t) => t.done);
    const tline = (t) => `<div class="settings-item"><div><b>${esc(t.sym)}</b> ${t.op === '>=' ? '≥' : '≤'} ${num(t.price, 4)} <span class="muted small">${{ S: 'acción/ETF', C: 'cripto', B: 'bono c/100' }[t.kind]}${t.note ? ' · ' + esc(t.note) : ''}</span>
        ${t.done ? `<div class="small pos">✓ Se cumplió el ${new Date(t.done).toLocaleDateString('es-AR')} (precio ${num(t.hitPrice, 4)})</div>` : ''}</div>
      <div class="actions"><button class="btn sm danger" data-action="tg-target-del" data-id="${esc(t.id)}">Quitar</button></div></div>`;
    body = `<p style="margin-top:0">✓ Conectado a <b>@${esc(s.bot.username)}</b>.
        <button class="btn sm" data-action="tg-test">Enviar prueba</button> <button class="btn sm" data-action="tg-unlink">Desconectar</button></p>
      <form class="alert-rules" data-form="tg-rules">
        <label class="small"><span class="muted">Futuros: avisar al llegar a ROE (%)</span><input name="roe" value="${esc((r.roe || []).join(', '))}" placeholder="20, 30"></label>
        <label class="small"><span class="muted">Futuros: avisar a menos de este % de la liquidación</span><input name="liqPct" type="number" min="0" max="90" step="any" value="${r.liqPct ?? ''}" placeholder="10"></label>
        <label class="small"><span class="muted">Futuros: avisar si el funding cuesta más de este % del margen por día (0 = no)</span><input name="fundingDayPct" type="number" min="0" max="100" step="any" value="${r.fundingDayPct ?? ''}" placeholder="0.5"></label>
        <label class="check small"><input type="checkbox" name="exdiv" ${r.exdiv ? 'checked' : ''}> Avisar el día anterior a un ex-dividendo de algo que tengo</label>
        <label class="check small"><input type="checkbox" name="coupons" ${r.coupons ? 'checked' : ''}> El día 1 de cada mes, los cupones de bonos y ONs que cobro</label>
        <div><button class="btn primary" type="submit">Guardar</button></div>
      </form>
      <h3 class="small muted" style="margin:16px 0 6px">Precios objetivo <span class="muted">(avisan una vez, como en TradingView)</span></h3>
      <div class="settings-list">${active.map(tline).join('') || '<div class="muted small">No tenés alertas de precio activas. También podés crearlas con 🔔 en Cotizaciones.</div>'}</div>
      <form class="filters" style="margin-top:10px" data-form="tg-target" autocomplete="off">
        <input name="sym" placeholder="Símbolo" required maxlength="15" style="text-transform:uppercase;width:110px">
        <select name="kind"><option value="S">Acción / ETF</option><option value="C">Cripto</option><option value="B">Bono / ON (c/100)</option></select>
        <select name="op"><option value=">=">sube a ≥</option><option value="<=">baja a ≤</option></select>
        <input name="price" type="number" step="any" min="0" placeholder="Precio" required style="width:120px">
        <input name="note" placeholder="Nota (opcional)" maxlength="120">
        <button class="btn" type="submit">+ Alerta</button>
      </form>
      ${done.length ? `<details style="margin-top:10px"><summary class="small muted">Cumplidas (${done.length})</summary><div class="settings-list">${done.map(tline).join('')}</div></details>` : ''}`;
  }
  return `<div class="card section">
    <h2>Alertas por Telegram</h2>
    ${body}
    ${s.bot && s.canSetBot ? `<p class="muted small" style="margin:12px 0 0">Bot: @${esc(s.bot.username)} · <button class="linkbtn" data-action="tg-bot-del">Quitar bot</button></p>` : ''}
  </div>`;
}

// ================= Copia de seguridad (solo el administrador) =================
const backupUI = { data: null, loading: false, running: false };
async function loadBackup() {
  if (backupUI.loading) return;
  backupUI.loading = true;
  try { backupUI.data = await api('/api/backup'); } catch { /* se reintenta al volver a Ajustes */ }
  finally { backupUI.loading = false; }
  if (route().name === 'ajustes') render();
}
function backupCard() {
  if (!isAdmin()) return '';
  const b = backupUI.data;
  if (!b) { loadBackup(); return '<div class="card section"><h2>Copia de seguridad</h2><div class="muted small">Cargando…</div></div>'; }
  const when = (iso) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const pwForm = (label) => `<form class="filters" data-form="bk-password" autocomplete="off" style="margin-top:8px">
      <input name="password" type="password" minlength="10" required placeholder="Contraseña del backup (mín. 10)" autocomplete="new-password">
      <input name="password2" type="password" minlength="10" required placeholder="Repetila" autocomplete="new-password">
      <button class="btn ${b.configured ? '' : 'primary'}" type="submit">${label}</button></form>`;
  return `<div class="card section">
    <h2>Copia de seguridad</h2>
    ${!b.configured ? `<p class="muted small" style="margin-top:0">Todos los días se guarda una copia <b>cifrada</b> de toda la app (tus carteras, las de tus amigos, usuarios y claves de exchanges) fuera de esta PC.
        Elegí una contraseña para cifrarla: <b>anotala en un lugar seguro</b>, sin ella el backup no se puede abrir y no hay forma de recuperarla.</p>${pwForm('Activar copias')}`
    : `<div class="settings-list">
        <div class="settings-item"><div><b>Última copia</b><div class="small ${b.error && (!b.last || b.error.at > b.last.at) ? 'neg' : 'muted'}">
          ${b.last ? `${when(b.last.at)} · ${(b.last.size / 1024).toFixed(0)} KB · en ${b.last.where.join(' y ')}` : 'Todavía ninguna'}
          ${b.error && (!b.last || b.error.at > b.last.at) ? `<br>⚠ Falló el ${when(b.error.at)}: ${esc(b.error.message)}` : ''}</div></div>
          <div class="actions"><button class="btn primary" data-action="bk-run" ${backupUI.running ? 'disabled' : ''}>${backupUI.running ? 'Copiando…' : 'Hacer copia ahora'}</button></div></div>
        <div class="settings-item"><div><label class="check"><input type="checkbox" data-bk-opt="oneDrive" ${b.folder ? 'checked' : ''} ${b.oneDrive ? '' : 'disabled'}> <b>OneDrive</b></label>
          <div class="muted small">${b.oneDrive ? (b.folder ? `En <code>${esc(b.folder)}</code> · se guardan los últimos 30 días y OneDrive las sube a la nube` : 'Desactivado') : 'OneDrive no está instalado en esta PC'}</div></div></div>
        <div class="settings-item"><div><label class="check"><input type="checkbox" data-bk-opt="telegram" ${b.telegram ? 'checked' : ''}> <b>Telegram</b></label>
          <div class="muted small">${b.telegramReady ? 'El archivo te llega al chat del bot de alertas' : 'Conectá tu Telegram en "Alertas por Telegram" para recibirla ahí'}</div></div></div>
      </div>
      <p class="muted small" style="margin:10px 0 0">Se hace sola una vez por día (desde las 3 de la mañana, o apenas prendas la PC). Para restaurar: arrastrá el archivo <code>.ttmbak</code> sobre <code>restaurar-backup.bat</code> en la carpeta de la app.</p>
      <details style="margin-top:8px"><summary class="small muted">Cambiar la contraseña del backup</summary>
        <p class="muted small">Las copias nuevas usan la nueva; las viejas se siguen abriendo con la anterior.</p>${pwForm('Cambiar')}</details>`}
  </div>`;
}

// Alerta de precio rápida desde el gráfico de Cotizaciones
function priceAlertForm(kind, sym, current) {
  openModal('🔔 Alerta de precio · ' + esc(sym), `
    ${field('Avisarme cuando', `<select name="op"><option value=">=">suba a ≥</option><option value="<=">baje a ≤</option></select>`)}
    ${field('Precio', `<input name="price" type="number" step="any" min="0" required value="${current ? +current.toPrecision(6) : ''}">`, { hint: current ? 'Precio actual: ' + num(current, 4) : '' })}
    ${field('Nota', '<input name="note" maxlength="120" placeholder="Opcional">', { full: true })}
    <div class="warn" id="pa-err"></div>`, async (d) => {
    try { await postJson('/api/alerts/targets', { kind, sym, op: d.op, price: +d.price, note: d.note }); toast('🔔 Alerta creada: te llega por Telegram'); alertsUI.data = null; }
    catch (e) { $('#pa-err').textContent = e.message; return false; }
  });
}

// ================= Ajustes: exchanges y usuarios =================
const EXCHANGE_INFO = {
  bitget: { what: 'tus futuros USDT-M y coin-M (Doble Saylor)', fields: [['key', 'API key'], ['secret', 'Secret key'], ['passphrase', 'Passphrase']],
    help: 'En Bitget: Perfil → Gestión de API → Crear API, con permiso <b>solo lectura</b>. Bitget te pide inventar una <b>passphrase</b>: es la que va acá.' },
  binance: { what: 'tu spot (con Funding y Earn) y tus futuros USDT-M y coin-M', fields: [['key', 'API key'], ['secret', 'Secret key']],
    help: 'En Binance: Perfil → Gestión de API → Crear API → <b>generada por el sistema</b> (HMAC), dejando tildado solo <b>Habilitar lectura</b> (sin trading ni retiros).' },
  bingx: { what: 'tus futuros USDT-M y coin-M', fields: [['key', 'API key'], ['secret', 'Secret key']],
    help: 'En BingX: Perfil → Gestión de API → Crear API, con permiso <b>solo lectura</b> (sin trading ni retiros).' },
  pionex: { what: 'tus bots', fields: [['key', 'API key'], ['secret', 'Secret']],
    help: 'En Pionex: Cuenta → API → Crear API, con permiso <b>solo lectura</b> (sin trading ni retiros).' },
};

function exchangeCard(ex) {
  const st = state[ex], info = EXCHANGE_INFO[ex], name = EXCHANGE_NAMES[ex];
  const form = (btn) => `<form class="keys-form" data-form="keys" data-ex="${ex}" autocomplete="off">
      ${info.fields.map(([k, label]) => `<label class="small"><span class="muted">${label}</span>
        <input name="${k}" type="password" autocomplete="off" spellcheck="false" required></label>`).join('')}
      <div class="actions"><button class="btn primary" type="submit">${btn}</button></div>
    </form>`;
  return `<div class="card section">
    <h2>${name}</h2>
    ${st.configured
      ? `<p style="margin-top:0">✓ Conectado con API de solo lectura${st.source === 'env' ? ` (desde <code>data\\${ex}.env</code>)` : ''}. La app sincroniza ${info.what} sola cada 3 minutos.
          ${st.error ? `<br><span class="neg small">Último error: ${esc(st.error)}</span>` : ''}</p>
         <div class="actions">
           <button class="btn" data-action="sync-${ex}">Sincronizar ahora</button>
           <button class="btn" data-action="keys-replace" data-ex="${ex}">Cambiar claves</button>
           ${st.source === 'app' ? `<button class="btn danger" data-action="keys-del" data-ex="${ex}">Desconectar</button>` : ''}
         </div>
         <div class="keys-replace" data-ex="${ex}" hidden>${form('Probar y guardar')}</div>`
      : `<p class="muted small" style="margin-top:0">${info.help} Después pegá las claves acá: la app las prueba antes de guardarlas, quedan cifradas en el servidor y nunca se vuelven a mostrar.</p>
         ${form('Conectar')}`}
  </div>`;
}

function membersCard() {
  const ms = state.members || [];
  return `<div class="card section">
    <h2>Usuarios <span class="muted small">(amigos con sus propias carteras)</span></h2>
    <p class="muted small" style="margin-top:0">Cada usuario entra con su usuario y contraseña, carga sus propias claves de exchanges y ve solo sus carteras. Vos no ves las de ellos ni ellos las tuyas.</p>
    <div class="settings-list">${ms.map((m) => `
      <div class="settings-item">
        <div><b>${esc(m.username)}</b> <span class="tag ${m.active ? 'buy' : ''}">${m.active ? 'activo' : 'desactivado'}</span>
          <div class="muted small">Creado el ${m.created ? fmtDate(m.created.slice(0, 10)) : '—'}</div></div>
        <div class="actions">
          <button class="btn" data-action="member-pass" data-id="${esc(m.id)}">Nueva contraseña</button>
          <button class="btn" data-action="member-toggle" data-id="${esc(m.id)}">${m.active ? 'Desactivar' : 'Activar'}</button>
          <button class="btn danger" data-action="member-del" data-id="${esc(m.id)}">Borrar</button>
        </div>
      </div>`).join('') || '<div class="muted small">Todavía no agregaste usuarios.</div>'}
    </div>
    <form class="filters" style="margin-top:12px" data-form="member-add" autocomplete="off">
      <input name="username" placeholder="Usuario (ej. juan)" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_\\-]{3,30}" title="De 3 a 30 letras, números, - o _" autocapitalize="none" spellcheck="false">
      <input name="password" type="password" placeholder="Contraseña inicial (mín. 8)" required minlength="8" autocomplete="new-password">
      <button class="btn primary" type="submit">+ Agregar usuario</button>
    </form>
    <p class="muted small" style="margin:8px 0 0">Pasale el usuario y la contraseña por un medio privado y pedile que la cambie al entrar (Ajustes → Cambiar contraseña).</p>
  </div>`;
}

async function reloadMembers() {
  state.members = await api('/api/auth/members').catch(() => state.members || []);
  render();
}

function viewSettings() {
  const mp = state.db.manualPrices || {};
  const au = state.auth || {};
  return `
  <div class="page-head"><div><h1>Ajustes</h1></div></div>
  ${installCard()}
  ${alertsCard()}
  ${backupCard()}
  <div class="card section">
    <h2>Seguridad</h2>
    <div class="settings-list">
      <div class="settings-item">
        <div><b>Tu usuario${au.user ? ': ' + esc(au.user) : ''}</b><div class="muted small">${au.totp ? '✓ Con código de 6 dígitos (2FA)' : 'Solo con contraseña'} · la sesión se cierra sola tras 1 h sin uso</div></div>
        <div class="actions"><button class="btn" data-action="change-password">Cambiar contraseña</button><button class="btn" data-action="logout-all">Cerrar otras sesiones</button></div>
      </div>
      ${isAdmin() ? `<div class="settings-item">
        <div><b>Usuario invitado</b> <span class="tag">${au.guestEnabled ? 'activo' : 'desactivado'}</span>
          <div class="muted small">Entra con el usuario <code>invitado</code>. Ve carteras, distribución y porcentajes, <b>nunca montos</b>, y no puede cambiar nada.</div></div>
        <div class="actions">${au.guestEnabled
          ? '<button class="btn" data-action="guest-on">Cambiar contraseña</button><button class="btn danger" data-action="guest-off">Desactivar</button>'
          : '<button class="btn" data-action="guest-on">Activar</button>'}</div>
      </div>` : ''}
    </div>
  </div>
  ${isAdmin() ? membersCard() : ''}
  ${tabsCard()}
  <div class="card section">
    <h2>Carteras</h2>
    ${state.db.portfolios.map((p) => `<div class="settings-row" data-pid="${p.id}">
      <input value="${esc(p.name)}" data-pfield="name" aria-label="Nombre">
      <select data-pfield="type" aria-label="Tipo">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <input value="${esc(p.broker || '')}" data-pfield="broker" placeholder="Broker / exchange" aria-label="Broker">
      <button class="btn sm danger" data-action="del-portfolio" data-id="${p.id}">Borrar</button>
    </div>`).join('')}
    <div style="margin-top:12px"><button class="btn" data-action="add-portfolio">+ Nueva cartera</button></div>
  </div>
  <div class="card section">
    <h2>Precios manuales</h2>
    <p class="muted small" style="margin-top:0">Para activos sin cotización automática (o si querés forzar un precio). Precio del activo subyacente en USD (para CEDEARs: el precio de la acción en NY).</p>
    <table><thead><tr><th>Activo</th><th class="num">Precio USD</th><th></th></tr></thead><tbody>
    ${Object.entries(mp).map(([k, v]) => `<tr><td class="ticker">${esc(k.slice(2))} <span class="tag">${{ C: 'cripto', B: 'bono / ON' }[k[0]] || 'acción'}</span></td><td class="num">${price(+v)}</td>
      <td class="num"><button class="btn sm danger" data-action="del-manual" data-key="${esc(k)}">Quitar</button></td></tr>`).join('') || '<tr><td colspan="3" class="empty">Ninguno</td></tr>'}
    </tbody></table>
    <form class="filters" style="margin-top:12px" data-form="manual">
      <select name="kind"><option value="S">Acción / CEDEAR</option><option value="B">Bono / ON (c/100 VN)</option><option value="C">Cripto</option></select>
      <input name="ticker" placeholder="Ticker" required>
      <input name="price" type="number" step="any" min="0" placeholder="Precio USD" required>
      <button class="btn" type="submit">Agregar</button>
    </form>
  </div>
  ${['binance', 'bitget', 'bingx', 'pionex'].map(exchangeCard).join('')}
  <div class="card section">
    <h2>Datos</h2>
    <p class="muted small" style="margin-top:0">${isAdmin()
      ? 'Todo se guarda en <code>app/data/db.json</code> en tu PC, con una copia diaria en <code>data/backups</code>.'
      : 'Tus datos se guardan en el servidor, con una copia diaria. Podés descargar tu propio backup cuando quieras.'}</p>
    <div class="actions">
      <button class="btn" data-action="export">Descargar backup (JSON)</button>
      <button class="btn" data-action="export-csv">Exportar operaciones (CSV)</button>
      <label class="btn">Restaurar backup… <input type="file" accept="application/json" data-action="import" hidden></label>
    </div>
  </div>`;
}

