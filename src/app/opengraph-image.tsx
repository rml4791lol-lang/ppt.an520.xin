import { ImageResponse } from "next/og";

export const alt = "AnPPT · 把文档变成能讲的 PPT";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f7f5f0",
          color: "#1f2329",
          padding: "64px 72px",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            right: "-120px",
            top: "-140px",
            width: "420px",
            height: "420px",
            borderRadius: "999px",
            background: "#f2571a",
            opacity: 0.12,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
          <div
            style={{
              width: "54px",
              height: "54px",
              borderRadius: "16px",
              background: "#f2571a",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#ffffff",
              fontSize: "28px",
              fontWeight: 700,
            }}
          >
            A
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: "28px", fontWeight: 700, letterSpacing: "-0.02em" }}>
              AnPPT
            </div>
            <div style={{ fontSize: "18px", color: "#8a919e" }}>
              AI PRESENTATION STUDIO
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", maxWidth: "900px" }}>
          <div style={{ fontSize: "26px", color: "#f2571a", fontWeight: 600, marginBottom: "18px" }}>
            文档 → 大纲 → 设计 → 可编辑 PPTX
          </div>
          <div style={{ fontSize: "68px", fontWeight: 700, lineHeight: 1.15, letterSpacing: "-0.04em" }}>
            把文档，变成能讲的 PPT
          </div>
          <div style={{ fontSize: "26px", color: "#4e5562", lineHeight: 1.5, marginTop: "24px" }}>
            PDF / Word / Markdown · 40 页型 · 设计风格包 · 转可编辑
          </div>
        </div>

        <div style={{ display: "flex", gap: "14px" }}>
          {["文档生成", "PPT 美化", "可编辑导出"].map((label) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                borderRadius: "999px",
                border: "1px solid #fdd9c4",
                background: "#fff8f3",
                color: "#d9440c",
                padding: "12px 22px",
                fontSize: "20px",
                fontWeight: 500,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
