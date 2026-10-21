import { config } from './config.js';
import { CloudYieldError } from './provider.js';
import { diagramSchema, languages, type Diagram, type Language, type StoredQuestion } from '../src/schema.js';
import { statementPresentation } from '../src/statementPresentation.js';
import { layoutStatement, MathLayoutError } from './math-layout.js';
import { combineQuestionPng, cropQuestionPng } from './png.js';

export class QuestionRenderError extends Error {}
export class DiagramLayoutError extends QuestionRenderError {}
type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };
type Request = Record<string, unknown>;
const ink = { red: 0.08, green: 0.08, blue: 0.08 };
const fill = { red: 0.89, green: 0.89, blue: 0.89 };
const white = { red: 1, green: 1, blue: 1 };
const length = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function triangulate(vertices: Point[]): [Point, Point, Point][] {
  const remaining = vertices.slice();
  const area = remaining.reduce((sum, point, index) => {
    const next = remaining[(index + 1) % remaining.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(area) < 1e-6) throw new DiagramLayoutError('Вырожденный многоугольник');
  const direction = Math.sign(area);
  const result: [Point, Point, Point][] = [];
  while (remaining.length > 3) {
    let removed = false;
    for (let i = 0; i < remaining.length; i++) {
      const previousIndex = (i + remaining.length - 1) % remaining.length;
      const nextIndex = (i + 1) % remaining.length;
      const a = remaining[previousIndex]!, b = remaining[i]!, c = remaining[nextIndex]!;
      if (cross(a, b, c) * direction <= 1e-8) continue;
      const contains = remaining.some((point, index) => index !== previousIndex && index !== i && index !== nextIndex &&
        cross(a, b, point) * direction >= -1e-8 && cross(b, c, point) * direction >= -1e-8 && cross(c, a, point) * direction >= -1e-8);
      if (contains) continue;
      result.push([a, b, c]);
      remaining.splice(i, 1);
      removed = true;
      break;
    }
    if (!removed) throw new DiagramLayoutError('Невозможно заполнить самопересекающийся многоугольник');
  }
  result.push([remaining[0]!, remaining[1]!, remaining[2]!]);
  return result;
}

function renderer(diagram: Diagram, language: Language, pageId: string, width: number, height: number): Request[] {
  const requests: Request[] = [];
  let serial = 0;
  const nextId = () => `studio_${Utilities.getUuid().replace(/-/g, '').slice(0, 12)}_${serial++}`;
  const source = new Map(diagram.points.map(point => [point.id, point]));
  const lookup = (id: string) => {
    const point = source.get(id);
    if (!point) throw new DiagramLayoutError(`Неизвестная точка ${id}`);
    return point;
  };
  const xs = diagram.points.map(point => point.x), ys = diagram.points.map(point => point.y);
  for (const circle of diagram.circles) {
    const center = lookup(circle.center);
    xs.push(center.x - circle.radius, center.x + circle.radius);
    ys.push(center.y - circle.radius, center.y + circle.radius);
  }
  for (const arc of diagram.arcs) {
    const center = lookup(arc.center);
    xs.push(center.x - arc.radiusX, center.x + arc.radiusX);
    ys.push(center.y - arc.radiusY, center.y + arc.radiusY);
  }
  for (const label of diagram.labels) { xs.push(label.x); ys.push(label.y); }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((width - 170) / Math.max(maxX - minX, 1), (height - 120) / Math.max(maxY - minY, 1));
  if (!(scale > 0)) throw new DiagramLayoutError('Недопустимый размер страницы');
  const map = (point: Point): Point => ({ x: width / 2 + (point.x - (minX + maxX) / 2) * scale,
    y: height / 2 - (point.y - (minY + maxY) / 2) * scale });
  const position = (id: string) => map(lookup(id));
  const transform = (x: number, y: number) => ({ scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: x, translateY: y, unit: 'PT' });
  function shape(type: string, box: Box, color: typeof ink | null, border: boolean): string {
    const id = nextId();
    requests.push({ createShape: { objectId: id, shapeType: type, elementProperties: { pageObjectId: pageId,
      size: { width: { magnitude: box.width, unit: 'PT' }, height: { magnitude: box.height, unit: 'PT' } }, transform: transform(box.x, box.y) } } });
    requests.push({ updateShapeProperties: { objectId: id, shapeProperties: {
      shapeBackgroundFill: color ? { solidFill: { color: { rgbColor: color }, alpha: 1 } } : { propertyState: 'NOT_RENDERED' },
      outline: border ? { solidFill: { color: { rgbColor: ink } }, weight: { magnitude: 1.3, unit: 'PT' } } : { propertyState: 'NOT_RENDERED' },
    }, fields: 'shapeBackgroundFill,outline' } });
    return id;
  }
  function line(a: Point, b: Point, dashed = false, weight = 1.3): void {
    const magnitude = length(a, b);
    if (magnitude < 1e-6) return;
    const cosine = (b.x - a.x) / magnitude, sine = (b.y - a.y) / magnitude;
    const id = nextId();
    requests.push({ createLine: { objectId: id, lineCategory: 'STRAIGHT', elementProperties: { pageObjectId: pageId,
      size: { width: { magnitude, unit: 'PT' }, height: { magnitude: 0, unit: 'PT' } },
      transform: { scaleX: cosine, scaleY: cosine, shearX: -sine, shearY: sine, translateX: a.x, translateY: a.y, unit: 'PT' } } } });
    requests.push({ updateLineProperties: { objectId: id, lineProperties: { lineFill: { solidFill: { color: { rgbColor: ink } } },
      weight: { magnitude: weight, unit: 'PT' }, dashStyle: dashed ? 'DASH' : 'SOLID' }, fields: 'lineFill,weight,dashStyle' } });
  }
  function triangle(a: Point, b: Point, c: Point): void {
    if (Math.abs(cross(a, b, c)) < 1e-7) return;
    const id = nextId();
    const dx = c.x - b.x, dy = c.y - b.y;
    const tx = a.x - dx / 2, ty = a.y - dy / 2;
    requests.push({ createShape: { objectId: id, shapeType: 'TRIANGLE', elementProperties: { pageObjectId: pageId,
      size: { width: { magnitude: 1, unit: 'PT' }, height: { magnitude: 1, unit: 'PT' } },
      transform: { scaleX: dx, shearY: dy, shearX: b.x - tx, scaleY: b.y - ty, translateX: tx, translateY: ty, unit: 'PT' } } } });
    requests.push({ updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: fill } } },
      outline: { propertyState: 'NOT_RENDERED' } }, fields: 'shapeBackgroundFill,outline' } });
  }
  function arc(center: Point, rx: number, ry: number, start: number, delta: number, dashed: boolean): void {
    const steps = Math.max(2, Math.ceil(Math.abs(delta) * Math.sqrt(Math.max(rx, ry) / 0.7)));
    const curve = (angle: number) => ({ x: center.x + rx * Math.cos(angle), y: center.y + ry * Math.sin(angle) });
    let previous = curve(start);
    let distance = 0;
    for (let i = 1; i <= steps; i++) {
      const current = curve(start + delta * i / steps);
      const segmentLength = length(previous, current);
      if (!dashed || Math.floor(distance / 5) % 2 === 0) line(previous, current);
      distance += segmentLength;
      previous = current;
    }
  }
  for (const polygon of diagram.polygons) {
    const vertices = polygon.vertices.map(position);
    if (polygon.fill) for (const [a, b, c] of triangulate(vertices)) triangle(a, b, c);
    vertices.forEach((point, index) => line(point, vertices[(index + 1) % vertices.length]!));
  }
  for (const circle of diagram.circles) {
    const center = position(circle.center), radius = circle.radius * scale;
    shape('ELLIPSE', { x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2 }, null, true);
  }
  for (const item of diagram.arcs) arc(position(item.center), item.radiusX * scale, item.radiusY * scale,
    -item.startAngle * Math.PI / 180, -(item.endAngle - item.startAngle) * Math.PI / 180, item.dashed);
  for (const segment of diagram.segments) line(position(segment.from), position(segment.to), segment.dashed);
  const labels: { text: string; anchor: Point; candidates: Point[] }[] = [];
  for (const angle of diagram.angles) {
    const vertex = position(angle.vertex), from = position(angle.from), to = position(angle.to);
    const u = length(vertex, from), v = length(vertex, to);
    if (u < 1e-6 || v < 1e-6) throw new DiagramLayoutError('Вырожденный угол');
    const radius = Math.min(angle.rightAngle ? 12 : 20, Math.min(u, v) * 0.22);
    const start = Math.atan2(from.y - vertex.y, from.x - vertex.x);
    let delta = Math.atan2(to.y - vertex.y, to.x - vertex.x) - start;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    if (angle.rightAngle) {
      const a = { x: vertex.x + radius * (from.x - vertex.x) / u, y: vertex.y + radius * (from.y - vertex.y) / u };
      const b = { x: vertex.x + radius * (to.x - vertex.x) / v, y: vertex.y + radius * (to.y - vertex.y) / v };
      const corner = { x: a.x + b.x - vertex.x, y: a.y + b.y - vertex.y };
      line(a, corner); line(corner, b);
    } else arc(vertex, radius, radius, start, delta, false);
    if (angle.label[language]) labels.push({ text: angle.label[language], anchor: vertex,
      candidates: [14, 25, 38].map(extra => ({ x: vertex.x + Math.cos(start + delta / 2) * (radius + extra),
        y: vertex.y + Math.sin(start + delta / 2) * (radius + extra) })) });
  }
  for (const label of diagram.labels) labels.push({ text: label.text[language], anchor: map(label), candidates: [map(label)] });
  const center = { x: diagram.points.reduce((sum, point) => sum + position(point.id).x, 0) / diagram.points.length,
    y: diagram.points.reduce((sum, point) => sum + position(point.id).y, 0) / diagram.points.length };
  for (const point of diagram.points) {
    if (!point.label[language]) continue;
    const anchor = position(point.id);
    shape('ELLIPSE', { x: anchor.x - 1.6, y: anchor.y - 1.6, width: 3.2, height: 3.2 }, ink, false);
    const angle = Math.atan2(anchor.y - center.y, anchor.x - center.x);
    labels.push({ text: point.label[language], anchor, candidates: [22, 34, 48].flatMap(radius => [0, -0.6, 0.6, -1.2, 1.2, Math.PI]
      .map(offset => ({ x: anchor.x + radius * Math.cos(angle + offset), y: anchor.y + radius * Math.sin(angle + offset) }))) });
  }
  const occupied: Box[] = [];
  const pointLocations = diagram.points.map(point => position(point.id));
  for (const label of labels) {
    if (!label.text) continue;
    const measure = (text: string) => [...text].reduce((sum, character) => sum +
      (/\s/.test(character) ? 4 : /[ilI1.,:;!'|]/.test(character) ? 5 : /[MWЖШЩЮФ]/.test(character) ? 16 : 10), 0);
    const wrapped: string[] = [];
    for (const paragraph of label.text.split('\n')) {
      let current = '';
      for (const character of paragraph) {
        if (current && measure(current + character) > 196) { wrapped.push(current); current = ''; }
        current += character;
      }
      wrapped.push(current);
    }
    const boxWidth = Math.max(26, Math.max(...wrapped.map(measure)) + 18);
    const boxHeight = wrapped.length * 21 + 12;
    const box = label.candidates.map(point => ({ x: point.x - boxWidth / 2, y: point.y - boxHeight / 2, width: boxWidth, height: boxHeight }))
      .find(candidate => candidate.x >= 4 && candidate.y >= 4 && candidate.x + candidate.width <= width - 4 && candidate.y + candidate.height <= height - 4 &&
        !occupied.some(other => candidate.x < other.x + other.width + 3 && candidate.x + candidate.width + 3 > other.x &&
          candidate.y < other.y + other.height + 3 && candidate.y + candidate.height + 3 > other.y) &&
        !pointLocations.some(point => point.x > candidate.x - 2 && point.x < candidate.x + candidate.width + 2 &&
          point.y > candidate.y - 2 && point.y < candidate.y + candidate.height + 2));
    if (!box) throw new DiagramLayoutError('Подписи чертежа перекрываются или выходят за границы изображения');
    occupied.push(box);
    const id = shape('TEXT_BOX', box, white, false);
    requests.push({ insertText: { objectId: id, text: wrapped.join('\n') } },
      { updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, style: { fontFamily: 'Times New Roman', fontSize: { magnitude: 16, unit: 'PT' },
        foregroundColor: { opaqueColor: { rgbColor: ink } } }, fields: 'fontFamily,fontSize,foregroundColor' } },
      { updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { alignment: 'CENTER', spaceAbove: { magnitude: 0, unit: 'PT' },
        spaceBelow: { magnitude: 0, unit: 'PT' } }, fields: 'alignment,spaceAbove,spaceBelow' } },
      { updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: 'MIDDLE', autofit: { autofitType: 'NONE' } },
        fields: 'contentAlignment,autofit' } });
  }
  return requests;
}

