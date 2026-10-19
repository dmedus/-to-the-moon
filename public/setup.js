'use strict';
(async function () {
  const $ = (s) => document.querySelector(s);
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Error');
    return j;
  };

  const st = await (await fetch('/api/auth/state')).json();
  if (st.ready) { location.replace(st.role ? '/' : '/login.html'); return; }
  if (!st.local) { $('#not-local').hidden = false; return; }
  $('#step1').hidden = false;
  $('#u').focus();

  $('#step1').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#err1').textContent = '';
    if ($('#p').value !== $('#p2').value) { $('#err1').textContent = 'Las contraseñas no coinciden.'; return; }
    try {
      const r = await post('/api/auth/setup', { username: $('#u').value.trim(), password: $('#p').value, totp: $('#totp').checked });
      if (r.done) { location.replace('/'); return; }
      $('#step1').hidden = true;
      $('#step2').hidden = false;
      $('#secret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
      if (window.QRCode) new QRCode($('#qr'), { text: r.uri, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
      else $('#qr').textContent = 'No se pudo cargar el QR: usá la clave de abajo.';
      $('#c').focus();
    } catch (err) { $('#err1').textContent = err.message; }
  });

  $('#step2').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#err2').textContent = '';
    try {
      await post('/api/auth/setup/confirm', { code: $('#c').value.trim() });
      location.replace('/');
    } catch (err) { $('#err2').textContent = err.message; $('#c').value = ''; $('#c').focus(); }
  });
})();
