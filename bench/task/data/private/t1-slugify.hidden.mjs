// Test NASCOSTO di t1-slugify: eseguito da evaluate.py con cwd = workdir del loop.
// Importa il modulo dal workdir (mai visto dal loop durante il run).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { slugify } = await import(pathToFileURL(join(process.cwd(), 'src', 'slugify.mjs')));

let fail = 0, tot = 0;
const eq = (a, b, msg) => { tot++; if (a !== b) { console.error(`FAIL ${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); fail++; } };
const throws = (fn, msg) => { tot++; try { fn(); console.error(`FAIL ${msg}: nessun errore`); fail++; } catch (e) { if (!(e instanceof TypeError)) { console.error(`FAIL ${msg}: atteso TypeError, avuto ${e.constructor.name}`); fail++; } } };

eq(slugify('Hello World'), 'hello-world', 'base');
eq(slugify('perché no?'), 'perche-no', 'accento + punteggiatura');
eq(slugify('Città di México'), 'citta-di-mexico', 'accenti misti');
eq(slugify('foo_bar__baz'), 'foo-bar-baz', 'underscore');
eq(slugify('--Già--Fatto--'), 'gia-fatto', 'trattini in testa/coda e doppi');
eq(slugify(''), '', 'vuota');
eq(slugify('***'), '', 'soli separatori');
eq(slugify('C++ & C#'), 'c-c', 'simboli');
eq(slugify('  A  '), 'a', 'trim');
eq(slugify('a1 b2'), 'a1-b2', 'alfanumerici conservati');
throws(() => slugify(42), 'numero');
throws(() => slugify(null), 'null');
throws(() => slugify(undefined), 'undefined');
throws(() => slugify(['a']), 'array');

console.log(`HIDDEN t1: ${tot - fail}/${tot}`);
process.exit(fail ? 1 : 0);
