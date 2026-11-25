---
title: "第十一课：Rules 系统 — System Prompt 的工程化管理"
date: 2026-11-25
excerpt: "行为约束如何从硬编码变成可组合的规则模块？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 12
---

> 目标：把行为约束从硬编码的字符串变成可复用、可组合的规则模块

---

## 背景：硬编码 System Prompt 的痛点

前10课里，我们的 System Prompt 都是这样写的：

```typescript
const agent = new Agent(apiKey, model, baseURL,
  `你是一个专业的编程助手。
禁止执行危险命令。
代码必须用 TypeScript。
回复要简洁，不要废话。
...`
);
```

这有几个明显的问题：

| 问题 | 说明 |
|------|------|
| **不可复用** | 同样的"安全规则"在每个 Agent 里都要复制粘贴 |
| **难以维护** | 修改一条规则要找到所有用到它的地方 |
| **无法组合** | 不同场景需要不同规则组合，硬编码做不到 |
| **无优先级** | 所有规则混在一起，哪条更重要？不清楚 |

**Rules 系统**的解法：把规则拆成独立文件，按需加载、动态组合。

---

## 核心设计

### 规则文件格式（Markdown + Frontmatter）

```markdown
---
priority: 100
---
## 安全规则

- 禁止执行任何可能损害用户系统的命令
- 禁止泄露用户的隐私信息
```

设计选择：
- **Markdown 格式**：人类可读，LLM 也能很好理解
- **Frontmatter**：用 `priority` 字段控制注入顺序，数字越大越靠前
- **文件名即规则名**：`safety.md` → 规则名 `safety`

### 注入后的 System Prompt 结构

```
[baseSystemPrompt]          ← 角色定义
[memorySection]             ← 第9课的长期记忆（如果有）
[rulesSection]              ← Rules 系统注入的内容
  ## 行为规则
  ### 规则：safety          ← priority: 100，排最前
  ...
  ### 规则：coding-style    ← priority: 50
  ...
  ### 规则：response-format ← priority: 30，排最后
```

---

## 实现：RulesManager

```typescript
// src/agent/rules-manager.ts

export class RulesManager {
  private loadedRules: Rule[] = [];

  // 从单个文件加载
  loadFromFile(filePath: string): this { ... }

  // 从目录批量加载所有 .md 文件
  loadFromDirectory(dirPath: string): this { ... }

  // 直接注册内联规则（不需要文件）
  addRule(name: string, content: string, priority: number = 0): this { ... }

  // 移除规则
  removeRule(name: string): this { ... }

  // 核心：格式化成 System Prompt 片段
  formatForSystemPrompt(): string { ... }
}
```

**关键设计：链式调用**

```typescript
const rulesManager = new RulesManager()
  .loadFromFile('rules/safety.md')       // 加载安全规则
  .loadFromFile('rules/coding-style.md') // 加载代码风格规则
  .addRule('language', '只用中文回复', 60); // 动态添加内联规则
```

### Agent 改造：注入 RulesManager

```typescript
// 改造前
constructor(apiKey, modelName, baseURL, systemPrompt, workspaceRoot)

// 改造后：新增可选的 rulesManager 参数
constructor(apiKey, modelName, baseURL, systemPrompt, workspaceRoot, rulesManager?)
```

`buildSystemPrompt()` 方法自动拼接三层内容：

```typescript
private buildSystemPrompt(): string {
  const memorySection = this.memory.format_for_system_prompt();
  const rulesSection = this.rulesManager
    ? this.rulesManager.formatForSystemPrompt()
    : '';
  return this.baseSystemPrompt + memorySection + rulesSection;
}
```

---

## 使用方式

### 场景1：从目录批量加载

```typescript
const rulesManager = new RulesManager()
  .loadFromDirectory('./rules'); // 加载 rules/ 下所有 .md 文件

const agent = new Agent(apiKey, model, baseURL,
  '你是一个编程助手。',
  process.cwd(),
  rulesManager  // ← 注入
);
```

### 场景2：动态组合规则

```typescript
// 不同场景，不同规则组合
const codeReviewAgent = new Agent(apiKey, model, baseURL, '你是代码审查专家。',
  process.cwd(),
  new RulesManager()
    .loadFromFile('rules/safety.md')
    .loadFromFile('rules/coding-style.md')
);

const reportAgent = new Agent(apiKey, model, baseURL, '你是报告撰写专家。',
  process.cwd(),
  new RulesManager()
    .loadFromFile('rules/safety.md')
    .loadFromFile('rules/response-format.md')
);
```

### 场景3：动态添加内联规则

```typescript
const rulesManager = new RulesManager()
  .loadFromFile('rules/safety.md')
  .addRule('language', '所有回复必须使用英文。', 80); // 无需文件，直接注入
```

---

## 目录结构

```
simple-agent/
├── rules/                        ← 规则文件目录
│   ├── safety.md                 ← 安全规则（priority: 100）
│   ├── coding-style.md           ← 代码风格规则（priority: 50）
│   └── response-format.md        ← 回复格式规则（priority: 30）
├── src/
│   ├── agent/
│   │   ├── rules-manager.ts      ← 新增：Rules 核心实现
│   │   └── agent.ts              ← 改造：支持 rulesManager 注入
│   └── rules-demo.ts             ← 新增：第11课演示
```

---

## 运行演示

```bash
npx ts-node --esm src/rules-demo.ts
```

演示内容：
1. **从目录批量加载规则** → 验证规则被正确注入 System Prompt
2. **动态添加内联规则** → 无需文件，直接注入"只用英文回复"规则
3. **无规则 vs 有规则对比** → 直观看到规则对输出的影响
4. **交互式 REPL** → 带全套规则的对话体验

---

## 核心问题回答

**Q：Rules 系统的本质是什么？**

A：用一句话总结——**从 Markdown 文件读取约束内容 → 按优先级排序 → 拼接到 System Prompt 末尾 → 发给 LLM**。LLM 并不知道"Rules 系统"的存在，它只是收到了一段更长的 System Prompt。Rules 系统是给开发者用的工程化工具，解决的是"如何优雅地管理 System Prompt"的问题，而不是什么新的 AI 能力。

**Q：为什么不直接把规则写在 System Prompt 字符串里？**

A：硬编码的字符串无法复用、无法组合、无法按优先级排序。Rules 系统让规则变成独立的"模块"，可以像 npm 包一样按需引入。

**Q：priority 有什么实际意义？**

A：LLM 对 System Prompt 开头的内容更敏感（注意力机制的特性）。把最重要的规则（如安全规则）放在最前面，能提高模型遵守的概率。注意：`priority` 字段只被代码消费（决定排序顺序），**不会出现在发给 LLM 的 System Prompt 里**，LLM 只看到规则正文。

**Q：为什么用 Markdown 而不是 JSON/YAML？**

A：规则的"消费者"是 LLM，Markdown 是 LLM 最擅长理解的格式。同时人类也更容易阅读和编写 Markdown。

**Q：这和 Cursor、Claude 的规则文件有什么关系？**

A：本质完全相同。Cursor 的 `.cursorrules`、Claude 的 `CLAUDE.md` 都是同一个思路：**把约束写在文件里，运行时注入 System Prompt**。我们这节课手动实现了这套机制，理解了这些工具背后的原理。

---

## 下一课预告

第12课：**MCP — Model Context Protocol**

MCP 是什么？它解决了工具调用的哪些痛点？为什么比普通 tool 更强大？我们将实现一个自定义 MCP Server，让 Cursor 能调用我们的工具。
