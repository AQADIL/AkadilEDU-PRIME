export function arrangeDiagramLabels() {
  const svg = document.querySelector('svg');
  if (!svg) return;
  const labels = [...svg.querySelectorAll<SVGTextElement>('[data-diagram-label]')];
  type Box = { x: number; y: number; width: number; height: number };
  type Edge = { x1: number; y1: number; x2: number; y2: number };
  const placed: Box[] = [];
  const edges: Edge[] = [...svg.querySelectorAll('line')].map(line => ({
    x1: line.x1.baseVal.value, y1: line.y1.baseVal.value,
    x2: line.x2.baseVal.value, y2: line.y2.baseVal.value,
  }));
  for (const polygon of svg.querySelectorAll('polygon')) {
    for (let i = 0; i < polygon.points.numberOfItems; i++) {
      const a = polygon.points.getItem(i), b = polygon.points.getItem((i + 1) % polygon.points.numberOfItems);
      edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  const geometry = {
    intersects(a: Box, b: Box) {
      return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    },
    edgeIntersects(box: Box, edge: Edge) {
      let low = 0, high = 1;
      for (const [start, delta, min, max] of [
        [edge.x1, edge.x2 - edge.x1, box.x, box.x + box.width],
        [edge.y1, edge.y2 - edge.y1, box.y, box.y + box.height],
      ] as const) {
        if (Math.abs(delta) < 1e-8) { if (start < min || start > max) return false; }
        else {
          const a = (min - start) / delta, b = (max - start) / delta;
          low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
          if (low > high) return false;
        }
      }
      return true;
    },
  };
  for (const label of labels) {
    const initial = label.getBBox();
    if (initial.width > 720 || initial.height > 450) throw new Error('Diagram label is too long to display legibly');
    const originalX = Number(label.getAttribute('x')), originalY = Number(label.getAttribute('y'));
    const anchorX = Number(label.dataset.anchorX), anchorY = Number(label.dataset.anchorY);
    const isPoint = label.dataset.diagramLabel === 'point';
    const dx = initial.width / 2 + 16, dy = initial.height / 2 + 14;
    const candidates: [number, number][] = [[originalX, originalY]];
    if (isPoint) {
      for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        candidates.push([anchorX + sx! * dx, anchorY + sy! * dy]);
      }
    } else {
      for (const distance of [18, 36, 54]) for (const [sx, sy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        candidates.push([originalX + sx! * distance, originalY + sy! * distance]);
      }
    }
    let best = candidates[0]!, bestScore = Infinity;
    for (const [cx, cy] of candidates) {
      const box = { x: initial.x + cx - originalX - 4, y: initial.y + cy - originalY - 4, width: initial.width + 8, height: initial.height + 8 };
      let score = Math.hypot(cx - originalX, cy - originalY) * 0.2;
      if (box.x < 8 || box.y < 8 || box.x + box.width > 752 || box.y + box.height > 492) score += 100000;
      score += placed.filter(other => geometry.intersects(box, other)).length * 10000;
      score += edges.filter(edge => geometry.edgeIntersects(box, edge)).length * 500;
      if (isPoint && anchorX >= box.x && anchorX <= box.x + box.width && anchorY >= box.y && anchorY <= box.y + box.height) score += 10000;
      if (score < bestScore) { best = [cx, cy]; bestScore = score; }
    }
    label.setAttribute('x', String(best[0])); label.setAttribute('y', String(best[1]));
    const box = label.getBBox();
    if (box.x < 0 || box.y < 0 || box.x + box.width > 760 || box.y + box.height > 500
      || placed.some(other => geometry.intersects(box, other))) {
      throw new Error('Diagram labels overlap or exceed the image; revise label positions');
    }
    placed.push({ x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6 });
  }
}
