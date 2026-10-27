import { personNode } from "../data/site.js";

const REPO = "https://github.com/BiuBiuHu/opc-skills";

/** SoftwareSourceCode JSON-LD for BiuBiuHu OPC Skills — not ReScienceLab / opc.dev. */
export function opcSkillsJsonLd({ isEn, lang, authorUrl, pageUrl }) {
  const locale = lang || (isEn ? "en" : "zh");
  const description =
    locale === "en"
      ? "BiuBiuHu / One PC Codex skill template for OPC (C-end and B-end) delivery. Not affiliated with ReScienceLab or opc.dev."
      : locale === "ja"
        ? "BiuBiuHu / One PC の Codex Skill テンプレート。OPC（C向け・B向け）納品向け。ReScienceLab / opc.dev とは別プロジェクト。"
        : "BiuBiuHu / One PC 的 Codex Skill 模板，面向 OPC（C 端与 B 端）交付。与 ReScienceLab / opc.dev 不是同一项目。";
  const sameAs = [REPO];
  if (pageUrl && pageUrl !== REPO && !sameAs.includes(pageUrl)) sameAs.push(pageUrl);
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "OPC Skills",
    alternateName: ["BiuBiuHu OPC Skills", "One PC OPC Skills", "opc-skills"],
    description,
    url: REPO,
    codeRepository: REPO,
    sameAs,
    author: personNode({ url: authorUrl }),
    programmingLanguage: "Shell"
  };
}
