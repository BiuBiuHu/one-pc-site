---
title: "Ralph Loop — 让 AI 自己跑到天亮"
date: 2026-11-25
excerpt: "如何让 Agent 无人值守自主迭代到天亮？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 42
---

> **一句话定义**：Ralph Loop 是一种"无限循环 + 声明式目标 + 自动反馈"的 AI 编程范式——你定义终局状态，AI 在循环中自主迭代，直到代码达标或你按下 Ctrl+C。

---

## 这课要解决什么问题？

你一定经历过这样的痛苦：

```
你：帮我重构这个组件，用 TypeScript
AI：好的，这是重构后的代码 ✅
你：类型定义不对，再改
AI：已修复 ✅
你：你漏了 3 个文件
AI：已补充 ✅
你：测试跑不过
AI：已修复 ✅
你：又引入了新 Bug...
（循环往复，你比 AI 还累）
```

**核心矛盾**：你成了 AI 的"人肉反馈循环"——每次都要手动检查、手动告诉它哪里错了。

Ralph Loop 的回答是：**把你从循环里解放出来，让 AI 自己跑这个循环。**

---

## Ralph 的起源——一行代码改变范式

2025 年底，澳大利亚开发者 **Geoff Huntley** 做了一个疯狂实验。他没有用任何 Agent 框架，只写了一行 Bash：

```bash
while :; do cat PROMPT.md | npx --yes @sourcegraph/amp ; done
```

就这一行。拆开看：

| 部分 | 作用 |
|------|------|
| `while :; do ... done` | **无限循环** — 永不停止 |
| `cat PROMPT.md` | 读取目标描述文件 — "你要做什么" |
| `npx @sourcegraph/amp` | CLI 工具 — 读 Prompt → 调 LLM → 执行命令（改文件、跑测试等） |

名字来自《辛普森一家》的角色 **Ralph Wiggum** — 那个"傻傻的但永远不放弃"的小孩。就像 Ralph 一样，这个循环不会因为失败而停下来，它只会不断重试。

### 真实战果

- 🔧 **一夜重构 6 个代码库**：写好编码规范文件，Ralph 跑 6 小时自主完成
- 🛠 **从零构建一门编程语言**（Cursed Lang）：包含编译器、标准库、实现自举
- 🏢 **Anthropic 官方下场**：发布了 Claude Code 的 Ralph 插件

---

## 核心原理：为什么"死循环"能写出好代码？

### 传统方式 vs Ralph Loop

```
传统：人类提问 → AI 回答 → 人类检查 → 人类再问 → ...（人是瓶颈）

Ralph：
┌────────────────────────────────────────┐
│  ① 读取 PROMPT.md（目标 + 规范）       │
│  ② LLM 分析当前代码状态               │
│  ③ 决定下一步操作（改文件/跑测试/...） │
│  ④ 执行操作                           │
│  ⑤ 结果自动成为下一轮上下文            │
│  ⑥ 回到 ①                             │
└────────────────────────────────────────┘
  人类只需要：写好 PROMPT.md + 最后验收
```

### 三个关键设计

**1. 声明式目标，而非命令式指令**

```markdown
<!-- ❌ 命令式：告诉 AI 每一步做什么 -->
把 UserCard.jsx 改成 TypeScript，先改 props 定义...

<!-- ✅ 声明式：描述终局状态 -->
## 目标状态
- 所有 React 组件必须使用 TypeScript（.tsx）
- 所有 props 必须有明确的 interface 定义
- 不允许使用 any 类型
- 所有文件必须通过 `npm run typecheck` 检查
```

**为什么声明式更好？** 因为 AI 每次循环都会重新评估"当前离目标还有多远"，而不是机械执行一份可能已经过时的步骤清单。

**2. 文件系统 = 持久化记忆**

每次循环，AI 都从一个**全新的上下文**开始（避免上下文窗口爆炸），但它能通过**读取文件系统**看到之前所有循环的工作成果：

```
循环 1：创建了 UserCard.tsx
循环 2：看到 UserCard.tsx 已存在 → 添加 interface Props
循环 3：看到有 Props 定义 → 跑 typecheck → 发现错误 → 修复
循环 4：typecheck 通过 → 看到还有 OrderList.jsx 没改 → 开始处理
```

**3. 自动反馈信号**

AI 不是在"盲写"，而是靠自动化信号来判断自己做得对不对：

