---
title: "第三十六课：Agent 测试方法论 — 单元测试、Mock LLM 与回归测试"
date: 2026-11-25
excerpt: "输出不确定的 Agent 怎么做自动化测试？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 37
---

> 目标：理解 Agent 测试的特殊挑战，掌握 Mock LLM、工具测试、端到端测试三个层次的测试方法

---

## 背景：为什么 Agent 测试比普通代码测试难

普通代码测试：输入确定 → 输出确定 → 断言通过/失败

Agent 测试的挑战：
- **LLM 输出不确定**：同样的输入，每次模型回复可能不同
- **工具调用顺序不确定**：模型可能选择不同的工具组合完成同一个任务
- **测试成本高**：每次测试都真实调用 LLM API，既慢又贵
- **难以复现**：线上出现的问题，在测试环境里可能无法复现

**解决方案**：分层测试 + Mock LLM

---

## 测试金字塔：三个层次

```
          ┌─────────────────┐
          │  端到端测试 E2E  │  ← 少量，真实 LLM，验证关键路径
          │  (慢、贵、不稳定)│
          └────────┬────────┘
                   │
          ┌────────┴────────┐
          │  集成测试        │  ← 中量，Mock LLM，测试 Agent Loop
          │  (中速、中成本)  │
          └────────┬────────┘
                   │
          ┌────────┴────────┐
          │  单元测试        │  ← 大量，无 LLM，测试工具和工具函数
          │  (快、免费、稳定)│
          └─────────────────┘
```

---

## 第一层：工具单元测试

工具是纯函数（输入确定，输出确定），最容易测试：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 直接测试工具的 execute 函数，不需要 LLM
describe('readFileTool', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    // 每个测试用例前创建临时目录和文件
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
    testFilePath = path.join(tempDir, 'test.ts');
    fs.writeFileSync(testFilePath, 'export const hello = "world";', 'utf-8');
  });

  afterEach(() => {
    // 每个测试用例后清理临时文件
    fs.rmSync(tempDir, { recursive: true });
  });

  it('应该成功读取存在的文件', async () => {
    // 直接调用工具的 execute 函数
    const { readFileTool } = await import('../src/agent/tools.js');
    const result = await readFileTool.execute(
      { filePath: 'test.ts' },
      { toolCallId: 'test-1', messages: [], abortSignal: new AbortController().signal, workspaceRoot: tempDir },
    );

    expect(result).toMatchObject({
      success: true,
      content: 'export const hello = "world";',
    });
  });

  it('应该在文件不存在时返回错误信息', async () => {
    const { readFileTool } = await import('../src/agent/tools.js');
    const result = await readFileTool.execute(
      { filePath: 'nonexistent.ts' },
      { toolCallId: 'test-2', messages: [], abortSignal: new AbortController().signal, workspaceRoot: tempDir },
    );

    expect(result).toMatchObject({
      success: false,
    });
    expect(String(result)).toContain('不存在');
  });

  it('应该拒绝路径穿越攻击', async () => {
    const { readFileTool } = await import('../src/agent/tools.js');
    const result = await readFileTool.execute(
      { filePath: '../../etc/passwd' },
      { toolCallId: 'test-3', messages: [], abortSignal: new AbortController().signal, workspaceRoot: tempDir },
    );

    // 路径穿越应该被沙箱拦截
    expect(result).toMatchObject({ success: false });
  });
});
```

---

## 第二层：Mock LLM 集成测试

用预设的响应替代真实 LLM，测试 Agent Loop 的逻辑：

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { LanguageModel, LanguageModelV1StreamPart } from 'ai';

// 创建一个 Mock LLM，返回预设的响应序列
function createMockModel(responses: Array<{
  text?: string;
  toolCalls?: Array<{ toolName: string; toolCallId: string; args: Record<string, unknown> }>;
}>): LanguageModel {
  let callIndex = 0;

  return {
    specificationVersion: 'v1',
    provider: 'mock',
    modelId: 'mock-model',
    defaultObjectGenerationMode: 'json',

    async doGenerate(options) {
      const response = responses[callIndex % responses.length];
      callIndex++;

      const toolCalls = response.toolCalls?.map((tc) => ({
        toolCallType: 'function' as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: JSON.stringify(tc.args),
      })) ?? [];

      return {
        text: response.text ?? '',
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
        usage: { promptTokens: 100, completionTokens: 50 },
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
      };
    },

    async doStream(options) {
      // Mock 流式：把 doGenerate 的结果包装成流
      const generateResult = await this.doGenerate(options);

      const parts: LanguageModelV1StreamPart[] = [];

      if (generateResult.text) {
        parts.push({ type: 'text-delta', textDelta: generateResult.text });
      }

      for (const toolCall of generateResult.toolCalls ?? []) {
        parts.push({
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        });
      }

      parts.push({
        type: 'finish',
        finishReason: generateResult.finishReason,
        usage: generateResult.usage,
      });

      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
        rawCall: generateResult.rawCall,
      };
    },
  };
}

// 测试 Agent 在工具调用场景下的行为
describe('Agent 工具调用集成测试', () => {
  it('应该在模型请求工具时执行工具并把结果回传', async () => {
    const { generateText } = await import('ai');
    const { agentTools } = await import('../src/agent/tools.js');

    // Mock 模型：第一次调用返回工具调用，第二次返回最终文字
    const mockModel = createMockModel([
      {
        toolCalls: [{
          toolName: 'get_current_time',
          toolCallId: 'call-1',
          args: {},
        }],
      },
      {
        text: '当前时间已获取，任务完成。',
      },
    ]);

    const toolCallSpy = vi.spyOn(agentTools.get_current_time, 'execute');

    const { text } = await generateText({
      model: mockModel,
      messages: [{ role: 'user', content: '现在几点了？' }],
      tools: agentTools,
      maxSteps: 3,
    });

    // 验证工具确实被调用了
    expect(toolCallSpy).toHaveBeenCalledOnce();
    // 验证最终回复是第二次模型调用的结果
    expect(text).toBe('当前时间已获取，任务完成。');
  });
});
```

