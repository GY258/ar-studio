import { notFound } from "next/navigation";
import { StudioApp } from "@/components/StudioApp";
import { allTemplates, getTemplate } from "@/lib/templates";
import { t } from "@/lib/copy";

export function generateStaticParams() {
  return allTemplates().map((t) => ({ template: t.slug }));
}

export function generateMetadata({ params }: { params: { template: string } }) {
  const tpl = getTemplate(params.template);
  return { title: tpl ? `${t(tpl.name)} · AR Studio` : "AR Studio" };
}

/** 直接进入指定模板。锁着的模板也能进——进去后弹解锁面板，这是主要转化入口。 */
export default function StudioTemplatePage({ params }: { params: { template: string } }) {
  if (!getTemplate(params.template)) notFound();
  return <StudioApp initialSlug={params.template} />;
}
