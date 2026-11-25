---
title: "第二十二课：streamText 源码解析"
date: 2026-11-25
excerpt: "AsyncIterator 背压是怎么实现的？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 23
---

> 目标：理解 streamText 的 AsyncIterator 实现原理，掌握背压（Backpressure）机制

---

## 背景：streamText 和 generateText 的本质区别

```typescript
// generateText：等全部生成完，一次性返回
const { text } = await generateText({ model, messages });
// text 是完整字符串，等待时间 = 模型生成全部 token 的时间

// streamText：边生成边返回
const { textStream } = streamText({ model, messages });
for await (const chunk of textStream) {
  process.stdout.write(chunk); // 每来一个 token 立刻打印
}
// 第一个 chunk 的等待时间 ≈ 模型生成第一个 token 的时间（通常 < 1 秒）
```

---

## 核心概念：AsyncIterator 协议

`textStream` 是一个**异步迭代器（AsyncIterator）**，`for await...of` 是消费它的语法糖。

```typescript
// for await...of 的等价写法
const iterator = textStream[Symbol.asyncIterator]();
while (true) {
  const { value, done } = await iterator.next();
  if (done) break;
  process.stdout.write(value); // value 就是一个 token
}
```

AsyncIterator 的核心是 `next()` 方法：
- 调用 `next()` → 等待下一个 token 到来 → 返回 `{ value: token, done: false }`
- 流结束时 → 返回 `{ value: undefined, done: true }`

---

## streamText 内部实现

`streamText` 的核心（位于 `packages/ai/core/generate-text/stream-text.ts`）：

```typescript
// 大幅简化，保留核心逻辑
export function streamText({
  model,
  messages,
  tools,
  maxSteps = 1,
  onStepFinish,
}: StreamTextParams): StreamTextResult {

  // streamText 是同步函数，立刻返回结果对象
  // 真正的流式执行在 ReadableStream 内部异步进行
  const { readable, writable } = new TransformStream<string, string>();
  const writer = writable.getWriter();

  // 在后台异步执行 Agent Loop
  (async () => {
    try {
      let currentMessages = [...messages];

      for (let step = 0; step < maxSteps; step++) {
        // 调用模型的流式接口
        const { stream } = await model.doStream({
          inputFormat: 'messages',
          mode: tools
            ? { type: 'regular', tools: convertToolsToModelFormat(tools) }
            : { type: 'regular' },
          prompt: convertMessagesToModelFormat(currentMessages),
        });

        const toolCalls: ToolCall[] = [];
        let fullText = '';

        // 消费模型返回的流
        for await (const part of stream) {
          if (part.type === 'text-delta') {
            // 每来一个 token，立刻写入 TransformStream
            // 这会唤醒正在 await iterator.next() 的消费者
            await writer.write(part.textDelta);
            fullText += part.textDelta;
          } else if (part.type === 'tool-call') {
            toolCalls.push(part);
          }
        }

        // 执行工具（工具执行期间，流暂停）
        const toolResults: ToolResult[] = [];
        for (const toolCall of toolCalls) {
          const tool = tools?.[toolCall.toolName];
          if (tool?.execute) {
            const result = await tool.execute(toolCall.args, {});
            toolResults.push({ toolCallId: toolCall.toolCallId, result });
          }
        }

        await onStepFinish?.({ text: fullText, toolCalls, toolResults });

        if (toolCalls.length === 0) break;

        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: toolCalls },
          ...toolResults.map(r => ({
            role: 'tool' as const,
            content: [{ type: 'tool-result', toolCallId: r.toolCallId, result: r.result }],
          })),
        ];
      }
    } finally {
      // 流结束，关闭 writer，消费者的 for await 循环会自动退出
      await writer.close();
    }
  })();

  // 把 ReadableStream 包装成 AsyncIterator 返回给调用方
  return {
    textStream: readable,
    // 其他属性...
  };
}
```

---

## 背压（Backpressure）：生产者和消费者的速度协调

