---
title: "流式输出（Streaming）"
date: 2026-11-25
excerpt: "如何让回复像 ChatGPT 一样逐字出现？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 4
---

> 目标：理解流式输出的原理，让 Agent 的回复像 ChatGPT 一样逐字出现

---

## 背景

上一课的 Agent 回复体验是这样的：

```
You: 帮我写一个快速排序算法
Agent: （沉默等待 5 秒...）突然出现一大段文字
```

这是因为普通请求（默认不开启 `stream`）会等模型**把所有 token 全部生成完**，才一次性返回完整的 JSON 响应。

**流式输出（Streaming）** 让体验变成这样：

```
You: 帮我写一个快速排序算法
Agent: 好的，快速排序的核心思路是...  ← 逐字出现，像打字机一样
```

---

## 原理：Token 是怎么生成的？

大语言模型生成文字的方式是**一个 token 一个 token 地产生**（token 大约等于半个到一个中文字，或者 3/4 个英文单词）。

```
非流式请求（默认）：
模型生成: "好" → "的" → "，" → "快" → ... → "。"
                                              ↓ 全部完成后
                                         一次性返回给你

流式请求（stream: true）：
模型生成: "好" → 立刻推送 → "的" → 立刻推送 → "，" → 立刻推送 → ...
           ↓                  ↓                  ↓
        你收到              你收到              你收到
```

---

## 改造：添加 chatStream 方法

**文件：`src/agent/agent.ts`**

### 第一步：请求体加上 `stream: true`

流式和非流式请求打的是**同一个接口**（`/v1/chat/completions`），唯一区别是请求体里多一个字段：

```typescript
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: modelName,
    messages: messagesWithSystem,
    stream: true,  // ← 开启流式输出！就这一个字段的区别
  }),
});
```

### 第二步：看懂 SSE 数据格式

加了 `stream: true` 后，响应不再是一个完整 JSON，而是一条 **SSE（Server-Sent Events）** 文本流——一串以换行分隔的数据帧：

```
data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"的"},"finish_reason":null}]}

data: [DONE]
```

规律：

- 每行数据以 `data: ` 开头，后面跟着一个 JSON
- 帧与帧之间用空行分隔
- JSON 里不再是 `message`，而是 **`delta`**（本帧的"增量"），其中 `delta.content` 就是新生成的 token
- 收到 `data: [DONE]` 表示流结束

> 💡 注意最后一行 `[DONE]`：它长得像消息内容，但**不是模型生成的文字**，而是 OpenAI 在 SSE 协议层约定的"流结束哨兵"。`data:` 后面跟的不再是 JSON，而是字面量 `[DONE]`。
> 为什么需要它？SSE 连接本身不会告诉你"内容发完了没"，靠连接关闭来判断既不可靠也有延迟。`[DONE]` 让客户端能明确、即时地知道生成完毕，立刻收尾（存历史、统计 token）。
> 另外 JSON 帧内部还有个 `finish_reason: "stop"` 字段表示"模型生成完了"，通常先收到它、紧接着收到 `[DONE]`。我们的代码只依赖 `[DONE]` 来结束循环，简单可靠。

### 第三步：用 ReadableStream 读取并解析数据帧

`response.body` 是一个 `ReadableStream<Uint8Array>`（二进制流），需要逐块读取、解码成文字、按行切出数据帧：

