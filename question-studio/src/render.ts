import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import sharp from 'sharp';
import { config, studioRoot } from './config.js';
import { languages, type Language, type StoredQuestion } from './schema.js';
import { diagramSvg } from './diagram.js';
import { arrangeDiagramLabels } from './diagramLayout.js';

let browser: Browser | undefined;
export class DiagramLayoutError extends Error {}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export async function closeRenderer() { await browser?.close(); browser = undefined; }

export async function renderQuestion(question: StoredQuestion): Promise<Record<Language, string> | null> {
  if (!question.diagram && !languages.some(lang => /\$|\\[A-Za-z]+/.test(question.translations[lang].text))) return null;
  browser ||= await chromium.launch({ channel: config.browserChannel, headless: true });
  const directory = path.join(config.dataDir, 'media');
  await mkdir(directory, { recursive: true });
  const result = {} as Record<Language, string>;
  const rendered = new Map<string, string>();
  for (const language of languages) {
    const translation = question.translations[language];
    const text = translation.text;
    const containsStatement = /\$|\\[A-Za-z]+/.test(text);
    const drawing = question.diagram ? diagramSvg(question.diagram, language) : '';
    const signature = JSON.stringify([containsStatement ? text : '', drawing]);
    const existing = rendered.get(signature);
    translation.imageContainsStatement = containsStatement;
    if (existing) {
      result[language] = existing;
      translation.localImageUrl = `/media/${path.basename(existing)}`;
      continue;
    }
    const page = await browser.newPage({ viewport: { width: 840, height: 1000 }, deviceScaleFactor: 1.5 });
    try {
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === config.origin) await route.continue(); else await route.abort();
      });
      await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8">
        ${containsStatement ? `<link rel="stylesheet" href="${config.origin}/vendor/katex/katex.min.css">` : ''}
        <style>body{margin:0;background:white;color:#182840;font:22px/1.65 Arial,sans-serif}
        article{box-sizing:border-box;width:840px;padding:36px}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
        svg{display:block;width:100%}#statement+svg{margin-top:24px}
        .katex{font-size:1.1em}</style></head><body><article>${containsStatement ? `<p id="statement">${escape(text)}</p>` : ''}
        ${drawing}</article></body></html>`, { waitUntil: 'networkidle' });
      if (containsStatement && /\$/.test(text)) {
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
      if (question.diagram) {
        try { await page.evaluate(arrangeDiagramLabels); }
        catch (error) {
          if (error instanceof Error && /Diagram labels? (overlap|is too long)/.test(error.message)) {
            throw new DiagramLayoutError('Подписи чертежа перекрываются или не помещаются в изображение.');
          }
          throw error;
        }
      }
      const height = await page.locator('article').evaluate(element => element.scrollHeight);
      if (height > 6000) throw new Error('Question image exceeds readable size');
      const filename = path.join(directory, `${question.id}-${language}.png`);
      const pixels = await page.locator('article').screenshot();
      await sharp(pixels).png({ compressionLevel: 9, palette: true, colours: 64 }).toFile(filename);
      result[language] = filename;
      rendered.set(signature, filename);
      translation.localImageUrl = `/media/${path.basename(filename)}`;
    } finally { await page.close(); }
  }
  return result;
}
