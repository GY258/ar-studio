"use client";

import { useState } from "react";
import Link from "next/link";
import { COPY } from "@/lib/copy";
import { Wordmark, primaryButton } from "./bits";

/** 顶栏：桌面横排链接，手机收进汉堡菜单。 */
export function HomeHeader() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="sticky top-0 z-50 bg-home-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-18 w-full max-w-7xl items-center justify-between px-5 sm:px-8">
        <Wordmark />
        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          {COPY.home.nav.map((l) => (
            <Link key={l.href} href={l.href} className="font-dm text-sm font-medium text-home-fg transition-colors hover:text-home-accent">
              {l.label}
            </Link>
          ))}
          <Link href="/#idea" className={`${primaryButton} h-9 px-4 text-sm`}>
            {COPY.home.ideaCta}
          </Link>
        </nav>
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-full text-home-fg hover:bg-home-panel md:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-6" aria-hidden="true">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 5h16M4 12h16M4 19h16" />}
          </svg>
        </button>
      </div>
      {open && (
        <div className="border-t border-home-line bg-home-bg md:hidden">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-5 py-4 sm:px-8">
            {COPY.home.nav.map((l) => (
              <Link key={l.href} href={l.href} onClick={close} className="py-3 font-dm text-lg font-medium text-home-fg">
                {l.label}
              </Link>
            ))}
            <Link href="/#idea" onClick={close} className={`${primaryButton} mt-3 h-11 self-start px-6 text-sm`}>
              {COPY.home.ideaCta}
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
