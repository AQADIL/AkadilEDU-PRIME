import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import sharp from 'sharp';
import { config, studioRoot } from './config.js';
import { languages, type Diagram, type Language, type StoredQuestion } from './schema.js';

let browser: Browser | undefined;
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export async function closeRenderer() { await browser?.close(); browser = undefined; }

function diagramSvg(diagram: Diagram, language: Language) {
  const byId = new Map(diagram.points.map(p => [p.id, p]));
  const xs = diagram.points.map(p => p.x), ys = diagram.points.map(p => p.y);
  for (const circle of diagram.circles) {
    const center = byId.get(circle.center)!;
    xs.push(center.x - circle.radius, center.x + circle.radius);
    ys.push(center.y - circle.radius, center.y + circle.radius);
  }
  for (const label of diagram.labels) { xs.push(label.x); ys.push(label.y); }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(620 / Math.max(maxX - minX, 1), 400 / Math.max(maxY - minY, 1));
  const offsetX = 380 - (minX + maxX) * scale / 2;
  const offsetY = 240 + (minY + maxY) * scale / 2;
  const x = (value: number) => (offsetX + value * scale).toFixed(3);
  const y = (value: number) => (offsetY - value * scale).toFixed(3);
  const polygons = diagram.polygons.map(p => `<polygon points="${p.vertices.map(id => {
    const point = byId.get(id)!; return `${x(point.x)},${y(point.y)}`;
  }).join(' ')}" fill="${p.fill ? '#e8eef7' : 'none'}" stroke="#182840" stroke-width="2"/>`).join('');
  const circles = diagram.circles.map(c => {
    const center = byId.get(c.center)!;
    return `<circle cx="${x(center.x)}" cy="${y(center.y)}" r="${(c.radius * scale).toFixed(3)}" fill="none" stroke="#182840" stroke-width="2"/>`;
  }).join('');
  const lines = diagram.segments.map(s => {
    const a = byId.get(s.from)!, b = byId.get(s.to)!;
    return `<line x1="${x(a.x)}" y1="${y(a.y)}" x2="${x(b.x)}" y2="${y(b.y)}" stroke="#182840" stroke-width="2" ${s.dashed ? 'stroke-dasharray="7 6"' : ''}/>`;
  }).join('');
  const centerX = diagram.points.reduce((sum, p) => sum + p.x, 0) / diagram.points.length;
  const centerY = diagram.points.reduce((sum, p) => sum + p.y, 0) / diagram.points.length;
  const points = diagram.points.filter(p => p.label[language]).map(p => {
    const dx = p.x - centerX, dy = p.y - centerY;
    const labelX = Math.max(80, Math.min(680, Number(x(p.x)) + (dx > 0 ? 10 : -10)));
    const labelY = Number(y(p.y)) + (dy > 0 ? -16 : 24);
    return `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="3" fill="#182840"/><text x="${labelX}" y="${labelY}" text-anchor="middle" stroke="white" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${escape(p.label[language])}</text>`;
  }).join('');
  const labels = diagram.labels.map(l => `<text x="${x(l.x)}" y="${y(l.y)}" text-anchor="middle">${escape(l.text[language])}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 500" role="img"><g font-family="Arial,sans-serif" font-size="18" fill="#182840">${polygons}${circles}${lines}${points}${labels}</g></svg>`;
}

export async function renderQuestion(question: StoredQuestion): Promise<Record<Language, string> | null> {
  if (!question.diagram && !languages.some(lang => /\$|\\[A-Za-z]+/.test(question.translations[lang].text))) return null;
  browser ||= await chromium.launch({ channel: config.browserChannel, headless: true });
  const directory = path.join(config.dataDir, 'media');
  await mkdir(directory, { recursive: true });
  const result = {} as Record<Language, string>;
  for (const language of languages) {
    const page = await browser.newPage({ viewport: { width: 840, height: 1000 }, deviceScaleFactor: 1.5 });
    try {
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === config.origin) await route.continue(); else await route.abort();
      });
      const text = question.translations[language].text;
      const drawing = question.diagram ? diagramSvg(question.diagram, language) : '';
      const caption = question.diagram?.caption[language] || '';
      await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8">
        <link rel="stylesheet" href="${config.origin}/vendor/katex/katex.min.css">
        <style>body{margin:0;background:white;color:#182840;font:22px/1.65 Arial,sans-serif}
        article{box-sizing:border-box;width:840px;padding:36px}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
        svg{display:block;width:100%;margin-top:24px}.caption{font-size:17px;margin-top:8px;color:#42506a}
        .katex{font-size:1.1em}</style></head><body><article><p id="statement">${escape(text)}</p>
        ${drawing}${caption ? `<p class="caption">${escape(caption)}</p>` : ''}</article></body></html>`, { waitUntil: 'networkidle' });
      if (/\$/.test(text)) {
        await page.addScriptTag({ path: path.join(studioRoot, 'node_modules/katex/dist/katex.min.js') });
        await page.addScriptTag({ path: path.join(studioRoot, 'node_modules/katex/dist/contrib/auto-render.min.js') });
        await page.evaluate(() => {
          const renderer = (globalThis as unknown as { renderMathInElement: (element: Element, options: object) => void }).renderMathInElement;
          renderer(document.getElementById('statement')!, {
            delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
            throwOnError: true, trust: false, maxExpand: 1000, strict: 'error',
            errorCallback: (message: string) => { throw new Error(message); },
          });
        });
      }
      await page.evaluate(() => document.fonts.ready);
      const height = await page.locator('article').evaluate(element => element.scrollHeight);
      if (height > 6000) throw new Error('Question image exceeds readable size');
      const filename = path.join(directory, `${question.id}-${language}.png`);
      const pixels = await page.locator('article').screenshot();
      await sharp(pixels).png({ compressionLevel: 9, palette: true, colours: 64 }).toFile(filename);
      result[language] = filename;
      question.translations[language].localImageUrl = `/media/${question.id}-${language}.png`;
    } finally { await page.close(); }
  }
  return result;
}
