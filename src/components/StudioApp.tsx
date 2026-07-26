"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArEngine, type EngineStats } from "@/engine/engine";
import { StudioRecorder, download, type RecordingResult } from "@/engine/recorder";
import type { ControlValues, TemplateConfig, TemplateListing } from "@/engine/types";
import { COPY, t } from "@/lib/copy";
import { PropThumb } from "./PropThumb";

type Phase = "loading" | "ready" | "live" | "denied" | "failed";

export function StudioApp({ initialSlug }: { initialSlug: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<ArEngine | null>(null);
  const recorderRef = useRef<StudioRecorder | null>(null);
  const micRef = useRef<MediaStream | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [problem, setProblem] = useState<string>("");
  const [listing, setListing] = useState<TemplateListing[]>([]);
  const [config, setConfig] = useState<TemplateConfig | null>(null);
  const [values, setValues] = useState<ControlValues>({});
  const [stats, setStats] = useState<EngineStats>({ fps: 0, tracking: false, degraded: false });
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [useMic, setUseMic] = useState(false);
  const [lockedTarget, setLockedTarget] = useState<TemplateListing | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---------------- 引擎 ---------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const engine = new ArEngine({ canvas, video, onStats: setStats });
    engineRef.current = engine;

    engine
      .loadPerception()
      .then(() => setPhase("ready"))
      .catch((e: Error) => {
        setPhase("failed");
        setProblem(COPY.studio.modelFailed(e.message));
      });

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  /* ---------------- 模板 ---------------- */

  const loadConfig = useCallback(async (slug: string) => {
    const res = await fetch(`/api/templates/${slug}/config`);
    if (res.status === 403) return null; // 锁着，服务端不给配置
    if (!res.ok) throw new Error(`config ${res.status}`);
    const { config } = (await res.json()) as { config: TemplateConfig };
    return config;
  }, []);

  const applyTemplate = useCallback((cfg: TemplateConfig) => {
    setConfig(cfg);
    engineRef.current?.setTemplate(cfg);
    // 切模板不丢已调好的参数：同名 key 保留，新模板独有的用默认值
    setValues((prev) => {
      const next: ControlValues = {};
      for (const c of cfg.controls) next[c.key] = prev[c.key] ?? c.default;
      engineRef.current?.setControls(next);
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch("/api/templates");
      const { items } = (await res.json()) as { items: TemplateListing[] };
      if (!alive) return;
      setListing(items);

      const wanted =
        items.find((it) => it.slug === initialSlug && !it.locked) ?? items.find((it) => !it.locked);
      if (!wanted) return;
      const cfg = await loadConfig(wanted.slug);
      if (alive && cfg) applyTemplate(cfg);
    })().catch((e: Error) => setProblem(e.message));
    return () => {
      alive = false;
    };
  }, [initialSlug, loadConfig, applyTemplate]);

  const pick = useCallback(
    async (tpl: TemplateListing) => {
      if (tpl.locked) {
        setLockedTarget(tpl);
        void fetch("/api/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: [{ event: "unlock_click", slug: tpl.slug }] }),
        });
        return;
      }
      const cfg = await loadConfig(tpl.slug);
      if (cfg) applyTemplate(cfg);
    },
    [loadConfig, applyTemplate],
  );

  const unlock = useCallback(async () => {
    if (!lockedTarget) return;
    setBusy(true);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: lockedTarget.slug }),
      });
      const data = (await res.json()) as { mode?: string; redirectUrl?: string; error?: string };
      if (data.error === "login_required") {
        window.location.href = `/api/auth/signin?callbackUrl=/studio/${lockedTarget.slug}`;
        return;
      }
      if (data.mode === "stripe" && data.redirectUrl) {
        window.location.href = data.redirectUrl; // 托管收银台
        return;
      }
      // 生产环境没配 Stripe 时 checkout 返回 503。不显式处理的话会掉进下面的
      // 体验模式分支，表现是弹层静默关闭、什么也没发生，看着就是坏的。
      if (data.error) {
        setProblem(
          data.error === "payments_unavailable"
            ? COPY.studio.unlockUnavailable
            : COPY.studio.unlockFailed,
        );
        setLockedTarget(null);
        return;
      }
      // 体验模式：权益已发，重新拉一次列表和配置
      const fresh = await fetch("/api/templates").then((r) => r.json() as Promise<{ items: TemplateListing[] }>);
      setListing(fresh.items);
      const cfg = await loadConfig(lockedTarget.slug);
      if (cfg) applyTemplate(cfg);
      setLockedTarget(null);
    } finally {
      setBusy(false);
    }
  }, [lockedTarget, loadConfig, applyTemplate]);

  /* ---------------- 摄像头 ---------------- */

  const openCamera = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setBusy(true);
    try {
      await engine.startCamera();
      engine.start();
      setPhase("live");
      void fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [{ event: "camera_grant", slug: config?.slug }] }),
      });
    } catch (e) {
      const err = e as Error;
      setPhase("denied");
      setProblem(COPY.cameraHelp[err.name] ?? `Camera failed to open: ${err.name}`);
    } finally {
      setBusy(false);
    }
  }, [config?.slug]);

  /* ---------------- 参数 ---------------- */

  const setValue = useCallback((key: string, v: number) => {
    setValues((prev) => {
      const next = { ...prev, [key]: v };
      engineRef.current?.setControls(next);
      return next;
    });
  }, []);

  /* ---------------- 录制 ---------------- */

  const toggleMic = useCallback(async (on: boolean) => {
    if (!on) {
      micRef.current?.getTracks().forEach((t) => t.stop());
      micRef.current = null;
      setUseMic(false);
      return;
    }
    try {
      micRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      setUseMic(true);
    } catch {
      setUseMic(false);
      setProblem(COPY.studio.micDenied);
    }
  }, []);

  const toggleRecord = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (recorderRef.current?.recording) {
      recorderRef.current.stop();
      return;
    }
    const rec = new StudioRecorder({
      canvas,
      audio: micRef.current,
      maxMs: 60_000,
      onTick: setElapsed,
      onStop: (r) => {
        setRecording(false);
        setElapsed(0);
        setResult(r);
        recorderRef.current = null;
      },
    });
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    void fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ event: "record_start", slug: config?.slug }] }),
    });
  }, [config?.slug]);

  const saveResult = useCallback(() => {
    if (!result || !config) return;
    download(result, config.slug);
    void fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ event: "record_download", slug: config.slug }] }),
    });
  }, [result, config]);

  const statusLine = useMemo(() => {
    if (phase !== "live") return "";
    const track = stats.tracking ? COPY.studio.tracking : COPY.studio.waiting;
    return `${track} · ${stats.fps} fps${stats.degraded ? ` · ${COPY.studio.degraded}` : ""}`;
  }, [phase, stats]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-5">
      {/* 预览区：居中最大化 */}
      <div className="relative w-full max-w-[1100px] overflow-hidden rounded-2xl border border-line bg-black aspect-video touch-none">
        <video ref={videoRef} playsInline muted autoPlay className="hidden" />
        <canvas ref={canvasRef} className="block h-full w-full" />

        {phase !== "live" && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
            {phase === "loading" && <p className="text-muted text-body">{COPY.studio.loadingModel}</p>}
            {phase === "ready" && (
              <>
                <button
                  onClick={openCamera}
                  disabled={busy}
                  className="rounded-full bg-accent px-7 py-3 text-[15px] font-medium text-[#1A0F2E] disabled:opacity-50"
                >
                  {busy ? COPY.studio.connecting : COPY.studio.openCamera}
                </button>
                <p className="max-w-[44ch] text-note text-muted">{COPY.studio.cameraNote}</p>
              </>
            )}
            {(phase === "denied" || phase === "failed") && (
              <>
                <p className="max-w-[42ch] text-body text-fg">{problem}</p>
                <button onClick={openCamera} className="rounded-full border border-line px-6 py-2.5 text-body">
                  {COPY.studio.retry}
                </button>
              </>
            )}
          </div>
        )}

        {config?.emitter.draggable && phase === "live" && (
          <p className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1.5 text-note text-white/60">
            {COPY.studio.dragHint}
          </p>
        )}
        {recording && (
          <div className="absolute right-3 top-3 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5">
            <span className="h-2 w-2 animate-blink rounded-full bg-rec" />
            <span className="font-mono text-note text-fg">
              {String(Math.floor(elapsed / 1000)).padStart(2, "0")}s / 60s
            </span>
          </div>
        )}
      </div>

      {/* 模板选择器 */}
      <div className="flex flex-wrap justify-center gap-2.5">
        {listing.map((tpl) => {
          const on = tpl.slug === config?.slug;
          return (
            <button
              key={tpl.slug}
              onClick={() => pick(tpl)}
              aria-pressed={on}
              className={`relative w-[92px] rounded-xl border bg-surface px-1.5 pb-2 pt-2 ease-brand transition-colors ${
                on ? "border-accent text-fg" : "border-line text-muted hover:border-[#34343C] hover:text-fg"
              }`}
            >
              {tpl.preview.shape && (
                <PropThumb
                  shape={tpl.preview.shape}
                  ratio={0.62}
                  className={`w-full ${tpl.locked ? "opacity-[.42]" : ""}`}
                />
              )}
              <div className="mt-1 text-center text-[12px]">{t(tpl.name)}</div>
              {tpl.locked && (
                <span className="absolute right-1.5 top-1.5 rounded bg-gold px-1 py-px font-mono text-[9px] text-[#2A1D00]">
                  ${(tpl.priceCents / 100).toFixed(2)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 控制条：滑块由模板配置定义，不硬编码 */}
      <div className="flex flex-wrap items-center justify-center gap-4 rounded-2xl border border-line bg-surface px-5 py-3">
        {config?.controls.map((c) => (
          <label key={c.key} className="flex items-center gap-2 text-[13px] text-muted">
            {t(c.label)}
            <input
              type="range"
              min={c.min}
              max={c.max}
              step={c.step ?? 1}
              value={values[c.key] ?? c.default}
              onChange={(e) => setValue(c.key, Number(e.target.value))}
              className="w-24"
            />
            <span className="min-w-[30px] text-right font-mono text-[11px] text-fg">
              {values[c.key] ?? c.default}
            </span>
          </label>
        ))}

        <span className="h-6 w-px bg-line" />

        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={useMic} onChange={(e) => toggleMic(e.target.checked)} />
          {COPY.studio.micLabel}
        </label>

        <button
          onClick={toggleRecord}
          disabled={phase !== "live"}
          data-on={recording ? "1" : "0"}
          className="flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] text-muted disabled:opacity-40 data-[on=1]:text-rec hover:text-fg"
        >
          <span className={`h-2.5 w-2.5 rounded-full bg-rec ${recording ? "animate-blink" : ""}`} />
          {recording ? COPY.studio.stop : COPY.studio.record}
        </button>
      </div>

      <p className="font-mono text-note text-muted">{statusLine || problem}</p>

      {/* 录完的预览与下载 */}
      {result && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-5">
          <div className="w-full max-w-[520px] rounded-2xl border border-[#34343C] bg-surface p-6">
            <video src={result.url} controls autoPlay loop className="w-full rounded-lg" />
            {result.container === "webm" && (
              <p className="mt-3 text-note text-gold">
                {COPY.studio.webmWarning}
              </p>
            )}
            <div className="mt-4 flex gap-3">
              <button
                onClick={saveResult}
                className="flex-1 rounded-full bg-accent py-2.5 text-[14px] font-medium text-[#1A0F2E]"
              >
                {COPY.studio.resultDownload(result.container.toUpperCase())}
              </button>
              <button
                onClick={() => {
                  URL.revokeObjectURL(result.url);
                  setResult(null);
                }}
                className="rounded-full border border-line px-5 text-[13px] text-muted"
              >
                {COPY.studio.resultRetake}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 解锁面板 */}
      {lockedTarget && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-5">
          <div className="w-full max-w-[340px] rounded-[18px] border border-[#34343C] bg-surface p-7 text-center">
            <h2 className="text-[19px] font-semibold">{COPY.studio.unlockTitle(t(lockedTarget.name))}</h2>
            <p className="mt-1.5 text-[13px] leading-[1.7] text-muted">
              {COPY.studio.unlockBody}
            </p>
            <div className="my-4 font-mono text-[26px] text-gold">
              ${(lockedTarget.priceCents / 100).toFixed(2)}
            </div>
            <button
              onClick={unlock}
              disabled={busy}
              className="w-full rounded-full bg-gold py-2.5 text-[14px] font-semibold text-[#2A1D00] disabled:opacity-50"
            >
              {busy ? COPY.studio.unlockBusy : COPY.studio.unlockCta}
            </button>
            <button
              onClick={() => setLockedTarget(null)}
              className="mt-3 text-[13px] text-muted"
            >
              {COPY.studio.unlockLater}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
