"use client";

import { useState } from "react";
import Link from "next/link";
import { COPY } from "@/lib/copy";
import type { Demo } from "@/lib/demos";

export interface HeroItem extends Demo {
  name: string;
}

/**
 * 首屏的「取景器」：长得像相机预览，下面一排圆形滤镜可以切。
 * 快门按钮直接进当前选中的模板。桌面上竖幅视频两边用同一帧模糊铺满。
 */
export function HeroCamera({ items }: { items: HeroItem[] }) {
  const [i, setI] = useState(0);
  const cur = items[i];

  return (
    <>
      <div className="relative mx-auto aspect-[3/4] w-full max-w-md overflow-hidden rounded-[2rem] bg-home-fg sm:aspect-[16/11] sm:max-w-3xl">
        <img
          src={cur.still}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 hidden size-full scale-110 object-cover opacity-70 blur-2xl sm:block"
        />
        <video
          key={cur.template}
          src={cur.video}
          poster={cur.still}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={`${cur.name} filter in action`}
          className="relative mx-auto h-full w-full object-cover sm:aspect-[3/4] sm:w-auto"
        />
        {CORNERS.map((c) => (
          <span key={c} aria-hidden="true" className={`absolute size-8 border-white/90 sm:size-10 ${c}`} />
        ))}
        <div className="absolute inset-x-0 bottom-6 flex items-center justify-center gap-6 sm:bottom-8">
          <span aria-hidden="true" className="size-10" />
          <Link
            href={`/studio/${cur.template}`}
            aria-label={`Try ${cur.name}`}
            className="group flex size-16 items-center justify-center rounded-full border-[3px] border-white sm:size-18"
          >
            <span className="size-12 rounded-full bg-white transition-transform group-hover:scale-90 sm:size-14" />
          </Link>
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full border border-white/70 text-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-5">
              <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
              <path d="M9.5 13.5a2.5 2.5 0 0 0 4.6 1.3M14.5 12.5a2.5 2.5 0 0 0-4.6-1.3" />
            </svg>
          </span>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={COPY.home.pickerLabel}
        className="no-scrollbar -mx-5 mt-10 flex gap-5 overflow-x-auto px-5 pb-2 pt-2 sm:mx-0 sm:justify-center sm:gap-8 sm:overflow-visible sm:px-0"
      >
        {items.map((it, k) => {
          const on = k === i;
          return (
            <button
              key={it.template}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setI(k)}
              className="group flex w-20 shrink-0 cursor-pointer flex-col items-center gap-3 sm:w-24"
            >
              <span
                className={`block size-16 overflow-hidden rounded-full ring-offset-4 ring-offset-home-bg transition-shadow sm:size-20 ${
                  on ? "ring-[3px] ring-home-dot" : "ring-0 group-hover:ring-2 group-hover:ring-home-line"
                }`}
              >
                <img src={it.still} alt="" width={80} height={80} loading="lazy" className="size-full object-cover object-[center_35%]" />
              </span>
              <span className={`font-dm text-xs font-medium leading-snug sm:text-sm ${on ? "text-home-fg" : "text-home-muted"}`}>
                {it.name}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

const CORNERS = [
  "left-5 top-5 rounded-tl-xl border-l-[3px] border-t-[3px] sm:left-7 sm:top-7",
  "right-5 top-5 rounded-tr-xl border-r-[3px] border-t-[3px] sm:right-7 sm:top-7",
  "bottom-5 left-5 rounded-bl-xl border-b-[3px] border-l-[3px] sm:bottom-7 sm:left-7",
  "bottom-5 right-5 rounded-br-xl border-b-[3px] border-r-[3px] sm:bottom-7 sm:right-7",
];
