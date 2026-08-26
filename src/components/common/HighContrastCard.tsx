export function HighContrastCard({
  title,
  tag,
  description,
}: {
  title: string;
  tag: string;
  description: string;
}) {
  return (
    <div className="bg-white text-slate-900 rounded-2xl p-6 shadow-sm border border-slate-200/90 hover:border-slate-300 hover:shadow-md transition-all">
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-lg font-bold font-heading text-slate-900">{title}</h4>
        <span className="text-[11px] font-bold uppercase tracking-wider text-brand-pink px-2.5 py-1 rounded-full bg-pink-50 border border-pink-200 font-body">
          {tag}
        </span>
      </div>
      <p className="text-slate-600 text-sm leading-relaxed font-body">{description}</p>
    </div>
  );
}
