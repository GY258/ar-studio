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
      {/* 导航：极简，Instagram 放在这里是因为「关注我们」是主页最关键的动作之一 */}
      <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-content items-center justify-between px-6">
          <span className="whitespace-nowrap font-mono text-note tracking-[0.18em] text-fg">{COPY.brand}</span>
          <div className="flex items-center gap-4">
            <a
              href={COPY.home.instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] text-muted hover:text-fg transition"
            >
              Instagram
            </a>
            <Link href="/feedback" className="hidden text-[14px] text-muted transition hover:text-fg sm:inline">
              Feedback
            </Link>
            <Link
              href="/studio"
              className="whitespace-nowrap rounded-full bg-accent px-5 py-2 text-[14px] font-medium text-[#1A0F2E] ease-brand transition hover:-translate-y-px"
            >
              {COPY.nav.cta}
            </Link>
          </div>
        </nav>
      </header>

      {/* 关于我们 + Instagram：主页第一屏就是我们俩，先认识人再看作品 */}
      <section>
        <div className="mx-auto grid max-w-content gap-12 px-6 pb-20 pt-16 md:grid-cols-[3fr_2fr] md:gap-16 md:pt-24">
          <div>
            <h1 className="animate-rise text-[clamp(40px,6vw,84px)] font-medium leading-[0.98] tracking-[-0.03em]">
              {COPY.home.aboutTitle}
            </h1>
            <div className="mt-8 max-w-[58ch] space-y-5 text-body text-muted animate-rise [animation-delay:120ms]">
              {COPY.home.aboutParagraphs.map((para) => (
                <p key={para}>{para}</p>
              ))}
            </div>
          </div>

          {/*
            长得像一个 Instagram 主页预览，而不是一张通用的「关注我们」卡片：
            有头像、有账号、有几张真照片，整块都能点。
          */}
          <a
            href={COPY.home.instagramUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group block self-start rounded-2xl border border-line bg-surface p-5 ease-brand transition hover:border-[#34343C] animate-rise [animation-delay:200ms]"
          >
            <div className="flex items-center gap-3">
              <img
                src="/about/avatar.jpg"
                alt=""
                width={48}
                height={48}
                className="h-12 w-12 rounded-full object-cover ring-2 ring-accent ring-offset-2 ring-offset-surface"
              />
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium text-fg">{COPY.home.instagramHandle.slice(1)}</div>
                <div className="text-note text-muted">Instagram</div>
              </div>
              <span className="ml-auto whitespace-nowrap rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-[#1A0F2E]">
                Follow
              </span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-1 overflow-hidden rounded-lg">
              {COPY.home.instagramPhotos.map((src) => (
                <img
                  key={src}
                  src={src}
                  alt=""
                  width={180}
                  height={180}
                  loading="lazy"
                  className="aspect-square w-full object-cover ease-brand transition group-hover:opacity-90"
                />
              ))}
            </div>
            <p className="mt-4 text-[14px] leading-relaxed text-muted">
              <span className="text-fg">{COPY.home.instagramTitle}.</span> {COPY.home.instagramBody}
            </p>
          </a>
        </div>
      </section>

      {/* 示例片段：3:4 竖幅、静音循环 */}
      {DEMOS.length > 0 && (
        <section id="gallery" className="border-t border-line">
          <div className="mx-auto max-w-content px-6 py-20">
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
          </div>
        </section>
      )}

      {/* 留言 */}
      <section className="border-t border-line bg-surface/40">
        <div className="mx-auto max-w-content px-6 py-20">
          <h2 className="text-section font-medium">{COPY.home.ideaTitle}</h2>
          <p className="mt-4 max-w-[52ch] text-body text-muted">{COPY.home.ideaBody}</p>
          <Link
            href="/feedback"
            className="mt-8 inline-block rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-[#1A0F2E] ease-brand transition hover:-translate-y-px"
          >
            {COPY.home.ideaCta}
          </Link>
        </div>
      </section>

      {/* 隐私：这是真实的技术事实，也是转化的关键说服点 */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-content px-6 py-16">
          <p className="max-w-[38ch] text-section font-medium">
            {COPY.home.privacyTitle}
            <span className="text-muted">{COPY.home.privacyTitleMuted}</span>
          </p>
          <p className="mt-6 max-w-[58ch] text-body text-muted">{COPY.home.privacyBody}</p>
        </div>
      </section>

      {/* 收尾：标语 + 去相机。原来的 hero，放到最下面 */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-content px-6 py-24 md:py-30">
          <h2 className="text-hero font-medium">
            {COPY.home.heroLines.map((line, i) => (
              <span key={line} className={`block ${i === lastHeroLine ? "text-accent" : ""}`}>
                {line}
              </span>
            ))}
          </h2>
          <p className="mt-10 max-w-[52ch] text-body text-muted">{COPY.home.heroBody}</p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              href={`/studio/${DEMOS[0]?.template ?? "cloud"}`}
              className="rounded-full bg-accent px-7 py-3.5 text-[15px] font-medium text-[#1A0F2E]"
            >
              {COPY.home.ctaPrimary}
            </Link>
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
