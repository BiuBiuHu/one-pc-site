---
title: "第三十二课：工具调用错误重试策略 — 让 Agent 在失败中自愈"
date: 2026-11-25
excerpt: "不同类型的失败该用什么重试策略？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 33
---

> 目标：理解工具调用失败的常见原因，掌握指数退避、错误分类、Agent 自主重规划三种重试策略

---

## 背景：当前代码没有任何重试机制

回顾 `agent.ts` 的工具调用实现，工具执行失败时只有两种结果：

1. 工具内部 `try/catch` 返回错误字符串 → 模型可能假装成功（幻觉，见第29课）
2. 工具抛出未捕获异常 → 整个 Agent 执行中断，用户看到报错

**没有重试，Agent 的可靠性完全依赖工具的成功率。** 在生产环境中，网络抖动、文件锁、API 限流等瞬时错误随时可能发生，一次失败不应该让整个任务失败。

---

## 错误分类：哪些值得重试，哪些不值得

重试的前提是判断错误类型：

```typescript
type ToolErrorCategory =
  | 'transient'    // 瞬时错误，值得重试（网络超时、限流、文件锁）
  | 'permanent'    // 永久错误，不值得重试（文件不存在、权限不足、参数错误）
  | 'unknown';     // 未知错误，谨慎重试一次

function categorizeError(error: Error): ToolErrorCategory {
  const message = error.message.toLowerCase();

  // 瞬时错误：重试有意义
  if (
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('503') ||
    message.includes('ebusy')           // 文件被占用
  ) {
    return 'transient';
  }

  // 永久错误：重试没有意义
  if (
    message.includes('enoent') ||       // 文件不存在
    message.includes('eacces') ||       // 权限不足
    message.includes('not found') ||
    message.includes('invalid') ||
    message.includes('400')             // 参数错误
  ) {
    return 'permanent';
  }

  return 'unknown';
}
```

---

## 策略一：指数退避重试（Exponential Backoff）

对瞬时错误，等待一段时间后重试，每次等待时间翻倍：

```typescript
interface RetryOptions {
  maxAttempts: number;       // 最大重试次数（含第一次）
  initialDelayMs: number;    // 初始等待时间（毫秒）
  maxDelayMs: number;        // 最大等待时间上限（毫秒）
  jitterRatio: number;       // 随机抖动比例（0~1），防止多个请求同时重试造成"惊群"
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.2,
};

async function withExponentialBackoff<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error = new Error('未知错误');

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const category = categorizeError(lastError);

      // 永久错误：立即抛出，不重试
      if (category === 'permanent') {
        throw lastError;
      }

      // 已达最大重试次数：抛出最后一次错误
      if (attempt === config.maxAttempts) {
        throw lastError;
      }

      // 计算等待时间：初始延迟 × 2^(attempt-1)，加随机抖动，不超过上限
      const baseDelay = config.initialDelayMs * Math.pow(2, attempt - 1);
      const jitter = baseDelay * config.jitterRatio * Math.random();
      const delayMs = Math.min(baseDelay + jitter, config.maxDelayMs);

      console.warn(
        `⚠️ 第 ${attempt} 次尝试失败（${category}）：${lastError.message}，${delayMs.toFixed(0)}ms 后重试...`,
      );

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// 使用示例：包装任何可能失败的工具操作
async function readFileWithRetry(filePath: string): Promise<string> {
  return withExponentialBackoff(
    () => import('fs/promises').then((fs) => fs.readFile(filePath, 'utf-8')),
    { maxAttempts: 3, initialDelayMs: 200 },
  );
}
```

---

## 策略二：在 Vercel ai SDK 中使用内置重试

`generateText` 和 `streamText` 都支持 `maxRetries` 参数，用于 LLM API 调用层面的重试：

```typescript
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = provider.chat('gpt-4o');

// maxRetries 控制 LLM API 调用失败时的重试次数（默认是 2）
// 这只针对 LLM API 本身的失败（如网络超时、限流），不针对工具执行失败
const { text } = await generateText({
  model,
  messages: [{ role: 'user', content: '你好' }],
  maxRetries: 3,  // LLM API 调用失败时最多重试 3 次
});
```

**注意**：`maxRetries` 只针对 LLM API 调用失败，不针对工具执行失败。工具失败的重试需要在工具层面自己实现。

---

## 策略三：Agent 自主重规划（最智能）

