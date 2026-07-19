// Test NASCOSTO di t3-refactor: blocca il comportamento dei tre parser dopo il refactor
// E verifica STRUTTURALMENTE che la deduplicazione sia avvenuta (v2: il solo comportamento
// passava anche sul template mai toccato — non misurava l'obiettivo del task).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const srcPath = join(process.cwd(), 'src', 'parsers.mjs');
const m = await import(pathToFileURL(srcPath));
const { parseUser, parseProduct, parseOrder } = m;

let fail = 0, tot = 0;
const eq = (a, b, msg) => { tot++; const ja = JSON.stringify(a), jb = JSON.stringify(b); if (ja !== jb) { console.error(`FAIL ${msg}: ${ja} != ${jb}`); fail++; } };

eq(parseUser(' 7 ;  Bo  ; bo@x.it '), { id: 7, name: 'Bo', email: 'bo@x.it' }, 'trim aggressivo');
eq(parseUser('x;Ada;a@b'), null, 'id non numerico -> null');
eq(parseUser('1;Ada'), null, '2 campi -> null');
eq(parseUser('1;Ada;a@b;extra'), null, '4 campi -> null');
eq(parseUser(42), null, 'non stringa -> null');
eq(parseUser('0;;'), { id: 0, name: '', email: '' }, 'campi vuoti ammessi (id 0 valido)');
eq(parseProduct('A1;Vite;2.5'), { sku: 'A1', desc: 'Vite', price: 2.5 }, 'product base');
eq(parseProduct('A1;Vite;caro'), null, 'prezzo NaN -> null');
eq(parseProduct('A1;Vite;2.5;x'), null, 'product 4 campi -> null');
eq(parseOrder('o1;A1;3;7.5'), { orderId: 'o1', sku: 'A1', qty: 3, total: 7.5 }, 'order base');
eq(parseOrder('o1;A1;tre;7.5'), null, 'qty NaN -> null');
eq(parseOrder('o1;A1;3;tot'), null, 'total NaN -> null');
eq(parseOrder('o1;A1;3'), null, 'order 3 campi -> null');
eq(parseOrder(null), null, 'null -> null');

// verifica strutturale della deduplicazione: la logica comune deve vivere in UN punto.
// Proxy robusti: nel template originale split(';') e la guardia non-stringa compaiono
// 3 volte (una per parser); dopo un refactor vero al massimo 1.
const src = readFileSync(srcPath, 'utf8');
const count = (re) => (src.match(re) || []).length;
tot++; { const n = count(/split\(\s*['"`];['"`]\s*\)/g); if (n > 1) { console.error(`FAIL dedup: split(';') compare ${n} volte nel sorgente (atteso 1: helper comune)`); fail++; } }
tot++; { const n = count(/typeof\s+\w+\s*!==\s*['"`]string['"`]/g); if (n > 1) { console.error(`FAIL dedup: la guardia non-stringa e' duplicata ${n} volte (attesa 1)`); fail++; } }

console.log(`HIDDEN t3: ${tot - fail}/${tot}`);
process.exit(fail ? 1 : 0);