---

## 第三层：端到端回归测试

用真实 LLM 测试关键路径，建立"黄金标准"用于回归对比：

```typescript
import { describe, it, expect } from 'vitest';
import 'dotenv/config';

// 端到端测试：只在 CI 环境或手动触发时运行（避免每次都消耗 API）
const runE2E = process.env.RUN_E2E === 'true';

describe.skipIf(!runE2E)('Agent 端到端测试', () => {
  it('应该能读取文件并回答关于文件内容的问题', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { generateText } = await import('ai');
    const { agentTools } = await import('../src/agent/tools.js');

    const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const model = provider.chat('gpt-4o-mini');  // 用便宜的模型做 E2E 测试

    const { text } = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: '你是一个代码助手。回答要简洁，不超过两句话。',
        },
        {
          role: 'user',
          content: '读取 package.json 文件，告诉我这个项目叫什么名字',
        },
      ],
      tools: agentTools,
      maxSteps: 3,
    });

    // 不断言具体文字，只断言关键信息是否存在
    expect(text.toLowerCase()).toMatch(/simple-agent|simple agent/i);
  }, 30_000); // E2E 测试超时设为 30 秒
});
```

---

## 快照测试：防止 Prompt 改动导致行为退化

```typescript
import { describe, it, expect } from 'vitest';

// 对 Agent 的输出做快照，Prompt 改动后如果输出变化，测试会失败并要求确认
describe('Prompt 快照测试', () => {
  it('系统提示词格式应该保持稳定', () => {
    const { buildSystemPrompt } = require('../src/agent/agent.js');
    const prompt = buildSystemPrompt();

    // 第一次运行时会生成快照文件，后续运行会对比
    expect(prompt).toMatchSnapshot();
  });
});
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **测试金字塔** | 单元测试多、集成测试中、E2E 测试少，越底层越快越稳定 |
| **Mock LLM** | 用预设响应替代真实 LLM，让测试快速、免费、可复现 |
| **工具单元测试** | 直接调用工具的 `execute` 函数，不需要 LLM 参与 |
| **集成测试** | 用 Mock LLM 测试 Agent Loop 的完整流程（工具调用 → 结果回传 → 继续生成） |
| **E2E 测试** | 用真实 LLM 测试关键路径，只在 CI 或手动触发时运行 |
| **快照测试** | 对 Prompt 或输出做快照，防止无意识的退化 |

---

## 与其他课程的关联

- **第32课（错误重试）**：重试逻辑需要专门的单元测试，验证在不同错误类型下的重试行为是否符合预期
- **第39课（Agent Evals）**：E2E 测试是 Evals 的基础，Evals 是 E2E 测试的系统化延伸
