// range(start, end, step = 1) -> number[]
// Specifica (semantica Python):
//   - intervallo SEMIAPERTO [start, end): end escluso
//   - step negativo -> conta all'indietro (es. range(3, 0, -1) -> [3, 2, 1])
//   - step 0 -> lancia RangeError
//   - intervallo vuoto (es. range(5, 2) con step positivo) -> []
export function range(start, end, step = 1) {
  const out = [];
  for (let i = start; i <= end; i += step) out.push(i);
  return out;
}
