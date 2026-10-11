// 截图上传前的本地预处理：letterbox 到 1536×864 白底 PNG，与底座输出画幅对齐（编辑模型不再改构图）。
// 与 ppt-replicate 的壳图 letterbox 同算法；模块不交叉 import，各自保留一份小拷贝。

const BASE_W = 1536;
const BASE_H = 864;

export async function screenshotToBasePng(file: File): Promise<File> {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    throw new Error("请上传 PNG / JPG / WebP 截图");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片无法读取"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = BASE_W;
    canvas.height = BASE_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, BASE_W, BASE_H);
    const scale = Math.min(BASE_W / img.naturalWidth, BASE_H / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.drawImage(img, (BASE_W - dw) / 2, (BASE_H - dh) / 2, dw, dh);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片编码失败"))), "image/png");
    });
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".png", { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