function slidesRequest(path: string, body?: unknown): GoogleAppsScript.URL_Fetch.HTTPResponse {
  let response: GoogleAppsScript.URL_Fetch.HTTPResponse;
  try { response = UrlFetchApp.fetch(`${config.googleSlidesApiUrl.replace(/\/$/, '')}/${path}`, {
    method: body === undefined ? 'get' : 'post', headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
    muteHttpExceptions: true, ...(body === undefined ? {} : { contentType: 'application/json', payload: JSON.stringify(body) }),
  }); } catch { throw new CloudYieldError('Соединение с Google Slides временно недоступно'); }
  if ([408, 429].includes(response.getResponseCode()) || response.getResponseCode() >= 500 ||
      (response.getResponseCode() === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/.test(response.getContentText()))) {
    throw new CloudYieldError(`Google Slides временно недоступен: HTTP ${response.getResponseCode()}`);
  }
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(`Google Slides renderer: HTTP ${response.getResponseCode()}`);
  }
  return response;
}

function formulaRequests(text: string, pageId: string, width: number, height: number): Request[] {
  const layout = layoutStatement(text, width - 48);
  if (layout.height > height - 48) throw new QuestionRenderError('Условие слишком высокое для читаемого изображения; сократите текст внутри формулы, сохранив все данные');
  const requests: Request[] = [];
  for (const primitive of layout.primitives) {
    const id = `math_${Utilities.getUuid().replace(/-/g, '').slice(0, 18)}`;
    const x = primitive.x + 24, y = primitive.y + 24;
    if (primitive.kind === 'text') {
      requests.push({ createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: pageId,
        size: { width: { magnitude: primitive.width, unit: 'PT' }, height: { magnitude: primitive.height, unit: 'PT' } },
        transform: { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: x, translateY: y, unit: 'PT' } } } },
      { insertText: { objectId: id, text: primitive.text } },
      { updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, style: { fontFamily: 'Times New Roman', fontSize: { magnitude: primitive.fontSize, unit: 'PT' },
        foregroundColor: { opaqueColor: { rgbColor: ink } } }, fields: 'fontFamily,fontSize,foregroundColor' } },
      { updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { alignment: 'START', lineSpacing: 100,
        spaceAbove: { magnitude: 0, unit: 'PT' }, spaceBelow: { magnitude: 0, unit: 'PT' } }, fields: 'alignment,lineSpacing,spaceAbove,spaceBelow' } },
      { updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: 'MIDDLE', autofit: { autofitType: 'NONE' },
        shapeBackgroundFill: { propertyState: 'NOT_RENDERED' }, outline: { propertyState: 'NOT_RENDERED' } },
        fields: 'contentAlignment,autofit,shapeBackgroundFill,outline' } });
    } else {
      const dx = primitive.x2 - primitive.x, dy = primitive.y2 - primitive.y, magnitude = Math.hypot(dx, dy);
      if (magnitude < 1e-6) continue;
      requests.push({ createLine: { objectId: id, lineCategory: 'STRAIGHT', elementProperties: { pageObjectId: pageId,
        size: { width: { magnitude, unit: 'PT' }, height: { magnitude: 0, unit: 'PT' } },
        transform: { scaleX: dx / magnitude, scaleY: dx / magnitude, shearX: -dy / magnitude, shearY: dy / magnitude,
          translateX: x, translateY: y, unit: 'PT' } } } },
      { updateLineProperties: { objectId: id, lineProperties: { lineFill: { solidFill: { color: { rgbColor: ink } } },
        weight: { magnitude: 1.2, unit: 'PT' } }, fields: 'lineFill,weight' } });
    }
  }
  return requests;
}

