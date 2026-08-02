"use client";

/**
 * 摄像头自检页。**不是给用户的功能**，是给我用的诊断工具。
 *
 * 存在的理由：iOS Safari 到底能给出什么样的流，**猜不出来也测不出来**。
 * Playwright 的 WebKit 里 `navigator.mediaDevices` 根本不存在，桌面 Safari 走的是
 * 另一套采集栈，模拟器没有真摄像头 —— 唯一的信息源就是 Gary 的真机。
 * 而每问一个问题就要「改代码 → 发版 → 他上手机 → 截图」跑一整轮，
 * 一次只能验一个假设，这就是慢的根源。
 *
 * 所以这一页**一次把整个约束矩阵跑完**，把每种问法拿到的真实分辨率列出来。
 * 他开一次、点一个「复制」，我就拿到了这台设备的全部能力，
 * 不用再一轮一轮试。
 *
 * 为什么矩阵里既有 ideal 又有 exact：`ideal` 是偏好，给不了会**静默**降级 ——
 * 我之前一直用 ideal，所以永远分不清「设备不支持」和「我问错了」。
 * `exact` 不支持就抛 OverconstrainedError，那是个**明确答案**。
 * 已知 Safari 只认少数几个预设宽度，exact 大概率会抛 —— 抛了也是结论。
 */

import { useCallback, useRef, useState } from "react";

type Row = {
  label: string;
  /** 实际拿到的分辨率。iOS 会无视请求给别的，所以「要了什么」和「拿到什么」必须分开记 */
  got: string;
  aspect: string;
  err?: string;
  /** track.getCapabilities()，能看出这台设备的分辨率上限 —— 也就是最大视野 */
  caps?: string;
};

/**
 * 要跑的问法。每一条都是一个**具体假设**，不是随便试试。
 *
 * 顺序从「完全不提要求」开始：如果连它都给横向流，那就说明
 * 竖向流压根不存在，后面所有花样都是白费 —— 这个对照组我之前一直没做。
 */
const MATRIX: { label: string; video: MediaTrackConstraints }[] = [
  { label: "不提任何要求", video: {} },
  { label: "aspectRatio 3/4（竖 4:3，系统相机就是这个）", video: { aspectRatio: 3 / 4 } },
  { label: "aspectRatio 9/16（竖 16:9）", video: { aspectRatio: 9 / 16 } },
  { label: "aspectRatio exact 3/4", video: { aspectRatio: { exact: 3 / 4 } } },
  { label: "ideal 1080x1920（我线上正在用的）", video: { width: { ideal: 1080 }, height: { ideal: 1920 } } },
  { label: "exact 1080x1920", video: { width: { exact: 1080 }, height: { exact: 1920 } } },
  { label: "ideal 1440x1080（横 4:3）", video: { width: { ideal: 1440 }, height: { ideal: 1080 } } },
  { label: "ideal width 1280（Safari 认的预设值之一）", video: { width: { ideal: 1280 } } },
];

