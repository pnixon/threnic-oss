/**
 * WGSL backend — emits the IR as shader statements.
 *
 * Per-vertex and per-pixel equations are pure functions of the frame uniform
 * block plus position, so they parallelize perfectly. This emitter turns them
 * into WGSL that runs in the warp vertex shader or a pixel node, instead of
 * being walked on the CPU per grid vertex.
 *
 * Semantics match emitJS exactly — division by zero is 0, log of a
 * non-positive number is 0, sqrt takes |x| — via the md_* helpers in the
 * shader prelude. Divergence between the two backends would show up as the
 * preview and export disagreeing, which is the exact bug this design exists
 * to prevent.
 */

import type { Expr, Program } from './ast';

interface WGSLBindings {
  /**
   * Read-only substitutions: variable name -> WGSL expression.
   * e.g. { bass: 'md_bass()', x: 'grid.x', rad: 'rad' }
   */
  reads?: Record<string, string>;
  /**
   * Mutable lvalues the caller has already declared: name -> WGSL lvalue.
   * Assignments to these write through; typically the per-vertex outputs
   * (x, y) and any q-vars a node forwards.
   */
  vars?: Record<string, string>;
  /** Prefix for generated locals. Default 'e_'. */
  localPrefix?: string;
}

interface WGSLEmission {
  /** `var` declarations for every local the program introduced. */
  declarations: string;
  /** The statement list, one assignment per line. */
  body: string;
  /** Names that became locals (useful for reading results back out). */
  locals: string[];
}

const CMP: Record<string, string> = {
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '==': '==',
  '!=': '!=',
};

export function compileWGSL(program: Program, bindings: WGSLBindings = {}): WGSLEmission {
  const reads = bindings.reads ?? {};
  const vars = bindings.vars ?? {};
  const prefix = bindings.localPrefix ?? 'e_';

  // Anything assigned that is not a caller-provided lvalue becomes a local.
  // Locals seeded from a read-only binding keep that binding's initial value,
  // which is how a preset that writes to `bass` still starts from real bass.
  const locals = new Map<string, string>();
  for (const name of program.writes) {
    if (vars[name]) continue;
    locals.set(name, reads[name] ?? '0.0');
  }

  const lvalue = (name: string): string => {
    if (vars[name]) return vars[name];
    if (locals.has(name)) return prefix + name;
    // Assigning something with no home at all: give it one.
    locals.set(name, reads[name] ?? '0.0');
    return prefix + name;
  };

  const rvalue = (name: string): string => {
    if (vars[name]) return vars[name];
    if (locals.has(name)) return prefix + name;
    if (reads[name]) return reads[name];
    // Unknown identifier reads as zero, matching EEL2's implicit variables.
    return '0.0';
  };

  const emit = (e: Expr): string => {
    switch (e.kind) {
      case 'num': {
        // WGSL needs a decimal point to infer f32.
        const s = String(e.value);
        return /[.eE]/.test(s) ? s : s + '.0';
      }
      case 'var':
        return rvalue(e.name);
      case 'unary':
        return e.op === '-'
          ? `(-(${emit(e.operand)}))`
          : `select(0.0, 1.0, (${emit(e.operand)}) == 0.0)`;
      case 'binary': {
        const l = emit(e.left);
        const r = emit(e.right);
        switch (e.op) {
          case '+':
          case '-':
          case '*':
            return `((${l}) ${e.op} (${r}))`;
          case '/':
            return `md_div(${l}, ${r})`;
          case '%':
            return `md_mod(${l}, ${r})`;
          case '^':
            return `md_pow(${l}, ${r})`;
          case '&&':
            return `select(0.0, 1.0, (${l}) != 0.0 && (${r}) != 0.0)`;
          case '||':
            return `select(0.0, 1.0, (${l}) != 0.0 || (${r}) != 0.0)`;
          default:
            return `select(0.0, 1.0, (${l}) ${CMP[e.op]} (${r}))`;
        }
      }
      case 'call': {
        const a = e.args.map(emit);
        switch (e.name) {
          case 'sin':
          case 'cos':
          case 'tan':
          case 'asin':
          case 'acos':
          case 'atan':
          case 'sinh':
          case 'cosh':
          case 'tanh':
          case 'exp':
          case 'abs':
          case 'sign':
          case 'floor':
          case 'ceil':
          case 'min':
          case 'max':
          case 'clamp':
            return `${e.name}(${a.join(', ')})`;
          case 'atan2':
            return `atan2(${a[0]}, ${a[1]})`;
          case 'sqrt':
            return `sqrt(abs(${a[0]}))`;
          case 'sqr':
            return `((${a[0]}) * (${a[0]}))`;
          case 'invsqrt':
            return `md_invsqrt(${a[0]})`;
          case 'pow':
            return `md_pow(${a[0]}, ${a[1]})`;
          case 'log':
            return `md_log(${a[0]})`;
          case 'log10':
            return `md_log10(${a[0]})`;
          case 'int':
            return `trunc(${a[0]})`;
          case 'frac':
            return `fract(${a[0]})`;
          case 'fmod':
            return `md_mod(${a[0]}, ${a[1]})`;
          case 'above':
            return `select(0.0, 1.0, (${a[0]}) > (${a[1]}))`;
          case 'below':
            return `select(0.0, 1.0, (${a[0]}) < (${a[1]}))`;
          case 'equal':
            return `select(0.0, 1.0, (${a[0]}) == (${a[1]}))`;
          case 'band':
            return `select(0.0, 1.0, (${a[0]}) != 0.0 && (${a[1]}) != 0.0)`;
          case 'bor':
            return `select(0.0, 1.0, (${a[0]}) != 0.0 || (${a[1]}) != 0.0)`;
          case 'bnot':
            return `select(0.0, 1.0, (${a[0]}) == 0.0)`;
          case 'if':
            return `select(${a[2]}, ${a[1]}, (${a[0]}) != 0.0)`;
          case 'sigmoid':
            return `md_sigmoid(${a[0]}, ${a[1]})`;
          case 'rand':
            return `md_rand(${a[0]})`;
        }
        throw new Error(`[milkdrop/ir] no WGSL implementation for '${e.name}'`);
      }
    }
  };

  const body = program.statements
    .map((st) => `  ${lvalue(st.target)} = md_finite(${emit(st.value)});`)
    .join('\n');

  const declarations = [...locals.entries()]
    .map(([name, init]) => `  var ${prefix}${name}: f32 = ${init};`)
    .join('\n');

  return { declarations, body, locals: [...locals.keys()] };
}
