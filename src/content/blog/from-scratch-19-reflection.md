---
title: "第十九课：Reflection — Agent 自我反思"
date: 2026-11-25
excerpt: "如何让 Agent 自我评估并修正输出？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 20
---

> 目标：让 Agent 对自己的输出进行评估和修正，通过迭代循环提升输出质量

---

## 背景：为什么 Agent 需要自我反思？

LLM 的输出是一次性的——它生成完就结束了，不会主动检查自己是否出错。

但人类在完成一项任务后，通常会回头检查：
- 代码写完了，跑一下测试
- 文章写完了，通读一遍修改
- 方案设计完了，对照需求逐条核查

**Reflection（自我反思）** 就是给 Agent 加上这个"回头检查"的能力。

---

## 核心模式：Critic-Actor 循环

```
用户任务
    │
    ▼
Actor（执行者）：生成初始输出
    │
    ▼
Critic（评审者）：评估输出质量，给出改进建议
    │
    ├─ 质量达标 → 输出最终结果
    │
    └─ 质量不达标 → Actor 根据建议修正 → 再次 Critic → ...
```

Actor 和 Critic 可以是：
- **同一个 LLM**（用不同的 Prompt）
- **不同的 LLM**（如 GPT-4 生成，Claude 评审）
- **外部工具**（代码用编译器检查，文章用 Lint 工具检查）

---

## 实现一：同一个 LLM 自我评审

```typescript
import { generateText, generateObject } from 'ai';
import { z } from 'zod'; from 'ai';

interface ReflectionResult {
  finalOutput: string;
  iterations: number;
  history: Array<{ output: string; critique: string; score: number }>;
}

async function reflectAndRefine(
  task: string,
  model: Parameters<typeof generateText>[0]['model'],
  maxIterations = 3,
  qualityThreshold = 8  // 满分 10 分，达到 8 分才停止
): Promise<ReflectionResult> {
  const history: ReflectionResult['history'] = [];
  let currentOutput = '';

  // ── 第一步：Actor 生成初始输出 ──────────────────────────────────────────
  const { text: initialOutput } = await generateText({
    model,
    messages: [
      { role: 'system', content: '你是一个专业的任务执行者，尽力完成用户的任务。' },
      { role: 'user', content: task },
    ],
  });
  currentOutput = initialOutput;

  // ── 迭代循环：Critic 评审 → Actor 修正 ──────────────────────────────────
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Critic：评估当前输出
    const { object: critique } = await generateObject({
      model,
      schema: z.object({
        score: z.number().min(0).max(10).describe('输出质量评分，0-10'),
        issues: z.array(z.string()).describe('发现的问题列表'),
        suggestions: z.array(z.string()).describe('具体的改进建议'),
        is_acceptable: z.boolean().describe('是否达到可接受的质量标准'),
      }),
      messages: [
        {
          role: 'system',
          content: '你是一个严格的质量评审者。评估以下输出是否完整、准确、符合要求，给出具体的改进建议。',
        },
        {
          role: 'user',
          content: `原始任务：${task}\n\n当前输出：\n${currentOutput}`,
        },
      ],
    });

    history.push({
      output: currentOutput,
      critique: critique.issues.join('; '),
      score: critique.score,
    });

    // 质量达标，停止迭代
    if (critique.is_acceptable || critique.score >= qualityThreshold) {
      break;
    }

    // Actor：根据 Critic 的建议修正输出
    const { text: refinedOutput } = await generateText({
      model,
      messages: [
        { role: 'system', content: '你是一个专业的任务执行者，根据评审意见改进你的输出。' },
        { role: 'user', content: task },
        { role: 'assistant', content: currentOutput },
        {
          role: 'user',
          content: `评审意见：\n${critique.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n请根据以上意见改进你的输出。`,
        },
      ],
    });

    currentOutput = refinedOutput;
  }

  return {
    finalOutput: currentOutput,
    iterations: history.length,
    history,
  };
}
```

---

## 实现二：外部工具作为 Critic

对于代码生成场景，最好的 Critic 不是另一个 LLM，而是**真实的编译器/测试工具**：

```typescript
import { generateText } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';

// 从 LLM 输出中提取代码块（去掉 ```typescript ... ``` 包裹）
function extractCodeBlock(text: string): string {
  // 匹配 ```typescript 或 ``` 包裹的代码块
  const match = text.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  // 没有代码块标记，直接返回原文
  return text.trim();
}

// 把代码写入临时文件，用 tsc 做类型检查
// 返回 { success: true } 或 { success: false, error: string }
function runTypeCheck(code: string): { success: boolean; error: string } {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `reflection-check-${Date.now()}.ts`);

  try {
    fs.writeFileSync(tmpFile, code, 'utf-8');
    // --noEmit：只检查类型，不生成 JS 文件
    // --strict：开启严格模式
    // --skipLibCheck：跳过 node_modules 类型检查，加快速度
    execSync(`npx tsc --noEmit --strict --skipLibCheck --target ES2020 --module NodeNext ${tmpFile}`, {
      stdio: 'pipe',
    });
    return { success: true, error: '' };
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as NodeJS.ErrnoException & { stderr: Buffer }).stderr)
      : String(error);
    // 去掉临时文件路径，只保留错误信息
    const cleanedError = stderr.replace(new RegExp(tmpFile.replace(/[.*+?^${}()|[\]\\]/g, '\\## 实现二：外部工具作为 Critic

对于代码生成场景，最好的 Critic 不是另一个 LLM，而是**真实的编译器/测试工具**：

```typescript
// 代码生成 + 自动测试的 Reflection 循环
async function generateAndTestCode(requirement: string): Promise<string> {
  let code = '';
  let lastError = '';

  for (let attempt = 0; attempt < 5; attempt++) {
    // Actor：生成代码
    const { text } = await generateText({
      model,
      messages: [
        { role: 'system', content: '你是一个 TypeScript 专家，生成符合要求的代码。只输出代码，不要解释。' },
        { role: 'user', content: requirement },
        // 如果有上一次的错误，把错误信息带上
        ...(lastError ? [{
          role: 'user' as const,
          content: `上次生成的代码有以下错误，请修复：\n${lastError}`,
        }] : []),
      ],
    });

    code = extractCodeBlock(text);

    // Critic：用真实工具检查代码
    const testResult = await runTypeCheck(code);

    if (testResult.success) {
      console.log(`✅ 第 ${attempt + 1} 次尝试成功`);
      return code;
    }

    lastError = testResult.error;
    console.log(`❌ 第 ${attempt + 1} 次尝试失败：${lastError}`);
  }

  return code; // 达到最大尝试次数，返回最后一次的结果
}
```'), 'g'), 'code.ts');
    return { success: false, error: cleanedError };
  } finally {
    // 清理临时文件
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

// 代码生成 + 自动类型检查的 Reflection 循环
async function generateAndTestCode(
  requirement: string,
  model: Parameters<typeof generateText>[0]['model']
): Promise<string> {
  let code = '';
  let lastError = '';

  for (let attempt = 0; attempt < 5; attempt++) {
    // Actor：生成代码
    const { text } = await generateText({
      model,
      messages: [
        { role: 'system', content: '你是一个 TypeScript 专家，生成符合要求的代码。只输出代码块，不要解释。' },
        { role: 'user', content: requirement },
        // 如果有上一次的错误，把错误信息带上，让模型修复
        ...(lastError ? [{
          role: 'user' as const,
          content: `上次生成的代码有以下类型错误，请修复：\n\`\`\`\n${lastError}\n\`\`\``,
        }] : []),
      ],
    });

    code = extractCodeBlock(text);

    // Critic：用 tsc 做真实的类型检查
    const checkResult = runTypeCheck(code);

    if (checkResult.success) {
      console.log(`✅ 第 ${attempt + 1} 次尝试通过类型检查`);
      return code;
    }

    lastError = checkResult.error;
    console.log(`❌ 第 ${attempt + 1} 次尝试失败：\n${lastError}`);
  }

  console.warn('⚠️ 达到最大尝试次数，返回最后一次生成的代码');
  return code;
}
```

---

## 实现三：多维度评审（Rubric-based）

```typescript
// 用评分标准（Rubric）进行多维度评审
const RubricSchema = z.object({
  dimensions: z.array(z.object({
    name: z.string(),
    score: z.number().min(0).max(10),
    feedback: z.string(),
  })),
  overall_score: z.number().min(0).max(10),
  must_fix: z.array(z.string()).describe('必须修复的问题，不修复不能通过'),
  nice_to_fix: z.array(z.string()).describe('建议修复的问题，可选'),
});

