// Service worker mínimo: permite "instalar" la app en el celular.
// No guarda nada en caché a propósito: son datos financieros y siempre se piden al servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* red directa, sin caché */ });
