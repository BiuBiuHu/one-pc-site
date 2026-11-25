---
title: "第三十八课：长任务断点续传 — 让 Agent 从中断处恢复"
date: 2026-11-25
excerpt: "执行 30 分钟的任务崩了，如何从断点继续？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 39
---

> 目标：理解长任务的中断风险，掌握执行状态持久化、断点检测、从检查点恢复三种核心技术

---

## 背景：长任务的中断是必然的

一个需要执行 30 分钟的 Agent 任务，在执行过程中可能遭遇：

- 服务器重启、进程崩溃
- 网络超时、LLM API 限流
- 用户主动中断后想继续
- HTTP 请求超时（通常 30-60 秒）

**没有断点续传，任何中断都意味着从头开始。** 对于耗时的任务（代码重构、批量文档生成、大规模数据处理），这是不可接受的。

---

## 核心思路：把执行过程变成可恢复的状态机

```
任务开始
    │
    ▼
步骤 1 执行完 → 保存检查点（步骤1的结果）
    │
    ▼
步骤 2 执行完 → 保存检查点（步骤1+2的结果）
    │
    ▼
💥 中断！
    │
    ▼（重启后）
加载最新检查点 → 从步骤 3 继续执行
    │
    ▼
步骤 3 执行完 → 保存检查点
    │
    ▼
任务完成
```

---

## 检查点数据结构设计

```typescript
import type { CoreMessage } from 'ai';

// 单个步骤的执行结果
interface StepCheckpoint {
  stepIndex: number;
  stepName: string;
  completedAt: number;          // Unix 时间戳（毫秒）
  result: unknown;              // 步骤的输出结果
  toolCallsCount: number;       // 本步骤调用了多少次工具
  tokenUsed: number;            // 本步骤消耗的 Token 数
}

// 整个任务的检查点（保存到磁盘）
interface TaskCheckpoint {
  taskId: string;
  taskDescription: string;
  createdAt: number;
  lastUpdatedAt: number;
  status: 'running' | 'completed' | 'failed';
  completedSteps: StepCheckpoint[];
  conversationHistory: CoreMessage[];   // 对话历史，用于恢复上下文
  nextStepIndex: number;               // 下次从哪个步骤继续
  metadata: Record<string, unknown>;   // 任务相关的额外数据
}
```

---

## 检查点管理器

```typescript
import * as fs from 'fs';
import * as path from 'path';

export class CheckpointManager {
  private checkpointDir: string;

  constructor(checkpointDir: string = path.join(process.cwd(), '.agent-checkpoints')) {
    this.checkpointDir = checkpointDir;
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }
  }

  private getCheckpointPath(taskId: string): string {
    return path.join(this.checkpointDir, `${taskId}.json`);
  }

  // 创建新任务的检查点
  create(taskId: string, taskDescription: string, metadata: Record<string, unknown> = {}): TaskCheckpoint {
    const checkpoint: TaskCheckpoint = {
      taskId,
      taskDescription,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      status: 'running',
      completedSteps: [],
      conversationHistory: [],
      nextStepIndex: 0,
      metadata,
    };

    this.save(checkpoint);
    return checkpoint;
  }

  // 保存检查点到磁盘
  save(checkpoint: TaskCheckpoint): void {
    checkpoint.lastUpdatedAt = Date.now();
    const filePath = this.getCheckpointPath(checkpoint.taskId);
    // 先写临时文件，再原子性地重命名，防止写入过程中崩溃导致检查点损坏
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  }

  // 从磁盘加载检查点
  load(taskId: string): TaskCheckpoint | null {
    const filePath = this.getCheckpointPath(taskId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as TaskCheckpoint;
    } catch {
      console.error(`⚠️ 检查点文件损坏：${filePath}，将从头开始`);
      return null;
    }
  }

  // 记录一个步骤完成
  recordStep(
    checkpoint: TaskCheckpoint,
    stepName: string,
    result: unknown,
    toolCallsCount: number,
    tokenUsed: number,
  ): void {
    checkpoint.completedSteps.push({
      stepIndex: checkpoint.nextStepIndex,
      stepName,
      completedAt: Date.now(),
      result,
      toolCallsCount,
      tokenUsed,
    });
    checkpoint.nextStepIndex++;
    this.save(checkpoint);
  }

  // 标记任务完成
  markCompleted(checkpoint: TaskCheckpoint): void {
    checkpoint.status = 'completed';
    this.save(checkpoint);
  }

  // 标记任务失败
  markFailed(checkpoint: TaskCheckpoint, error: Error): void {
    checkpoint.status = 'failed';
    checkpoint.metadata.lastError = error.message;
    this.save(checkpoint);
  }

  // 列出所有未完成的任务
  listPendingTasks(): Array<{ taskId: string; taskDescription: string; progress: string; lastUpdatedAt: number }> {
    const files = fs.readdirSync(this.checkpointDir).filter((f) => f.endsWith('.json'));

    return files
      .map((file) => {
        try {
          const content = fs.readFileSync(path.join(this.checkpointDir, file), 'utf-8');
          const checkpoint = JSON.parse(content) as TaskCheckpoint;
          return {
            taskId: checkpoint.taskId,
            taskDescription: checkpoint.taskDescription,
            progress: `${checkpoint.completedSteps.length} 步已完成，下一步：${checkpoint.nextStepIndex}`,
            lastUpdatedAt: checkpoint.lastUpdatedAt,
          };
        } catch {
          return null;
        }
      })
      .filter((task): task is NonNullable<typeof task> => task !== null && true)
      .filter((task) => {
        const checkpoint = this.load(task.taskId);
        return checkpoint?.status === 'running';
      });
  }

  // 删除已完成任务的检查点（清理磁盘）
  cleanup(taskId: string): void {
    const filePath = this.getCheckpointPath(taskId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
```