不是机械地重试同一个操作，而是把错误信息反馈给模型，让模型自主决定如何调整：

```typescript
import { generateText, type CoreMessage } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { agentTools } from './tools.js';
import type { ChatContext } from './context-manager.js';
import { ContextManager } from './context-manager.js';

// 把工具错误结构化地返回给模型，而不是抛出异常
// 这样模型可以感知到错误，并自主决定是换一种方式还是放弃
function buildToolErrorResult(toolName: string, error: Error): string {
  return JSON.stringify({
    success: false,
    toolName,
    error: error.message,
    // 给模型提供重规划的线索
    suggestion: categorizeError(error) === 'permanent'
      ? '此错误无法通过重试解决，请考虑换一种方式完成任务'
      : '此错误可能是临时性的，可以稍后重试或换一种方式',
  });
}

// 带自主重规划能力的 Agent 执行
// 核心思路：工具失败时，把结构化错误信息注入 messages，让模型重新规划
async function chatWithSelfHealing(
  model: ReturnType<OpenAIProvider['chat']>,
  message: string,
  context: ChatContext,
  systemPrompt: string,
): Promise<string> {
  const userMessage: CoreMessage = { role: 'user', content: message };
  context.messages.push(userMessage);

  const messages = await ContextManager.buildMessages(systemPrompt, context, model);

  // experimental_repairToolCall：当工具调用参数无效时，让模型自动修复参数
  // 这是 Vercel ai SDK 内置的工具调用自愈机制
  const { text } = await generateText({
    model,
    messages,
    tools: agentTools,
    maxSteps: 8,  // 给更多步骤，为重规划留出空间
    experimental_repairToolCall: async ({ toolCall, error, messages: currentMessages, system }) => {
      // 当工具参数解析失败时，让模型重新生成正确的参数
      console.warn(`🔧 工具参数修复：${toolCall.toolName}，错误：${error.message}`);

      const { text: repairedArgs } = await generateText({
        model,
        system,
        messages: [
          ...currentMessages,
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, args: toolCall.args }],
          },
          {
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, result: `参数错误：${error.message}，请修正参数格式后重试` }],
          },
        ],
      });

      // 尝试从模型回复中提取修复后的 JSON 参数
      try {
        return { ...toolCall, args: JSON.parse(repairedArgs) };
      } catch {
        // 如果模型回复不是合法 JSON，返回原始 toolCall，让 SDK 处理
        return toolCall;
      }
    },
  });

  const assistantMessage: CoreMessage = { role: 'assistant', content: text };
  context.messages.push(assistantMessage);

  return text;
}
```

---

## 三种策略对比

| 策略 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| **指数退避** | 网络超时、API 限流等瞬时错误 | 简单可靠，不消耗额外 Token | 机械重试，不能处理逻辑错误 |
| **SDK maxRetries** | LLM API 调用失败 | 零成本，SDK 内置 | 只针对 LLM API，不针对工具 |
| **Agent 自主重规划** | 工具参数错误、路径错误等逻辑错误 | 智能，能处理复杂情况 | 消耗额外 Token，增加延迟 |

**最佳实践**：三种策略组合使用
- 工具层：指数退避处理瞬时错误
- LLM 调用层：`maxRetries: 3`
- Agent 层：`experimental_repairToolCall` 处理参数错误

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **错误分类** | 区分瞬时错误（值得重试）和永久错误（不值得重试）是重试策略的前提 |
| **指数退避** | 每次重试等待时间翻倍，加随机抖动，防止惊群效应 |
| **jitter（抖动）** | 在退避时间上加随机偏移，防止多个客户端同时重试打爆服务端 |
| **maxRetries** | Vercel ai SDK 内置的 LLM API 重试参数，默认值为 2 |
| **experimental_repairToolCall** | SDK 内置的工具参数修复机制，让模型自动修正无效的工具调用参数 |
| **自主重规划** | 把错误信息结构化地反馈给模型，让模型自己决定如何调整策略 |

---

## 与其他课程的关联

- **第29课（幻觉防治）**：错误透明化是幻觉防治的核心手段之一，本课的 `buildToolErrorResult` 是其具体实现
- **第16课（Hooks/Middleware）**：重试逻辑可以封装成基于 `onEvent` 的中间件，在收到 `tool_call_result` 事件后统一判断是否需要重试，而不是在每个工具里单独实现
