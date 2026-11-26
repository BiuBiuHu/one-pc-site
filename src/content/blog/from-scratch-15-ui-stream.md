---
title: "UI 界面如何展示 AI 的执行和思考过程"
date: 2026-11-25
excerpt: "如何实时展示「思考 → 调工具 → 回复」全过程？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 16
---

> 目标：设计一套事件驱动的 Agent 执行流，让 UI 能实时展示"思考中 → 调用工具 → 生成回复"的完整过程

---

## 背景：为什么需要可视化执行过程？

当 Agent 在处理一个复杂任务时，用户看到的是：

```
You: 帮我查一下当前时间，然后列出项目文件
Agent: （沉默 5 秒...）突然出现结果
```

这种体验很差。用户不知道 Agent 在做什么，是卡住了还是在思考？

**理想的体验应该是：**

```
You: 帮我查一下当前时间，然后列出项目文件

🤔 思考中...
🔧 调用工具: get_current_time
   └─ 结果: 2024-01-15 14:30:22
🔧 调用工具: list_files
   └─ 结果: 找到 12 个文件
✍️  生成回复...

Agent: 当前时间是 2024-01-15 14:30:22。项目文件如下：...
```

---

## 核心设计：事件驱动架构

### 这个模式的本质

用一句话概括整个设计：

> **前端发请求 → 服务端调 LLM → 执行过程以事件形式持续推送 → 前端按事件类型渲染 UI**

三层职责完全分离：

| 层 | 职责 | 不关心什么 |
|----|------|-----------|
| **Agent 核心** | 执行任务，调用 `onEvent` | 谁在看、怎么展示 |
| **SSE 通道** | 把事件字节传给前端 | 事件内容是什么 |
| **UI 渲染器** | 按事件类型更新界面 | 事件从哪来 |

### Agent 执行过程是一个多阶段异步流程

```
用户输入
  → [LLM 思考] → finish_reason: tool_calls
  → [执行工具1] → 工具结果
  → [执行工具2] → 工具结果
  → [LLM 再次思考] → finish_reason: stop
  → [生成最终回复]
```

UI 需要知道每个阶段的**开始**和**结束**，才能实时更新界面。

### 解决方案：定义 AgentEvent 类型

把 Agent 执行过程中的所有关键节点，抽象成**事件（Event）**：

```typescript
// 每种事件代表 Agent 执行过程中的一个关键节点
export type AgentEvent =
  | { type: 'thinking_start' }                                                    // 开始思考（调用 LLM）
  | { type: 'tool_call_start'; toolName: string; args: Record<string, unknown> }  // 开始调用工具
  | { type: 'tool_call_result'; toolName: string; result: string }                // 工具返回结果
  | { type: 'text_delta'; content: string }                                       // 最终回复的流式 token
  | { type: 'step_complete'; stepIndex: number }                                  // 一个 Agent Loop 步骤完成
  | { type: 'done'; fullText: string }                                            // 全部完成
  | { type: 'error'; message: string };                                           // 出错
```

---

## 改造 Agent：发射事件

### 旧版 chatWithTools（回调版）

```typescript
// 旧版：两个独立回调，信息量不足
async chatWithTools(
  message: string,
  context: ChatContext,
  onChunk: (chunk: string) => void,
  onToolCall?: (toolName: string) => void  // 只知道工具名，不知道参数和结果
): Promise<void>
```

### 新版 chatWithToolsStream（事件版）

```typescript
// 新版：统一的事件回调，包含完整信息
async chatWithToolsStream(
  message: string,
  context: ChatContext,
  onEvent: (event: AgentEvent) => void  // 一个回调，覆盖所有阶段
): Promise<void>
```

### 关键：onStepFinish 钩子

`ai` SDK 的 `generateText` 提供了 `onStepFinish` 钩子，在每个 Agent Loop 步骤完成时触发：

```typescript
const result = await generateText({
  model: this.model,
  messages: messagesWithSystem,
  tools: allTools,
  maxSteps: 5,
  onStepFinish: ({ toolCalls, toolResults }) => {
    // 每次工具调用完成后，这里会被触发
    // toolCalls: 本步骤调用了哪些工具
    // toolResults: 每个工具的返回结果
    for (let i = 0; i < toolCalls.length; i++) {
      onEvent({ type: 'tool_call_start', toolName: toolCalls[i].toolName, args: toolCalls[i].args });
      onEvent({ type: 'tool_call_result', toolName: toolCalls[i].toolName, result: String(toolResults[i]?.result ?? '') });
    }
  },
});
```

---

## CLI 可视化：用 ANSI 颜色模拟 UI

在终端里，我们用 **ANSI 颜色码** 来模拟 UI 的视觉层次：