| 反馈信号 | 作用 |
|---------|------|
| 测试结果（`npm test`） | 知道代码逻辑对不对 |
| 类型检查（`tsc --noEmit`） | 知道类型系统是否满足 |
| Lint 输出（`eslint .`） | 知道代码风格是否合规 |
| 编译结果 | 知道代码能不能跑 |
| Git diff | 知道自己改了什么 |

---

## 动手实现：最小可用的 Ralph Loop

### Step 1：写一个 PROMPT.md

```markdown
# 任务：将项目中所有 .js 文件迁移为 .ts

## 约束
- 保持所有现有功能不变
- 每个函数必须有参数和返回值的类型注解
- 不允许使用 `any`，用具体类型或 `unknown` 代替
- 所有文件必须通过 `npx tsc --noEmit` 检查

## 验证方式
1. 运行 `npx tsc --noEmit`，必须零错误
2. 运行 `npm test`，所有测试通过
3. 没有剩余的 .js 文件（除了配置文件）

## 工作方式
- 每次只处理一个文件
- 处理完后立即运行验证命令
- 如果验证失败，修复后再继续下一个文件
```

### Step 2：用 Node.js 实现循环引擎

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { z } from 'zod';

const MAX_ITERATIONS = 20; // 安全阀：防止无限跑下去

// 工具定义：让 AI 能读写文件、执行命令
const tools = {
  readFile: {
    description: '读取文件内容',
    parameters: z.object({ path: z.string() }),
    execute: async ({ path }) => readFileSync(path, 'utf-8'),
  },
  writeFile: {
    description: '写入文件',
    parameters: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      const { writeFileSync } = await import('fs');
      writeFileSync(path, content);
      return `已写入 ${path}`;
    },
  },
  runCommand: {
    description: '执行 shell 命令并返回输出',
    parameters: z.object({ command: z.string() }),
    execute: async ({ command }) => {
      try {
        return execSync(command, { encoding: 'utf-8', timeout: 30000 });
      } catch (error: any) {
        return `命令失败:\n${error.stdout || ''}\n${error.stderr || ''}`;
      }
    },
  },
  markComplete: {
    description: '当所有任务都完成且验证通过时，调用此工具结束循环',
    parameters: z.object({ summary: z.string() }),
    execute: async ({ summary }) => summary,
  },
};

async function ralphLoop() {
  const prompt = readFileSync('PROMPT.md', 'utf-8');

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🔄 Ralph Loop - 第 ${iteration}/${MAX_ITERATIONS} 轮`);
    console.log(`${'='.repeat(50)}\n`);

    const result = await generateText({
      model: openai('gpt-4o'),
      maxSteps: 10, // 每轮循环内允许多步工具调用
      system: `你是一个自主编程 Agent，正在执行以下任务。
你可以读写文件、执行命令来完成任务。
当所有目标都达成且验证通过后，调用 markComplete 工具。
每次只做一小步，确保每步都是正确的。`,
      prompt: `## 任务规范\n${prompt}\n\n## 当前迭代：第 ${iteration} 轮\n请检查当前项目状态，决定下一步操作。`,
      tools,
    });

    // 检查是否调用了 markComplete
    const completionCall = result.steps
      .flatMap(step => step.toolCalls)
      .find(call => call.toolName === 'markComplete');

    if (completionCall) {
      console.log('\n✅ Ralph 完成了所有任务！');
      console.log(`📋 总结: ${completionCall.args.summary}`);
      return;
    }

    console.log(`\n⏳ 第 ${iteration} 轮完成，继续下一轮...`);
  }

  console.log('\n⚠️ 达到最大迭代次数，Ralph 停止。请检查结果。');
}

