<!-- 由 npm run gen:skill-reference 从源码生成，不要手改 -->

# 人脸锚点

JSON 里**只准写左列的语义名**。右列的编号是引擎内部实现，
在 478 个编号里挑数字是幻觉重灾区，语义名就是为了消除这个问题——写数字会被校验拒收。

### 眼部

| 语义名 | mesh 编号（引擎内部，JSON 里不要写） |
|---|---|
| `lower_eyelid_left` | 145 |
| `lower_eyelid_right` | 374 |
| `upper_eyelid_left` | 159 |
| `upper_eyelid_right` | 386 |
| `eye_outer_left` | 33 |
| `eye_outer_right` | 263 |
| `iris_left` | 468 |
| `iris_right` | 473 |

### 中轴

| 语义名 | mesh 编号（引擎内部，JSON 里不要写） |
|---|---|
| `nose_bridge` | 168 |
| `nose_tip` | 4 |
| `forehead` | 151 |
| `head_top` | 10 |
| `chin` | 152 |
| `mouth_center` | 13 |
| `upper_lip` | 0 |
| `lower_lip` | 17 |

### 两侧

| 语义名 | mesh 编号（引擎内部，JSON 里不要写） |
|---|---|
| `cheek_left` | 50 |
| `cheek_right` | 280 |
| `temple_left` | 127 |
| `temple_right` | 356 |
| `jaw_left` | 172 |
| `jaw_right` | 397 |
| `ear_left` | 234 |
| `ear_right` | 454 |

## 成对锚点

`mirrorPair` 的 `anchor` 写这一列，不是上面的单侧名：

| 成对名 | 展开成 |
|---|---|
| `lower_eyelid` | lower_eyelid_left + lower_eyelid_right（右侧自动 mirror） |
| `upper_eyelid` | upper_eyelid_left + upper_eyelid_right（右侧自动 mirror） |
| `eye_outer` | eye_outer_left + eye_outer_right（右侧自动 mirror） |
| `iris` | iris_left + iris_right（右侧自动 mirror） |
| `cheek` | cheek_left + cheek_right（右侧自动 mirror） |
| `temple` | temple_left + temple_right（右侧自动 mirror） |

## 偏移的单位

`anchor.offset` 是 `[x, y]`，单位是 **IOD（瞳距）**，不是像素也不是 size 的参照物。
y 为正表示向下。偏移会跟着头部滚转一起旋转。
