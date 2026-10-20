import type { Diagram, Language } from './schema.js';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const number = (value: number) => value.toFixed(3);
const dash = (dashed: boolean) => dashed ? ' stroke-dasharray="7 6"' : '';

export function diagramSvg(diagram: Diagram, language: Language): string {
  const byId = new Map(diagram.points.map(p => [p.id, p]));
  const xs = diagram.points.map(p => p.x), ys = diagram.points.map(p => p.y);
  for (const shape of [...diagram.circles.map(c => ({ ...c, radiusX: c.radius, radiusY: c.radius })), ...(diagram.arcs || [])]) {
    const center = byId.get(shape.center)!;
    xs.push(center.x - shape.radiusX, center.x + shape.radiusX);
    ys.push(center.y - shape.radiusY, center.y + shape.radiusY);
  }
  for (const label of diagram.labels) { xs.push(label.x); ys.push(label.y); }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(540 / Math.max(maxX - minX, 1), 340 / Math.max(maxY - minY, 1));
  const x = (value: number) => 380 + (value - (minX + maxX) / 2) * scale;
  const y = (value: number) => 250 - (value - (minY + maxY) / 2) * scale;
  const polygons = diagram.polygons.map(p => `<polygon points="${p.vertices.map(id => {
    const point = byId.get(id)!; return `${number(x(point.x))},${number(y(point.y))}`;
  }).join(' ')}" fill="${p.fill ? '#e4e4e4' : 'none'}"/>`).join('');
  const circles = diagram.circles.map(c => {
    const center = byId.get(c.center)!;
    return `<circle cx="${number(x(center.x))}" cy="${number(y(center.y))}" r="${number(c.radius * scale)}" fill="none"/>`;
  }).join('');
  const arcs = (diagram.arcs || []).map(arc => {
    const center = byId.get(arc.center)!;
    const delta = arc.endAngle - arc.startAngle;
    const point = (degrees: number) => `${number(x(center.x + arc.radiusX * Math.cos(degrees * Math.PI / 180)))} ${number(y(center.y + arc.radiusY * Math.sin(degrees * Math.PI / 180)))}`;
    const count = Math.ceil(Math.abs(delta) / 180);
    let d = `M ${point(arc.startAngle)}`;
    for (let i = 1; i <= count; i++) {
      d += ` A ${number(arc.radiusX * scale)} ${number(arc.radiusY * scale)} 0 0 ${delta > 0 ? 0 : 1} ${point(arc.startAngle + delta * i / count)}`;
    }
    return `<path d="${d}" fill="none"${dash(arc.dashed)}/>`;
  }).join('');
  const lines = diagram.segments.map(s => {
    const a = byId.get(s.from)!, b = byId.get(s.to)!;
    return `<line x1="${number(x(a.x))}" y1="${number(y(a.y))}" x2="${number(x(b.x))}" y2="${number(y(b.y))}"${dash(s.dashed)}/>`;
  }).join('');
  const markerLabels: string[] = [];
  const angles = (diagram.angles || []).map(a => {
    const vertex = byId.get(a.vertex)!, from = byId.get(a.from)!, to = byId.get(a.to)!;
    const vx = x(vertex.x), vy = y(vertex.y);
    const ux = x(from.x) - vx, uy = y(from.y) - vy, wx = x(to.x) - vx, wy = y(to.y) - vy;
    const lenU = Math.hypot(ux, uy), lenW = Math.hypot(wx, wy);
    const radius = Math.min(a.rightAngle ? 17 : 29, Math.min(lenU, lenW) * 0.22);
    const start = Math.atan2(uy, ux);
    let delta = Math.atan2(wy, wx) - start;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const ax = vx + radius * ux / lenU, ay = vy + radius * uy / lenU;
    const bx = vx + radius * wx / lenW, by = vy + radius * wy / lenW;
    const d = a.rightAngle
      ? `M ${number(ax)} ${number(ay)} L ${number(ax + bx - vx)} ${number(ay + by - vy)} L ${number(bx)} ${number(by)}`
      : `M ${number(ax)} ${number(ay)} A ${number(radius)} ${number(radius)} 0 0 ${delta > 0 ? 1 : 0} ${number(bx)} ${number(by)}`;
    if (a.label[language]) {
      const distance = radius + 24;
      markerLabels.push(`<text data-diagram-label="fixed" x="${number(vx + Math.cos(start + delta / 2) * distance)}" y="${number(vy + Math.sin(start + delta / 2) * distance)}">${escape(a.label[language])}</text>`);
    }
    return `<path d="${d}" fill="none" stroke-width="1.8"/>`;
  }).join('');
  const centerX = diagram.points.reduce((sum, p) => sum + p.x, 0) / diagram.points.length;
  const centerY = diagram.points.reduce((sum, p) => sum + p.y, 0) / diagram.points.length;
  const pointLabels = diagram.points.filter(p => p.label[language]).map(p => {
    const dx = p.x - centerX, dy = p.y - centerY;
    const length = Math.hypot(dx, dy) || 1;
    const labelX = x(p.x) + dx / length * 28;
    const labelY = y(p.y) - dy / length * 28;
    return `<text data-diagram-label="point" data-anchor-x="${number(x(p.x))}" data-anchor-y="${number(y(p.y))}" x="${number(labelX)}" y="${number(labelY)}">${escape(p.label[language])}</text>`;
  }).join('');
  const points = diagram.points.filter(p => p.label[language]).map(p =>
    `<circle cx="${number(x(p.x))}" cy="${number(y(p.y))}" r="2.5" fill="#151515" stroke="none"/>`).join('');
  const labels = diagram.labels.map(l => `<text data-diagram-label="free" x="${number(x(l.x))}" y="${number(y(l.y))}">${escape(l.text[language])}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 500" role="img">
    <g stroke="#151515" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">${polygons}${circles}${arcs}${lines}${angles}${points}</g>
    <g font-family="'Times New Roman',serif" font-size="28" fill="#151515" text-anchor="middle" dominant-baseline="middle" stroke="white" stroke-width="5" paint-order="stroke" stroke-linejoin="round">${pointLabels}${labels}${markerLabels.join('')}</g></svg>`;
}