const { object: rubricResult } = await generateObject({
  model,
  schema: RubricSchema,
  messages: [{
    role: 'user',
    content: `
      请从以下维度评审这段代码：
      1. 正确性（0-10）：逻辑是否正确，有无 bug
      2. 可读性（0-10）：命名是否清晰，结构是否合理
      3. 健壮性（0-10）：是否处理了边界情况和错误
      4. 性能（0-10）：是否有明显的性能问题

      代码：
      \`\`\`typescript
      ${code}
      \`\`\`
    `,
  }],
});
```

---

## 何时使用 Reflection？

| 场景 | 是否适合 | 原因 |
|------|----------|------|
| 代码生成 | ✅ 非常适合 | 可以用编译器/测试作为客观 Critic |
| 文章写作 | ✅ 适合 | LLM 自我评审能发现逻辑漏洞 |
| 简单问答 | ❌ 不适合 | 增加延迟和成本，收益不大 |
| 实时对话 | ❌ 不适合 | 用户等不了多轮迭代 |
| 高风险决策 | ✅ 非常适合 | 多轮检查降低出错概率 |

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Reflection** | Agent 对自己输出进行评估和修正的能力 |
| **Critic-Actor 模式** | Actor 生成，Critic 评审，循环迭代直到质量达标 |
| **外部 Critic** | 用编译器、测试工具等客观工具替代 LLM 评审，更可靠 |
| **Rubric** | 多维度评分标准，让评审结果更结构化、可量化 |
| **质量阈值** | 设定停止迭代的条件，防止无限循环 |
| **迭代上限** | `maxIterations` 防止在低质量任务上无限消耗 Token |

---

## 下一步

- [ ] 实现 Planning（任务规划），让 Agent 面对复杂任务时先制定计划再执行
