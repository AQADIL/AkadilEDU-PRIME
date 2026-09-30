import imageCompression from 'browser-image-compression';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { toPng } from 'html-to-image';
import html2canvas from 'html2canvas';
import { storage, storageRef, uploadBytes, getDownloadURL, deleteObject } from '../lib/firebase';

const compressionOptions = {
  maxSizeMB: 0.5,
  maxWidthOrHeight: 1920,
  useWebWorker: true,
  initialQuality: 0.8
};

export const compressImage = async (file) => {
  return imageCompression(file, compressionOptions);
};

export const uploadImageToStorage = async (file, path) => {
  const storageReference = storageRef(storage, path);
  const snapshot = await uploadBytes(storageReference, file);
  return getDownloadURL(snapshot.ref);
};

export const deleteImageFromStorage = async (path) => {
  await deleteObject(storageRef(storage, path));
};

export const renderLatexToHtml = (latex, displayMode = false) => {
  try {
    return katex.renderToString(latex, {
      displayMode: displayMode,
      throwOnError: false,
      output: 'html'
    });
  } catch {
    return String(latex).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }
};

export const createLatexImage = async (text) => {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '0';
  container.style.top = '0';
  container.style.zIndex = '-1';
  container.style.pointerEvents = 'none';
  container.style.backgroundColor = 'white';
  container.style.padding = '24px';
  container.style.borderRadius = '12px';
  container.style.fontFamily = 'Inter, Arial, sans-serif';
  container.style.fontSize = '15px';
  container.style.color = 'black';
  container.style.width = '600px';
  container.style.maxWidth = '600px';
  container.style.whiteSpace = 'pre-wrap';
  container.style.lineHeight = '2.0';
  container.style.textAlign = 'left';
  container.style.wordWrap = 'break-word';
  container.style.overflowWrap = 'break-word';

  const style = document.createElement('style');
  style.textContent = `
    .katex {
      font-size: 1.15em !important;
      line-height: normal !important;
      text-align: initial !important;
    }
    .katex-inline {
      white-space: nowrap !important;
    }
    .katex-display {
      margin: 1.5em 0 !important;
    }
  `;
  container.appendChild(style);

  let lastIndex = 0;
  const regex = /\$\$([^$]+)\$\$|\$([^$]+)\$/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plainText = text.substring(lastIndex, match.index);
      if (plainText) {
        const textSpan = document.createElement('span');
        textSpan.textContent = plainText;
        textSpan.style.display = 'inline';
        textSpan.style.fontSize = '15px';
        textSpan.style.whiteSpace = 'pre-wrap';
        textSpan.style.wordBreak = 'break-word';
        container.appendChild(textSpan);
      }
    }

    const latex = match[1] || match[2];
    const isBlock = !!match[1];

    const latexSpan = document.createElement('span');
    latexSpan.innerHTML = renderLatexToHtml(latex, isBlock);
    latexSpan.style.display = isBlock ? 'block' : 'inline';
    latexSpan.style.verticalAlign = 'middle';
    latexSpan.style.fontSize = '15px';
    latexSpan.style.margin = isBlock ? '8px 0' : '0 2px';

    if (!isBlock) {
      latexSpan.style.whiteSpace = 'nowrap';
      latexSpan.style.wordBreak = 'keep-all';
    }

    container.appendChild(latexSpan);

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    if (remainingText) {
      const textSpan = document.createElement('span');
      textSpan.textContent = remainingText;
      textSpan.style.display = 'inline';
      textSpan.style.fontSize = '15px';
      textSpan.style.whiteSpace = 'pre-wrap';
      textSpan.style.wordBreak = 'break-word';
      container.appendChild(textSpan);
    }
  }

  document.body.appendChild(container);

  try {
    await document.fonts.ready;
    const imageWidth = Math.ceil(container.scrollWidth);
    const imageHeight = Math.ceil(container.scrollHeight);
    let dataUrl;
    try {
      dataUrl = await toPng(container, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: '#ffffff',
        width: imageWidth,
        height: imageHeight
      });
      if (!(await imageHasVisibleInk(dataUrl))) throw new Error('LaTeX image was blank.');
    } catch {
      const canvas = await html2canvas(container, {
        backgroundColor: '#ffffff',
        width: imageWidth,
        height: imageHeight,
        scale: 2,
        useCORS: true
      });
      dataUrl = canvas.toDataURL('image/png');
      if (!(await imageHasVisibleInk(dataUrl))) throw new Error('LaTeX image was blank.');
    }
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return new File([blob], 'latex.png', { type: 'image/png' });
  } finally {
    container.remove();
  }
};

async function imageHasVisibleInk(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable.');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] > 0 && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) {
      return true;
    }
  }
  return false;
}

export const detectLatexInText = (text) => {
  const latexPattern = /\$\$([^$]+)\$\$|\$([^$]+)\$/g;
  const matches = [];
  let match;
  while ((match = latexPattern.exec(text)) !== null) {
    matches.push({
      fullMatch: match[0],
      latex: match[1] || match[2],
      index: match.index
    });
  }
  return matches;
};

export const processTextWithLatex = async (text) => {
  const latexMatches = detectLatexInText(text);

  if (latexMatches.length === 0) {
    return null;
  }

  return await createLatexImage(text);
};

export const generateImagePath = (questionId, imageType = 'question', mimeType = 'image/png') => {
  const timestamp = Date.now();
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : null;
  if (!extension) throw new Error('Only PNG and JPEG images are supported.');
  if (!/^[A-Za-z0-9_-]+$/.test(String(questionId)) || !/^[A-Za-z0-9_-]+$/.test(String(imageType))) {
    throw new Error('Invalid image path component.');
  }
  return `questions/${questionId}/${imageType}_${timestamp}.${extension}`;
};
