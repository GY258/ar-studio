import { NextRequest, NextResponse } from "next/server";
import { FACE_ANCHORS } from "@/engine/anchors";
import { listSvgKeys } from "@/engine/svg-assets";
import { validateTemplate } from "@/lib/validate";
import { buildSystemPrompt } from "@/lib/template-prompt";

export const dynamic = "force-dynamic";

/**
 * POST /api/generate
 *
 * 接收自然语言描述，返回模板 JSON。
 * 目前返回 system prompt + 可用锚点/素材/动画列表，
 * 供前端或外部 LLM 调用生成。
 *
 * system prompt 和 ar-template skill 的 reference 来自同一个
 * src/lib/template-prompt.ts。以前这里是一大段手抄的字符串，
 * 已经教着 v1 的字段名（overlay_elements / iodScale / type:"tear-pool"）——
 * 照它生成出来的 JSON 现在一份都过不了校验。不要再把 schema 抄进这个文件。
 *
 * 注意能力差距：skill 那条路能跑校验、能渲染出图、能看图，是完整闭环；
 * 这条路只能跑 validateTemplate 回喂，是半个闭环。要补齐得在服务端起
 * headless chromium，那是另一笔基建。
 */
const SYSTEM_PROMPT = buildSystemPrompt();

export async function POST(req: NextRequest) {
  let body: { description?: string; validate?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const description = (body.description ?? "").trim();
  if (!description) {
    return NextResponse.json({ error: "description required" }, { status: 400 });
  }

  // 如果只是要 system prompt（前端自己调 LLM）
  if (!body.validate) {
    return NextResponse.json({
      systemPrompt: SYSTEM_PROMPT,
      anchors: Object.keys(FACE_ANCHORS),
      svgAssets: listSvgKeys(),
      animationPresets: ["float", "fall", "pulse", "spin", "emit-fall-fade"],
    });
  }

  // 校验模式：前端传来 LLM 生成的 JSON，这里校验
  let template: Record<string, unknown>;
  try {
    template = JSON.parse(description);
  } catch {
    return NextResponse.json({ error: "invalid template JSON", problems: ["JSON 解析失败"] }, { status: 400 });
  }

  const problems = validateTemplate(template);
  if (problems.length > 0) {
    return NextResponse.json({ error: "validation_failed", problems }, { status: 422 });
  }

  return NextResponse.json({ ok: true, template });
}
