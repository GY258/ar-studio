import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

/**
 * 应用图标。用 ImageResponse 现画而不是塞一个 png 进仓库：
 * 一个 512×512 的位图在 git 里是死的，改一次颜色就得重新导出；
 * 而这里图标和站点的配色是同一份常量。
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0B0B0D",
        }}
      >
        {/* 取景框 + 中心点，一眼是「相机」而不是某个具体特效 */}
        <div
          style={{
            width: 300,
            height: 300,
            border: "22px solid #C9A7FF",
            borderRadius: 48,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ width: 110, height: 110, borderRadius: 999, background: "#C9A7FF" }} />
        </div>
      </div>
    ),
    size,
  );
}
