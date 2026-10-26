"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f6f7f9",
          color: "#1f2329",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
        }}
      >
        <main style={{ maxWidth: 560, padding: 32, textAlign: "center" }}>
          <p style={{ color: "#f2571a", fontSize: 13, fontWeight: 700, letterSpacing: "0.16em" }}>
            ANPPT ERROR
          </p>
          <h1 style={{ margin: "12px 0 0", fontSize: 30, lineHeight: 1.3 }}>
            页面加载失败
          </h1>
          <p style={{ margin: "16px 0 0", color: "#8a919e", fontSize: 14, lineHeight: 1.8 }}>
            请刷新页面重试。如果问题持续出现，请联系 support@anppt.app 并附上错误编号。
          </p>
          {error.digest && (
            <p style={{ marginTop: 16, color: "#b6bcc7", fontSize: 12 }}>
              错误编号：{error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 28,
              border: 0,
              borderRadius: 999,
              background: "#f2571a",
              color: "#fff",
              padding: "12px 26px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            重新加载
          </button>
        </main>
      </body>
    </html>
  );
}
