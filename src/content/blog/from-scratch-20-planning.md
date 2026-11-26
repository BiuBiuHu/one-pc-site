---
title: "Planning — 任务规划"
date: 2026-11-25
excerpt: "面对复杂任务，如何先规划再执行？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 21
---

> 目标：让 Agent 面对复杂任务时先制定计划再执行，而不是盲目地一步步摸索

---

## 背景：为什么需要规划？

没有规划的 Agent 面对复杂任务时，像一个没有地图的旅行者：

```
用户：帮我分析这个项目的代码质量，生成报告，并给出改进建议

Agent（无规划）：
  Step 1: 读了一个文件
  Step 2: 又读了另一个文件
  Step 3: 发现还有很多文件没读
  Step 4: 开始写报告，发现信息不够
  Step 5: 回头再读文件...
  （绕了很多弯路，可能超出 maxSteps 限制）
```

有规划的 Agent：

```
Agent（有规划）：
  [规划阶段]
  Plan:
    1. 列出所有源文件
    2. 读取每个文件，分析代码质量指标
    3. 汇总分析结果
    4. 生成结构化报告

  [执行阶段]
  按计划逐步执行，不走弯路
```

---

## 核心模式：ReAct（Reasoning + Acting）

ReAct 是目前最主流的 Agent 规划模式，每一步都包含：

```
Thought（思考）：我现在需要做什么？为什么？
Action（行动）：调用哪个工具，参数是什么？
Observation（观察）：工具返回了什么结果？
→ 回到 Thought，根据结果决定下一步
```

`ai` SDK 的 `generateText` + `maxSteps` 本质上就是在实现 ReAct 循环，只是思考过程隐藏在 LLM 内部。

---

## 实现一：两阶段规划（Plan-then-Execute）

把任务分成两个独立的 LLM 调用：第一个调用负责规划，第二个调用负责执行。

```typescript
import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { agentTools } from './agent/tools.js';

// 任务计划的数据结构
const TaskPlanSchema = z.object({
  goal: z.string().describe('任务的最终目标'),
  steps: z.array(z.object({
    stepId: z.string().describe('步骤 ID，如 step-1、step-2'),
    description: z.string().describe('这一步要做什么'),
    tool: z.string().describe('需要调用的工具名称，如 list_files、read_file'),
    args: z.record(z.string()).describe('工具参数'),
    dependsOn: z.array(z.string()).describe('依赖的步骤 ID，必须等这些步骤完成后才能执行'),
    reason: z.string().describe('为什么需要这一步'),
  })),
  estimatedSteps: z.number().describe('预计总步骤数'),
});

type TaskPlan = z.infer<typeof TaskPlanSchema>;

// 阶段一：规划
async function planTask(
  userRequest: string,
  model: Parameters<typeof generateText>[0]['model']
): Promise<TaskPlan> {
  const availableTools = Object.keys(agentTools).join(', ');

  const { object: plan } = await generateObject({
    model,
    schema: TaskPlanSchema,
    messages: [
      {
        role: 'system',
        content: `你是一个任务规划专家。将用户的任务分解成具体的执行步骤。
可用工具：${availableTools}
要求：
- 每个步骤必须对应一个具体的工具调用
- 步骤之间的依赖关系要明确
- 步骤数量尽量精简，避免冗余`,
      },
      { role: 'user', content: userRequest },
    ],
  });

  return plan;
}

// 阶段二：按计划执行
async function executePlan(
  plan: TaskPlan,
  model: Parameters<typeof generateText>[0]['model'],
  onProgress: (stepId: string, status: 'running' | 'done', result?: string) => void
): Promise<string> {
  const stepResults = new Map<string, string>();
  const completedSteps = new Set<string>();

  // 按依赖顺序执行步骤
  // 简单实现：顺序执行（生产环境可以并行执行无依赖的步骤）
  for (const step of plan.steps) {
    // 等待所有依赖步骤完成
    for (const depId of step.dependsOn) {
      if (!completedSteps.has(depId)) {
        throw new Error(`步骤 ${step.stepId} 的依赖 ${depId} 尚未完成`);
      }
    }

    onProgress(step.stepId, 'running');

    // 把前置步骤的结果注入到当前步骤的上下文中
    const previousResults = step.dependsOn
      .map(depId => `${depId} 的结果：${stepResults.get(depId)}`)
      .join('\n');

    // 执行这一步
    const { text: stepResult } = await generateText({
      model,
      tools: agentTools,
      maxSteps: 3,
      messages: [
        {
          role: 'system',
          content: `你正在执行任务计划的第 ${step.stepId} 步：${step.description}
