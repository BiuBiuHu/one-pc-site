---
title: "第三十课：真正的流式 Agent Loop — streamText + 工具调用的完美结合"
date: 2026-11-25
excerpt: "伪流式和真流式的本质区别是什么？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 31
---

> 目标：理解伪流式与真流式的本质区别，用 streamText 实现工具调用过程中的真实 token 级流式输出

---

## 背景：当前实现的问题

回顾第15课的 `chatWithToolsStream` 方法，它的"流式"其实是假的：

```typescript
// ❌ 当前实现：generateText 等待完整结果，再逐字符模拟流式
const result = await generateText({ model, messages, tools, maxSteps: 5 });

for (const char of result.text) {
  onEvent({ type: 'text_delta', content: char });  // 伪流式！
}
```

**问题**：`generateText` 是阻塞的——它等 LLM 生成完所有 token 后才返回。用户要等整个响应完成才能看到第一个字，体验和 ChatGPT 的逐字出现完全不同。

---

## 伪流式 vs 真流式的本质区别

```
伪流式（generateText）：
LLM 生成 ████████████████████ 完成
                              ↓ 一次性返回
前端收到 ████████████████████ 一次性渲染
用户感知：等待 → 突然全部出现

真流式（streamText）：
LLM 生成 █ → █ → █ → █ → █ → █ → ...
         ↓    ↓    ↓    ↓    ↓    ↓
前端收到 █ → █ → █ → █ → █ → █ → ...
用户感知：逐字出现，像打字机
```

**延迟对比**：假设模型生成 200 个 token 需要 5 秒
- 伪流式：用户等 5 秒后看到全部内容
- 真流式：用户 200ms 内看到第一个字，5 秒内看完全部

---

## 核心挑战：工具调用 + 流式的矛盾

工具调用天然是"阻塞"的：

```
模型流式输出 → 遇到 tool_call → 必须等工具执行完 → 再继续流式输出
```

这意味着一次带工具调用的 Agent Loop 实际上是：

```
[流式阶段1] 模型思考并决定调用工具（可流式）
[阻塞阶段]  工具实际执行（必须等待）
[流式阶段2] 模型基于工具结果生成最终回复（可流式）
```

`streamText` 的 `fullStream` 正是为了处理这个混合场景而设计的。

---

## 实现：用 fullStream 处理混合事件流

`streamText` 返回的 `fullStream` 是一个 `AsyncIterable`，它会按顺序吐出所有事件：

```typescript
import { streamText, type StreamTextResult, type CoreMessage } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { agentTools } from './tools.js';
import type { ChatContext } from './context-manager.js';
import { ContextManager } from './context-manager.js';
// 直接复用第15课定义的事件类型，事件契约完全一致（7 种事件）
import type { AgentEvent } from './agent.js';

export async function chatWithTrueStream(
  model: ReturnType<OpenAIProvider['chat']>,
  message: string,
  context: ChatContext,
  systemPrompt: string,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const userMessage: CoreMessage = { role: 'user', content: message };
  context.messages.push(userMessage);

  const messagesWithSystem = await ContextManager.buildMessages(systemPrompt, context, model);

  onEvent({ type: 'thinking_start' });

  let stepIndex = 0;
  let fullText = '';

  try {
    // streamText 返回的是流，不会阻塞
    // experimental_continueSteps 允许工具调用后继续流式输出
    const result: StreamTextResult<typeof agentTools, never> = streamText({
      model,
      messages: messagesWithSystem,
      tools: agentTools,
      maxSteps: 5,
      experimental_continueSteps: true,
    });

    // fullStream 是混合事件流，包含所有类型的事件
    for await (const chunk of result.fullStream) {
      switch (chunk.type) {
        // 模型正在流式输出文字 token
        case 'text-delta':
          fullText += chunk.textDelta;
          onEvent({ type: 'text_delta', content: chunk.textDelta });
          break;

        // 模型决定调用工具（此时工具参数可能还在流式生成中）
        case 'tool-call':
          onEvent({
            type: 'tool_call_start',
            toolName: chunk.toolName,
            args: chunk.args as Record<string, unknown>,
          });
          break;

        // 工具执行完毕，结果回来了
        case 'tool-result':
          onEvent({
            type: 'tool_call_result',
            toolName: chunk.toolName,
            result: JSON.stringify(chunk.result),
          });
          break;

        // 一个 Agent Loop 步骤完成（工具调用完毕，模型即将继续思考）
        case 'step-finish':
          stepIndex++;
          onEvent({ type: 'step_complete', stepIndex });
          // isContinued 为 true 表示还有后续步骤（模型将继续思考）
          if (chunk.isContinued) {
            onEvent({ type: 'thinking_start' });
          }
          break;

        // 工具参数流式生成中（可用于显示"正在准备工具参数..."）
        case 'tool-call-streaming-start':
          // 工具参数开始流式生成，可选择性地通知 UI
          break;

        // 整个流结束
        case 'finish':
          break;

        // 发生错误
        case 'error':
          throw chunk.error;
      }
    }

    onEvent({ type: 'done', fullText });

    const assistantMessage: CoreMessage = { role: 'assistant', content: fullText };
    context.messages.push(assistantMessage);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    onEvent({ type: 'error', message: errorMessage });
    throw error;
  }
}
```

