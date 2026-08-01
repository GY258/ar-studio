/**
 * 全身姿态锚点：语义名 → MediaPipe PoseLandmarker 的点号。
 *
 * 和人脸、手部两张表同一个约定：**JSON 里只写语义名，绝不写数字**。
 * 数字是模型的实现细节，换个模型就全错，而且没人看得懂 `landmark: 15` 是哪。
 *
 * 左右说的是**本人的**左右，不是画面上的左右 —— 画面是镜像的
 * （背景平面 scale.x = -1），所以本人的左手出现在屏幕右侧。
 * 这一点和 hand-anchors 的 handedness 是同一个坑，按「戴表的那只手」思考。
 */
export const POSE_ANCHORS = {
  nose: 0,
  eye_left: 2,
  eye_right: 5,
  ear_left: 7,
  ear_right: 8,
  mouth_left: 9,
  mouth_right: 10,
  shoulder_left: 11,
  shoulder_right: 12,
  elbow_left: 13,
  elbow_right: 14,
  wrist_left: 15,
  wrist_right: 16,
  pinky_left: 17,
  pinky_right: 18,
  index_left: 19,
  index_right: 20,
  thumb_left: 21,
  thumb_right: 22,
  hip_left: 23,
  hip_right: 24,
  knee_left: 25,
  knee_right: 26,
  ankle_left: 27,
  ankle_right: 28,
  heel_left: 29,
  heel_right: 30,
  foot_left: 31,
  foot_right: 32,
} as const;

export type PoseAnchorName = keyof typeof POSE_ANCHORS;

/**
 * 骨架连线：哪两个点之间算一根「骨头」。
 *
 * 给需要画骨架的效果用。**不含脸上那几个点**（眼、耳、嘴）——
 * 它们挤在一小块地方，连起来是一团糊，而躯干四肢才是「人体运动」的读法。
 */
export const POSE_BONES: [PoseAnchorName, PoseAnchorName][] = [
  ["shoulder_left", "shoulder_right"],
  ["shoulder_left", "elbow_left"],
  ["elbow_left", "wrist_left"],
  ["shoulder_right", "elbow_right"],
  ["elbow_right", "wrist_right"],
  ["shoulder_left", "hip_left"],
  ["shoulder_right", "hip_right"],
  ["hip_left", "hip_right"],
  ["hip_left", "knee_left"],
  ["knee_left", "ankle_left"],
  ["hip_right", "knee_right"],
  ["knee_right", "ankle_right"],
];

/**
 * 挂框的点。比全部 33 个少 —— 眼耳嘴四个点挤在脸上，
 * 每个都挂一个框的话脸会被糊住，而参考素材里脸上只有两三个框。
 */
export const POSE_BOX_POINTS: PoseAnchorName[] = [
  "nose",
  "ear_left",
  "ear_right",
  "shoulder_left",
  "shoulder_right",
  "elbow_left",
  "elbow_right",
  "wrist_left",
  "wrist_right",
  "index_left",
  "index_right",
  "hip_left",
  "hip_right",
  "knee_left",
  "knee_right",
  "ankle_left",
  "ankle_right",
  "foot_left",
  "foot_right",
];
