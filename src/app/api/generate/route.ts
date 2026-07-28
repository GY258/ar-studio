import { NextRequest, NextResponse } from "next/server";
import { FACE_ANCHORS } from "@/engine/anchors";
import { listSvgKeys } from "@/engine/svg-assets";
import { validateTemplate } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * POST /api/generate
 *
 * 接收自然语言描述，返回模板 JSON。
 * 目前返回 system prompt + 可用锚点/素材/动画列表，
 * 供前端或外部 LLM 调用生成。
 *
 * 后续接入 Claude API 后可直接在服务端生成 + 校验 + 修复。
 */

const SYSTEM_PROMPT = `You are a template designer for AR Studio. Generate a valid template JSON.

## Available Face Anchors (use these names, never raw numbers):
${Object.keys(FACE_ANCHORS).join(", ")}

## Available SVG Assets:
${listSvgKeys().join(", ")}

## Animation Presets:
- float: { preset: "float", amplitude: number, period: number, phase?: number }
- fall: { preset: "fall", period: number, phase?: number }
- pulse: { preset: "pulse", scaleRange: [min, max], period: number }
- spin: { preset: "spin", period: number }
- emit-fall-fade: { preset: "emit-fall-fade", distance: number, period: number, phase?: number, outwardDrift?: 0.08, shrink?: 0.3 }

## Template Types:
- "overlay": static screen-space elements (overlay_elements array, each with nx/ny/sizeW)
- "facetrack": face-anchored elements (face_track_elements array, each with landmark/iodScale)

## Element Fields:
- id: unique string
- type: "svg" | "text" (overlay) or "tear-pool" | "trailing-tear" | "blush" | "sticker" | "text" (facetrack)
- svgAsset: key from SVG assets list
- text: string content (for text type)
- landmark: anchor name from the list above (facetrack only)
- offsetX/offsetY: offset in IOD units (facetrack sticker only)
- iodScale: size relative to inter-iris distance
- nx/ny: normalized screen position 0-1 (overlay only)
- sizeW: width as fraction of screen width (overlay only)
- animations: array of animation presets

## Rules:
1. Always use semantic anchor names, never numbers
2. All SVG assets must exist in the available list
3. iodScale should be 0.05-1.0 for most elements
4. Template must have slug, name (zh+en), category, price_cents, template_type
5. Return ONLY valid JSON, no markdown fences`;

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
