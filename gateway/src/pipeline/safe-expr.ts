/**
 * pipeline/safe-expr.ts — fail-closed evaluator for pipeline `condition` step expressions.
 *
 * Replaces `new Function`/eval. Evaluates a restricted grammar over JSON LITERALS only:
 * comparisons, boolean logic, arithmetic, parentheses. There are no identifiers, member
 * access, or function calls, so a value interpolated into the expression — even one shaped
 * by an agent/model — can never reach code execution. That "model output flows into eval"
 * path is the #1 agent-framework RCE pattern (Microsoft "prompts become shells", 2026).
 *
 * Context references use `{{context.x}}` placeholders that the caller substitutes for JSON
 * literals BEFORE evaluation (consistent with the rest of Mission Control's pipeline
 * templating). Anything outside the grammar throws — the failure mode is rejection of the
 * expression, never code execution.
 */

type Value = number | string | boolean | null

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }

// Longest-match-first so '===' wins over '==', '<=' over '<', etc.
const OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!']

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '(') { tokens.push({ kind: 'lparen' }); i++; continue }
    if (c === ')') { tokens.push({ kind: 'rparen' }); i++; continue }

    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1]
          if (esc === 'n') { s += '\n'; j += 2 }
          else if (esc === 't') { s += '\t'; j += 2 }
          else if (esc === 'r') { s += '\r'; j += 2 }
          else if (esc === '"') { s += '"'; j += 2 }
          else if (esc === '\\') { s += '\\'; j += 2 }
          else if (esc === '/') { s += '/'; j += 2 }
          else if (esc === 'b') { s += '\b'; j += 2 }
          else if (esc === 'f') { s += '\f'; j += 2 }
          else if (esc === 'u') {
            const hex = src.slice(j + 2, j + 6)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid \\u escape in string literal')
            s += String.fromCharCode(parseInt(hex, 16))
            j += 6
          }
          else throw new Error('invalid escape in string literal')
        } else {
          s += src[j]
          j++
        }
      }
      if (j >= src.length) throw new Error('unterminated string literal')
      tokens.push({ kind: 'str', value: s })
      i = j + 1
      continue
    }

    if (c >= '0' && c <= '9') {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i))
      if (!m) throw new Error('invalid number literal')
      tokens.push({ kind: 'num', value: Number(m[0]) })
      i += m[0].length
      continue
    }

    if (/[a-z]/i.test(c)) {
      const word = /^[a-z]+/i.exec(src.slice(i))![0]
      if (word === 'true') tokens.push({ kind: 'bool', value: true })
      else if (word === 'false') tokens.push({ kind: 'bool', value: false })
      else if (word === 'null') tokens.push({ kind: 'null' })
      else throw new Error(`unexpected identifier "${word}" — conditions may use only {{context.x}} placeholders, literals, and operators`)
      i += word.length
      continue
    }

    const op = OPERATORS.find(o => src.startsWith(o, i))
    if (op) { tokens.push({ kind: 'op', value: op }); i += op.length; continue }

    throw new Error(`unexpected character "${c}" in condition`)
  }
  return tokens
}

// Recursive-descent evaluator. Precedence (low→high): || && equality comparison +- */% unary.
class Evaluator {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  evaluate(): Value {
    const v = this.parseOr()
    if (this.pos !== this.tokens.length) throw new Error('trailing tokens after condition expression')
    return v
  }

  private matchOp(...ops: string[]): string | null {
    const tok = this.tokens[this.pos]
    if (tok && tok.kind === 'op' && ops.includes(tok.value)) { this.pos++; return tok.value }
    return null
  }

  private parseOr(): Value {
    let left = this.parseAnd()
    while (this.matchOp('||')) left = toBool(left) || toBool(this.parseAnd())
    return left
  }

  private parseAnd(): Value {
    let left = this.parseEquality()
    while (this.matchOp('&&')) left = toBool(left) && toBool(this.parseEquality())
    return left
  }

  private parseEquality(): Value {
    let left = this.parseComparison()
    let op: string | null
    while ((op = this.matchOp('===', '!==', '==', '!='))) {
      const eq = this.parseComparison() === left  // strict equality; loose forms map to strict (no coercion)
      left = (op === '===' || op === '==') ? eq : !eq
    }
    return left
  }

  private parseComparison(): Value {
    let left = this.parseAdditive()
    let op: string | null
    while ((op = this.matchOp('<', '>', '<=', '>='))) left = compare(op, left, this.parseAdditive())
    return left
  }

  private parseAdditive(): Value {
    let left = this.parseMultiplicative()
    let op: string | null
    while ((op = this.matchOp('+', '-'))) {
      const right = this.parseMultiplicative()
      if (op === '+') {
        left = (typeof left === 'string' || typeof right === 'string') ? String(left) + String(right) : toNum(left) + toNum(right)
      } else {
        left = toNum(left) - toNum(right)
      }
    }
    return left
  }

  private parseMultiplicative(): Value {
    let left = this.parseUnary()
    let op: string | null
    while ((op = this.matchOp('*', '/', '%'))) {
      const a = toNum(left), b = toNum(this.parseUnary())
      left = op === '*' ? a * b : op === '/' ? a / b : a % b
    }
    return left
  }

  private parseUnary(): Value {
    if (this.matchOp('!')) return !toBool(this.parseUnary())
    if (this.matchOp('-')) return -toNum(this.parseUnary())
    return this.parsePrimary()
  }

  private parsePrimary(): Value {
    const tok = this.tokens[this.pos]
    if (!tok) throw new Error('unexpected end of condition expression')
    if (tok.kind === 'num' || tok.kind === 'str' || tok.kind === 'bool') { this.pos++; return tok.value }
    if (tok.kind === 'null') { this.pos++; return null }
    if (tok.kind === 'lparen') {
      this.pos++
      const v = this.parseOr()
      if (this.tokens[this.pos]?.kind !== 'rparen') throw new Error('missing closing ")" in condition')
      this.pos++
      return v
    }
    throw new Error('unexpected token in condition expression')
  }
}

function toBool(v: Value): boolean { return Boolean(v) }

function toNum(v: Value): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (Number.isNaN(n)) throw new Error(`condition: "${String(v)}" is not a number`)
  return n
}

function compare(op: string, a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b
  }
  const x = toNum(a), y = toNum(b)
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y
}

/** Evaluate a condition expression to a boolean. Throws on anything outside the grammar. */
export function evaluateCondition(expression: string): boolean {
  const tokens = tokenize(expression)
  if (tokens.length === 0) throw new Error('empty condition expression')
  return toBool(new Evaluator(tokens).evaluate())
}