**背压**是流式系统中的核心问题：如果生产者（LLM）比消费者（你的代码）快，数据会堆积在内存里。

### 没有背压的问题

```
LLM 每 10ms 生成一个 token
你的代码每 100ms 处理一个 token

→ 10 秒后，内存里堆积了 900 个未处理的 token
→ 内存溢出
```

### TransformStream 的背压机制

`TransformStream` 内置了背压支持：

```typescript
// writer.write() 返回一个 Promise
// 如果消费者还没读完，这个 Promise 会等待（阻塞生产者）
await writer.write(part.textDelta);
//    ↑ 如果消费者慢，这里会等待，自动限速生产者
```

```
LLM 生成 token → writer.write() → [TransformStream 缓冲区] → reader.read()
                      ↑                                           ↓
                  如果缓冲区满，                            消费者读取后
                  write() 等待                             缓冲区空出来
```

### 实际效果

```typescript
// 消费者很慢（每个 token 处理 100ms）
for await (const chunk of textStream) {
  await sleep(100); // 模拟慢速处理
  process.stdout.write(chunk);
}
// TransformStream 会自动限速 LLM 的输出速度
// 不会因为消费者慢而导致内存溢出
```

---

## OpenAI 流式响应的解析

`model.doStream()` 内部（位于 `packages/openai/src/openai-chat-language-model.ts`）：

```typescript
async doStream(options: LanguageModelV1CallOptions) {
  // 1. 发起流式 HTTP 请求
  const response = await fetch(`${this.config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
    body: JSON.stringify({
      ...openAIRequest,
      stream: true, // 关键：开启流式模式
    }),
  });

  // 2. 把 HTTP 响应的 body（ReadableStream）转成 SDK 的流格式
  const stream = response.body!
    .pipeThrough(new TextDecoderStream())           // 字节 → 字符串
    .pipeThrough(new EventSourceParserStream())     // 字符串 → SSE 事件
    .pipeThrough(new TransformStream({
      transform(event, controller) {
        if (event.data === '[DONE]') {
          controller.terminate();
          return;
        }
        const json = JSON.parse(event.data);
        const delta = json.choices[0]?.delta;

        if (delta?.content) {
          // 文字 token
          controller.enqueue({ type: 'text-delta', textDelta: delta.content });
        } else if (delta?.tool_calls) {
          // 工具调用
          controller.enqueue({ type: 'tool-call', ...parseToolCall(delta.tool_calls) });
        }
      },
    }));

  return { stream, rawCall: { rawPrompt: openAIRequest, rawSettings: {} } };
}
```

这就是第6课手写的流式解析逻辑！SDK 把它封装成了 `TransformStream` 管道。

---

## 流处理管道全景

```
OpenAI API
    │ HTTP 响应 body（字节流）
    ▼
TextDecoderStream          字节 → UTF-8 字符串
    │
    ▼
EventSourceParserStream    字符串 → SSE 事件对象 { data: "..." }
    │
    ▼
OpenAI Delta Parser        SSE 事件 → SDK 通用格式 { type: 'text-delta', textDelta: '...' }
    │
    ▼
streamText 内部消费        把 text-delta 写入 TransformStream
    │
    ▼
textStream（用户侧）       for await (const chunk of textStream)
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **AsyncIterator** | 异步迭代器协议，`for await...of` 的底层机制 |
| **TransformStream** | Web Streams API 提供的流转换工具，内置背压支持 |
| **背压（Backpressure）** | 生产者和消费者速度不匹配时的自动限速机制 |
| **pipeThrough** | 把多个 TransformStream 串联成管道，每个只做一件事 |
| **EventSourceParserStream** | 把 SSE 字节流解析成事件对象的 TransformStream |
| **writer.write() 等待** | 背压的实现方式：消费者慢时，write() 的 Promise 会等待 |

---

## 下一步

- [ ] 学习消息队列，解决 Agent 长任务的异步处理问题
