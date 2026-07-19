// Test NASCOSTO di t2-bugfix: eseguito da evaluate.py con cwd = workdir del loop.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { range } = await import(pathToFileURL(join(process.cwd(), 'src', 'range.mjs')));

let fail = 0, tot = 0;
const eq = (a, b, msg) => { tot++; const ja = JSON.stringify(a), jb = JSON.stringify(b); if (ja !== jb) { console.error(`FAIL ${msg}: ${ja} != ${jb}`); fail++; } };
const throwsRange = (fn, msg) => { tot++; try { fn(); console.error(`FAIL ${msg}: nessun errore`); fail++; } catch (e) { if (!(e instanceof RangeError)) { console.error(`FAIL ${msg}: atteso RangeError, avuto ${e.constructor.name}`); fail++; } } };

eq(range(0, 3), [0, 1, 2], 'end escluso');
eq(range(0, 0), [], 'vuoto identico');
eq(range(5, 2), [], 'vuoto con step positivo');
eq(range(3, 0, -1), [3, 2, 1], 'step negativo');
eq(range(10, 4, -2), [10, 8, 6], 'step -2');
eq(range(0, -3, -1), [0, -1, -2], 'negativi');
eq(range(2, 8, 3), [2, 5], 'step 3 (end escluso anche non allineato)');
eq(range(0, 1), [0], 'singolo');
throwsRange(() => range(0, 5, 0), 'step 0');

console.log(`HIDDEN t2: ${tot - fail}/${tot}`);
process.exit(fail ? 1 : 0);
