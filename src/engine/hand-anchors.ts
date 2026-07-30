/**
 * 手部语义锚点表。和 FACE_ANCHORS 一个待遇：JSON 里只准写左列的名字。
 *
 * MediaPipe 的 21 个编号比 478 个少得多，但「让 LLM 记住 8 是食指指尖」
 * 仍然是没必要的幻觉来源，而且数字进了 JSON 就等于把引擎内部实现写进了模板。
 */

export const HAND_ANCHORS = {
  wrist: 0,

  thumb_mcp: 2,
  thumb_ip: 3,
  thumb_tip: 4,

  index_mcp: 5,
  index_pip: 6,
  index_dip: 7,
  index_tip: 8,

  middle_mcp: 9,
  middle_pip: 10,
  middle_dip: 11,
  middle_tip: 12,

  ring_mcp: 13,
  ring_pip: 14,
  ring_dip: 15,
  ring_tip: 16,

  pinky_mcp: 17,
  pinky_pip: 18,
  pinky_dip: 19,
  pinky_tip: 20,
} as const;

export type HandAnchorName = keyof typeof HAND_ANCHORS;

/** 五根指尖，「每根手指挂一个东西」这类需求直接用这个列表 */
export const FINGER_TIPS: HandAnchorName[] = ["thumb_tip", "index_tip", "middle_tip", "ring_tip", "pinky_tip"];

export function resolveHandLandmark(name: string): number | null {
  const idx = HAND_ANCHORS[name as HandAnchorName];
  return idx !== undefined ? idx : null;
}
