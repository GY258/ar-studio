import Link from "next/link";
import { allTemplates } from "@/lib/templates";
import { COPY, t } from "@/lib/copy";
import { PropThumb } from "@/components/PropThumb";

export const metadata = { title: "Templates · AR Studio" };

/** 模板库 / 定价。锁定态用降透明度 + 金色价签，不用挂锁图标（PRD 6.2 组件）。 */
export default function TemplatesPage() {
  const templates = allTemplates();
  return (
    <main className="mx-auto max-w-content px-6 py-24">
      <h1 className="text-section font-medium">{COPY.templates.title}</h1>
      <p className="mt-4 max-w-[52ch] text-body text-muted">{COPY.templates.lede}</p>

      <div className="mt-14 grid grid-cols-2 gap-5 md:grid-cols-4">
        {templates.map((tpl) => {
          const paid = tpl.priceCents > 0;
          return (
            <Link
              key={tpl.slug}
              href={`/studio/${tpl.slug}`}
              className="group rounded-xl border border-line bg-surface p-4 ease-brand transition hover:border-[#34343C]"
            >
              {tpl.preview.shape && (
                <PropThumb
                  shape={tpl.preview.shape}
                  ratio={1.25}
                  className={`w-full ${paid ? "opacity-[.42] group-hover:opacity-70" : ""} ease-brand transition-opacity`}
                />
              )}
              <div className="mt-3 flex items-baseline justify-between">
                <span className="text-card font-medium">{t(tpl.name)}</span>
                <span className={`font-mono text-note ${paid ? "text-gold" : "text-muted"}`}>
                  {paid ? `$${(tpl.priceCents / 100).toFixed(2)}` : COPY.templates.free}
                </span>
              </div>
              <p className="mt-1 text-note capitalize text-muted">{tpl.category}</p>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
