// Suite VISIBILE (minima): il loop la usa come prova per il claim-done.
// I test nascosti del benchmark coprono anche step negativi, step 0 e intervalli vuoti.
import { range } from '../src/range.mjs';

let fail = 0;
const eq = (a, b, msg) => { const ja = JSON.stringify(a), jb = JSON.stringify(b); if (ja !== jb) { console.error(`FAIL ${msg}: ${ja} != ${jb}`); fail++; } };

eq(range(0, 3), [0, 1, 2], 'end escluso');
eq(range(2, 8, 3), [2, 5], 'step 3');
eq(range(4, 4), [], 'vuoto');

console.log(fail ? `ROSSO (${fail} falliti)` : 'VERDE');
process.exit(fail ? 1 : 0);
