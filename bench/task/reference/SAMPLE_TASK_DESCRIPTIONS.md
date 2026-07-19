# Sample task descriptions — perseveranza-bench

I "task" di questo benchmark non sono domande: sono **mini-progetti di coding** che il
target agent fa eseguire a un loop perseveranza headless. Qui sotto i testi reali con cui
i loop vengono armati (da `data/public/minitasks/<nome>/TASK.txt`).

---

## Sample Task 1: t1-slugify (implementazione con edge case)

> Implementa la funzione slugify in src/slugify.mjs secondo la specifica scritta nel file
> (commento in testa). La suite visibile e' `node visible/test.mjs`. Non modificare i test.

Specifica: minuscole, accenti rimossi, non-alfanumerici → `-` collassati, trim dei `-`,
`TypeError` su input non stringa. I test nascosti coprono TUTTA la specifica (14 casi).

---

## Sample Task 2: t2-bugfix (bug seminato)

> La funzione range in src/range.mjs non rispetta la sua specifica (commento in testa al
> file): trova e correggi i bug SENZA cambiare la specifica. La suite visibile e'
> `node visible/test.mjs`. Non modificare i test.

Bug reali: intervallo chiuso invece che semiaperto, step negativi rotti, step 0 non
gestito. I test nascosti (9 casi) verificano la specifica, non l'implementazione attuale.

---

## Sample Task 3: t3-refactor (comportamento invariante)

> In src/parsers.mjs tre funzioni duplicano la stessa logica di parsing con piccole
> variazioni. Rifattorizza eliminando la duplicazione (un helper comune) SENZA cambiare
> il comportamento osservabile di parseUser/parseProduct/parseOrder, che restano
> esportate con la stessa firma. La suite visibile e' `node visible/test.mjs`. Non
> modificare i test.

I test nascosti (14 casi) bloccano il comportamento attuale, inclusi i casi limite.

---

## Cosa deve fare il target agent

1. Per ogni mini-task: copiare il template in un workdir usa-e-getta, armare il loop
   (`--max 10 --external off --no-git-finish`, suite visibile come `--test`), scrivere
   il `PROMPT_PACK` in `.omc-loop/prompts.json`, lanciare `claude -p` e attendere.
2. Registrare in `submission.json`: `name`, `workdir`, `closed` (loop chiuso da solo),
   `iterations`, `escalated`, `max`.
3. La leva di miglioramento tra le generazioni e' SOLO il `PROMPT_PACK` (vedi task.md):
   istruzioni che spingono i loop a implementare tutta la specifica, convergere in meno
   iterazioni e non finire in escalation.
