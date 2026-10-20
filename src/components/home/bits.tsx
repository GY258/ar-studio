import Link from "next/link";

/** 主页上的小零件：品牌字标、Instagram 图标、主按钮样式。 */

export function Wordmark() {
  return (
    <Link href="/" aria-label="AR Studio home">
      <span className="inline-flex items-center gap-1.5 font-dm text-xl font-bold lowercase tracking-tight text-home-fg">
        ar studio
        <span aria-hidden="true" className="mt-0.5 size-3 rounded-full bg-home-dot" />
      </span>
    </Link>
  );
}

export function InstagramIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={className}>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
      <circle cx="12" cy="12" r="4.3" />
      <circle cx="17.6" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 绿色胶囊主按钮。高度和左右留白由调用方给（h-9 px-4 / h-11 px-6 / h-13 px-8） */
export const primaryButton =
  "inline-flex items-center justify-center whitespace-nowrap rounded-full border border-home-accent bg-home-accent font-dm font-medium leading-none text-white transition-colors hover:border-home-accent-hover hover:bg-home-accent-hover disabled:pointer-events-none disabled:opacity-50";
