import { personNode } from "../data/site.js";
import { OPC_SKILLS_REPO, OPC_SKILLS_SITE } from "../data/product-hubs.js";
import { normalizeLocale } from "./i18n.js";

/** SoftwareSourceCode JSON-LD for BiuBiuHu OPC Skills — not ReScienceLab / opc.dev. */
export function opcSkillsJsonLd({ isEn, lang, authorUrl, pageUrl }) {
  const locale = lang || (isEn ? "en" : "zh");
  const siteUrl = OPC_SKILLS_SITE[normalizeLocale(locale)] || OPC_SKILLS_SITE.en;
  const description =
    locale === "en"
      ? "BiuBiuHu / One PC skill pack for coding agents (Codex, Cursor, Claude, and others that can load it). For shipping C-end products with B-side consoles. Not affiliated with ReScienceLab or opc.dev."
      : locale === "ja"
        ? "BiuBiuHu / One PC のコーディングAgent向けSkillパック（Codex、Cursor、Claude、および読み込める他のAgent）。OPC（C向けプロダクトとB向け運用台）納品向け。ReScienceLab / opc.dev とは別プロジェクト。"
        : "BiuBiuHu / One PC 的编程 Agent Skill 包（Codex、Cursor、Claude 以及能加载它的其他 Agent），面向 OPC（C 端产品与 B 端工作台）交付。与 ReScienceLab / opc.dev 不是同一项目。";
  const sameAs = [siteUrl, OPC_SKILLS_REPO];
  if (pageUrl && !sameAs.includes(pageUrl)) sameAs.push(pageUrl);
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "OPC Skills",
    alternateName: ["BiuBiuHu OPC Skills", "One PC OPC Skills", "opc-skills"],
    description,
    url: siteUrl,
    codeRepository: OPC_SKILLS_REPO,
    sameAs,
    author: personNode({ url: authorUrl }),
    programmingLanguage: "Shell"
  };
}
