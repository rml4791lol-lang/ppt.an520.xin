import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // mammoth / pdfjs-dist / pptxgenjs 通过 createRequire 走 node_modules 真实路径
  // 加载（见 src/lib/server/documents.ts、exports.ts 注释），必须保持外部化，
  // 否则 Turbopack 打包后 createRequire 解析不到。
  serverExternalPackages: ["mammoth", "pdfjs-dist", "pptxgenjs"],
};

export default nextConfig;
