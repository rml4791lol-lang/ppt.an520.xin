import type { Metadata } from "next";
import { DeckWorkbench } from "@/components/deck/deck-workbench";

export const metadata: Metadata = {
  title: "整套 PPT 工作台",
  description: "AnPPT 整套 PPT 工作台：编辑大纲、内容梳理、选择风格、生成页面与导出。",
  robots: { index: false, follow: false },
};

// Next 16：params 是 Promise，必须 await（见 node_modules/next/dist/docs page.md）。
export default async function DeckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeckWorkbench deckId={id} />;
}
