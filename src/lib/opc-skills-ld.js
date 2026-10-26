const REPO = "https://github.com/BiuBiuHu/opc-skills";

/** SoftwareSourceCode JSON-LD for BiuBiuHu OPC Skills — not ReScienceLab / opc.dev. */
export function opcSkillsJsonLd({ isEn, authorName, authorUrl }) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "OPC Skills",
    alternateName: ["BiuBiuHu OPC Skills", "One PC OPC Skills", "opc-skills"],
    description: isEn
      ? "BiuBiuHu / One PC Codex skill template for OPC (C-end and B-end) delivery. Not affiliated with ReScienceLab or opc.dev."
      : "BiuBiuHu / One PC 的 Codex Skill 模板，面向 OPC（C 端与 B 端）交付。与 ReScienceLab / opc.dev 不是同一项目。",
    url: REPO,
    codeRepository: REPO,
    sameAs: [REPO],
    author: {
      "@type": "Person",
      name: authorName,
      url: authorUrl
    },
    programmingLanguage: "Shell"
  };
}
