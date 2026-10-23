/**
 * Equation frontend — tokenizer plus Pratt parser producing the IR.
 *
 * The dialect is the Milkdrop/EEL2 subset presets actually use: assignments
 * separated by `;` or newlines, C-style operators, `^` for power, and the
 * function set in BUILTINS. It is deliberately a frontend: an importer for
 * real .milk presets can target the same IR without the rest of the engine
 * knowing this syntax exists.
 */

import { analyze, BUILTINS, type BinaryOp, type Expr, type Program, type Stmt } from './ast';

type TokKind = 'num' | 'ident' | 'op' | 'eof';

interface Token {
  kind: TokKind;
  text: string;
  pos: number;
  line: number;
}

export class ParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`[milkdrop/ir] line ${line}: ${message}`);
    this.name = 'ParseError';
    this.line = line;
  }
}

const MULTI_CHAR_OPS = ['<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%='];
const SINGLE_CHAR_OPS = '+-*/%^<>=!(),;';

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;

  while (i < src.length) {
    const c = src[i];

    if (c === '\n') {
      // Newlines end a statement just like ';' does.
      out.push({ kind: 'op', text: ';', pos: i, line });
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && /[0-9.eE]/.test(src[i])) {
        // Allow exponent sign only directly after e/E.
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-')) i++;
        i++;
      }
      out.push({ kind: 'num', text: src.slice(start, i), pos: start, line });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      out.push({ kind: 'ident', text: src.slice(start, i).toLowerCase(), pos: start, line });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_CHAR_OPS.includes(two)) {
      out.push({ kind: 'op', text: two, pos: i, line });
      i += 2;
      continue;
    }
    if (SINGLE_CHAR_OPS.includes(c)) {
      out.push({ kind: 'op', text: c, pos: i, line });
      i++;
      continue;
    }
    throw new ParseError(`unexpected character '${c}'`, line);
  }

  out.push({ kind: 'eof', text: '', pos: i, line });
  return out;
}

// Binding powers, lowest first.
const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '^': 7,
};

class Parser {
  private toks: Token[];
  private i = 0;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  private peek(): Token {
    return this.toks[this.i];
  }

  private next(): Token {
    return this.toks[this.i++];
  }

  private eat(text: string): boolean {
    if (this.peek().kind === 'op' && this.peek().text === text) {
      this.i++;
      return true;
    }
    return false;
  }

  private expect(text: string): void {
    if (!this.eat(text)) {
      const t = this.peek();
      throw new ParseError(`expected '${text}' but found '${t.text || 'end of input'}'`, t.line);
    }
  }

  parseProgram(): Program {
    const statements: Stmt[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.eat(';')) continue;
      statements.push(this.parseAssignment());
      // A statement must be followed by a separator or the end of input.
      if (this.peek().kind !== 'eof' && !this.eat(';')) {
        const t = this.peek();
        throw new ParseError(`unexpected '${t.text}' after statement`, t.line);
      }
    }
    return analyze(statements);
  }

  private parseAssignment(): Stmt {
    const target = this.next();
    if (target.kind !== 'ident') {
      throw new ParseError(`expected a variable name, found '${target.text}'`, target.line);
    }
    const op = this.next();
    if (op.kind !== 'op' || !['=', '+=', '-=', '*=', '/=', '%='].includes(op.text)) {
      throw new ParseError(`expected an assignment after '${target.text}'`, op.line);
    }
    const value = this.parseExpr(0);
    if (op.text === '=') return { kind: 'assign', target: target.text, value };
    return {
      kind: 'assign',
      target: target.text,
      value: {
        kind: 'binary',
        op: op.text[0] as BinaryOp,
        left: { kind: 'var', name: target.text },
        right: value,
      },
    };
  }

  private parseExpr(minBp: number): Expr {
    let left = this.parseUnary();

    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op') break;
      const bp = BINARY_PRECEDENCE[t.text];
      if (bp === undefined || bp < minBp) break;
      this.next();
      // '^' is right-associative, everything else left.
      const rhs = this.parseExpr(t.text === '^' ? bp : bp + 1);
      left = { kind: 'binary', op: t.text as BinaryOp, left, right: rhs };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && (t.text === '-' || t.text === '!')) {
      this.next();
      return { kind: 'unary', op: t.text, operand: this.parseUnary() };
    }
    if (t.kind === 'op' && t.text === '+') {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.next();

    if (t.kind === 'num') {
      const value = Number(t.text);
      if (!Number.isFinite(value)) throw new ParseError(`bad number '${t.text}'`, t.line);
      return { kind: 'num', value };
    }

    if (t.kind === 'ident') {
      if (this.peek().kind === 'op' && this.peek().text === '(') {
        this.next();
        const args: Expr[] = [];
        if (!this.eat(')')) {
          do {
            args.push(this.parseExpr(0));
          } while (this.eat(','));
          this.expect(')');
        }
        const arity = BUILTINS[t.text];
        if (arity === undefined) throw new ParseError(`unknown function '${t.text}'`, t.line);
        if (arity >= 0 && args.length !== arity) {
          throw new ParseError(
            `'${t.text}' takes ${arity} argument(s), got ${args.length}`,
            t.line,
          );
        }
        return { kind: 'call', name: t.text, args };
      }
      return { kind: 'var', name: t.text };
    }

    if (t.kind === 'op' && t.text === '(') {
      const e = this.parseExpr(0);
      this.expect(')');
      return e;
    }

    throw new ParseError(`unexpected '${t.text || 'end of input'}'`, t.line);
  }
}

/** Parse equation source into the IR. Throws ParseError on bad input. */
export function parseEquations(source: string): Program {
  return new Parser(source).parseProgram();
}