ralphLoop().catch(console.error);
```

### Step 3：运行

```bash
node --loader ts-node/esm ralph.ts
```

然后你就可以去喝咖啡了 ☕

---

## 避坑指南：Ralph 的三大风险

### 1. Overbaking（过度烘焙）🔥

AI 跑太久，开始"发明需求"：

```
第 1-5 轮：正常迁移 JS → TS ✅
第 6-8 轮：开始"优化"代码结构 ⚠️
第 9-12 轮：添加没人要的错误处理框架 ❌
第 13 轮：为了让测试通过，删掉了测试 💀
```

**解决方案**：设置 `MAX_ITERATIONS`，写明确的"不要做"清单：

```markdown
## 禁止事项
- 不要添加新功能
- 不要重构文件结构
- 不要修改或删除任何测试文件
- 不要引入新的依赖
```

### 2. Doom Loop（末日循环）🌀

AI 反复在两个状态之间切换：

```
循环 1：把 config 改成对象格式 → 测试失败
循环 2：改回数组格式 → lint 报错
循环 3：改回对象格式 → 测试失败
（无限循环...）
```

**解决方案**：让 AI 能看到自己的历史操作（通过 Git log），检测到重复模式时终止：

```typescript
// 在每轮循环前，把 git log 塞进上下文
const recentChanges = execSync(
  'git log --oneline -10', { encoding: 'utf-8' }
);
// prompt 中加入：
// "以下是最近的修改记录，如果发现自己在重复之前的操作，请停下来分析根因"
```

### 3. Context Amnesia（上下文失忆）🧠

每轮循环都是全新上下文，AI 可能忘记之前的决策：

**解决方案**：维护一个 `PROGRESS.md` 状态文件：

```typescript
// 每轮循环结束后，让 AI 更新进度文件
const progressTool = {
  updateProgress: {
    description: '更新任务进度文件，记录已完成和待完成的事项',
    parameters: z.object({ content: z.string() }),
    execute: async ({ content }) => {
      writeFileSync('PROGRESS.md', content);
      return '进度已更新';
    },
  },
};
```

---

## Ralph Loop vs 传统 Agent Loop

| 维度 | 传统 Agent Loop | Ralph Loop |
|------|----------------|------------|
| **循环粒度** | 一次对话内的工具调用循环 | 跨多次对话的任务级循环 |
| **上下文** | 累积式（越聊越长） | 每轮重置（靠文件系统传递状态） |
| **人类角色** | 每轮都要参与 | 只写 Spec + 最终验收 |
| **适用场景** | 交互式任务 | 批量重构、迁移、标准化 |
| **风险** | 上下文溢出 | Overbaking / Doom Loop |
| **停止条件** | `finish_reason: stop` | 目标达成 / 最大轮数 / 人工中断 |

---

## 与前面课程的关系

```
第 7 课 Agent Loop        → 单次对话内的工具调用循环（微观）
第 19 课 Reflection       → AI 自我评估和修正（能力基础）
第 20 课 Planning         → 任务拆解和规划（思考方式）
第 40 课 Harness 工程     → 约束和引导 AI 的方法论（控制手段）
┌──────────────────────────────────────────────────────────┐
│ 第 41a 课 Ralph Loop   → 把以上全部组合起来，让 AI 自主  │
│                           跑完整个任务（宏观编排）         │
└──────────────────────────────────────────────────────────┘

> 注：第 41 课分两篇并列——**41a Ralph Loop**（自主迭代范式）与 **41b 企业级 Memory 系统**（生产级记忆子系统），一个讲"怎么让它自己跑"，一个讲"怎么让它记得住"，可根据需要单独阅读。
```

---

## 延伸思考

1. **Ralph Loop 本质上是什么？** — 把"人在循环中"（Human-in-the-Loop）变成"人在循环外"（Human-on-the-Loop）。人从执行者变成了监督者。

2. **Spec 的质量决定一切** — Ralph 跑得好不好，90% 取决于你的 PROMPT.md 写得好不好。垃圾规范 = 垃圾产出（GIGO）。

3. **这就是 Loop Engineer 的工作** — 你不写代码，你设计循环：什么目标、什么约束、什么反馈信号、什么终止条件。

---

## 下一课

Ralph Loop 解决了"让 AI 自主迭代"的编排问题，但一个长时间无人值守的 Agent，还需要**在迭代过程中持续记住上下文**——这正是同卷并列的 [第 41b 课：企业级 Memory 系统](/blog/from-scratch-41b-enterprise-memory-system/) 要解决的。两篇合起来，构成"怎么让它自己跑 + 怎么让它记得住"的完整闭环。

---

## 参考资料

- [Geoff Huntley 的 Ralph 原始介绍](https://ghuntley.com/ralph/)
- [Ralph 简史 — HumanLayer](https://www.humanlayer.dev/blog/brief-history-of-ralph)
- [Tony Bai — 从"手搓Prompt"到"无限循环"](https://tonybai.com/2026/01/21/ai-coding-evolution-from-prompting-to-ralph/)
- [Addy Osmani — 2026 AI Coding Trends](https://beyond.addy.ie/2026-trends/)
