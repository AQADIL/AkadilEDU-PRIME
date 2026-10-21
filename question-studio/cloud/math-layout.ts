export class MathLayoutError extends Error {}

type Text = { kind: 'text'; text: string };
type Row = { kind: 'row'; items: Node[] };
type Node = Text | Row | { kind: 'fraction'; numerator: Node; denominator: Node; bar: boolean }
  | { kind: 'root'; body: Node; index?: Node }
  | { kind: 'script'; body: Node; upper?: Node; lower?: Node }
  | { kind: 'fenced'; body: Node; left: string; right: string }
  | { kind: 'overline'; body: Node }
  | { kind: 'table'; rows: Node[][]; left: string; right: string };
export type MathPrimitive = { kind: 'text'; text: string; x: number; y: number; width: number; height: number; fontSize: number }
  | { kind: 'line'; x: number; y: number; x2: number; y2: number };
export type MathLayout = { width: number; height: number; baseline: number; primitives: MathPrimitive[] };

const symbols: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', vartheta: 'ϑ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', ell: 'ℓ', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Pi: 'Π', Gamma: 'Γ', Theta: 'Θ',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', infty: '∞', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩',
  emptyset: '∅', varnothing: '∅', angle: '∠', triangle: '△', perpendicular: '⊥', perp: '⊥', parallel: '∥',
  circ: '°', degree: '°', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftrightarrow: '⇔',
  ldots: '…', cdots: '⋯', dots: '…', vert: '|', lvert: '|', rvert: '|', Vert: '‖', lVert: '‖', rVert: '‖',
  lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', tg: 'tg', ctg: 'ctg', sec: 'sec', csc: 'csc',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan', arctg: 'arctg', ln: 'ln', log: 'log', lg: 'lg',
  lim: 'lim', min: 'min', max: 'max', det: 'det', exp: 'exp', sum: '∑', prod: '∏', int: '∫',
};

