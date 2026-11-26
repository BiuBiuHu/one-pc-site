// peak-lake 上给 OPC Skills 做实体页（官网 + GitHub）。
// Anpai.Life / Smart Tab Pilot / AI Gateway 已有官网，不在本站再做产品页。

export const OPC_SKILLS_REPO = "https://github.com/BiuBiuHu/opc-skills";

// 中文 / 日文走官网中文页；英文走英文页。官网没有独立日文站。
export const OPC_SKILLS_SITE = {
  zh: "https://biubiuhu.github.io/opc-skills/zh/",
  en: "https://biubiuhu.github.io/opc-skills/",
  ja: "https://biubiuhu.github.io/opc-skills/zh/"
};

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
    zh: "OPC Skills：面向编程 Agent 的 OPC 交付 Skill 包",
    en: "OPC Skills: a skill pack for coding agents doing OPC delivery",
    ja: "OPC Skills：コーディングAgent向けのOPC納品Skillパック"
  },
  description: {
    zh: "BiuBiuHu / One PC 的 opc-skills：给 Codex、Cursor、Claude 以及能加载它的其他编程 Agent 用，面向 OPC / C 端产品与 B 端工作台一起交付。与 ReScienceLab 的 opc.dev 不是同一项目。",
    en: "BiuBiuHu / One PC opc-skills: a skill pack for coding agents (Codex, Cursor, Claude, and others that can load it) to ship C-end products with B-side consoles. Not ReScienceLab or opc.dev.",
    ja: "BiuBiuHu / One PC の opc-skills。Codex、Cursor、Claude、および読み込める他のコーディングAgent向け。OPC / C向けプロダクトとB向け運用台を一緒に納品する。ReScienceLab の opc.dev とは別プロジェクト。"
  },
  h1: { zh: "OPC Skills", en: "OPC Skills", ja: "OPC Skills" },
  eyebrow: { zh: "Skill 包", en: "Skill pack", ja: "Skillパック" },
  tagline: {
    zh: "面向编程 Agent 的 OPC 交付 Skill 包",
    en: "Skill pack for coding agents doing OPC delivery",
    ja: "コーディングAgent向けのOPC納品Skillパック"
  },
  tldr: {
    zh: "把需求澄清到发布门禁串成可复用工作流的 Skill 包，Codex、Cursor、Claude 等能加载它的编程 Agent 都可以用。官网 biubiuhu.github.io/opc-skills，仓库 github.com/BiuBiuHu/opc-skills，与 ReScienceLab / opc.dev 无关。",
    en: "A skill pack that chains clarification through release gates. Coding agents that can load it — Codex, Cursor, Claude, and others — can use it. Official site: biubiuhu.github.io/opc-skills. Repo: github.com/BiuBiuHu/opc-skills — not ReScienceLab / opc.dev.",
    ja: "要件の見極めからリリース門禁までを再利用ワークフローにしたSkillパック。Codex、Cursor、Claude など読み込めるコーディングAgentで使える。公式サイトは biubiuhu.github.io/opc-skills、リポジトリは github.com/BiuBiuHu/opc-skills。ReScienceLab / opc.dev とは無関係。"
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
      "OPC Skills 是 BiuBiuHu 维护的 Skill 包（github.com/BiuBiuHu/opc-skills），给 Codex、Cursor、Claude 以及能加载它的其他编程 Agent 用，面向 OPC / C 端产品与 B 端工作台一起交付。",
      "它把需求澄清、产品设计、B 端运营页、架构治理、研发、测试、联调、发布门禁串成一套可复用工作流，让 Agent 在复杂业务里持续做正确判断。"
    ],
    en: [
      "OPC Skills is BiuBiuHu's skill pack (github.com/BiuBiuHu/opc-skills) for coding agents — Codex, Cursor, Claude, and others that can load it — to ship C-end products together with B-side consoles.",
      "It chains requirement clarification, product design, B-side ops pages, architecture governance, development, testing, integration, and release gates into one reusable workflow — so agents keep making correct calls in complex business contexts."
    ],
    ja: [
      "OPC Skills は BiuBiuHu が保守する Skillパック（github.com/BiuBiuHu/opc-skills）。Codex、Cursor、Claude、および読み込める他のコーディングAgent向け。対象は OPC / C向けプロダクトとB向け運用台の同時納品。",
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
      zh: "推荐用官方 CLI 安装。CLI 会写入 Codex，并同步 Cursor 与 Claude 的 skill 目录：",
      en: "Install with the official CLI. It writes the Codex skill and syncs Cursor and Claude skill surfaces:",
      ja: "公式 CLI で入れる。Codex に書き込み、Cursor と Claude の skill ディレクトリも同期する："
    },
    code: "npx opc-skills install\nnpx opc-skills update",
    after: {
      zh: "install 会按需创建 ~/.codex/skills。update 会同步已有的 .agents、Cursor 与 Claude skill 目录。也可以手动 git clone 到 ~/.codex/skills/opc-skills，或克隆到别处再软链过去。在 Codex 里说「启动 OPC Skills」或「用 opc-skills 分析这个需求」即可触发。完整规则以仓库里的 SKILL.md 为准。",
      en: "install creates ~/.codex/skills if needed. update syncs existing .agents, Cursor, and Claude skill surfaces. You can also git clone into ~/.codex/skills/opc-skills, or clone elsewhere and symlink. In Codex, say “Start OPC Skills” or “Use opc-skills to analyze this requirement.” SKILL.md in the repo is the source of rules.",
      ja: "install は必要なら ~/.codex/skills を作る。update は既存の .agents、Cursor、Claude の skill ディレクトリを同期する。手動で ~/.codex/skills/opc-skills に git clone してもよいし、別の場所からシンボリックリンクしてもよい。Codex では「OPC Skills を起動」または「opc-skills でこの要件を分析して」と言えば起動する。ルールの正本はリポジトリの SKILL.md。"
    }
  },
  site: {
    href: OPC_SKILLS_SITE,
    external: true,
    label: { zh: "打开官网", en: "Open the official site", ja: "公式サイトを開く" }
  },
  cta: {
    href: OPC_SKILLS_REPO,
    external: true,
    label: { zh: "打开 GitHub 仓库", en: "Open the GitHub repo", ja: "GitHub リポジトリを開く" }
  },
  relatedSlugs: ["opc-software-practice", "loop-engineering", "mcp-model-context-protocol"]
};
