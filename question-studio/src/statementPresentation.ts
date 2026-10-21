export function statementPresentation(text: string) {
  const blocks = [...text.matchAll(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g)];
  if (!blocks.length) return { imageText: '', displayText: text, containsStatement: false };
  const first = blocks[0]!;
  const prefix = text.slice(0, first.index).trim();
  const remainder = text.slice(first.index).replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, '');
  if (prefix && !/\$|\\[A-Za-z]+/.test(prefix) && /^[\s.,;:]*$/.test(remainder)) {
    return { imageText: text.slice(first.index).trim(), displayText: prefix, containsStatement: false };
  }
  return { imageText: text, displayText: text, containsStatement: true };
}
