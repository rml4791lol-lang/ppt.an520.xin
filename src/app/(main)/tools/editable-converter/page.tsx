import type { Metadata } from "next";
import { EditableConverterClient } from "@/modules/editable-export/client/editable-converter-client";

export const metadata: Metadata = {
  title: "文件转可编辑 PPT",
  description: "上传 PDF 或多张 PNG/JPG 图片，后台转换为元素级可编辑 PPTX。",
  robots: { index: false, follow: false },
};

export default function EditableConverterPage() {
  return <EditableConverterClient />;
}
