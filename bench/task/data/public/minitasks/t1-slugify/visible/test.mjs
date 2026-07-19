// Suite VISIBILE (minima): il loop la usa come prova per il claim-done.
// I test nascosti del benchmark sono piu' severi: implementare TUTTA la specifica.
import { slugify } from '../src/slugify.mjs';

let fail = 0;
const eq = (a, b, msg) => { if (a !== b) { console.error(`FAIL ${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); fail++; } };

eq(slugify('Hello World'), 'hello-world', 'base');
eq(slugify('  Foo   Bar  '), 'foo-bar', 'spazi multipli');
eq(slugify('già fatto'), 'gia-fatto', 'accenti');
try { slugify(42); console.error('FAIL: 42 doveva lanciare TypeError'); fail++; } catch (e) { if (!(e instanceof TypeError)) { console.error('FAIL: errore sbagliato'); fail++; } }

console.log(fail ? `ROSSO (${fail} falliti)` : 'VERDE');
process.exit(fail ? 1 : 0);
