"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArEngine, type EngineStats } from "@/engine/engine";
import { StudioRecorder, download, type RecordingResult } from "@/engine/recorder";
import type { ControlValues, TemplateConfig, TemplateListing } from "@/engine/types";
import { saveToPhotos } from "@/engine/recorder";
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
  const [stats, setStats] = useState<EngineStats>({
    fps: 0,
    tracking: false,
    degraded: false,
    needsTracking: true,
    camera: "",
    zoom: 1,
    fitZoom: 1,
  });
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [useMic, setUseMic] = useState(false);
  const [lockedTarget, setLockedTarget] = useState<TemplateListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  /**
   * 手机上把控件收起来。
   *
   * 模板条 + 录制按钮 + 状态栏一共压住画面下半部分的一大块，而这是个
   * 「对着自己比划」的工具 —— 挡住的正是要看的地方。相机类 app 的通行做法
   * 是点一下画面收起 UI，这里照做。
   */
  const [uiHidden, setUiHidden] = useState(false);
  /** 存相册的结果提示。null = 没提示 */
  const [saveNote, setSaveNote] = useState<string | null>(null);
  /**
   * iOS 上引导「添加到主屏幕」。
   *
   * 装上之后**摄像头权限就不再每次页面加载都问一遍** —— 那是手机上最烦的一点，
   * 而它是 Safari 对普通标签页的策略，改跳转方式治不了。
   *
   * iOS 不触发 beforeinstallprompt（那是 Chrome 的），所以只能自己判断
   * 「是 iOS Safari 且还没装」再提示。判断条件写得保守一点：宁可不提示，
   * 也别对已经装好的人重复弹。
   */
  const [showInstall, setShowInstall] = useState(false);


  /* ---------------- 引擎 ---------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const engine = new ArEngine({ canvas, video, onStats: setStats });
    engineRef.current = engine;

    // 开发期把引擎挂到 window 上，控制台里能直接问它状态：
    //   __engine.debugMaskStats()
    // 生产环境不挂 —— 那是给排查用的，不是 API。
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __engine?: ArEngine }).__engine = engine;
    }

    /*
     * 注册 Service Worker，把模型权重缓存下来 —— 第二次进来不用再下几十 MB。
     *
     * 放在这里而不是 layout：只有真正要用模型的页面才值得装它。
     * 失败了就算了，它是纯优化，不该拖着主流程。
     */
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    engine
      .loadPerception()
      .then(() => setPhase("ready"))
      .catch((e: Error) => {
        setPhase("failed");
        setProblem(COPY.studio.modelFailed(e.message));
      });

    /*
     * 只对「iOS + 独立窗口之外 + 这次会话没关过」提示。
     * navigator.standalone 是 iOS 专有的，装到主屏后为 true。
     */
    const nav = window.navigator as Navigator & { standalone?: boolean };
    const isIOS = /iPad|iPhone|iPod/.test(nav.userAgent) && !/CriOS|FxiOS/.test(nav.userAgent);
    if (isIOS && !nav.standalone && sessionStorage.getItem("ar-install-hint") !== "off") {
      setShowInstall(true);
    }

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
    // 403 = 没解锁，404 = 没这个 slug。两种都退回上层去挑别的模板，不是异常
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new Error(`config ${res.status}`);
    const { config } = (await res.json()) as { config: TemplateConfig };
    return config;
  }, []);

  const applyTemplate = useCallback((cfg: TemplateConfig) => {
    setConfig(cfg);
    engineRef.current?.setTemplate(cfg);
    setValues((prev) => {
      const next: ControlValues = {};
      for (const c of cfg.controls) next[c.key] = prev[c.key] ?? c.default;
      engineRef.current?.setControls(next);
      return next;
    });
  }, []);

  useEffect(() => {
    void fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ event: "view", slug: initialSlug }] }),
    });
  }, [initialSlug]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch("/api/templates");
      const { items } = (await res.json()) as { items: TemplateListing[] };
      if (!alive) return;
      setListing(items);

      /*
       * 先按 URL 里的 slug 试一次，试不成再回落到第一个可用模板。
       *
       * 不能只在 items 里找：hidden 模板（调试视图、没做完的）刻意不进列表，
       * 但 /studio/<slug> 直接访问必须能用 —— hidden 是列表过滤，不是权限。
       * 只查列表的话这类模板永远打不开，而且会静默跳到 cloud，看着像路由坏了。
       */
      const listed = items.find((it) => it.slug === initialSlug && !it.locked);
      const cfg = (await loadConfig(listed?.slug ?? initialSlug)) ?? null;
      if (alive && cfg) {
        applyTemplate(cfg);
        return;
      }

      const fallback = items.find((it) => !it.locked);
      if (!fallback) return;
      const fallbackCfg = await loadConfig(fallback.slug);
      if (alive && fallbackCfg) applyTemplate(fallbackCfg);
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
        window.location.href = data.redirectUrl;
        return;
      }
      if (data.error) {
        setProblem(
          data.error === "payments_unavailable"
            ? COPY.studio.unlockUnavailable
            : COPY.studio.unlockFailed,
        );
        setLockedTarget(null);
        return;
      }
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
      await engine.startCamera(facing);
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

  /**
   * 前后置切换。
   *
   * 前置框不进全身 —— fluidity 这类需要全身入镜的模板必须用后置。
   * 之前 facingMode 是写死的 "user"，而且没有任何切换入口。
   */
  /**
   * 切缩放档位。
   *
   * 给档位而不是只给捏合：双指在小屏上很难精确，而且拍的时候一只手要拿稳手机。
   * 系统相机也是这么做的（.5 / 1x / 2 / 3），捏合只作微调。
   * 高亮跟着 **stats.zoom** 走而不是本地 state —— 捏合改的是引擎里那个值，
   * 两套控件各存各的话，捏完之后高亮的还是旧档位。
   */
  const setZoom = useCallback((z: number) => {
    engineRef.current?.setZoom(z);
  }, []);

  const flipCamera = useCallback(() => {
    const next = facing === "user" ? "environment" : "user";
    setFacing(next);
    engineRef.current?.startCamera(next).catch((e: Error) => setProblem(e.message));
  }, [facing]);

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

  /**
   * 存到相册。
   *
   * 按钮**常驻**而不是「支持才显示」：不显示的话用户根本不知道有这条路，
   * 而能不能用要到点下去才知道（canShare 依赖文件类型）。
   * 点了不行就如实说，并留着旁边的下载按钮兜底。
   */
  const saveToAlbum = useCallback(async () => {
    if (!result || !config) return;
    setSaveNote(null);
    const r = await saveToPhotos(result, config.slug);
    if (r === "webm") setSaveNote(COPY.studio.saveWebmHint);
    else if (r === "unsupported") setSaveNote(COPY.studio.saveUnsupported);
    // ok / cancelled 都不提示 —— 用户自己取消不是错误
  }, [result, config]);

  const statusLine = useMemo(() => {
    if (phase !== "live") return "";
    // 不需要感知的模板没有东西可追，说「在找人」是假信息
    const track = !stats.needsTracking ? "" : stats.tracking ? COPY.studio.tracking : COPY.studio.waiting;
    // 把摄像头实际给的分辨率也显示出来：「缩放不对」「掉帧」这类反馈
    // 只有落到具体数字上才查得动
    const parts = [track, `${stats.fps} fps`, stats.camera, stats.degraded ? COPY.studio.degraded : ""].filter(
      Boolean,
    );
    return parts.join(" · ");
  }, [phase, stats]);

  /* ============================================================
   * 单一 DOM 结构，通过 CSS 断点实现：
   * - 手机 (<md)：全屏竖屏相机，控制件浮在画面上
   * - 桌面 (md+)：居中 16:9 + 下方控制条
   * ============================================================ */

  return (
    <div className="h-[100dvh] md:h-auto md:min-h-[100dvh] w-full bg-black md:bg-bg md:flex md:flex-col md:items-center md:justify-center md:gap-4 md:p-5 relative overflow-hidden">

      {/* 画布容器：手机全屏 / 桌面 16:9 */}
      <div className="absolute inset-0 md:relative md:w-full md:max-w-[1100px] md:overflow-hidden md:rounded-2xl md:border md:border-line md:aspect-video touch-none">
        <video ref={videoRef} playsInline muted autoPlay className="hidden" />
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>

      {/* 加载/授权覆盖层：绝对定位叠在画布上 */}
      {phase !== "live" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-bg md:rounded-2xl px-6 text-center"
             style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {phase === "loading" && <p className="text-muted text-body">{COPY.studio.loadingModel}</p>}
          {phase === "ready" && (
            <>
              <button
                onClick={openCamera}
                disabled={busy}
                className="rounded-full bg-accent px-7 py-3.5 md:py-3 text-[16px] md:text-[15px] font-medium text-[#1A0F2E] disabled:opacity-50"
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

      {/* ---- 桌面端 overlay（录制指示器 + 拖拽提示）---- */}
      {config?.emitter?.draggable && phase === "live" && (
        <p className="hidden md:block pointer-events-none absolute left-1/2 top-8 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1.5 text-note text-white/60 z-20">
          {COPY.studio.dragHint}
        </p>
      )}
      {recording && (
        <div className="hidden md:flex absolute right-8 top-8 items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 z-20">
          <span className="h-2 w-2 animate-blink rounded-full bg-rec" />
          <span className="font-mono text-note text-fg">
            {String(Math.floor(elapsed / 1000)).padStart(2, "0")}s / 60s
          </span>
        </div>
      )}

      {/* ---- 桌面端控制件 ---- */}
      <div className="hidden md:flex flex-wrap justify-center gap-2.5 relative z-10">
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
                <PropThumb shape={tpl.preview.shape} ratio={0.62} className={`w-full ${tpl.locked ? "opacity-[.42]" : ""}`} />
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

      <div className="hidden md:flex flex-wrap items-center justify-center gap-4 rounded-2xl border border-line bg-surface px-5 py-3 relative z-10">
        {config?.controls.map((c) => (
          <label key={c.key} className="flex items-center gap-2 text-[13px] text-muted">
            {t(c.label)}
            {/*
              离散档位渲染成一排按钮，不是滑块。
              「强度四档」这种诉求用连续滑块表达不了 —— 用户要的是选一个预设，
              不是在 0~100 之间找一个数。
            */}
            {c.options ? (
              <span className="flex gap-1">
                {c.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setValue(c.key, o.value)}
                    className={`rounded-full px-2.5 py-1 text-[12px] border transition-colors ${
                      (values[c.key] ?? c.default) === o.value
                        ? "border-fg bg-fg text-bg"
                        : "border-line text-muted hover:text-fg"
                    }`}
                  >
                    {t(o.label)}
                  </button>
                ))}
              </span>
            ) : (
            <input
              type="range"
              min={c.min}
              max={c.max}
              step={c.step ?? 1}
              value={values[c.key] ?? c.default}
              onChange={(e) => setValue(c.key, Number(e.target.value))}
              className="w-24"
            />
            )}
            {!c.options && (
              <span className="min-w-[30px] text-right font-mono text-[11px] text-fg">
                {values[c.key] ?? c.default}
              </span>
            )}
          </label>
        ))}
        <span className="h-6 w-px bg-line" />
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={useMic} onChange={(e) => toggleMic(e.target.checked)} />
          {COPY.studio.micLabel}
        </label>
        <button
          onClick={flipCamera}
          disabled={phase !== "live"}
          title={COPY.studio.flipCamera}
          className="rounded-full px-3.5 py-1.5 text-[13px] text-muted disabled:opacity-40 hover:text-fg"
        >
          {COPY.studio.flipCamera}
        </button>
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

      <p className="hidden md:block font-mono text-note text-muted relative z-10">{statusLine || problem}</p>

      {/* ==================== 手机端浮层 ==================== */}

      {/*
        收起状态下铺一层透明层，点一下把 UI 叫回来。
        只在收起时存在 —— 常驻的话会挡住可拖拽道具的拖动手势。
      */}
      {phase === "live" && uiHidden && (
        <button
          onClick={() => setUiHidden(false)}
          aria-label={COPY.studio.showUi}
          className="md:hidden absolute inset-0 z-20"
        />
      )}

      {/* 顶部：模板名 + 录制计时 */}
      {phase === "live" && (
        <div className={`md:hidden absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 transition-opacity ${
               uiHidden ? "pointer-events-none opacity-0" : "opacity-100"
             }`}
             style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}>
          <span className="rounded-full bg-black/50 px-3 py-1.5 text-[13px] text-white/80">
            {config ? t(config.name) : ""}
          </span>
          <button
            onClick={() => setUiHidden(true)}
            aria-label={COPY.studio.hideUi}
            className="rounded-full bg-black/50 px-3 py-1.5 text-[13px] text-white/70"
          >
            {COPY.studio.hideUi}
          </button>
          {recording && (
            <div className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5">
              <span className="h-2 w-2 animate-blink rounded-full bg-rec" />
              <span className="font-mono text-[12px] text-fg">
                {String(Math.floor(elapsed / 1000)).padStart(2, "0")}s
              </span>
            </div>
          )}
        </div>
      )}

      {/* 拖拽提示（手机） */}
      {config?.emitter?.draggable && phase === "live" && !recording && (
        <p className="md:hidden pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1.5 text-note text-white/60"
           style={{ top: "calc(env(safe-area-inset-top, 0px) + 52px)" }}>
          {COPY.studio.dragHint}
        </p>
      )}

      {/* 底部控制区（手机） */}
      {phase === "live" && (
        <div className={`md:hidden absolute bottom-0 left-0 right-0 z-20 flex flex-col gap-3 transition-opacity ${
               uiHidden ? "pointer-events-none opacity-0" : "opacity-100"
             }`}
             style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}>

          {/*
            缩放档位。最低那一档是**算出来的「完整视野」**，不是固定的 0.5 ——
            1920x1080 的流塞进竖屏，cover 只显示宽度的 31%，0.5 档翻倍也才 63%，
            仍然裁掉 37%。真正不裁需要缩到 0.31，那个数只能从两个长宽比算。
            标签直接显示算出来的值，用户看到的就是「这台设备最宽能到多少」。
          */}
          <div className="flex justify-center gap-2 px-4">
            {/*
              fitZoom 等于 1 时（流本来就够竖，没什么可缩的）要去掉那一档 ——
              不去重的话会出现两个并排的「1×」，而且两个都高亮。
            */}
            {(stats.fitZoom < 0.95 ? [stats.fitZoom, 1, 2, 3] : [1, 2, 3]).map((z) => (
              <button
                key={z}
                onClick={() => setZoom(z)}
                className={`h-9 min-w-9 rounded-full px-3 font-mono text-[12px] backdrop-blur ${
                  Math.abs(stats.zoom - z) < 0.02 ? "bg-white text-black" : "bg-black/50 text-white/80"
                }`}
              >
                {COPY.studio.zoomLabel(z)}
              </button>
            ))}
          </div>

          {/* 模板横向滚动 */}
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-4">
            {listing.map((tpl) => {
              const on = tpl.slug === config?.slug;
              return (
                <button
                  key={tpl.slug}
                  onClick={() => pick(tpl)}
                  className={`relative flex-shrink-0 w-[64px] rounded-lg border bg-black/50 backdrop-blur px-1 pb-1.5 pt-1.5 ${
                    on ? "border-accent" : "border-white/20"
                  }`}
                >
                  {tpl.preview.shape && (
                    <PropThumb shape={tpl.preview.shape} ratio={0.6} className={`w-full ${tpl.locked ? "opacity-40" : ""}`} />
                  )}
                  <div className={`mt-0.5 text-center text-[10px] ${on ? "text-accent" : "text-white/70"}`}>
                    {t(tpl.name)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 操作栏：设置 | 快门 | 麦克风 */}
          <div className="flex items-center justify-center gap-8 px-4">
            <button
              onClick={() => setShowControls(!showControls)}
              aria-label={COPY.studio.settings}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur text-white/80"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>

            {/*
              手机上这几个圆钮原来一个可访问名称都没有 —— 读屏软件念不出来，
              自动化也点不到（冒烟里那条「录完之后有没有存相册按钮」因此
              整段被跳过，突变都抓不到）。补上 aria-label 两个问题一起解决。
            */}
            <button
              onClick={toggleRecord}
              disabled={phase !== "live"}
              aria-label={recording ? COPY.studio.recordStop : COPY.studio.recordStart}
              className="relative flex h-[72px] w-[72px] items-center justify-center rounded-full border-[3px] border-white/80 disabled:opacity-40"
            >
              <span className={`rounded-full transition-all duration-200 ${
                recording
                  ? "h-[28px] w-[28px] rounded-[6px] bg-rec"
                  : "h-[56px] w-[56px] bg-rec"
              }`} />
            </button>

            <button
              onClick={() => toggleMic(!useMic)}
              aria-label={COPY.studio.micLabel}
              className={`flex h-11 w-11 items-center justify-center rounded-full backdrop-blur ${
                useMic ? "bg-accent text-[#1A0F2E]" : "bg-black/50 text-white/80"
              }`}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>

            {/*
              翻转摄像头。**手机上这个按钮比桌面重要得多** ——
              笔记本只有前置，而全身类模板（fluidity）非后置不可。
              上一版只加在桌面那一排里，手机上根本看不到入口。
            */}
            <button
              onClick={flipCamera}
              aria-label={COPY.studio.flipCamera}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h3l2-2h8l2 2h3v12H3z" />
                <path d="M15 12a3 3 0 1 1-3-3" />
                <polyline points="12 6.5 12 9 14.5 9" />
              </svg>
            </button>
          </div>

          {/* 加个底衬：原来白字直接压在画面上，浅色背景下几乎读不出来 */}
          <p className="mx-auto rounded-full bg-black/45 px-3 py-1 text-center font-mono text-[11px] text-white/70">
            {statusLine}
          </p>
        </div>
      )}

      {/* 参数抽屉（手机） */}
      {showControls && phase === "live" && (
        /*
          面板高度封到 48vh 并内部滚动。
          原来它撑到 80% 屏高，**调滑块时完全看不到效果** —— 而这是个纯视觉的
          工具，看不到就只能拖一下关掉再看一眼，来回好几趟。
        */
        <div className="md:hidden absolute inset-x-0 bottom-0 z-30 flex max-h-[48vh] flex-col rounded-t-2xl bg-surface/95 backdrop-blur border-t border-line"
             style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-line">
            <span className="text-[14px] font-medium text-fg">Settings</span>
            <button onClick={() => setShowControls(false)} className="text-muted text-[13px]">Done</button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {config?.controls.map((c) => (
              <label key={c.key} className="flex items-center gap-3 text-[14px] text-muted">
                <span className="w-16 shrink-0">{t(c.label)}</span>
                {c.options ? (
                  <span className="flex flex-1 gap-1.5">
                    {c.options.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setValue(c.key, o.value)}
                        className={`flex-1 rounded-full px-2 py-1.5 text-[12px] border transition-colors ${
                          (values[c.key] ?? c.default) === o.value
                            ? "border-fg bg-fg text-bg"
                            : "border-line text-muted"
                        }`}
                      >
                        {t(o.label)}
                      </button>
                    ))}
                  </span>
                ) : (
                  <>
                    <input
                      type="range"
                      min={c.min}
                      max={c.max}
                      step={c.step ?? 1}
                      value={values[c.key] ?? c.default}
                      onChange={(e) => setValue(c.key, Number(e.target.value))}
                      className="flex-1"
                    />
                    <span className="w-10 text-right font-mono text-[12px] text-fg">
                      {values[c.key] ?? c.default}
                    </span>
                  </>
                )}
              </label>
            ))}
          </div>
        </div>
      )}

      {/*
        引导添加到主屏（只有 iOS 普通标签页会看到）。
        **只在开摄像头之前显示**：第一版没加这个条件，横幅盖住了底部的模板条，
        拍摄时想换模板点不到 —— 冒烟里「切模板不重开摄像头」那条当场超时才发现。
        而且时机上也该在开始之前说，不是拍到一半打断人。
      */}
      {showInstall && phase !== "live" && (
        <div className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-5 pt-4 backdrop-blur"
             style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}>
          <p className="text-[14px] font-medium text-fg">{COPY.studio.installTitle}</p>
          <p className="mt-1 text-note text-muted">{COPY.studio.installBody}</p>
          <button
            onClick={() => {
              sessionStorage.setItem("ar-install-hint", "off");
              setShowInstall(false);
            }}
            className="mt-3 w-full rounded-full border border-line py-2 text-[13px] text-muted"
          >
            {COPY.studio.installDismiss}
          </button>
        </div>
      )}

      {/* ==================== 共享弹层 ==================== */}

      {result && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-5">
          <div className="w-full max-w-[520px] rounded-2xl border border-[#34343C] bg-surface p-6">
            <video src={result.url} controls autoPlay loop playsInline className="w-full rounded-lg" />
            {result.container === "webm" && (
              <p className="mt-3 text-note text-gold">{COPY.studio.webmWarning}</p>
            )}
            {saveNote && <p className="mt-3 text-note text-gold">{saveNote}</p>}
            <div className="mt-4 flex flex-col gap-3">
              {/*
                「存到相册」放在最上面：手机上这才是绝大多数人要的动作。
                原来只有「下载」，而 iOS Safari 的下载会**打开**文件而不是存下来，
                用户得再长按视频→存储，正是 Gary 说的「有点麻烦」。
              */}
              <button
                onClick={saveToAlbum}
                className="w-full rounded-full bg-accent py-2.5 text-[14px] font-medium text-[#1A0F2E]"
              >
                {COPY.studio.saveToPhotos}
              </button>
              <div className="flex gap-3">
                <button
                  onClick={saveResult}
                  className="flex-1 rounded-full border border-line py-2.5 text-[13px] text-muted"
                >
                  {COPY.studio.resultDownload(result.container.toUpperCase())}
                </button>
                <button
                  onClick={() => { URL.revokeObjectURL(result.url); setResult(null); setSaveNote(null); }}
                  className="rounded-full border border-line px-5 text-[13px] text-muted"
                >
                  {COPY.studio.resultRetake}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {lockedTarget && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-5">
          <div className="w-full max-w-[340px] rounded-[18px] border border-[#34343C] bg-surface p-7 text-center">
            <h2 className="text-[19px] font-semibold">{COPY.studio.unlockTitle(t(lockedTarget.name))}</h2>
            <p className="mt-1.5 text-[13px] leading-[1.7] text-muted">{COPY.studio.unlockBody}</p>
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
            <button onClick={() => setLockedTarget(null)} className="mt-3 text-[13px] text-muted">
              {COPY.studio.unlockLater}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
