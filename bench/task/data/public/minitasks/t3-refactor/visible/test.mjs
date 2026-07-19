// Suite VISIBILE (minima): il loop la usa come prova per il claim-done.
// I test nascosti del benchmark bloccano il comportamento su molti piu' casi limite.
import { parseUser, parseProduct, parseOrder } from '../src/parsers.mjs';

let fail = 0;
const eq = (a, b, msg) => { const ja = JSON.stringify(a), jb = JSON.stringify(b); if (ja !== jb) { console.error(`FAIL ${msg}: ${ja} != ${jb}`); fail++; } };

eq(parseUser('1; Ada ; ada@x.it'), { id: 1, name: 'Ada', email: 'ada@x.it' }, 'user base');
eq(parseProduct('A1;Vite;2.5'), { sku: 'A1', desc: 'Vite', price: 2.5 }, 'product base');
eq(parseOrder('o1;A1;3;7.5'), { orderId: 'o1', sku: 'A1', qty: 3, total: 7.5 }, 'order base');
eq(parseUser('1;solo-due'), null, 'campi mancanti -> null');

console.log(fail ? `ROSSO (${fail} falliti)` : 'VERDE');
process.exit(fail ? 1 : 0);
