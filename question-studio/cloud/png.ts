import * as UPNG from 'upng-js';

export function cropQuestionPng(bytes: number[]): number[] {
  const decoded = UPNG.decode(Uint8Array.from(bytes, value => value & 255).buffer);
  if (decoded.width * decoded.height > 5_000_000) throw new Error('Изображение превышает предел обработки');
  const frame = UPNG.toRGBA8(decoded)[0];
  if (!frame) throw new Error('PNG не содержит изображения');
  const source = new Uint8Array(frame);
  let left = decoded.width, right = -1, top = decoded.height, bottom = -1;
  for (let y = 0; y < decoded.height; y++) for (let x = 0; x < decoded.width; x++) {
    const index = (y * decoded.width + x) * 4;
    if (source[index + 3]! > 16 && Math.min(source[index]!, source[index + 1]!, source[index + 2]!) < 245) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error('Рендерер вернул пустое изображение');
  const padding = 24, width = right - left + 1 + padding * 2, height = bottom - top + 1 + padding * 2;
  const pixels = new Uint8Array(width * height * 4).fill(255);
  for (let y = top; y <= bottom; y++) {
    const start = (y * decoded.width + left) * 4;
    pixels.set(source.subarray(start, start + (right - left + 1) * 4), ((y - top + padding) * width + padding) * 4);
  }
  return Array.from(new Uint8Array(UPNG.encode([pixels.buffer], width, height, 0)), value => value > 127 ? value - 256 : value);
}

export function combineQuestionPng(parts: number[][]): number[] {
  if (parts.length === 1) return parts[0]!;
  if (!parts.length) throw new Error('Отсутствуют изображения задания');
  const images = parts.map(part => {
    const decoded = UPNG.decode(Uint8Array.from(part, value => value & 255).buffer);
    const frame = UPNG.toRGBA8(decoded)[0];
    if (!frame) throw new Error('PNG не содержит изображения');
    return { width: decoded.width, height: decoded.height, rgba: new Uint8Array(frame) };
  });
  const width = Math.max(...images.map(image => image.width));
  const height = images.reduce((sum, image) => sum + image.height, 0);
  if (width * height > 5_000_000) throw new Error('Изображение превышает предел обработки');
  const pixels = new Uint8Array(width * height * 4).fill(255);
  let offsetY = 0;
  for (const image of images) {
    const offsetX = Math.floor((width - image.width) / 2);
    for (let y = 0; y < image.height; y++) pixels.set(image.rgba.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      ((y + offsetY) * width + offsetX) * 4);
    offsetY += image.height;
  }
  return Array.from(new Uint8Array(UPNG.encode([pixels.buffer], width, height, 0)), value => value > 127 ? value - 256 : value);
}
