/**
 * JS backend — compiles the IR to a tree of closures.
 *
 * Used for per-frame equations, which are sequential and stateful (~100
 * variables persisting frame to frame, q1..q32 propagating downward). Closures
 * rather than `new Function` so the engine works under a strict CSP, and
 * because per-frame code runs once per frame — the interpreter overhead is
 * nanoseconds against a 16ms budget.
 *
 * Every assignment is sanitized: a non-finite result is written as 0. With
 * feedback, one NaN reaching the uniform block poisons every later frame.
 */

import type { Expr, Program } from './ast';

type Thunk = (v: Float64Array) => number;

/** Named f32 slots backing a program's variable space. */
export class VarTable {
  private index = new Map<string, number>();
  values: Float64Array = new Float64Array(64);
  private count = 0;

  slot(name: string): number {
    let i = this.index.get(name);
    if (i === undefined) {
      i = this.count++;
      if (i >= this.values.length) {
        const grown = new Float64Array(this.values.length * 2);
        grown.set(this.values);
        this.values = grown;
      }
      this.index.set(name, i);
    }
    return i;
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  get(name: string): number {
    const i = this.index.get(name);
    return i === undefined ? 0 : this.values[i];
  }

  set(name: string, value: number): void {
    this.values[this.slot(name)] = Number.isFinite(value) ? value : 0;
  }

  names(): string[] {
    return [...this.index.keys()];
  }

  /** Zero every slot — used on preset load and on seek. */
  clear(): void {
    this.values.fill(0);
  }

  snapshot(): Float64Array {
    return this.values.slice(0, this.count);
  }

  restore(snap: Float64Array): void {
    this.values.set(snap.subarray(0, Math.min(snap.length, this.values.length)));
  }
}

/** Deterministic 0..1 hash used by rand(). Mirrors md_rand() in WGSL. */
export function hash31(a: number, b: number, c: number): number {
  let h = Math.imul(Math.trunc(a * 1000) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ Math.trunc(b), 0xc2b2ae35);
  h = Math.imul(h ^ Math.trunc(c * 1000), 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const bool = (x: boolean): number => (x ? 1 : 0);

/**
 * Compile a program into a `run()` that mutates `table` in place.
 * Reads and writes go through the table, so the caller sets inputs before
 * calling and reads outputs after.
 */
export function compileJS(program: Program, table: VarTable): () => void {
  // Allocate slots first so index lookups are stable inside the closures.
  for (const name of [...program.reads, ...program.writes]) table.slot(name);

  const expr = (e: Expr): Thunk => {
    switch (e.kind) {
      case 'num': {
        const k = e.value;
        return () => k;
      }
      case 'var': {
        const i = table.slot(e.name);
        return (v) => v[i];
      }
      case 'unary': {
        const a = expr(e.operand);
        return e.op === '-' ? (v) => -a(v) : (v) => bool(a(v) === 0);
      }
      case 'binary': {
        const l = expr(e.left);
        const r = expr(e.right);
        switch (e.op) {
          case '+':
            return (v) => l(v) + r(v);
          case '-':
            return (v) => l(v) - r(v);
          case '*':
            return (v) => l(v) * r(v);
          case '/':
            // EEL2 semantics: division by zero yields 0 rather than Infinity.
            return (v) => {
              const d = r(v);
              return d === 0 ? 0 : l(v) / d;
            };
          case '%':
            return (v) => {
              const d = r(v);
              return d === 0 ? 0 : l(v) % d;
            };
          case '^':
            return (v) => Math.pow(l(v), r(v));
          case '<':
            return (v) => bool(l(v) < r(v));
          case '<=':
            return (v) => bool(l(v) <= r(v));
          case '>':
            return (v) => bool(l(v) > r(v));
          case '>=':
            return (v) => bool(l(v) >= r(v));
          case '==':
            return (v) => bool(l(v) === r(v));
          case '!=':
            return (v) => bool(l(v) !== r(v));
          case '&&':
            return (v) => bool(l(v) !== 0 && r(v) !== 0);
          case '||':
            return (v) => bool(l(v) !== 0 || r(v) !== 0);
        }
        break;
      }
      case 'call': {
        const a = e.args.map(expr);
        switch (e.name) {
          case 'sin':
            return (v) => Math.sin(a[0](v));
          case 'cos':
            return (v) => Math.cos(a[0](v));
          case 'tan':
            return (v) => Math.tan(a[0](v));
          case 'asin':
            return (v) => Math.asin(a[0](v));
          case 'acos':
            return (v) => Math.acos(a[0](v));
          case 'atan':
            return (v) => Math.atan(a[0](v));
          case 'atan2':
            return (v) => Math.atan2(a[0](v), a[1](v));
          case 'sinh':
            return (v) => Math.sinh(a[0](v));
          case 'cosh':
            return (v) => Math.cosh(a[0](v));
          case 'tanh':
            return (v) => Math.tanh(a[0](v));
          case 'sqrt':
            return (v) => Math.sqrt(Math.abs(a[0](v)));
          case 'sqr':
            return (v) => {
              const x = a[0](v);
              return x * x;
            };
          case 'invsqrt':
            return (v) => {
              const x = Math.sqrt(Math.abs(a[0](v)));
              return x === 0 ? 0 : 1 / x;
            };
          case 'pow':
            return (v) => Math.pow(a[0](v), a[1](v));
          case 'exp':
            return (v) => Math.exp(a[0](v));
          case 'log':
            return (v) => {
              const x = a[0](v);
              return x <= 0 ? 0 : Math.log(x);
            };
          case 'log10':
            return (v) => {
              const x = a[0](v);
              return x <= 0 ? 0 : Math.log10(x);
            };
          case 'abs':
            return (v) => Math.abs(a[0](v));
          case 'sign':
            return (v) => Math.sign(a[0](v));
          case 'min':
            return (v) => Math.min(a[0](v), a[1](v));
          case 'max':
            return (v) => Math.max(a[0](v), a[1](v));
          case 'clamp':
            return (v) => Math.min(Math.max(a[0](v), a[1](v)), a[2](v));
          case 'floor':
            return (v) => Math.floor(a[0](v));
          case 'ceil':
            return (v) => Math.ceil(a[0](v));
          case 'int':
            return (v) => Math.trunc(a[0](v));
          case 'frac':
            return (v) => {
              const x = a[0](v);
              return x - Math.floor(x);
            };
          case 'fmod':
            return (v) => {
              const d = a[1](v);
              return d === 0 ? 0 : a[0](v) % d;
            };
          case 'above':
            return (v) => bool(a[0](v) > a[1](v));
          case 'below':
            return (v) => bool(a[0](v) < a[1](v));
          case 'equal':
            return (v) => bool(a[0](v) === a[1](v));
          case 'band':
            return (v) => bool(a[0](v) !== 0 && a[1](v) !== 0);
          case 'bor':
            return (v) => bool(a[0](v) !== 0 || a[1](v) !== 0);
          case 'bnot':
            return (v) => bool(a[0](v) === 0);
          case 'if':
            return (v) => (a[0](v) !== 0 ? a[1](v) : a[2](v));
          case 'sigmoid':
            return (v) => {
              const t = Math.exp(-a[0](v) * a[1](v));
              return Number.isFinite(t) ? 1 / (1 + t) : 0;
            };
          case 'rand': {
            const frameSlot = table.slot('frame');
            const seedSlot = table.slot('seed');
            return (v) => hash31(a[0](v), v[frameSlot], v[seedSlot]);
          }
        }
        throw new Error(`[milkdrop/ir] no JS implementation for '${e.name}'`);
      }
    }
    throw new Error('[milkdrop/ir] unreachable expression node');
  };

  const steps = program.statements.map((st) => {
    const slot = table.slot(st.target);
    const value = expr(st.value);
    return (v: Float64Array) => {
      const r = value(v);
      v[slot] = Number.isFinite(r) ? r : 0;
    };
  });

  return () => {
    const v = table.values;
    for (let i = 0; i < steps.length; i++) steps[i](v);
  };
}
