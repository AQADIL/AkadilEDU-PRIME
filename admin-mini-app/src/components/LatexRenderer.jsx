import katex from 'katex';
import 'katex/dist/katex.min.css';

export default function LatexRenderer({ text, className = '' }) {
  if (!text) return null;

  const parts = [];
  let lastIndex = 0;
  const regex = /\$\$([^$]+)\$\$|\$([^$]+)\$/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plainText = text.substring(lastIndex, match.index);
      if (plainText) {
        parts.push({ type: 'text', content: plainText });
      }
    }

    const latex = match[1] || match[2];
    const isBlock = !!match[1];

    parts.push({ type: 'latex', content: latex, isBlock });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    if (remainingText) {
      parts.push({ type: 'text', content: remainingText });
    }
  }

  if (parts.length === 0) {
    return <span className={`text-black ${className}`}>{text}</span>;
  }

  return (
    <span className={`inline-flex items-center flex-wrap gap-0 text-black whitespace-pre-wrap leading-[2.5] ${className}`}>
      {parts.map((part, index) => {
        if (part.type === 'text') {
          return <span key={index} className="inline text-black whitespace-pre">{part.content}</span>;
        }

        try {
          const html = katex.renderToString(part.content, {
            displayMode: part.isBlock,
            throwOnError: false,
            output: 'html'
          });

          return (
            <span
              key={index}
              dangerouslySetInnerHTML={{ __html: html }}
              className={`inline text-black ${part.isBlock ? 'block my-2' : 'inline align-baseline'}`}
            />
          );
        } catch {
          return <span key={index} className="inline text-red-600">{part.content}</span>;
        }
      })}
    </span>
  );
}
