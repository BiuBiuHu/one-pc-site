---
title: "Prompt 版本管理 — 把 System Prompt 当代码来管理"
date: 2026-11-25
excerpt: "Prompt 如何像代码一样版本化、A/B 测试？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 35
---

> 目标：理解 Prompt 工程化管理的必要性，掌握版本控制、A/B 测试、效果评估的工程方法

---

## 背景：Prompt 是 Agent 的"代码"，但没人把它当代码管

大多数项目里，System Prompt 是这样管理的：

```typescript
// ❌ 硬编码在代码里，没有版本，没有历史，改了不知道影响
const systemPrompt = `你是一个代码助手，帮助用户解决编程问题。`;
```

这带来的问题：
- **改了不知道影响**：Prompt 改一个词，Agent 行为可能大变，但没有对比
- **无法回滚**：发现新 Prompt 效果变差，不知道改了什么，也不知道怎么回滚
- **无法 A/B 测试**：不知道哪个版本的 Prompt 效果更好
- **团队协作困难**：多人修改同一个 Prompt，互相覆盖

---

## 第一步：Prompt 文件化 + Git 版本控制

把 Prompt 从代码里抽出来，存成独立文件，用 Git 管理变更历史：

```
src/
└── prompts/
    ├── system-prompt.md          # 当前生产版本
    ├── system-prompt.v1.md       # 历史版本（可选保留）
    └── variants/
        ├── system-prompt-a.md    # A/B 测试变体 A
        └── system-prompt-b.md   # A/B 测试变体 B
```

Prompt 文件格式（Markdown，支持注释和元数据）：

```markdown
---
version: "2.1.0"
author: "your-name"
created: "2024-01-15"
description: "增加了代码审查能力，优化了错误处理指令"
---

你是一个专业的代码助手。

## 核心能力
- 代码审查：发现潜在 Bug 和改进点
- 代码生成：生成符合项目规范的代码
- 问题排查：定位并解决技术问题

## 行为规范
- 回答简洁，避免冗余解释
- 给出可直接运行的代码示例
- 不确定时，先用工具确认，不猜测
```

加载 Prompt 文件的工具函数：

```typescript
import * as fs from 'fs';
import * as path from 'path';

interface PromptMetadata {
  version: string;
  author: string;
  created: string;
  description: string;
}

interface LoadedPrompt {
  content: string;
  metadata: PromptMetadata;
  filePath: string;
}

// 解析 Markdown 文件头部的 YAML frontmatter
function parseFrontmatter(rawContent: string): { metadata: Partial<PromptMetadata>; content: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = rawContent.match(frontmatterRegex);

  if (!match) {
    return { metadata: {}, content: rawContent.trim() };
  }

  const yamlBlock = match[1];
  const content = match[2].trim();

  // 简单的 YAML 键值解析（key: "value" 格式）
  const metadata: Partial<PromptMetadata> = {};
  for (const line of yamlBlock.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim() as keyof PromptMetadata;
    const value = line.slice(colonIndex + 1).trim().replace(/^"|"$/g, '');
    metadata[key] = value;
  }

  return { metadata, content };
}

export function loadPrompt(filePath: string): LoadedPrompt {
  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const { metadata, content } = parseFrontmatter(rawContent);

  return {
    content,
    metadata: {
      version: metadata.version ?? 'unknown',
      author: metadata.author ?? 'unknown',
      created: metadata.created ?? 'unknown',
      description: metadata.description ?? '',
    },
    filePath,
  };
}
```

---

## 第二步：Prompt 注册表 — 统一管理多个版本

```typescript
export class PromptRegistry {
  private prompts: Map<string, LoadedPrompt> = new Map();
  private activeVariant: string = 'default';

  // 注册一个 Prompt 变体
  register(name: string, filePath: string): void {
    const prompt = loadPrompt(filePath);
    this.prompts.set(name, prompt);
    console.log(`✅ 已注册 Prompt 变体 "${name}" (v${prompt.metadata.version})`);
  }

  // 设置当前激活的变体
  setActive(name: string): void {
    if (!this.prompts.has(name)) {
      throw new Error(`Prompt 变体 "${name}" 不存在，请先调用 register() 注册`);
    }
    this.activeVariant = name;
  }

  // 获取当前激活的 Prompt 内容
  getActive(): LoadedPrompt {
    const prompt = this.prompts.get(this.activeVariant);
    if (!prompt) {
      throw new Error(`当前激活的变体 "${this.activeVariant}" 不存在`);
    }
    return prompt;
  }

  // 获取指定变体的 Prompt 内容
  get(name: string): LoadedPrompt {
    const prompt = this.prompts.get(name);
    if (!prompt) {
      throw new Error(`Prompt 变体 "${name}" 不存在`);
    }
    return prompt;
  }

  // 列出所有已注册的变体
  listVariants(): Array<{ name: string; version: string; description: string; isActive: boolean }> {
    return Array.from(this.prompts.entries()).map(([name, prompt]) => ({
      name,
      version: prompt.metadata.version,
      description: prompt.metadata.description,
      isActive: name === this.activeVariant,
    }));
  }
}
```

---

## 第三步：A/B 测试框架