class Parser {
  private offset = 0;
  private depth = 0;
  constructor(private readonly source: string) {
    if (source.length > 4000) throw new MathLayoutError('Формула слишком длинная для читаемого изображения');
  }
  private whitespace() { while (/\s/.test(this.source[this.offset] || '') && this.offset < this.source.length) this.offset++; }
  private starts(value: string) { return this.source.startsWith(value, this.offset); }
  private command() {
    this.offset++;
    const match = this.source.slice(this.offset).match(/^[A-Za-z]+|^./s);
    if (!match) throw new MathLayoutError('Незавершённая команда LaTeX');
    this.offset += match[0].length;
    return match[0];
  }
  private group(): Node {
    this.whitespace();
    if (this.source[this.offset] !== '{') return this.atom();
    this.offset++;
    const body = this.row(['}']);
    if (this.source[this.offset++] !== '}') throw new MathLayoutError('Незакрытая группа LaTeX');
    return body;
  }
  private literalGroup(): string {
    this.whitespace();
    if (this.source[this.offset++] !== '{') throw new MathLayoutError('Текстовая команда требует группу в фигурных скобках');
    const start = this.offset;
    while (this.offset < this.source.length && this.source[this.offset] !== '}') {
      if (/[{\\]/.test(this.source[this.offset]!)) throw new MathLayoutError('Вложенные команды в текстовой подписи не поддерживаются; используйте Unicode');
      this.offset++;
    }
    if (this.offset >= this.source.length) throw new MathLayoutError('Незакрытая текстовая группа');
    return this.source.slice(start, this.offset++);
  }
  private delimiter(): string {
    this.whitespace();
    const char = this.source[this.offset];
    if (char === '\\') {
      const command = this.command();
      if (command === '{' || command === '}') return command;
      if (symbols[command]) return symbols[command]!;
      throw new MathLayoutError(`Неподдерживаемый разделитель \\${command}`);
    }
    this.offset++;
    if (char === '.') return '';
    if (!char || !'()[]{}|'.includes(char)) throw new MathLayoutError('Некорректный разделитель формулы');
    return char;
  }
  private table(environment: string): Node {
    const fences: Record<string, [string, string]> = {
      cases: ['{', ''], aligned: ['', ''], gathered: ['', ''], matrix: ['', ''],
      pmatrix: ['(', ')'], bmatrix: ['[', ']'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'],
    };
    const fence = fences[environment];
    if (!fence) throw new MathLayoutError(`Среда ${environment} не поддерживается; используйте cases, aligned или matrix`);
    const rows: Node[][] = [[]];
    const ending = `\\end{${environment}}`;
    while (this.offset < this.source.length) {
      rows[rows.length - 1]!.push(this.row(['&', '\\\\', ending]));
      if (this.starts(ending)) { this.offset += ending.length; break; }
      if (this.starts('\\\\')) { this.offset += 2; rows.push([]); }
      else if (this.starts('&')) this.offset++;
      else throw new MathLayoutError(`Незакрытая среда ${environment}`);
    }
    if (!this.source.slice(0, this.offset).endsWith(ending)) throw new MathLayoutError(`Незакрытая среда ${environment}`);
    if (rows.length > 8 || rows.some(row => row.length > 6)) throw new MathLayoutError('Система или матрица слишком велика для читаемого изображения');
    return { kind: 'table', rows, left: fence[0], right: fence[1] };
  }
  private atom(): Node {
    this.whitespace();
    if (++this.depth > 24) throw new MathLayoutError('Слишком глубокая вложенность формулы');
    try {
      const char = this.source[this.offset];
      if (!char) throw new MathLayoutError('Незавершённая формула');
      if (char === '{') return this.group();
      if (/[}^_&$]/.test(char)) throw new MathLayoutError(`Неожиданный символ ${char} в формуле`);
      if (char !== '\\') { this.offset++; return { kind: 'text', text: char === '-' ? '−' : char }; }
      const command = this.command();
      if (['frac', 'dfrac', 'tfrac', 'binom'].includes(command)) {
        const fraction: Node = { kind: 'fraction', numerator: this.group(), denominator: this.group(), bar: command !== 'binom' };
        return command === 'binom' ? { kind: 'fenced', body: fraction, left: '(', right: ')' } : fraction;
      }
      if (command === 'sqrt') {
        this.whitespace();
        let index: Node | undefined;
        if (this.source[this.offset] === '[') {
          this.offset++;
          index = this.row([']']);
          if (this.source[this.offset++] !== ']') throw new MathLayoutError('Незакрытый индекс корня');
        }
        return { kind: 'root', body: this.group(), index };
      }
      if (command === 'left') {
        const left = this.delimiter();
        const body = this.row(['\\right']);
        if (!this.starts('\\right')) throw new MathLayoutError('Отсутствует \\right после \\left');
        this.offset += 6;
        return { kind: 'fenced', body, left, right: this.delimiter() };
      }
      if (command === 'begin') return this.table(this.literalGroup());
      if (['overline', 'bar'].includes(command)) return { kind: 'overline', body: this.group() };
      if (['text', 'textrm', 'mathrm', 'operatorname', 'mbox'].includes(command)) return { kind: 'text', text: this.literalGroup() };
      if (command === 'mathbb') {
        const value = this.literalGroup();
        const sets: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' };
        if (!sets[value]) throw new MathLayoutError('Используйте Unicode для этого математического символа');
        return { kind: 'text', text: sets[value]! };
      }
      if (['displaystyle', 'textstyle', 'limits', 'nolimits'].includes(command)) return { kind: 'text', text: '' };
      if ([',', ';', ':', ' ', 'quad', 'qquad'].includes(command)) return { kind: 'text', text: command === 'qquad' ? '    ' : ' ' };
      if (command === '!') return { kind: 'text', text: '' };
      if (['{', '}', '%', '#', '_', '&'].includes(command)) return { kind: 'text', text: command };
      if (symbols[command]) return { kind: 'text', text: symbols[command]! };
      throw new MathLayoutError(`Команда \\${command} не поддерживается облачным рендерером; переформулируйте с поддерживаемой математической записью без изменения смысла`);
    } finally { this.depth--; }
  }
  private row(stops: string[] = []): Row {
    const items: Node[] = [];
    while (this.offset < this.source.length) {
      this.whitespace();
      if (this.offset >= this.source.length || stops.some(stop => this.starts(stop))) break;
      let body = this.atom();
      let upper: Node | undefined, lower: Node | undefined;
      this.whitespace();
      while (this.source[this.offset] === '^' || this.source[this.offset] === '_') {
        const type = this.source[this.offset++];
        if (type === '^') { if (upper) throw new MathLayoutError('Повторный верхний индекс'); upper = this.group(); }
        else { if (lower) throw new MathLayoutError('Повторный нижний индекс'); lower = this.group(); }
        this.whitespace();
      }
      if (upper || lower) body = { kind: 'script', body, upper, lower };
      const previous = items.at(-1);
      if (previous?.kind === 'text' && body.kind === 'text') previous.text += body.text;
      else items.push(body);
    }
    return { kind: 'row', items };
  }
  parse(): Node { return this.row(); }
}

const translated = (layout: MathLayout, dx: number, dy: number): MathPrimitive[] => layout.primitives.map(item =>
  item.kind === 'text' ? { ...item, x: item.x + dx, y: item.y + dy } : { ...item, x: item.x + dx, y: item.y + dy, x2: item.x2 + dx, y2: item.y2 + dy });
const serifWidths: Record<string, number> = {
  a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278, k: 500, l: 278,
  m: 778, n: 500, o: 500, p: 500, q: 500, r: 333, s: 389, t: 278, u: 500, v: 500, w: 722, x: 500, y: 500, z: 444,
  A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333, J: 389, K: 722, L: 611,
  M: 889, N: 722, O: 722, P: 556, Q: 722, R: 667, S: 556, T: 611, U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
  '+': 564, '=': 564, '−': 564, '<': 564, '>': 564, '(': 333, ')': 333, '[': 333, ']': 333,
  '.': 250, ',': 250, ':': 278, ';': 278, '|': 200, '°': 400, '/': 278, '!': 333, '%': 833,
};
const measure = (text: string, size: number) => [...text].reduce((sum, char) => sum + size *
  (serifWidths[char] ?? (/\s/.test(char) ? 250 : /[0-9]/.test(char) ? 500 : /[ЖШЩЮФ]/.test(char) ? 900 : 580)) / 1000, 0);

function typeset(node: Node, size: number): MathLayout {
  if (node.kind === 'text') {
    const width = measure(node.text, size), height = size * 1.35 + 8;
    return { width, height, baseline: size + 4, primitives: node.text ? [{ kind: 'text', text: node.text, x: -4, y: 0, width: width + 8, height, fontSize: size }] : [] };
  }
  if (node.kind === 'row') {
    const parts = node.items.map(item => typeset(item, size));
    const baseline = Math.max(0, ...parts.map(part => part.baseline));
    const bottom = Math.max(0, ...parts.map(part => part.height - part.baseline));
    let width = 0;
    const primitives: MathPrimitive[] = [];
    for (const part of parts) { primitives.push(...translated(part, width, baseline - part.baseline)); width += part.width; }
    return { width, height: baseline + bottom, baseline, primitives };
  }
  if (node.kind === 'fraction') {
    const numerator = typeset(node.numerator, size * 0.86), denominator = typeset(node.denominator, size * 0.86);
    const width = Math.max(numerator.width, denominator.width) + 10, gap = size * 0.14;
    const lineY = numerator.height + gap;
    return { width, height: numerator.height + denominator.height + gap * 2, baseline: lineY + size * 0.26,
      primitives: [...translated(numerator, (width - numerator.width) / 2, 0),
        ...(node.bar ? [{ kind: 'line' as const, x: 2, y: lineY, x2: width - 2, y2: lineY }] : []),
        ...translated(denominator, (width - denominator.width) / 2, lineY + gap)] };
  }
  if (node.kind === 'script') {
    const body = typeset(node.body, size), upper = node.upper ? typeset(node.upper, size * 0.65) : undefined,
      lower = node.lower ? typeset(node.lower, size * 0.65) : undefined;
    const lift = upper ? Math.max(0, upper.height - body.baseline + size * 0.15, upper.baseline - body.baseline + size * 0.45) : 0;
    const lowerY = lift + body.baseline - size * 0.1;
    return { width: body.width + Math.max(upper?.width || 0, lower?.width || 0),
      height: Math.max(lift + body.height, lowerY + (lower?.height || 0)), baseline: lift + body.baseline,
      primitives: [...translated(body, 0, lift), ...(upper ? translated(upper, body.width, 0) : []),
        ...(lower ? translated(lower, body.width, lowerY) : [])] };
  }
  if (node.kind === 'root') {
    const body = typeset(node.body, size), index = node.index ? typeset(node.index, size * 0.5) : undefined;
    const left = size * 0.65 + (index?.width || 0), top = size * 0.12;
    const baseline = body.baseline + top;
    const x = left - size * 0.65;
    return { width: left + body.width + 4, height: body.height + top, baseline,
      primitives: [...translated(body, left, top), ...(index ? translated(index, 0, 0) : []),
        { kind: 'line', x, y: baseline - size * 0.35, x2: x + size * 0.18, y2: baseline - size * 0.5 },
        { kind: 'line', x: x + size * 0.18, y: baseline - size * 0.5, x2: x + size * 0.38, y2: body.height + top - 3 },
        { kind: 'line', x: x + size * 0.38, y: body.height + top - 3, x2: left - 2, y2: 2 },
        { kind: 'line', x: left - 2, y: 2, x2: left + body.width, y2: 2 }] };
  }
  if (node.kind === 'overline') {
    const body = typeset(node.body, size), top = size * 0.12;
    return { ...body, height: body.height + top, baseline: body.baseline + top,
      primitives: [...translated(body, 0, top), { kind: 'line', x: 3, y: 1, x2: body.width - 3, y2: 1 }] };
  }
  if (node.kind === 'table') {
    const rows = node.rows.map(row => row.map(cell => typeset(cell, size)));
    const columns = Math.max(...rows.map(row => row.length));
    const widths = Array.from({ length: columns }, (_, index) => Math.max(0, ...rows.map(row => row[index]?.width || 0)));
    const primitives: MathPrimitive[] = [];
    let y = 0;
    for (const row of rows) {
      const baseline = Math.max(...row.map(cell => cell.baseline));
      const bottom = Math.max(...row.map(cell => cell.height - cell.baseline));
      let x = 0;
      row.forEach((cell, index) => { primitives.push(...translated(cell, x, y + baseline - cell.baseline)); x += widths[index]! + size * 0.5; });
      y += baseline + bottom + size * 0.25;
    }
    const body = { width: widths.reduce((sum, width) => sum + width, 0) + (columns - 1) * size * 0.5,
      height: y - size * 0.25, baseline: y / 2 + size * 0.25, primitives };
    return fenced(body, node.left, node.right, size);
  }
  return fenced(typeset(node.body, size), node.left, node.right, size);
}

function fenced(body: MathLayout, left: string, right: string, size: number): MathLayout {
  const height = Math.max(body.height, size * 1.5), fenceSize = Math.max(size, height * 0.72);
  const leftLayout = typeset({ kind: 'text', text: left }, fenceSize), rightLayout = typeset({ kind: 'text', text: right }, fenceSize);
  const totalHeight = Math.max(height, left ? leftLayout.height : 0, right ? rightLayout.height : 0);
  const offset = (totalHeight - body.height) / 2;
  return { width: leftLayout.width + body.width + rightLayout.width, height: totalHeight, baseline: body.baseline + offset,
    primitives: [...translated(leftLayout, 0, (totalHeight - leftLayout.height) / 2), ...translated(body, leftLayout.width, offset),
      ...translated(rightLayout, leftLayout.width + body.width, (totalHeight - rightLayout.height) / 2)] };
}

export function layoutStatement(text: string, width: number, fontSize = 24): MathLayout {
  const tokens = text.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g).filter(Boolean);
  const lines: MathLayout[][] = [[]];
  let used = 0;
  for (const token of tokens) {
    const math = token.startsWith('$');
    const parts = math ? [token] : token.split(/(\s+)/g).filter(Boolean);
    for (const part of parts) {
      if (!math && part.includes('\n')) { lines.push([]); used = 0; continue; }
      const node: Node = math ? new Parser(part.replace(/^\$\$?|\$\$?$/g, '')).parse() : { kind: 'text', text: part };
      const layout = typeset(node, fontSize);
      if (layout.width > width) throw new MathLayoutError('Формула шире изображения; разделите её на строки через aligned, сохранив все данные');
      if (used + layout.width > width && lines.at(-1)!.length) { lines.push([]); used = 0; }
      lines.at(-1)!.push(layout); used += layout.width;
      if (math && token.startsWith('$$')) { lines.push([]); used = 0; }
    }
  }
  let y = 0, totalWidth = 0;
  const primitives: MathPrimitive[] = [];
  for (const line of lines.filter(row => row.length)) {
    const baseline = Math.max(...line.map(part => part.baseline));
    const bottom = Math.max(...line.map(part => part.height - part.baseline));
    let x = 0;
    for (const part of line) { primitives.push(...translated(part, x, y + baseline - part.baseline)); x += part.width; }
    totalWidth = Math.max(totalWidth, x); y += baseline + bottom + fontSize * 0.35;
  }
  if (!primitives.length) throw new MathLayoutError('Изображение условия не содержит текста или формул');
  if (primitives.length > 600) throw new MathLayoutError('Формула содержит слишком много элементов для читаемого изображения');
  return { width: totalWidth, height: Math.max(0, y - fontSize * 0.35), baseline: 0, primitives };
}
