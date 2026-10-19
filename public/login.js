'use strict';
(async function () {
  const $ = (s) => document.querySelector(s);
  try {
    const st = await (await fetch('/api/auth/state')).json();
    if (!st.ready) { location.replace('/setup.html'); return; }
    if (st.role) { location.replace('/'); return; }
    // El código se pide si el dueño tiene 2FA; el invitado lo deja vacío.
    if (st.totp) $('#code-field').hidden = false;
  } catch { /* sin conexión: se intenta igual */ }

  $('#u').focus();
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btn');
    btn.disabled = true; btn.textContent = 'Ingresando…';
    $('#err').textContent = '';
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#u').value.trim(), password: $('#p').value, code: $('#c').value.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'No se pudo ingresar');
      location.replace('/');
    } catch (err) {
      $('#err').textContent = err.message;
      $('#p').value = ''; $('#c').value = '';
      $('#p').focus();
      btn.disabled = false; btn.textContent = 'Ingresar';
    }
  });
})();
