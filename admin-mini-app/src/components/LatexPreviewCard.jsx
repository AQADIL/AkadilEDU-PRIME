import LatexRenderer from './LatexRenderer';

export default function LatexPreviewCard({ text }) {
  if (!text) return null;

  return (
    <div className="flex justify-center items-center py-4">
      <div className="w-fit max-w-[90%] bg-white rounded-xl px-6 py-4 text-center">
        <LatexRenderer text={text} />
      </div>
    </div>
  );
}
