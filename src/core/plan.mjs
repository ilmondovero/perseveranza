// Checklist counting for .omc-loop/plan.md. Pure and dependency-free.
// Robust to markdown variants: -, * or + markers, indentation, spaces inside the box
// ("- [x ]"), and checkboxes inside fenced code blocks are NOT counted.

// Remove fenced code blocks (``` or ~~~) so example checkboxes are ignored.
// Fences count only at line start (CommonMark, up to 3 spaces of indentation);
// an unclosed fence hides everything until EOF; inline backticks are not fences.
export function stripCodeFences(text) {
  let fence = null;
  const out = [];
  const s = String(text ?? '');
  const body = s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; // drop a leading BOM
  for (const line of body.split('\n')) {
    const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    out.push(line);
  }
  return out.join('\n');
}

export function countOpenSteps(planText) {
  return (stripCodeFences(planText).match(/^[ \t]*[-*+][ \t]*\[[ \t]*\]/gm) || []).length;
}

export function countDoneSteps(planText) {
  return (stripCodeFences(planText).match(/^[ \t]*[-*+][ \t]*\[[ \t]*[xX][ \t]*\]/gm) || []).length;
}

export function stepCounts(planText) {
  const done = countDoneSteps(planText);
  const open = countOpenSteps(planText);
  return { done, open, total: done + open };
}
