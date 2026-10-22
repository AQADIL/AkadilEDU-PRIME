export const maximumAnswerCharacters = 64;
const ambiguousLogarithmBase = /\blog_(?:\(|\{|[A-Za-z0-9])|\blog[₀-₟]{2,}|\blog\s*\([^)]*,/u;

export function plainStatementIssues(text: string): string[] {
  const plain = text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*?\$/g, ' ');
  const issues: string[] = [];
  const units = new Set(['km/h', 'm/s', 'm/s²', 'm/s³', 'm/min', 'm/h', 'km/s', 'km/min', 'km/h²', 'cm/s', 'g/cm³', 'kg/m³']);
  const fractions = [...plain.matchAll(/([A-Za-z0-9₀-₉²³]+|\))\s*\/\s*(\(|[A-Za-z0-9√₀-₉²³]+)/gu)];
  if (fractions.some(match => !units.has(match[0].replace(/\s/g, ''))
    && !(match[1]!.length > 3 && match[2]!.length > 3 && /^[A-Za-z]+\s*\/\s*[A-Za-z]+$/.test(match[0])))) {
    issues.push('Дробь в условии записана через /. Перенесите её в блок LaTeX с вертикальной дробью \\frac, сохранив числитель и знаменатель.');
  }
  if (/[A-Za-z0-9)]\s*\^(?:\(|\{|-?\d|[A-Za-z])|[A-Za-z][A-Za-z0-9]*_\{?[A-Za-z0-9]/u.test(plain)) {
    issues.push('Степень или индекс в условии записаны через ^ или _. Оформите выражение блоком LaTeX для изображения.');
  }
  if (/[A-Za-z][₀-₟]{3,}/u.test(plain)) {
    issues.push('Длинные индексы в условии плохо читаются. Оформите выражение блоком LaTeX для изображения.');
  }
  if (ambiguousLogarithmBase.test(plain)) {
    issues.push('Основание логарифма должно быть отчётливым нижним индексом. Используйте LaTeX \\log_{основание}\\left(аргумент\\right) в формуле для изображения; записи log_(...) и сложные Unicode-индексы недопустимы.');
  }
  if (/√\s*\([^\n)]{3,}\)|\bsqrt\s*\(/u.test(plain)) {
    issues.push('Корень со сложным подкоренным выражением требует блока LaTeX с \\sqrt для изображения.');
  }
  const symbols = plain.match(/[=<>≤≥+−×÷√²³⁴⁵⁶⁷⁸⁹₀-₉∑∫^]/gu) ?? [];
  let depth = 0;
  let maximumDepth = 0;
  for (const character of plain) {
    if (character === '(' || character === '[' || character === '{') maximumDepth = Math.max(maximumDepth, ++depth);
    else if (character === ')' || character === ']' || character === '}') depth = Math.max(0, depth - 1);
  }
  const equations = plain.split(/\r?\n/).filter(line => /[=≤≥]/u.test(line)).length;
  if ((symbols.length >= 12 && plain.length >= 70) || (maximumDepth >= 3 && symbols.length >= 4) || equations >= 2) {
    issues.push('Условие содержит плотную формулу или систему, которая плохо читается обычным текстом. Перенесите математику в LaTeX, оставив переведённую инструкцию отдельно.');
  }
  return issues;
}

export function questionPresentationIssues(translations: Record<string, { text: string; options: readonly string[] }>): string[] {
  const issues: string[] = [];
  for (const [language, content] of Object.entries(translations)) {
    issues.push(...plainStatementIssues(content.text).map(issue => `${language}: ${issue}`));
    for (const [index, option] of content.options.entries()) {
      if (ambiguousLogarithmBase.test(option)) {
        issues.push(`${language}: вариант ${index + 1} содержит нечитаемое основание логарифма. Переформулируйте вопрос для короткого числового ответа или промежутка; варианты остаются обычным Unicode-текстом без LaTeX и картинок.`);
      }
      if (option.length > maximumAnswerCharacters || /[\r\n\u0085\u2028\u2029]/u.test(option)) {
        issues.push(`${language}: вариант ${index + 1} должен быть одной строкой до ${maximumAnswerCharacters} символов. Переформулируйте задание для короткого ответа; не обрезайте ответ и не переносите варианты в картинку.`);
      }
    }
  }
  return issues;
}
