/**
 * 语义锚点表。JSON 里只准写左列的名字，数字编号是引擎内部实现。
 * LLM 在 478 个编号里挑数字是幻觉重灾区，语义名消除这个问题。
 */

export const FACE_ANCHORS = {
  // 眼部
  lower_eyelid_left: 145,  lower_eyelid_right: 374,
  upper_eyelid_left: 159,  upper_eyelid_right: 386,
  eye_outer_left: 33,      eye_outer_right: 263,
  iris_left: 468,          iris_right: 473,
  // 中轴
  nose_bridge: 168, nose_tip: 4, forehead: 151, head_top: 10,
  chin: 152, mouth_center: 13,
  upper_lip: 0, lower_lip: 17,
  // 两侧
  cheek_left: 50, cheek_right: 280,
  temple_left: 127, temple_right: 356,
  jaw_left: 172, jaw_right: 397,
  ear_left: 234, ear_right: 454,
} as const;

export type FaceAnchorName = keyof typeof FACE_ANCHORS;

/** 成对锚点：mirrorPair 与 perEye 依赖这张表做镜像展开 */
export const ANCHOR_PAIRS: Record<string, [FaceAnchorName, FaceAnchorName]> = {
  lower_eyelid: ["lower_eyelid_left", "lower_eyelid_right"],
  upper_eyelid: ["upper_eyelid_left", "upper_eyelid_right"],
  eye_outer:    ["eye_outer_left",    "eye_outer_right"],
  iris:         ["iris_left",         "iris_right"],
  cheek:        ["cheek_left",        "cheek_right"],
  temple:       ["temple_left",       "temple_right"],
};

/** 把语义名或数字 landmark 解析为数字索引。兼容旧 JSON 的数字写法（打 warning）。 */
export function resolveLandmark(value: string | number): number | null {
  if (typeof value === "number") return value;
  const idx = FACE_ANCHORS[value as FaceAnchorName];
  return idx !== undefined ? idx : null;
}