```typescript
// 流式输出版本：每生成一个 token 就通过 onChunk 回调推送出去
async chatStream(
  message: string,
  context: ChatContext,
  onChunk: (chunk: string) => void  // ← 回调函数，每来一个 token 就调用一次
): Promise<void> {
  const userMessage: Message = { role: 'user', content: message };
  context.messages.push(userMessage);

  const messagesWithSystem: Message[] = [
    { role: 'system', content: this.systemPrompt },
    ...context.messages,
  ];

  // 关键：stream: true
  const response = await fetch(`${this.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    },
    body: JSON.stringify({
      model: this.modelName,
      messages: messagesWithSystem,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    // 还没开始流就失败（如 API Key 错误）：回滚 user message，调用方可直接重试
    context.messages.pop();
    throw new Error(`请求失败: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();      // 逐块读取二进制流
  const decoder = new TextDecoder('utf-8');      // 二进制 → 文字
  let fullText = '';
  let buffer = '';  // 缓存不完整的数据行（一块数据可能在一行中间被切断）

  try {
    while (true) {
      const { done, value } = await reader.read();  // 每次读一块数据
      if (done) break;

      // stream: true 表示后面可能还有数据，保留未完成的多字节字符
      buffer += decoder.decode(value, { stream: true });

      // SSE 以换行分隔，按行处理
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // 最后一行可能不完整，留到下一块再拼

      for (const line of lines) {
        const trimmed = line.trim();
        // 跳过空行（SSE 用空行分隔事件）和非 data 行
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);   // 去掉 "data: " 前缀
        // [DONE] 是流结束哨兵，不是 JSON！必须先拦截，
        // 否则下面 JSON.parse('[DONE]') 会直接抛异常
        if (data === '[DONE]') break;

        const frame = JSON.parse(data);
        const token = frame.choices?.[0]?.delta?.content;
        if (token) {
          onChunk(token);      // 立刻推送给调用方
          fullText += token;   // 同时拼接完整文本
        }
      }
    }
  } catch (error) {
    // 流中断：已生成的部分文本也是模型的真实输出，
    // 存入历史，避免下一轮上下文断裂（有问无答）
    if (fullText.length > 0) {
      context.messages.push({
        role: 'assistant',
        content: fullText + '\n\n[回复中断，内容不完整]',
      });
    } else {
      // 一个 token 都没收到就失败：回滚 user message，
      // 让调用方可以直接重试，不会留下孤儿记录
      context.messages.pop();
    }
    throw error;  // 继续向上抛，让 UI 层决定如何提示用户
  }

  // 流结束后，把完整回复存入历史，供下一轮使用
  const assistantMessage: Message = { role: 'assistant', content: fullText };
  context.messages.push(assistantMessage);
}
```

> 💡 这就是 `ai` SDK 里 `streamText` 底层做的事：发 `stream: true` 请求、解析 SSE、把 `delta.content` 逐个吐给你。手写一遍之后，再用 SDK 就知道它帮你省了哪些活。

---

## 两个关键设计决策

### 1. 用回调（onChunk）而不是直接打印

```typescript
// ❌ 不好的设计：Agent 直接打印，和 UI 层耦合
for await (const chunk of textStream) {
  process.stdout.write(chunk);  // 写死了只能用于 CLI
}

// ✅ 好的设计：通过回调把 token 推给调用方
for await (const chunk of textStream) {
  onChunk(chunk);  // 调用方决定怎么展示
}
```

这样 `chatStream` 可以复用在任何场景：
- CLI → `onChunk = (chunk) => process.stdout.write(chunk)`
- Web → `onChunk = (chunk) => response.write(chunk)`
- 测试 → `onChunk = (chunk) => buffer += chunk`

### 2. 流结束后才存入对话历史

```typescript
// ❌ 错误：把碎片 token 存进历史
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const token = parseDelta(value);
  context.messages.push({ role: 'assistant', content: token }); // 每个 token 都存一条！
}

// ✅ 正确：边读边拼完整文本，流结束后存一次
let fullText = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  fullText += parseDelta(value);
}
context.messages.push({ role: 'assistant', content: fullText }); // 存完整回复
```

### 3. 部分结果要不要存历史？—— 要

已经流出来的内容是模型真实生成的，丢掉它会让对话历史出现"用户问了、但没有回答"的断层，下一轮请求发给模型时上下文是断裂的。存下来并标注 `[回复中断]`，模型下一轮能理解发生了什么。

### 4. 一个 token 都没收到就失败？—— 回滚 user message

连接阶段就失败（如 API Key 错误），说明这轮对话从未真正开始。把 user message 弹出历史，调用方重试时不会重复 push 同一条消息。

### 5. 要不要自动重试？—— 区分错误类型

```typescript
function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // 网络错误、限流(429)、服务端错误(5xx) 值得重试
  // 认证失败(401)、参数错误(400) 重试没有意义
  return /network|fetch failed|429|5\d\d/i.test(message);
}
```

简单场景下把重试交给用户（提示"请求失败，请重试"）即可；生产环境可在 `isRetryableError` 为 true 时自动重试 1-2 次，注意**指数退避**（1s → 2s → 4s），避免对限流的 API 雪上加霜。

---

## SSE 失败了怎么办？

流式请求返回的是一条 **SSE（Server-Sent Events）** 长连接。连接随时可能断，错误可能发生在两个不同时机，处理方式完全不同：

| 阶段 | 时机 | 典型原因 | 处理策略 |
|------|------|----------|----------|
| **连接阶段** | 还没收到任何 token | API Key 错误、网络不通、限流（429） | 直接抛错/重试，对话历史无污染 |
| **流中断** | 已输出部分 token 后断开 | 网络抖动、服务端超时、模型截断 | 保存部分结果，决定是否重试 |

### 不处理会发生什么？

```typescript
while (true) {
  const { done, value } = await reader.read();  // ← 中途断流时，异常从这里抛出
  if (done) break;
  const token = parseDelta(value);
  onChunk(token);
  fullText += token;
}
// ❌ 抛错后这行不会执行：已生成的部分文本全部丢失
// ❌ 但 user message 已经 push 进 context，历史里留下"有问无答"的孤儿记录
context.messages.push(assistantMessage);
```

### 正确写法：try/catch + 保留部分结果

核心就是把读流的循环包进 try/catch（完整实现见上文 `chatStream`）：

```typescript
let fullText = '';
try {
  while (true) {
    const { done, value } = await reader.read();  // ← 中途断流时异常从这里抛出
    if (done) break;
    // ...解析 SSE 数据帧，取出 delta.content
    onChunk(token);
    fullText += token;
  }
} catch (error) {
  if (fullText.length > 0) {
    // 流中断：已生成的部分是模型真实输出，存下来避免"有问无答"的上下文断裂
    context.messages.push({
      role: 'assistant',
      content: fullText + '\n\n[回复中断，内容不完整]',
    });
  } else {
    // 一个 token 都没收到就失败：回滚 user message，调用方可直接重试
    context.messages.pop();
  }
  throw error;  // 继续向上抛，让 UI 层决定如何提示用户
}

context.messages.push({ role: 'assistant', content: fullText });
```

---

## 在 index.ts 中使用流式输出

```typescript
try {
  process.stdout.write('Agent: ');

  // 流式输出：每来一个 token 就立刻打印，不换行
  await agent.chatStream(trimmedInput, context, (chunk) => {
    process.stdout.write(chunk);  // ← 不换行，token 连续追加
  });

  // 流结束后换两行，保持格式整洁
  console.log('\n');
} catch (error) {
  console.error('❌ 请求失败:', error instanceof Error ? error.message : error);
}
```

### process.stdout.write vs console.log

| | `process.stdout.write` | `console.log` |
|---|---|---|
| 换行 | ❌ 不自动换行 | ✅ 自动追加 `\n` |
| 适用场景 | 流式逐字追加 | 完整一行输出 |

流式输出必须用 `process.stdout.write`，否则每个 token 都会换行，变成：
```
好
的
，
快
速
...
```

---

## 运行效果

```
🤖 Mini AI Agent 已启动！

You: 帮我写个冒泡排序
Agent: 好的，冒泡排序的实现如下：

```typescript
function bubbleSort(arr: number[]): number[] {
  // 外层循环控制轮数
  for (let i = 0; i < arr.length - 1; i++) {
    ...
```
← 以上内容逐字出现，不是一次性弹出
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Token** | 模型生成文字的最小单位，约等于半个中文字或 3/4 个英文单词 |
| **stream: true** | 流式与非流式请求的唯一区别：请求体里的一个字段 |
| **SSE** | Server-Sent Events，响应变成以换行分隔的 `data: {...}` 数据帧，以 `[DONE]` 结束 |
| **delta** | 流式响应每帧的"增量"，`delta.content` 就是新生成的 token |
| **ReadableStream** | `response.body.getReader()` 逐块读取二进制流，配合 `TextDecoder` 解码成文字 |
| **buffer 缓冲** | 网络分块可能把一行数据切断，用 buffer 缓存不完整的行等下一块拼接 |
| **onChunk 回调** | 解耦展示逻辑，让 Agent 可复用于 CLI、Web 等不同场景 |
| **process.stdout.write** | 不换行地向终端写入内容，流式打印的关键 |

---

## 下一步

- [ ] 实现**工具调用（Tool Use）**，让 Agent 能执行真实操作（读文件、搜索等）