function renderImageQuestion(question: StoredQuestion): Record<Language, string> | null {
  const presentations = Object.fromEntries(languages.map(language => [language, statementPresentation(question.translations[language].text)])) as
    Record<Language, ReturnType<typeof statementPresentation>>;
  for (const language of languages) {
    question.translations[language].imageContainsStatement = presentations[language].containsStatement;
    question.translations[language].displayText = presentations[language].displayText;
    delete question.translations[language].localImageUrl;
    if (!question.diagram && !presentations[language].imageText) delete question.translations[language].imageUrl;
  }
  if (!question.diagram && !languages.some(language => presentations[language].imageText)) return null;
  const diagram = question.diagram ? diagramSchema.parse(question.diagram) : null;
  const properties = PropertiesService.getScriptProperties();
  let presentationId = properties.getProperty('STUDIO_RENDER_PRESENTATION_ID');
  if (!presentationId) {
    const created = SlidesApp.create('AkadilEDU diagram renderer');
    presentationId = created.getId();
    properties.setProperty('STUDIO_RENDER_PRESENTATION_ID', presentationId);
    created.saveAndClose();
  }
  const result = {} as Record<Language, string>;
  const rendered = new Map<string, string>();
  for (const language of languages) {
    const text = presentations[language].imageText;
    const signature = JSON.stringify([text, diagram ? [diagram.points.map(point => point.label[language]), diagram.labels.map(label => label.text[language]),
      diagram.angles.map(angle => angle.label[language])] : null]);
    const previous = rendered.get(signature);
    if (previous) { result[language] = previous; continue; }
    const parts: number[][] = [];
    for (const part of [...(text ? ['formula'] : []), ...(diagram ? ['diagram'] : [])]) {
    const presentation = SlidesApp.openById(presentationId);
    const slide = presentation.getSlides()[0] || presentation.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    const pageId = slide.getObjectId();
    const width = presentation.getPageWidth(), height = presentation.getPageHeight();
    const clear: Request[] = slide.getPageElements().map(element => ({ deleteObject: { objectId: element.getObjectId() } }));
    presentation.saveAndClose();
    const background: Request = { updatePageProperties: { objectId: pageId,
      pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: white } } } }, fields: 'pageBackgroundFill' } };
    const requests = clear.concat([background], part === 'formula' ? formulaRequests(text, pageId, width, height)
      : renderer(diagram!, language, pageId, width, height));
    for (let offset = 0; offset < requests.length; offset += 350) {
      slidesRequest(`presentations/${encodeURIComponent(presentationId)}:batchUpdate`, { requests: requests.slice(offset, offset + 350) });
    }
    const response = slidesRequest(`presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageId)}/thumbnail?thumbnailProperties.thumbnailSize=LARGE`);
    const data: unknown = JSON.parse(response.getContentText());
    if (!data || typeof data !== 'object' || !('contentUrl' in data) || typeof data.contentUrl !== 'string' || !data.contentUrl.startsWith('https://')) {
      throw new Error('Google Slides thumbnail URL is missing');
    }
    let png: GoogleAppsScript.URL_Fetch.HTTPResponse;
    try { png = UrlFetchApp.fetch(data.contentUrl, { muteHttpExceptions: true }); }
    catch { throw new CloudYieldError('Изображение Google Slides временно недоступно'); }
    if ([408, 429].includes(png.getResponseCode()) || png.getResponseCode() >= 500) throw new CloudYieldError('Изображение Google Slides временно недоступно');
    if (png.getResponseCode() !== 200) throw new Error(`Google Slides thumbnail download: HTTP ${png.getResponseCode()}`);
    parts.push(cropQuestionPng(png.getBlob().getBytes()));
    }
    const encoded = Utilities.base64Encode(combineQuestionPng(parts));
    result[language] = encoded;
    rendered.set(signature, encoded);
  }
  return result;
}

export function renderQuestion(question: StoredQuestion): Record<Language, string> | null {
  try { return renderImageQuestion(question); }
  catch (error) {
    if (error instanceof MathLayoutError) throw new QuestionRenderError(error.message);
    if (error instanceof QuestionRenderError || error instanceof CloudYieldError) throw error;
    if (error instanceof Error && /quota|too many times|too much computer time|temporarily|timed?\s*out|unavailable|try again/i.test(error.message)) {
      throw new CloudYieldError('Рендеринг временно отложен: квота или соединение Google Slides');
    }
    throw error;
  }
}
