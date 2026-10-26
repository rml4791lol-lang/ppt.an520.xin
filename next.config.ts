import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // mammoth / pptxgenjs 通过 createRequire 走 node_modules 真实路径加载
  // （见 src/lib/server/documents.ts、exports.ts 注释）。pdfjs-dist 是 ESM-only，
  // Turbopack 不会真正外部化它；worker/CMap 路径已在 documents.ts 显式处理。
  serverExternalPackages: ["mammoth", "pptxgenjs"],
  // dev 服务器只白名单 localhost；用 127.0.0.1 访问时带 Origin 的 chunk 请求
  // 会被 403（客户端零水合、按钮全死）。补白名单，生产无影响。
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