export default function CameraCheck() {
  const [rows, setRows] = useState<Row[]>([]);
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const textRef = useRef<HTMLTextAreaElement>(null);

  const run = useCallback(
    async (want: "user" | "environment") => {
      setBusy(true);
      setFacing(want);
      setRows([]);

      const o = (screen as Screen & { orientation?: { type?: string } }).orientation;
      setEnv(
        [
          `视口 ${innerWidth}x${innerHeight}（比 ${(innerWidth / innerHeight).toFixed(3)}）`,
          `屏幕 ${screen.width}x${screen.height}  DPR ${devicePixelRatio}`,
          `方向 ${o?.type ?? "?"}`,
          navigator.userAgent,
        ].join("\n"),
      );

      const out: Row[] = [];
      for (const m of MATRIX) {
        let stream: MediaStream | null = null;
        try {
          /*
           * facingMode 用 ideal 不用 exact：exact 在某些机器上会让整条约束直接失败，
           * 那样每一行都是错误，矩阵就什么都没测到。
           */
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: want }, ...m.video },
            audio: false,
          });
          const track = stream.getVideoTracks()[0];
          const s = track.getSettings();
          /*
           * **必须真的播一帧再量。**
           *
           * 这一页上一版直接信 `track.getSettings()`，于是报「ideal 1080x1920
           * 拿到了 1080x1920」，我照着改完，真机状态栏是 `1920x1080`。
           * iOS 的 getSettings 会把**请求的值回读回来**，这一页从头到尾没播过
           * 一帧，所以它复述的是我自己的问题，不是设备的回答 ——
           * 一个只会附和的诊断工具比没有更坏，我按它的结论改错了一轮。
           *
           * videoWidth/Height 是解码器给的真实帧尺寸。两者不一致时两个都列出来。
           */
          const v = document.createElement("video");
          v.muted = true;
          v.playsInline = true;
          v.srcObject = stream;
          await new Promise<void>((res) => {
            const done = () => res();
            v.addEventListener("loadedmetadata", done, { once: true });
            setTimeout(done, 2000);
          });
          const w = v.videoWidth || 0;
          const h = v.videoHeight || 0;
          v.srcObject = null;
          const caps = track.getCapabilities?.() as
            | { width?: { max?: number }; height?: { max?: number } }
            | undefined;
          const claimed = `${s.width}x${s.height}`;
          out.push({
            label: m.label,
            got:
              `${w}x${h}${s.frameRate ? ` @${Math.round(s.frameRate)}` : ""}` +
              // 声称的和实际的不一样时一定要显出来 —— 这个差正是上一轮判断错的原因
              (claimed !== `${w}x${h}` ? `（getSettings 声称 ${claimed}）` : ""),
            aspect: h ? (w / h).toFixed(3) : "?",
            caps: caps?.width?.max ? `上限 ${caps.width.max}x${caps.height?.max ?? "?"}` : undefined,
          });
        } catch (e) {
          out.push({ label: m.label, got: "—", aspect: "—", err: (e as Error).name || String(e) });
        } finally {
          // 必须逐条释放：iOS 上同时开多路会直接失败，后面的行就全成了假阴性
          stream?.getTracks().forEach((t) => t.stop());
        }
        setRows([...out]);
        await new Promise((r) => setTimeout(r, 250));
      }
      setBusy(false);
    },
    [],
  );

  const report =
    `=== ${facing === "user" ? "前置" : "后置"} ===\n${env}\n\n` +
    rows.map((r) => `${r.label}\n  → ${r.err ? `❌ ${r.err}` : `${r.got}  比 ${r.aspect}  ${r.caps ?? ""}`}`).join("\n");

  return (
    <main className="min-h-dvh bg-black p-4 font-mono text-[13px] text-white">
      <h1 className="mb-1 text-base font-bold">摄像头自检</h1>
      <p className="mb-4 text-[11px] leading-relaxed text-white/50">
        把每一种问法拿到的真实分辨率列出来。跑完点「复制结果」发给我。
      </p>

      <div className="mb-4 flex gap-2">
        <button
          onClick={() => run("user")}
          disabled={busy}
          className="flex-1 rounded-lg bg-white px-3 py-3 font-bold text-black disabled:opacity-40"
        >
          测前置
        </button>
        <button
          onClick={() => run("environment")}
          disabled={busy}
          className="flex-1 rounded-lg bg-white/15 px-3 py-3 font-bold disabled:opacity-40"
        >
          测后置
        </button>
      </div>

      {env && <pre className="mb-4 whitespace-pre-wrap break-all text-[11px] text-white/60">{env}</pre>}

      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg bg-white/5 p-3">
            <div className="text-[11px] text-white/50">{r.label}</div>
            {r.err ? (
              <div className="mt-1 text-red-400">❌ {r.err}</div>
            ) : (
              <div className="mt-1">
                <span className="text-base font-bold text-emerald-400">{r.got}</span>
                <span className="ml-2 text-white/50">比 {r.aspect}</span>
                {r.caps && <span className="ml-2 text-white/40">{r.caps}</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {busy && <div className="mt-3 text-white/50">跑着…（每条之间要停一下让上一路彻底关掉）</div>}

      {rows.length > 0 && !busy && (
        <>
          {/* 复制比截图强：文字我能直接读，截图里的数字还得我认 */}
          <button
            onClick={() => {
              textRef.current?.select();
              navigator.clipboard?.writeText(report).catch(() => document.execCommand("copy"));
            }}
            className="mt-4 w-full rounded-lg bg-emerald-500 px-3 py-3 font-bold text-black"
          >
            复制结果
          </button>
          <textarea
            ref={textRef}
            readOnly
            value={report}
            className="mt-2 h-40 w-full rounded-lg bg-white/5 p-2 text-[10px] text-white/60"
          />
        </>
      )}
    </main>
  );
}