---

## fullStream 事件类型全览

| 事件类型 | 触发时机 | 包含数据 |
|---------|---------|---------|
| `text-delta` | 模型每生成一个 token | `textDelta: string` |
| `tool-call-streaming-start` | 工具参数开始流式生成 | `toolName: string` |
| `tool-call-delta` | 工具参数每生成一个 token | `argsTextDelta: string` |
| `tool-call` | 工具参数生成完毕，准备执行 | `toolName`, `args` |
| `tool-result` | 工具执行完毕 | `toolName`, `result` |
| `step-finish` | 一个 Agent Loop 步骤结束 | `finishReason`, `usage` |
| `finish` | 整个流结束 | `finishReason`, `usage` |
| `error` | 发生错误 | `error` |

---

## 与伪流式实现的对比

| 维度 | 伪流式（generateText） | 真流式（streamText fullStream） |
|------|----------------------|-------------------------------|
| **首字延迟** | 等全部生成完才显示 | 第一个 token 立即显示 |
| **用户体验** | 等待 → 突然全部出现 | 逐字出现，自然流畅 |
| **工具调用感知** | 只能在 onStepFinish 回调里感知 | 实时感知每个工具调用的开始和结束 |
| **工具参数流式** | 不支持 | 支持（tool-call-streaming-start / tool-call-delta） |
| **内存占用** | 全部结果在内存中 | 流式消费，内存友好 |
| **实现复杂度** | 简单 | 中等（需要处理多种事件类型） |

---

## 在 Web 服务器中使用

结合第15课的 SSE 服务器，把伪流式替换为真流式：

```typescript
// src/web-server.ts 中的路由改造
app.post('/api/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body as {
    message: string;
    sessionId?: string;
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const context = getOrCreateContext(sessionId);

  try {
    await chatWithTrueStream(
      model,
      message,
      context,
      systemPrompt,
      (event) => {
        // 真流式：text_delta 事件会在 LLM 生成每个 token 时立即触发
        // 而不是等全部生成完再模拟
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: errorMessage })}\n\n`);
  } finally {
    res.end();
  }
});
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **伪流式** | 用 `generateText` 等待完整结果，再逐字符模拟，用户体验差 |
| **真流式** | 用 `streamText` 的 `fullStream`，LLM 每生成一个 token 立即推送 |
| **fullStream** | `streamText` 返回的混合事件流，包含文字 token、工具调用、步骤完成等所有事件 |
| **tool-call-streaming-start** | 工具参数开始流式生成的事件，可用于提前显示"正在准备工具..." |
| **step-finish** | 一个 Agent Loop 步骤结束，通过 `finishReason` 判断是否还有后续步骤 |
| **experimental_continueSteps** | 允许工具调用后继续流式输出，是多步 Agent Loop 流式的关键配置 |

---

## 与其他课程的关联

- **第15课（UI 可视化）**：本课的 `chatWithTrueStream` 是第15课 `chatWithToolsStream` 的真流式升级版，SSE 推送逻辑完全复用
- **第7课（手写 Agent Loop）**：理解了手写 Agent Loop 的 while 循环后，`fullStream` 的事件序列就是这个循环的流式版本
