// peak-lake 上只给 GitHub-first 的 OPC Skills 做实体页。
// Anpai.Life / AI Gateway 已有官网，不在本站再做产品页。

export const HUB_SLUG_BY_NAME = {
  "OPC Skills": "opc-skills"
};

export function hubPathForProject(name, langOrIsEn) {
  const slug = HUB_SLUG_BY_NAME[name];
  if (!slug) return "";
  const lang = typeof langOrIsEn === "string" ? langOrIsEn : langOrIsEn ? "en" : "zh";
  const prefix = lang === "en" ? "/en" : lang === "ja" ? "/ja" : "";
  return `${prefix}/projects/${slug}/`;
}

export const opcSkillsHub = {
  slug: "opc-skills",
  projectName: "OPC Skills",
  title: {
    zh: "OPC Skills：BiuBiuHu 的 OPC 交付 Codex Skill 模板",
    en: "OPC Skills: BiuBiuHu's Codex skill template for OPC delivery",
    ja: "OPC Skills：BiuBiuHuのOPC納品向けCodex Skillテンプレート"
  },
  description: {
    zh: "BiuBiuHu / One PC 的 opc-skills：面向 OPC / C 端与 B 端交付的 Codex Skill 模板。与 ReScienceLab 的 opc.dev 不是同一项目。",
    en: "BiuBiuHu / One PC opc-skills: a Codex skill template for OPC / C-end and B-end delivery. Not ReScienceLab or opc.dev.",
    ja: "BiuBiuHu / One PC の opc-skills。OPC / C向け・B向け納品のためのCodex Skillテンプレート。ReScienceLab の opc.dev とは別プロジェクト。"
  },
  h1: { zh: "OPC Skills", en: "OPC Skills", ja: "OPC Skills" },
  eyebrow: { zh: "Codex Skill", en: "Codex Skill", ja: "Codex Skill" },
  tagline: {
    zh: "BiuBiuHu / One PC 的 OPC 交付 Codex Skill 模板",
    en: "BiuBiuHu / One PC Codex skill template for OPC delivery",
    ja: "BiuBiuHu / One PC のOPC納品向けCodex Skillテンプレート"
  },
  tldr: {
    zh: "把需求澄清到发布门禁串成可复用工作流的 Codex Skill 模板。仓库在 github.com/BiuBiuHu/opc-skills，与 ReScienceLab / opc.dev 无关。",
    en: "A Codex skill template that chains clarification through release gates. The repo is github.com/BiuBiuHu/opc-skills — not ReScienceLab / opc.dev.",
    ja: "要件の見極めからリリース門禁までを再利用ワークフローにしたCodex Skillテンプレート。リポジトリは github.com/BiuBiuHu/opc-skills。ReScienceLab / opc.dev とは無関係。"
  },
  problem: {
    zh: [
      "一个人做 OPC 产品，或同时交 C 端应用和 B 端运营台时，流程很长：澄清、设计、架构、研发、测试、联调、发布。",
      "如果每次都临时告诉 Agent「帮我实现这个需求」，判断容易漂，门禁也对不齐。需要一套可复用的工作流，而不是另一份空口号。"
    ],
    en: [
      "Shipping an OPC product — or a consumer app plus its operator console — is a long path: clarify, design, architecture, build, test, integrate, release.",
      "If you re-brief the agent from scratch every time, judgment drifts and gates do not line up. The need is a reusable workflow, not another slogan."
    ],
    ja: [
      "一人でOPCプロダクトを出す、あるいはC向けアプリとB向け運用台を同時に出すと、工程は長い。見極め、設計、アーキテクチャ、開発、テスト、結合、リリース。",
      "毎回「この要件を実装して」とAgentにゼロから頼むと、判断が流れ、門禁も揃わない。必要なのは再利用できるワークフローであり、別のスローガンではない。"
    ]
  },
  solution: {
    zh: [
      "OPC Skills 是 BiuBiuHu 维护的 Codex Skill 模板（github.com/BiuBiuHu/opc-skills），面向 OPC / C 端与 B 端交付。",
      "它把需求澄清、产品设计、B 端运营页、架构治理、研发、测试、联调、发布门禁串成一套可复用工作流，让 Agent 在复杂业务里持续做正确判断。"
    ],
    en: [
      "OPC Skills is BiuBiuHu's Codex skill template (github.com/BiuBiuHu/opc-skills) for OPC / C-end and B-end delivery.",
      "It chains requirement clarification, product design, B-side ops pages, architecture governance, development, testing, integration, and release gates into one reusable workflow — so agents keep making correct calls in complex business contexts."
    ],
    ja: [
      "OPC Skills は BiuBiuHu が保守する Codex Skill テンプレート（github.com/BiuBiuHu/opc-skills）。対象は OPC / C向け・B向け納品。",
      "要件の見極め、プロダクト設計、B向け運用ページ、アーキテクチャ統治、開発、テスト、結合、リリース門禁を一本の再利用ワークフローにする。複雑な業務でも Agent が正しい判断を続けられるようにする。"
    ]
  },
  note: {
    zh: "这是 BiuBiuHu / One PC 的 opc-skills，不是 ReScienceLab 的 opc.dev，也不是同一个项目。",
    en: "This is BiuBiuHu / One PC opc-skills. It is not ReScienceLab's opc.dev, and not the same project.",
    ja: "これは BiuBiuHu / One PC の opc-skills。ReScienceLab の opc.dev ではなく、同一プロジェクトでもない。"
  },
  install: {
    heading: { zh: "安装", en: "Install", ja: "インストール" },
    lead: {
      zh: "把仓库放到 Codex 能发现的 skills 目录，例如：",
      en: "Clone it into a skills directory Codex can see, for example:",
      ja: "Codex が見つけられる skills ディレクトリに置く。例："
    },
    code: "mkdir -p ~/.codex/skills\ngit clone https://github.com/BiuBiuHu/opc-skills.git ~/.codex/skills/opc-skills",
    after: {
      zh: "也可以克隆到别处，再软链到 ~/.codex/skills/opc-skills。在对话里说「启动 OPC Skills」或「用 opc-skills 分析这个需求」即可触发。完整规则以仓库里的 SKILL.md 为准。",
      en: "Or clone it elsewhere and symlink to ~/.codex/skills/opc-skills. In Codex, say “Start OPC Skills” or “Use opc-skills to analyze this requirement.” SKILL.md in the repo is the source of rules.",
      ja: "別の場所に clone して ~/.codex/skills/opc-skills へシンボリックリンクしてもよい。会話で「OPC Skills を起動」または「opc-skills でこの要件を分析して」と言えば起動する。ルールの正本はリポジトリの SKILL.md。"
    }
  },
  cta: {
    href: "https://github.com/BiuBiuHu/opc-skills",
    external: true,
    label: { zh: "打开 GitHub 仓库", en: "Open the GitHub repo", ja: "GitHub リポジトリを開く" }
  },
  relatedSlugs: ["opc-software-practice", "loop-engineering", "mcp-model-context-protocol"]
};
