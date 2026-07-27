import Link from "next/link";
import { allTemplates } from "@/lib/templates";
import { COPY, t } from "@/lib/copy";
import { PropThumb } from "@/components/PropThumb";

/**
 * 主页承担 SEO、品牌、转化，和工作台视觉语言统一但密度完全不同（PRD 3）。
 *
 * 排版气质：宣言式超大字、多行递进、末行加重收尾；导航极简。
 * 这里继承的是那种编辑设计式的克制，不是具体色彩。
 */
export default function HomePage() {
  const templates = allTemplates();

  return (
    <main className="min-h-screen">
      {/* 导航：极简，右侧只有一个 CTA */}
      <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-content items-center justify-between px-6">
          <span className="font-mono text-note tracking-[0.18em] text-fg">{COPY.brand}</span>
          <Link
            href="/studio"
            className="rounded-full bg-accent px-5 py-2 text-[14px] font-medium text-[#1A0F2E] ease-brand transition hover:-translate-y-px"
          >
            {COPY.nav.cta}
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-content px-6 pb-24 pt-20 md:pt-30">
        <h1 className="text-hero font-medium">
          {COPY.home.heroLines.map((line, i) => (
            <span
              key={line}
              className={`block animate-rise ${i === 2 ? "text-accent" : ""}`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              {line}
            </span>
          ))}
        </h1>
        <p className="mt-10 max-w-[52ch] text-body text-muted animate-rise [animation-delay:180ms]">
          {COPY.home.heroBody}
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4 animate-rise [animation-delay:240ms]">
          <Link
            href="/studio/cloud"
            className="rounded-full bg-accent px-7 py-3.5 text-[15px] font-medium text-[#1A0F2E]"
          >
            {COPY.home.ctaPrimary}
          </Link>
          <Link href="/templates" className="rounded-full border border-line px-7 py-3.5 text-[15px] text-fg">
            {COPY.home.ctaSecondary}
          </Link>
        </div>
      </section>

      {/* 隐私：这是真实的技术事实，也是转化的关键说服点 */}
      <section className="border-y border-line bg-surface/40">
        <div className="mx-auto max-w-content px-6 py-16">
          <p className="max-w-[38ch] text-section font-medium">
            {COPY.home.privacyTitle}
            <span className="text-muted">{COPY.home.privacyTitleMuted}</span>
          </p>
          <p className="mt-6 max-w-[58ch] text-body text-muted">{COPY.home.privacyBody}</p>
        </div>
      </section>

      {/* 三步 */}
      <section className="mx-auto max-w-content px-6 py-24">
        <div className="grid gap-10 md:grid-cols-3">
          {COPY.home.steps.map((s) => (
            <div key={s.n}>
              <span className="font-mono text-note text-accent">{s.n}</span>
              <h3 className="mt-3 text-card font-medium">{s.t}</h3>
              <p className="mt-2 text-body text-muted">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 模板库预览 */}
      <section className="mx-auto max-w-content px-6 pb-24">
        <h2 className="text-section font-medium">{COPY.home.templatesTitle}</h2>
        <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-4">
          {templates.map((tpl) => {
            const paid = tpl.priceCents > 0;
            return (
              <Link
                key={tpl.slug}
                href={`/studio/${tpl.slug}`}
                className="group relative overflow-hidden rounded-xl border border-line bg-surface p-4 ease-brand transition hover:border-[#34343C]"
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
              </Link>
            );
          })}
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-4 px-6 py-10 text-note text-muted">
          <span className="font-mono tracking-[0.18em]">{COPY.brand}</span>
          <div className="flex gap-6">
            <Link href="/legal/privacy" className="hover:text-fg">
              {COPY.footer.privacy}
            </Link>
            <Link href="/legal/terms" className="hover:text-fg">
              {COPY.footer.terms}
            </Link>
            <Link href="/feedback" className="hover:text-fg">
              Feedback
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
