export type FormulaNode =
  | { t: 'num'; v: number }
  | { t: 'ref'; code: string }
  | { t: 'neg'; e: FormulaNode }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; a: FormulaNode; b: FormulaNode }
  | { t: 'fn'; name: 'MIN' | 'MAX' | 'ABS' | 'ROUND'; args: FormulaNode[] };

export class FormulaError extends Error {}

const FUNCS = ['MIN', 'MAX', 'ABS', 'ROUND'] as const;

export function parseFormula(src: string): FormulaNode {
  const tokens = src.match(/\d+(?:\.\d+)?|[A-Z][A-Z0-9_]*|[-+*/(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (t: string) => {
    if (next() !== t) throw new FormulaError(`Expected "${t}"`);
  };
  function expr(): FormulaNode {
    let a = term();
    while (peek() === '+' || peek() === '-') {
      const op = next() as '+' | '-';
      a = { t: 'bin', op, a, b: term() };
    }
    return a;
  }
  function term(): FormulaNode {
    let a = factor();
    while (peek() === '*' || peek() === '/') {
      const op = next() as '*' | '/';
      a = { t: 'bin', op, a, b: factor() };
    }
    return a;
  }
  function factor(): FormulaNode {
    const tok = next();
    if (tok === undefined) throw new FormulaError('Unexpected end of formula');
    if (tok === '-') return { t: 'neg', e: factor() };
    if (tok === '(') {
      const e = expr();
      expect(')');
      return e;
    }
    if (/^\d/.test(tok)) return { t: 'num', v: Number(tok) };
    if (/^[A-Z]/.test(tok)) {
      if ((FUNCS as readonly string[]).includes(tok) && peek() === '(') {
        next();
        const args: FormulaNode[] = [];
        if (peek() !== ')') {
          args.push(expr());
          while (peek() === ',') {
            next();
            args.push(expr());
          }
        }
        expect(')');
        const name = tok as 'MIN' | 'MAX' | 'ABS' | 'ROUND';
        if ((name === 'ABS' && args.length !== 1) || (name === 'ROUND' && args.length !== 2) || args.length === 0) {
          throw new FormulaError(`Wrong number of arguments for ${tok}`);
        }
        return { t: 'fn', name, args };
      }
      return { t: 'ref', code: tok };
    }
    throw new FormulaError(`Unexpected "${tok}"`);
  }
  const node = expr();
  if (i < tokens.length) throw new FormulaError(`Unexpected "${tokens[i]}"`);
  return node;
}

export function formulaRefs(node: FormulaNode, out = new Set<string>()): Set<string> {
  switch (node.t) {
    case 'ref': out.add(node.code); break;
    case 'neg': formulaRefs(node.e, out); break;
    case 'bin': formulaRefs(node.a, out); formulaRefs(node.b, out); break;
    case 'fn': node.args.forEach((a) => formulaRefs(a, out)); break;
    default: break;
  }
  return out;
}

export function evalFormula(node: FormulaNode, lookup: (code: string) => number | null): number | null {
  switch (node.t) {
    case 'num': return node.v;
    case 'ref': return lookup(node.code);
    case 'neg': {
      const v = evalFormula(node.e, lookup);
      return v === null ? null : -v;
    }
    case 'bin': {
      const a = evalFormula(node.a, lookup);
      const b = evalFormula(node.b, lookup);
      if (a === null || b === null) return null;
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      return b === 0 ? null : a / b;
    }
    case 'fn': {
      const vals = node.args.map((x) => evalFormula(x, lookup));
      if (vals.some((v) => v === null)) return null;
      const n = vals as number[];
      if (node.name === 'MIN') return Math.min(...n);
      if (node.name === 'MAX') return Math.max(...n);
      if (node.name === 'ABS') return Math.abs(n[0]!);
      const f = 10 ** n[1]!;
      return Math.round(n[0]! * f) / f;
    }
    default: return null;
  }
}

/** Orders calculated codes so each comes after the codes it uses; throws on circular references (PAR-06). */
export function orderCalculated(formulas: Record<string, string>): string[] {
  const deps = new Map(Object.entries(formulas).map(([c, f]) => [c, [...formulaRefs(parseFormula(f))]]));
  const out: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (c: string, path: string[]) => {
    if (state.get(c) === 'done') return;
    if (state.get(c) === 'visiting') throw new FormulaError(`Circular reference: ${[...path, c].join(' → ')}`);
    state.set(c, 'visiting');
    for (const d of deps.get(c) ?? []) if (deps.has(d)) visit(d, [...path, c]);
    state.set(c, 'done');
    out.push(c);
  };
  for (const c of deps.keys()) visit(c, []);
  return out;
}