```typescript
// ANSI 颜色工具函数
const Colors = {
  gray:   (text: string) => `\x1b[90m${text}\x1b[0m`,   // 灰色：次要信息
  cyan:   (text: string) => `\x1b[36m${text}\x1b[0m`,   // 青色：工具调用
  green:  (text: string) => `\x1b[32m${text}\x1b[0m`,   // 绿色：成功/结果
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,   // 黄色：思考中
  blue:   (text: string) => `\x1b[34m${text}\x1b[0m`,   // 蓝色：用户输入
  bold:   (text: string) => `\x1b[1m${text}\x1b[0m`,    // 加粗
  dim:    (text: string) => `\x1b[2m${text}\x1b[0m`,    // 变暗
};
```

### 事件 → UI 渲染的映射

```typescript
function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'thinking_start':
      startThinkingAnimation();
      break;

    case 'tool_call_start':
      stopThinkingAnimation();
      console.log(Colors.cyan(`\n🔧 调用工具: ${event.toolName}`));
      console.log(Colors.dim(`   参数: ${JSON.stringify(event.args, null, 2)}`));
      break;

    case 'tool_call_result':
      const preview = truncate(event.result, 100);
      console.log(Colors.green(`   └─ 结果: ${preview}`));
      break;

    case 'text_delta':
      process.stdout.write(event.content);
      break;

    case 'done':
      console.log('\n');
      break;
  }
}
```

---

## 思考动画：让等待不无聊

```typescript
// 用 setInterval 实现旋转动画
let thinkingTimer: ReturnType<typeof setInterval> | null = null;
let thinkingFrame = 0;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startThinkingAnimation(): void {
  process.stdout.write(Colors.yellow('\n🤔 思考中 '));
  thinkingTimer = setInterval(() => {
    // \r 回到行首，覆盖上一帧，实现动画效果
    process.stdout.write(`\r🤔 思考中 ${SPINNER_FRAMES[thinkingFrame % SPINNER_FRAMES.length]}`);
    thinkingFrame++;
  }, 80);
}

function stopThinkingAnimation(): void {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
    process.stdout.write('\r\x1b[K'); // \r 回到行首，\x1b[K 清除当前行
  }
}
```

---

## Web 版本：一次完整请求的生命周期

以用户输入 **"现在几点了？"** 为例，追踪从点击发送到页面显示结果的每一步。

### 第一阶段：前端发起请求

```javascript
// index.html — sendMessage()

async function sendMessage() {
  // 1. 渲染用户气泡（立刻，不等服务器）
  appendUserMessage(message);

  // 2. 初始化 Agent 消息容器（空的，等待事件填充）
  initAgentMessage();

  // 3. 发起 POST 请求
  //    ⚠️ 注意：用 fetch 而不是 EventSource
  //    原因：EventSource 只支持 GET，无法携带 body
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId }),
  });

  // 4. 拿到 response 后，不等 body 全部下载完
  //    而是拿到一个 ReadableStream，边下载边处理
  const reader = response.body.getReader();
  // ...
}
```

**关键理解**：`fetch` 返回 `response` 时，HTTP 连接已建立，但 body 还没下载完。这正是 SSE 的工作方式——连接保持打开，服务器持续往里写数据。

### 第二阶段：服务端建立 SSE 连接

```typescript
// web-server.ts — app.post('/api/chat', ...)

app.post('/api/chat', async (req, res) => {
  // ── 把这个 HTTP 响应"升级"成 SSE 流 ──────────────────────────────────────
  // 正常 HTTP 响应：服务器写完数据 → 关闭连接
  // SSE 响应：服务器保持连接打开，持续写数据，直到主动 res.end()
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();  // ⚠️ 立刻把响应头发出去，不等 body
                       // 让浏览器知道"连接建立了，等着收数据"

  // ── 定义"如何把事件发给前端" ──────────────────────────────────────────────
  const sendEvent = (event: AgentEvent) => {
    // SSE 协议规定的格式：每条消息必须以 "data: " 开头，以 "\n\n" 结尾
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // 例如发出的字节流：
    // data: {"type":"thinking_start"}\n\n
  };

  // ── 启动 Agent，把 sendEvent 作为事件回调传入 ─────────────────────────────
  await agent.chatWithToolsStream(message, context, sendEvent);
  // ↑ 这行会阻塞，直到 Agent 完全执行完毕
  // 在阻塞期间，sendEvent 会被多次调用，每次调用都往 res 里写一条 SSE 数据

  res.end();  // Agent 执行完毕，关闭 SSE 连接
});
```

### 第三阶段：Agent 执行，持续发射事件

```typescript
// agent.ts — chatWithToolsStream() 内部执行过程

// 事件1：开始思考
onEvent({ type: 'thinking_start' });
// → 服务端写入：data: {"type":"thinking_start"}\n\n
// → 前端收到：显示旋转动画

// [LLM 决定调用 get_current_time 工具]

// onStepFinish 触发：
// 事件2：工具调用开始
onEvent({ type: 'tool_call_start', toolName: 'get_current_time', args: {} });
// → 前端收到：显示工具调用卡片，状态"执行中"

// 事件3：工具返回结果
onEvent({ type: 'tool_call_result', toolName: 'get_current_time', result: '{"datetime":"2024-01-15 14:30:22"}' });
// → 前端收到：工具卡片状态变为"✓ 完成"

// [LLM 生成最终回复，逐字符发射]
for (const char of result.text) {
  // 事件4：流式文字 token
  onEvent({ type: 'text_delta', content: char });
  // → 前端收到：逐字追加到回复气泡
}

// 事件5：全部完成
onEvent({ type: 'done', fullText: result.text });
// → 前端收到：移除光标，完成渲染
```

### 第四阶段：前端解析 SSE 流，更新 UI

```javascript
// index.html — while 循环读取 SSE 字节流

const decoder = new TextDecoder();
let buffer = '';  // ⚠️ 关键：SSE 数据可能被 TCP 分片，需要 buffer 拼接

while (true) {
  const { done, value } = await reader.read();
  if (done) break;  // 服务端调用了 res.end()，连接关闭

  // 把字节解码成字符串，stream:true 表示"这不是最后一块，可能还有后续"
  buffer += decoder.decode(value, { stream: true });

  // SSE 消息以 \n\n 分隔，按行切割
  const lines = buffer.split('\n');

  // ⚠️ 最后一个元素可能是不完整的行（TCP 分片导致），留在 buffer 里
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6));  // 去掉 "data: " 前缀
    handleEvent(event);  // 根据事件类型更新 UI
  }
}
```

**为什么需要 buffer？** TCP 是流协议，不保证消息边界。服务端发出 `data: {"type":"thinking_start"}\n\n`，前端可能分两次收到：
- 第一次：`data: {"type":"think`
- 第二次：`ing_start"}\n\n`

buffer 把两次拼起来，才能正确解析。

### 第五阶段：handleEvent 把事件映射到 DOM 操作

```javascript
// index.html — handleEvent()
// 这里的逻辑和 CLI 版本的 renderEvent() 完全对应
// 只是把"终端打印"换成了"DOM 操作"

function handleEvent(event) {
  switch (event.type) {
    case 'thinking_start':
      addThinkingRow();      // 显示旋转动画行
      break;

    case 'tool_call_start':
      removeThinkingRow();   // 移除思考动画
      addToolCallRow(event.toolName, event.args);  // 添加工具调用卡片
      break;

    case 'tool_call_result':
      updateToolCallResult(event.toolName, event.result);
      // 把工具行状态改为 "✓ 完成"，填入可折叠的详情区域
      break;

    case 'text_delta':
      ensureReplyBubble();
      appendTextDelta(event.content);  // 在光标前插入文字节点
      break;

    case 'done':
      removeCursor();  // 移除闪烁光标
      break;
  }
}
```

---

## 完整时序图

```
前端 (index.html)              服务端 (web-server.ts)         Agent (agent.ts)
      │                               │                              │
      │── POST /api/chat ────────────▶│                              │
      │   body: {message, sessionId}  │                              │
      │                               │── res.flushHeaders() ──────▶ │ (建立SSE连接)
      │◀── HTTP 200 (headers only) ───│                              │
      │    Content-Type: text/event-stream                           │
      │                               │── chatWithToolsStream() ────▶│
      │                               │                              │
      │◀── data: thinking_start ──────│◀── onEvent(thinking_start) ──│
      │    [显示旋转动画]              │                              │── 调用LLM
      │                               │                              │
      │◀── data: tool_call_start ─────│◀── onEvent(tool_call_start) ─│ (LLM决定调用工具)
      │    [显示工具卡片]              │                              │── 执行工具
      │                               │                              │
      │◀── data: tool_call_result ────│◀── onEvent(tool_call_result)─│ (工具执行完毕)
      │    [更新工具结果]              │                              │── LLM生成回复
      │                               │                              │
      │◀── data: text_delta × N ──────│◀── onEvent(text_delta) × N ──│ (逐字发射)
      │    [逐字追加文字]              │                              │
      │                               │                              │
      │◀── data: done ────────────────│◀── onEvent(done) ────────────│
      │    [移除光标]                  │                              │
      │                               │── res.end() ───────────────▶ │ (关闭连接)
      │◀── (连接关闭) ─────────────────│                              │
```

---

## 进阶：在 sendEvent 处做审计

`sendEvent` 是 Agent 内部和外部世界之间**唯一的出口**，所有事件都必须经过它。这让它天然成为审计、安全过滤、可观测性的最佳切面。

### 用"装饰器"包装 sendEvent

```typescript
// web-server.ts

app.post('/api/chat', async (req, res) => {
  // ── 原始的 sendEvent：只负责写 SSE ──────────────────────────────────────
  const rawSendEvent = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // ── 审计层：包装 rawSendEvent，在发出前做检查 ────────────────────────────
  const auditedSendEvent = (event: AgentEvent): void => {
    // 1. 记录日志（每个事件都留痕）
    console.log(`[AUDIT] session=${sessionId} event=${event.type}`);

    // 2. 工具白名单校验：只允许调用预期的工具
    if (event.type === 'tool_call_start') {
      const allowedTools = ['get_current_time', 'list_files', 'read_file'];
      if (!allowedTools.includes(event.toolName)) {
        rawSendEvent({ type: 'error', message: `工具 ${event.toolName} 未在白名单中` });
        throw new Error(`AUDIT BLOCK: 非法工具调用 ${event.toolName}`);
      }
    }

    // 3. 敏感内容过滤：工具结果里不能包含 API Key
    if (event.type === 'tool_call_result') {
      if (event.result.includes('sk-')) {
        const sanitized = event.result.replace(/sk-[a-zA-Z0-9]+/g, '[REDACTED]');
        rawSendEvent({ ...event, result: sanitized });
        return;
      }
    }

    // 4. 通过审计，正常发出
    rawSendEvent(event);
  };

  // Agent 拿到的是审计版本，它感知不到审计层的存在
  await agent.chatWithToolsStream(message, context, auditedSendEvent);
  res.end();
});
```

### 审计层可以做的事

| 审计点 | 检查内容 | 处理方式 |
|--------|----------|----------|
| `tool_call_start` | 工具是否在白名单 | 拦截 + 抛错 |
| `tool_call_start` | 参数是否合法（路径不能越界） | 拦截 + 抛错 |
| `tool_call_result` | 结果是否含敏感信息 | 脱敏后放行 |
| `text_delta` | 回复是否含违禁词 | 替换或拦截 |
| 所有事件 | 记录完整执行链路 | 写入审计日志 |
| 所有事件 | 统计每步耗时 | 性能监控 |

### 多层装饰器

```typescript
// 每一层只做一件事，可以任意组合
onEvent = rawSendEvent                        // 最简版：直接发
onEvent = audit(rawSendEvent)                 // 加审计
onEvent = rateLimit(audit(rawSendEvent))      // 加限流 + 审计
onEvent = log(rateLimit(audit(rawSendEvent))) // 加日志 + 限流 + 审计
```

这和 Express 的 `app.use(middleware)` 是同一个设计模式——**函数式中间件**。

---

## 运行方式

```bash
# CLI 版本
npx tsx src/ui-stream-demo.ts

# Web 版本（打开 http://localhost:3000）
npx tsx src/web-server.ts
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **AgentEvent** | 把 Agent 执行过程抽象成类型化事件，是解耦的关键 |
| **onStepFinish** | `ai` SDK 提供的钩子，在每个 Agent Loop 步骤完成时触发 |
| **SSE（Server-Sent Events）** | 服务端向客户端单向推送事件的 HTTP 协议，天然适合流式场景 |
| **res.flushHeaders()** | 立刻发出响应头，让浏览器知道连接已建立，开始等待数据 |
| **TCP 分片 + buffer** | SSE 数据可能被 TCP 切割，需要 buffer 拼接完整行再解析 |
| **fetch + ReadableStream** | 用 fetch 替代 EventSource，支持 POST 请求携带 body |
| **ANSI 颜色码** | 终端的"CSS"，用于在 CLI 中实现视觉层次 |
| **setInterval 动画** | 用定时器模拟旋转动画，给用户等待反馈 |
| **展示层解耦** | 同一套事件接口，驱动 CLI/Web/移动端，核心逻辑零修改 |
| **sendEvent 审计层** | onEvent 是唯一出口，天然适合做安全过滤、日志、性能监控 |

---

## 下一步

- [ ] 添加 `thinking_delta` 事件：展示模型的推理过程（适用于 o1/o3 等推理模型）
- [ ] 多用户并发：把内存 Map 换成 Redis，支持水平扩展
- [ ] 断线重连：SSE 连接断了，前端如何续上未完成的流
- [ ] 真正的流式 LLM：把 `text_delta` 从逐字符模拟改为真实 token 流