---

## 带断点续传的 Agent 执行器

```typescript
import { generateText, type CoreMessage } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { agentTools } from './tools.js';

// 预定义的任务步骤列表
interface TaskStep {
  name: string;
  prompt: string;   // 发给 Agent 的指令
}

export async function executeWithCheckpoint(
  model: ReturnType<OpenAIProvider['chat']>,
  taskId: string,
  taskDescription: string,
  steps: TaskStep[],
  systemPrompt: string,
  checkpointManager: CheckpointManager,
  onStepComplete?: (stepName: string, result: string, stepIndex: number) => void,
): Promise<string> {
  // 尝试加载已有检查点（断点续传）
  let checkpoint = checkpointManager.load(taskId);
  const isResuming = checkpoint !== null && checkpoint.status === 'running';

  if (isResuming) {
    console.log(`🔄 从检查点恢复任务：${taskDescription}`);
    console.log(`   已完成 ${checkpoint!.completedSteps.length} / ${steps.length} 步`);
  } else {
    console.log(`🚀 开始新任务：${taskDescription}`);
    checkpoint = checkpointManager.create(taskId, taskDescription);
  }

  // 恢复对话历史（从检查点中加载）
  const conversationHistory: CoreMessage[] = isResuming
    ? checkpoint!.conversationHistory
    : [];

  let finalResult = '';

  try {
    // 从上次中断的步骤继续
    const startStepIndex = checkpoint!.nextStepIndex;

    for (let stepIndex = startStepIndex; stepIndex < steps.length; stepIndex++) {
      const step = steps[stepIndex];
      console.log(`\n📍 执行步骤 ${stepIndex + 1}/${steps.length}：${step.name}`);

      const userMessage: CoreMessage = { role: 'user', content: step.prompt };
      conversationHistory.push(userMessage);

      const { text, usage } = await generateText({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
        ],
        tools: agentTools,
        maxSteps: 5,
      });

      const assistantMessage: CoreMessage = { role: 'assistant', content: text };
      conversationHistory.push(assistantMessage);

      // 更新检查点：保存本步骤结果和当前对话历史
      checkpoint!.conversationHistory = [...conversationHistory];
      checkpointManager.recordStep(
        checkpoint!,
        step.name,
        text,
        0,  // toolCallsCount 可从 onStepFinish 回调中获取
        usage.promptTokens + usage.completionTokens,
      );

      onStepComplete?.(step.name, text, stepIndex);
      finalResult = text;

      console.log(`   ✅ 步骤 ${stepIndex + 1} 完成`);
    }

    checkpointManager.markCompleted(checkpoint!);
    console.log(`\n🎉 任务完成：${taskDescription}`);

    return finalResult;
  } catch (error) {
    checkpointManager.markFailed(checkpoint!, error instanceof Error ? error : new Error(String(error)));
    console.error(`\n❌ 任务失败，检查点已保存，可以稍后恢复`);
    throw error;
  }
}

// 使用示例：一个需要多步骤的代码重构任务
const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = provider.chat('gpt-4o');
const checkpointManager = new CheckpointManager();

const refactoringSteps: TaskStep[] = [
  { name: '分析现有代码', prompt: '读取 src/agent/agent.ts，分析当前代码的结构和问题' },
  { name: '制定重构方案', prompt: '基于分析结果，制定详细的重构方案，列出需要修改的文件和改动点' },
  { name: '执行重构', prompt: '按照重构方案，逐步修改代码' },
  { name: '验证结果', prompt: '检查重构后的代码，确认没有遗漏和错误' },
];

await executeWithCheckpoint(
  model,
  'refactor-agent-2024-01',
  '重构 Agent 核心模块',
  refactoringSteps,
  '你是一个代码重构专家。',
  checkpointManager,
  (stepName, result, stepIndex) => {
    console.log(`步骤 "${stepName}" 完成，结果长度：${result.length} 字符`);
  },
);
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **检查点（Checkpoint）** | 保存任务执行状态的快照，包含已完成步骤、对话历史、下一步索引 |
| **原子写入** | 先写临时文件再重命名，防止写入过程中崩溃导致检查点文件损坏 |
| **断点续传** | 启动时检查是否有未完成的检查点，有则从 `nextStepIndex` 继续执行 |
| **对话历史恢复** | 把检查点中保存的 `conversationHistory` 恢复到 messages，让模型有完整上下文 |
| **状态机** | 把任务执行过程建模为状态机（running/completed/failed），每个步骤完成后转移状态 |

---

## 与其他课程的关联

- **卷五 · 消息队列（第23~28课）**：消息队列天然支持任务持久化，是断点续传的企业级实现方案
- **第33课（可观测性）**：检查点数据可以作为 Trace 的一部分，在可观测性平台中查看任务的完整执行历史
