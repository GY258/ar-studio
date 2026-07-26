"use client";

import { useEffect, useRef } from "react";
import { paintProp } from "@/engine/props";
import type { Emitter } from "@/engine/types";

/**
 * 模板卡片的预览图。
 * 首期用程序化道具现画，等设计出了 4:5 的效果视频，把这个组件换成 <video> 即可。
 */
export function PropThumb({
  shape,
  className,
  ratio = 0.75,
}: {
  shape: NonNullable<Emitter["shape"]>;
  className?: string;
  ratio?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = 400;
    c.width = w;
    c.height = Math.round(w * ratio);
    paintProp(shape, c);
  }, [shape, ratio]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
