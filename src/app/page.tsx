import Link from "next/link";
import { DM_Sans, Source_Serif_4 } from "next/font/google";
import { allTemplates } from "@/lib/templates";
import { COPY, t } from "@/lib/copy";
import { DEMOS } from "@/lib/demos";
import { HomeHeader } from "@/components/home/HomeHeader";
import { HeroCamera } from "@/components/home/HeroCamera";
import { IdeaForm } from "@/components/home/IdeaForm";
import { InstagramIcon, Wordmark, primaryButton } from "@/components/home/bits";

// opsz 轴要带上：大标题会自动用更紧的字形，不带的话 60px 的标题松垮
const dmSans = DM_Sans({ subsets: ["latin"], axes: ["opsz"], variable: "--font-dm" });
const serif = Source_Serif_4({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-serif" });

/**
 * 主页承担 SEO、品牌、转化（PRD 3）。
 *
 * 浅色薄荷绿、圆角卡片、DM Sans + Source Serif：和工作台的暗色分开，
 * 主页要的是「亲切、可爱」，工作台要的是「别抢画面」。
 * 顺序：取景器 → 滤镜 → 隐私 → Gallery → 关于我们 → 留言。
 */
export default function HomePage() {
  const templates = allTemplates();
  const name = (slug: string) => {
    const tpl = templates.find((x) => x.slug === slug);
    return tpl ? t(tpl.name) : slug;
  };
  const items = DEMOS.map((d) => ({ ...d, name: name(d.template) }));
  // 隐私卡片配的是哭哭那张：人脸上有效果，但一眼看得出是真人真场景
  const privacyShot = items.find((d) => d.template === "crying") ?? items[0];

  const h2 = "font-dm text-balance text-2xl font-semibold leading-[1.1] tracking-[-0.025em] text-home-fg sm:text-3xl lg:text-4xl";
  const lede = "font-serif text-lg leading-[1.6] text-home-muted sm:text-xl";
  const wrap = "mx-auto w-full max-w-6xl px-5 sm:px-8";

  return (
    <div className={`${dmSans.variable} ${serif.variable} min-h-screen bg-home-bg font-dm text-home-fg`}>
      <HomeHeader />

      <main>
        {/* 首屏：标语 + 取景器 */}
        <section className="relative pb-16 pt-10 sm:pb-20 sm:pt-14">
          <div className={`${wrap} flex flex-col items-center text-center`}>
            <div className="flex animate-rise flex-col items-center">
              <h1 className="max-w-3xl text-balance font-dm text-4xl font-semibold leading-[1.1] tracking-[-0.025em] sm:text-5xl lg:text-6xl">
                {COPY.home.heroLines[0]} <span className="sm:block">{COPY.home.heroLines[1]}</span>
              </h1>
              <p className={`mt-5 max-w-xl ${lede}`}>{COPY.home.heroBody}</p>
              <Link href={`/studio/${items[0]?.template ?? ""}`} className={`${primaryButton} mt-8 h-13 px-8 text-base`}>
                {COPY.home.ctaPrimary}
              </Link>
            </div>
            {items.length > 0 && (
              <div className="mt-12 w-full animate-rise [animation-delay:120ms] sm:mt-14">
                <HeroCamera items={items} />
              </div>
            )}
          </div>
        </section>

        {/* 滤镜一览 */}
        {items.length > 0 && (
          <section id="filters" className="relative scroll-mt-24 py-16 sm:py-20">
            <div className={wrap}>
              <div className="mx-auto max-w-2xl text-center">
                <h2 className={h2}>{COPY.home.filtersTitle}</h2>
                <p className={`mt-4 ${lede}`}>{COPY.home.filtersBody(items.length)}</p>
              </div>
              {/* flex + 居中换行：个数不是 3 的倍数时，最后一行居中而不是靠左缺一块 */}
              <ul className="-mx-2.5 mt-12 flex flex-wrap justify-center gap-y-10 sm:-mx-5 sm:mt-14 sm:gap-y-14">
                {items.map((d) => (
                  <li key={d.template} className="w-1/2 px-2.5 sm:px-5 lg:w-1/3">
                    <Link href={`/studio/${d.template}`} className="group flex flex-col items-center text-center">
                      <span className="block size-28 overflow-hidden rounded-full ring-offset-4 ring-offset-home-bg transition-shadow group-hover:ring-[3px] group-hover:ring-home-dot sm:size-40">
                        <img
                          src={d.still}
                          alt={`${d.name} filter example`}
                          width={160}
                          height={160}
                          loading="lazy"
                          className="size-full object-cover object-[center_40%]"
                        />
                      </span>
                      <h3 className="mt-5 text-balance text-base font-semibold leading-[1.1] tracking-[-0.025em] sm:mt-6 sm:text-lg">
                        {d.name}
                      </h3>
                      <p className="mt-2 hidden max-w-xs text-sm leading-[1.6] text-home-muted sm:block">{d.blurb}</p>
                      <span className="mt-2 text-sm font-medium text-home-accent underline-offset-4 group-hover:underline sm:mt-4">
                        {COPY.home.filterCta}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {/* 隐私：这是真实的技术事实，也是转化的关键说服点 */}
        <section id="privacy" className="relative scroll-mt-24 py-10 sm:py-14">
          <div className={wrap}>
            <div className="grid items-center gap-8 rounded-panel bg-home-card p-4 sm:p-6 md:grid-cols-[1.1fr_1fr] md:gap-12">
              <div className="px-4 pt-6 sm:px-6 md:py-6 md:pl-8">
                <h2 className={h2}>{COPY.home.privacyTitle}</h2>
                <p className="mt-5 max-w-md text-lg leading-[1.6] text-home-muted">{COPY.home.privacyBody}</p>
                <Link href="/legal/privacy" className={`${primaryButton} mt-8 h-11 px-6 text-sm`}>
                  {COPY.home.privacyCta}
                </Link>
              </div>
              {privacyShot && (
                <div className="aspect-[4/3] overflow-hidden rounded-[1.5rem] md:aspect-[5/4]">
                  <img
                    src={privacyShot.still}
                    alt={`A couple at night, one of them with the ${privacyShot.name} filter`}
                    width={768}
                    height={1024}
                    loading="lazy"
                    className="size-full object-cover object-[center_40%]"
                  />
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Gallery：3:4 竖幅、静音循环，手机上横向滑 */}
        {items.length > 0 && (
          <section id="gallery" className="relative scroll-mt-24 py-10 sm:py-14">
            <div className={wrap}>
              <div className="overflow-hidden rounded-panel bg-home-panel p-8 sm:p-12">
                <h2 className={h2}>{COPY.home.examplesTitle}</h2>
                <p className={`mt-3 ${lede}`}>{COPY.home.examplesBody}</p>
                <div
                  className="no-scrollbar -mx-8 mt-10 flex snap-x gap-4 overflow-x-auto px-8 pb-2 sm:-mx-12 sm:px-12 lg:mx-0 lg:grid lg:overflow-visible lg:px-0 lg:[grid-template-columns:repeat(var(--n),minmax(0,1fr))]"
                  style={{ "--n": items.length } as React.CSSProperties}
                >
                  {items.map((d) => (
                    <Link
                      key={d.template}
                      href={`/studio/${d.template}`}
                      className="group relative block aspect-[3/4] w-40 shrink-0 snap-start overflow-hidden rounded-2xl bg-home-fg sm:w-48 lg:w-auto"
                    >
                      <video
                        src={d.video}
                        poster={d.still}
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        aria-label={`${d.name} clip`}
                        className="size-full object-cover"
                      />
                      <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-home-fg/80 to-transparent px-3 pb-3 pt-10">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-home-fg">
                          <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 size-3.5" aria-hidden="true">
                            <path d="M7 4.5v15l12-7.5z" />
                          </svg>
                        </span>
                        <span className="truncate text-sm font-medium text-white">{d.name}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 关于我们 */}
        <section id="about" className="relative scroll-mt-24 py-16 sm:py-20">
          <div className={`${wrap} grid items-center gap-12 md:grid-cols-2 md:gap-16`}>
            <div className="grid grid-cols-3 grid-rows-2 gap-3">
              {COPY.home.aboutPhotos.map((p, i) => (
                <img
                  key={p.src}
                  src={p.src}
                  alt={p.alt}
                  width={360}
                  height={360}
                  loading="lazy"
                  className={`aspect-square size-full object-cover ${i === 0 ? "col-span-2 row-span-2 rounded-panel" : "rounded-2xl"}`}
                />
              ))}
            </div>
            <div>
              <h2 className={h2}>{COPY.home.aboutTitle}</h2>
              <div className="mt-6 space-y-4">
                {COPY.home.aboutParagraphs.map((para) => (
                  <p key={para} className="font-serif text-base leading-[1.6] sm:text-lg">
                    {para}
                  </p>
                ))}
              </div>
              <a
                href={COPY.home.instagramUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-8 inline-flex items-center gap-3 text-sm font-medium underline-offset-4 hover:underline"
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-home-card">
                  <InstagramIcon />
                </span>
                {COPY.home.instagramCta}
              </a>
            </div>
          </div>
        </section>

        {/* 留言 */}
        <section id="idea" className="relative scroll-mt-24 py-10 sm:py-14">
          <div className={wrap}>
            <div className="grid items-center gap-8 rounded-panel bg-home-panel p-8 sm:p-12 md:grid-cols-2 md:gap-12">
              <div>
                <h2 className="text-balance text-xl font-semibold leading-[1.1] tracking-[-0.025em] sm:text-2xl">{COPY.home.ideaTitle}</h2>
                <p className="mt-3 max-w-md text-base leading-[1.6] text-home-muted">{COPY.home.ideaBody}</p>
              </div>
              <IdeaForm />
            </div>
          </div>
        </section>
      </main>

      <footer className="pb-10 pt-6">
        <div className="mx-auto w-full max-w-7xl px-5 sm:px-8">
          <div className="flex flex-col gap-8 border-t border-home-line pt-10 md:flex-row md:items-center md:justify-between">
            <Wordmark />
            <nav aria-label="Footer" className="flex flex-wrap gap-x-8 gap-y-3">
              {COPY.home.nav.map((l) => (
                <Link key={l.href} href={l.href} className="text-sm font-medium hover:text-home-accent">
                  {l.label}
                </Link>
              ))}
            </nav>
            <a
              href={COPY.home.instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="AR Studio on Instagram"
              className="inline-flex size-10 items-center justify-center rounded-full bg-home-card transition-colors hover:bg-home-panel"
            >
              <InstagramIcon />
            </a>
          </div>
          <div className="mt-8 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-xs text-home-muted">
              © {new Date().getFullYear()} AR Studio. {COPY.home.footerLine}
            </p>
            <div className="flex gap-6">
              <Link href="/legal/privacy" className="text-xs text-home-muted hover:text-home-fg">
                {COPY.home.footerPrivacy}
              </Link>
              <Link href="/legal/terms" className="text-xs text-home-muted hover:text-home-fg">
                {COPY.footer.terms}
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