${previousResults ? `\n前置步骤结果：\n${previousResults}` : ''}
请直接执行，不要解释。`,
        },
        { role: 'user', content: `执行：${step.description}，工具参数：${JSON.stringify(step.args)}` },
      ],
    });

    stepResults.set(step.stepId, stepResult);
    completedSteps.add(step.stepId);
    onProgress(step.stepId, 'done', stepResult);
  }

  // 汇总所有步骤结果，生成最终回答
  const allResults = plan.steps
    .map(step => `## ${step.stepId}: ${step.description}\n${stepResults.get(step.stepId)}`)
    .join('\n\n');

  const { text: finalAnswer } = await generateText({
    model,
    messages: [
      {
        role: 'system',
        content: '根据以下执行结果，生成清晰、完整的最终回答。',
      },
      {
        role: 'user',
        content: `原始任务：${plan.goal}\n\n执行结果：\n${allResults}`,
      },
    ],
  });

  return finalAnswer;
}

// 使用示例
async function main() {
  const provider = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  const model = provider.chat(process.env.MODEL_NAME ?? 'gpt-4');

  const userRequest = '帮我分析项目根目录的文件结构，并说明每个文件的作用';

  console.log('📋 第一阶段：制定计划...');
  const plan = await planTask(userRequest, model);
  console.log(`计划包含 ${plan.steps.length} 个步骤：`);
  plan.steps.forEach(step => console.log(`  ${step.stepId}: ${step.description}`));

  console.log('\n🚀 第二阶段：执行计划...');
  const result = await executePlan(plan, model, (stepId, status, result) => {
    if (status === 'running') console.log(`  ▶ 执行 ${stepId}...`);
    if (status === 'done') console.log(`  ✅ ${stepId} 完成`);
  });

  console.log('\n📄 最终结果：');
  console.log(result);
}

main().catch(console.error);
```

---

## 实现二：Chain of Thought（思维链）

让 LLM 在回答前先"想清楚"，把推理过程写出来：

```typescript
import { generateText } from 'ai';

// 在 System Prompt 里要求模型先思考再行动
async function chatWithChainOfThought(
  userRequest: string,
  model: Parameters<typeof generateText>[0]['model']
): Promise<{ thinking: string; answer: string }> {
  const { text } = await generateText({
    model,
    messages: [
      {
        role: 'system',
        content: `在回答任何问题之前，你必须先在 <thinking> 标签内写出你的思考过程：
- 分析任务的核心需求
- 列出需要收集的信息
- 规划执行步骤
- 预判可能的问题

然后在 <answer> 标签内给出最终回答。

格式：
<thinking>
你的思考过程...
</thinking>
<answer>
你的最终回答...
</answer>`,
      },
      { role: 'user', content: userRequest },
    ],
  });

  // 解析思考过程和最终回答
  const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/);
  const answerMatch = text.match(/<answer>([\s\S]*?)<\/answer>/);

  return {
    thinking: thinkingMatch?.[1]?.trim() ?? '',
    answer: answerMatch?.[1]?.trim() ?? text,
  };
}
```

---

## 两种模式对比

| 维度 | Plan-then-Execute | Chain of Thought |
|------|-------------------|-----------------|
| **适用场景** | 多步骤、有明确子任务的复杂任务 | 需要推理的单次回答 |
| **LLM 调用次数** | 多次（规划 + 每步执行） | 一次 |
| **可控性** | 高（可以在步骤间插入审批） | 低（一次性生成） |
| **延迟** | 高 | 低 |
| **适合工具调用** | ✅ 是 | ❌ 否 |

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **ReAct** | Reasoning + Acting，每步包含思考、行动、观察三个环节 |
| **Plan-then-Execute** | 先规划再执行，把复杂任务分解成有序步骤 |
| **Chain of Thought** | 让 LLM 把推理过程写出来，提升回答质量 |
| **步骤依赖** | `dependsOn` 字段控制步骤执行顺序，支持并行化 |
| **generateObject** | 用结构化输出生成任务计划，比自由文字更可靠 |

---

## 下一步

- [ ] 阅读 `ai` SDK 源码，理解 `generateText` 的内部实现