把用户随机分配到不同的 Prompt 变体，收集效果数据：

```typescript
interface ABTestConfig {
  testName: string;
  variants: Array<{
    name: string;           // 变体名称，对应 PromptRegistry 中的 key
    weight: number;         // 流量权重（所有变体的 weight 之和应为 100）
  }>;
}

interface ABTestResult {
  sessionId: string;
  variantName: string;
  promptVersion: string;
  startTime: number;
  endTime: number | null;
  success: boolean;
  userRating?: number;     // 用户评分（1-5），如果有收集的话
  tokenCount?: number;     // 本次对话消耗的 Token 数
}

export class ABTestManager {
  private config: ABTestConfig;
  private registry: PromptRegistry;
  private results: ABTestResult[] = [];

  constructor(config: ABTestConfig, registry: PromptRegistry) {
    this.config = config;
    this.registry = registry;
  }

  // 根据权重随机分配变体（加权随机）
  assignVariant(sessionId: string): string {
    const totalWeight = this.config.variants.reduce((sum, variant) => sum + variant.weight, 0);
    let random = Math.random() * totalWeight;

    for (const variant of this.config.variants) {
      random -= variant.weight;
      if (random <= 0) {
        return variant.name;
      }
    }

    // 兜底：返回最后一个变体
    return this.config.variants[this.config.variants.length - 1].name;
  }

  // 开始一次 A/B 测试会话
  startSession(sessionId: string): { variantName: string; promptContent: string } {
    const variantName = this.assignVariant(sessionId);
    const prompt = this.registry.get(variantName);

    this.results.push({
      sessionId,
      variantName,
      promptVersion: prompt.metadata.version,
      startTime: Date.now(),
      endTime: null,
      success: false,
    });

    return { variantName, promptContent: prompt.content };
  }

  // 记录会话结果
  recordResult(
    sessionId: string,
    success: boolean,
    tokenCount?: number,
    userRating?: number,
  ): void {
    const result = this.results.find((r) => r.sessionId === sessionId && r.endTime === null);
    if (!result) return;

    result.endTime = Date.now();
    result.success = success;
    result.tokenCount = tokenCount;
    result.userRating = userRating;
  }

  // 统计各变体的效果
  getStats(): Array<{
    variantName: string;
    sampleCount: number;
    successRate: string;
    avgTokenCount: string;
    avgUserRating: string;
  }> {
    const variantNames = this.config.variants.map((v) => v.name);

    return variantNames.map((variantName) => {
      const variantResults = this.results.filter(
        (r) => r.variantName === variantName && r.endTime !== null,
      );

      const successCount = variantResults.filter((r) => r.success).length;
      const ratedResults = variantResults.filter((r) => r.userRating !== undefined);
      const tokenResults = variantResults.filter((r) => r.tokenCount !== undefined);

      return {
        variantName,
        sampleCount: variantResults.length,
        successRate: variantResults.length > 0
          ? `${((successCount / variantResults.length) * 100).toFixed(1)}%`
          : 'N/A',
        avgTokenCount: tokenResults.length > 0
          ? (tokenResults.reduce((sum, r) => sum + (r.tokenCount ?? 0), 0) / tokenResults.length).toFixed(0)
          : 'N/A',
        avgUserRating: ratedResults.length > 0
          ? (ratedResults.reduce((sum, r) => sum + (r.userRating ?? 0), 0) / ratedResults.length).toFixed(2)
          : 'N/A',
      };
    });
  }
}

// 使用示例
const registry = new PromptRegistry();
registry.register('control', path.join(process.cwd(), 'src/prompts/system-prompt-a.md'));
registry.register('treatment', path.join(process.cwd(), 'src/prompts/system-prompt-b.md'));

const abTest = new ABTestManager(
  {
    testName: 'concise-vs-detailed-prompt',
    variants: [
      { name: 'control',   weight: 50 },
      { name: 'treatment', weight: 50 },
    ],
  },
  registry,
);

// 每个新会话分配变体
const { variantName, promptContent } = abTest.startSession('session-abc');
console.log(`会话分配到变体：${variantName}`);

// 会话结束后记录结果
abTest.recordResult('session-abc', true, 1200, 4);

// 查看统计
console.table(abTest.getStats());
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Prompt 文件化** | 把 System Prompt 从代码里抽出来存成独立文件，用 Git 管理变更历史 |
| **frontmatter** | Markdown 文件头部的 YAML 元数据块，用于记录版本、作者、描述等信息 |
| **PromptRegistry** | 统一管理多个 Prompt 变体的注册表，支持按名称获取和切换 |
| **A/B 测试** | 把用户随机分配到不同 Prompt 变体，通过数据对比找出效果更好的版本 |
| **加权随机** | 按权重比例随机分配流量，支持 90/10 这样的小流量灰度测试 |

---

## 与其他课程的关联

- **第11课（Rules 系统）**：Rules 系统已经实现了 Prompt 的文件化管理，本课是其进一步延伸——加入版本元数据和 A/B 测试能力
- **第39课（Agent Evals）**：A/B 测试收集的成功率、用户评分数据，是 Evals 评估体系的重要数据来源
