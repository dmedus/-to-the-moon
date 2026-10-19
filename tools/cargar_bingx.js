// Carga un snapshot de BingX (formato de bingx.fetchSnapshot) en data/db.json.
// Uso: node tools/cargar_bingx.js [data/bingx-snapshot.json]
// Sirve para cargar datos sin API configurada en la app (por ejemplo, traídos con el conector de BingX).
const fs = require('fs');
const path = require('path');
const { mergeSnapshot } = require('../bingx');

const DB = path.join(__dirname, '..', 'data', 'db.json');
const snapPath = process.argv[2] || path.join(__dirname, '..', 'data', 'bingx-snapshot.json');
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
fs.copyFileSync(DB, DB.replace('db.json', 'db.antes-de-importar.json'));
fs.writeFileSync(DB, JSON.stringify(mergeSnapshot(db, snap), null, 2));
console.log(`BingX: ${snap.accounts.length} cuentas, ${snap.open.length} abiertas, ${snap.closed.length} cerradas`);
