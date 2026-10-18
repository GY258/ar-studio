import Link from "next/link";
import { allTemplates } from "@/lib/templates";
import { COPY, t } from "@/lib/copy";
import { DEMOS } from "@/lib/demos";

/**
 * 主页承担 SEO、品牌、转化，和工作台视觉语言统一但密度完全不同（PRD 3）。
 *
 * 排版气质：宣言式超大字、多行递进、末行加重收尾；导航极简。
 * 这里继承的是那种编辑设计式的克制，不是具体色彩。
 */
export default function HomePage() {
  const templates = allTemplates();
  const lastHeroLine = COPY.home.heroLines.length - 1;

  return (
    <main className="min-h-screen">
      {/* 导航：极简，右侧只有一个 CTA */}
      <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-content items-center justify-between px-6">
          <span className="font-mono text-note tracking-[0.18em] text-fg">{COPY.brand}</span>
          <div className="flex items-center gap-4">
            <Link href="/feedback" className="text-[14px] text-muted hover:text-fg transition">
              Feedback
            </Link>
            <Link
              href="/studio"
              className="rounded-full bg-accent px-5 py-2 text-[14px] font-medium text-[#1A0F2E] ease-brand transition hover:-translate-y-px"
            >
              {COPY.nav.cta}
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-content px-6 pb-24 pt-20 md:pt-30">
        <h1 className="text-hero font-medium">
          {COPY.home.heroLines.map((line, i) => (
            <span
              key={line}
              className={`block animate-rise ${i === lastHeroLine ? "text-accent" : ""}`}
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
            href={`/studio/${DEMOS[0]?.template ?? "cloud"}`}
            className="rounded-full bg-accent px-7 py-3.5 text-[15px] font-medium text-[#1A0F2E]"
          >
            {COPY.home.ctaPrimary}
          </Link>
          <a
            href="#examples"
            className="rounded-full border border-line px-7 py-3.5 text-[15px] text-fg"
          >
            {COPY.home.ctaSecondary}
          </a>
        </div>
      </section>

      {/* 示例片段：3:4 竖幅、静音循环 */}
      {DEMOS.length > 0 && (
        <section id="examples" className="mx-auto max-w-content scroll-mt-20 px-6 pb-24">
          <h2 className="text-section font-medium">{COPY.home.examplesTitle}</h2>
          <p className="mt-4 max-w-[52ch] text-body text-muted">{COPY.home.examplesBody}</p>
          <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-3">
            {DEMOS.map((demo) => {
              const tpl = templates.find((x) => x.slug === demo.template);
              return (
                <Link
                  key={demo.template}
                  href={`/studio/${demo.template}`}
                  className="group overflow-hidden rounded-xl border border-line bg-surface ease-brand transition hover:border-[#34343C]"
                >
                  <video
                    src={demo.video}
                    poster={demo.poster}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="aspect-[3/4] w-full bg-bg object-cover"
                  />
                  {tpl && <span className="block px-4 py-3 text-card font-medium">{t(tpl.name)}</span>}
                </Link>
              );
            })}
          </div>
        </section>
      )}

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

      {/* 关于我们 */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-content px-6 py-24">
          <h2 className="text-section font-medium">{COPY.home.aboutTitle}</h2>
          <div className="mt-8 max-w-[58ch] space-y-5 text-body text-muted">
            {COPY.home.aboutParagraphs.map((para) => (
              <p key={para}>{para}</p>
            ))}
          </div>
        </div>
      </section>

      {/* 留言 + Instagram */}
      <section className="border-t border-line bg-surface/40">
        <div className="mx-auto grid max-w-content gap-14 px-6 py-20 md:grid-cols-2">
          <div>
            <h3 className="text-card font-medium">{COPY.home.ideaTitle}</h3>
            <p className="mt-3 max-w-[46ch] text-body text-muted">{COPY.home.ideaBody}</p>
            <Link
              href="/feedback"
              className="mt-6 inline-block rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-[#1A0F2E] ease-brand transition hover:-translate-y-px"
            >
              {COPY.home.ideaCta}
            </Link>
          </div>
          <div>
            <h3 className="text-card font-medium">{COPY.home.instagramTitle}</h3>
            <p className="mt-3 max-w-[46ch] text-body text-muted">{COPY.home.instagramBody}</p>
            <a
              href={COPY.home.instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-block rounded-full border border-line px-6 py-3 text-[15px] text-fg ease-brand transition hover:border-accent/60"
            >
              {COPY.home.instagramHandle} ↗
            </a>
          </div>
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
            <a href={COPY.home.instagramUrl} target="_blank" rel="noopener noreferrer" className="hover:text-fg">
              Instagram
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
