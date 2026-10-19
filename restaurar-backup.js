// Restaura un backup de To the Moon (.ttmbak) en una carpeta nueva, SIN tocar la carpeta data actual.
// Uso: node restaurar-backup.js "ruta\al\archivo.ttmbak"   (o arrastrar el archivo sobre restaurar-backup.bat)
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { decrypt } = require('./backup');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.log('Uso: arrastrá el archivo .ttmbak sobre restaurar-backup.bat (o: node restaurar-backup.js archivo.ttmbak)');
  process.exit(1);
}

// Pide la contraseña sin mostrarla en pantalla
function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const pass = await askHidden('Contraseña del backup: ');
  let bundle;
  try { bundle = JSON.parse(decrypt(fs.readFileSync(file), pass).toString('utf8')); }
  catch (e) { console.log('\nNo se pudo abrir: ' + e.message); process.exit(1); }
  const out = path.join(__dirname, 'data-restaurado-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  for (const [rel, b64] of Object.entries(bundle.files)) {
    if (rel.includes('..') || path.isAbsolute(rel)) continue; // nunca fuera de la carpeta nueva
    const dest = path.join(out, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
  }
  console.log(`\nListo: ${Object.keys(bundle.files).length} archivos del backup del ${bundle.created.slice(0, 10)} en:\n  ${out}`);
  console.log('\nPara usarlo: detené la app (detener.bat), renombrá la carpeta "data" a "data-vieja",');
  console.log('renombrá esta carpeta nueva a "data" y volvé a iniciar la app (iniciar.bat).');
})();
