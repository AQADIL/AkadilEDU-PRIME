import { schoolMathTerminology } from '../public/i18n.js';
import type { Diagram } from './schema.js';

export const maximumAnswerCharacters = 64;
const schoolNotationPrefix = 'Школьные обозначения:';
const ambiguousLogarithmBase = /\blog_(?:\(|\{|[A-Za-z0-9])|\blog[₀-₟]{2,}|\blog\s*\([^)]*,/u;

export function hasSchoolNotationIssue(issues: readonly string[]): boolean {
  return issues.some(issue => issue.includes(schoolNotationPrefix));
}

export function schoolNotationIssues(language: string, text: string): string[] {
  if (language !== 'kk' && language !== 'ru' && language !== 'en') return [];
  const terms = schoolMathTerminology[language];
  const issues: string[] = [];
  if (language !== 'en') {
    if (/\b(?:gcd|gcf|hcf|lcm)\b/iu.test(text)) {
      issues.push(`${schoolNotationPrefix} вместо gcd/gcf/hcf и lcm используйте ${terms.gcd} (${terms.gcdName}) и ${terms.lcm} (${terms.lcmName}), включая формулы на изображениях. Сохраните математический смысл.`);
    }
    if (/\b(?:tan|cot|arctan|arccot)\b/iu.test(text)) {
      issues.push(`${schoolNotationPrefix} используйте привычные ${terms.tangent}, ${terms.cotangent}, arctg и arcctg вместо английских tan/cot/arctan/arccot.`);
    }
    if (/\b(?:min|max)\s*[({]/iu.test(text)) {
      issues.push(`${schoolNotationPrefix} замените функции min/max понятными словами «${terms.minimum}»/«${terms.maximum}» или поясните выбор меньшего/большего числа обычным текстом без этих функций.`);
    }
  }
  if (/\\(?:bmod|pmod|mod)\b|\b(?:mod|modulo)\b/iu.test(text)) {
    issues.push(`${schoolNotationPrefix} не требуйте знания mod или формальных сравнений. Используйте «${terms.remainder}», делимость и понятное школьное рассуждение об остатках; сохраните все числа и смысл.`);
  }
  if (/\b(?:ceil|floor|argmin|argmax|atan2|pow)\b/iu.test(text)) {
    issues.push(`${schoolNotationPrefix} замените программные/вузовские функции ceil/floor/argmin/argmax/atan2/pow школьной формулировкой и объясните нужное действие.`);
  }
  return issues.map(issue => `${language}: ${issue}`);
}

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

export function questionPresentationIssues(translations: Record<string, { text: string; options: readonly string[]; explanation?: string; hint?: string }>, diagram?: Diagram | null): string[] {
  const issues: string[] = [];
  for (const [language, content] of Object.entries(translations)) {
    const localLanguage = language === 'kk' || language === 'ru' || language === 'en' ? language : null;
    const diagramText = diagram && localLanguage ? [diagram.caption[localLanguage],
      ...diagram.points.map(point => point.label[localLanguage]),
      ...(diagram.angles ?? []).map(angle => angle.label[localLanguage]),
      ...diagram.labels.map(label => label.text[localLanguage])] : [];
    for (const text of [content.text, ...content.options, content.explanation, content.hint, ...diagramText]) {
      if (text) issues.push(...schoolNotationIssues(language, text));
    }
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
  return [...new Set(issues)];
}
