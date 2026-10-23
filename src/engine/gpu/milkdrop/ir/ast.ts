/**
 * Expression IR.
 *
 * The equation language is a frontend; this IR is the contract. Two backends
 * consume it: a closure compiler for the sequential per-frame equations that
 * run on the CPU, and a WGSL emitter for per-vertex and per-pixel equations
 * that run in the shader. Milkdrop evaluated per-vertex code on the CPU across
 * a 48x36 grid every frame; compiling the same IR to WGSL removes that cost
 * and lets mesh density go as high as we like.
 */

type UnaryOp = '-' | '!';

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '^'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||';

interface NumLit {
  kind: 'num';
  value: number;
}

interface VarRef {
  kind: 'var';
  name: string;
}

interface Unary {
  kind: 'unary';
  op: UnaryOp;
  operand: Expr;
}

interface Binary {
  kind: 'binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

/** Builtin call. `if(cond, a, b)` is a Call like any other. */
interface Call {
  kind: 'call';
  name: string;
  args: Expr[];
}

export type Expr = NumLit | VarRef | Unary | Binary | Call;

/** The only statement form: assignment, possibly compound. */
interface Assign {
  kind: 'assign';
  target: string;
  value: Expr;
}

export type Stmt = Assign;

export interface Program {
  statements: Stmt[];
  /** Every variable read before being written in this program. */
  reads: string[];
  /** Every variable assigned by this program. */
  writes: string[];
}

/** Builtin signatures shared by both backends. -1 arity means variadic. */
export const BUILTINS: Record<string, number> = {
  sin: 1,
  cos: 1,
  tan: 1,
  asin: 1,
  acos: 1,
  atan: 1,
  atan2: 2,
  sinh: 1,
  cosh: 1,
  tanh: 1,
  sqrt: 1,
  sqr: 1,
  invsqrt: 1,
  pow: 2,
  exp: 1,
  log: 1,
  log10: 1,
  abs: 1,
  sign: 1,
  min: 2,
  max: 2,
  clamp: 3,
  floor: 1,
  ceil: 1,
  int: 1,
  frac: 1,
  fmod: 2,
  // Milkdrop / EEL2 logic helpers — all return 0 or 1 except if/sigmoid.
  above: 2,
  below: 2,
  equal: 2,
  band: 2,
  bor: 2,
  bnot: 1,
  if: 3,
  sigmoid: 2,
  // Deterministic randomness: rand(x) hashes x with the scene seed.
  rand: 1,
};

export function analyze(statements: Stmt[]): Program {
  const writes = new Set<string>();
  const reads = new Set<string>();

  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'num':
        return;
      case 'var':
        if (!writes.has(e.name)) reads.add(e.name);
        return;
      case 'unary':
        walk(e.operand);
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'call':
        e.args.forEach(walk);
        return;
    }
  };

  for (const st of statements) {
    walk(st.value);
    writes.add(st.target);
  }

  return { statements, reads: [...reads], writes: [...writes] };
}
