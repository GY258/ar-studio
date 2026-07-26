import { StudioApp } from "@/components/StudioApp";

export const metadata = { title: "Studio · AR Studio" };

/** 工作台是纯全屏应用，不带任何营销元素（PRD 3 关键决策）。 */
export default function StudioPage() {
  return <StudioApp initialSlug="cloud" />;
}
