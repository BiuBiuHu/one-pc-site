---
title: "手写 Agent Loop"
date: 2026-11-25
excerpt: "工具调用循环背后的消息格式和 while 循环是怎样的？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 8
---

> 目标：不依赖 ai SDK，用原生 fetch 手写工具调用的完整循环逻辑，彻底理解 `maxSteps` 背后发生了什么

---

## 背景

第四课用 `ai` SDK 的 `generateText({ tools, maxSteps })` 实现了工具调用：

```typescript
const result = await generateText({
  model,
  messages,
  tools: { getCurrentTime, getWeather },
  maxSteps: 10,
});
```

SDK 帮我们隐藏了所有细节。这一课我们把这个"黑盒"打开，手写完整的循环逻辑。

---

## 核心认知：LLM 不会执行工具

这是理解 Agent Loop 最重要的前提：

```
LLM 只负责"决策"：输出"我想调用 get_weather，参数是 {city: '北京'}"
Agent 层负责"执行"：真正去调接口、读文件、执行代码
```

**LLM 本身没有执行工具的能力**，它只是输出一段结构化的 JSON，告诉你它想调用什么工具、传什么参数。真正的执行权在我们手里。

这也是为什么权限控制和沙箱隔离很重要——LLM 说要调什么，我们不一定非得照做。

---

## 三种新的消息格式

工具调用引入了第五课 `Message` 类型之外的三种新格式：

### 1. assistant 消息（含 tool_calls）

LLM 决定调用工具时，返回的不是文字，而是 `tool_calls`：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"北京\"}"
      }
    }
  ]
}
```

注意：
- `content` 是 `null`（没有文字回复，只有工具调用）
- `arguments` 是 **JSON 字符串**，不是对象，需要 `JSON.parse()` 才能用
- `id` 是这次调用的唯一标识，后续 tool 消息要用它对应

### 2. tool 消息（工具执行结果）

我们执行完工具后，把结果以 `role: "tool"` 塞回 messages：

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "北京今天晴，25°C"
}
```

- `tool_call_id` 必须和上面 `tool_calls[].id` 对应，LLM 靠这个知道是哪个工具的结果
- `content` 是工具执行结果的字符串

### 3. assistant 消息（最终文字回复）

LLM 拿到工具结果后，生成最终的文字回复：

```json
{
  "role": "assistant",
  "content": "北京今天天气晴朗，气温 25°C，适合出行。",
  "finish_reason": "stop"
}
```

---

## finish_reason：判断循环是否继续

每次 LLM 响应都会带一个 `finish_reason`，这是 Agent Loop 的控制信号：

| finish_reason | 含义 | 下一步 |
|--------------|------|--------|
| `"tool_calls"` | LLM 要调用工具 | 执行工具，把结果塞回 messages，继续循环 |
| `"stop"` | LLM 生成了最终回复 | 返回结果，退出循环 |
| `"length"` | 超出 max_tokens 限制 | 强制退出 |

---

## Agent Loop 的完整流程

```
用户输入
  ↓
构建 messages（system + user）
  ↓
┌─────────────────────────────────────┐
│           while 循环                 │
│                                     │
│  callLLM(messages)                  │
│       ↓                             │
│  finish_reason === 'tool_calls'?    │
│       ↓ 是                          │
│  executeTool(name, args)            │
│       ↓                             │
│  messages.push({ role: 'tool', ... })│
│       ↓                             │
│  continue（继续循环）                │
│                                     │
│  finish_reason === 'stop'?          │
│       ↓ 是                          │
│  return 最终文字，break              │
└─────────────────────────────────────┘
```

---

## 工具定义：发给 LLM 的 schema

请求 LLM 时，需要在请求体里带上 `tools` 字段，告诉 LLM 有哪些工具可以用：

```typescript
const availableTools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的当前天气情况',  // ← LLM 靠这个决定要不要调用
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '城市名称，如：北京、上海',
          },
        },
        required: ['city'],
      },
    },
  },
];
```

`description` 非常关键——LLM 完全靠它来理解工具的用途，写得越清晰，LLM 调用越准确。

---

## tool_choice：控制工具调用行为

```typescript
tool_choice: 'auto'   // LLM 自己决定要不要调用工具（最常用）
tool_choice: 'none'   // 禁止调用工具，强制返回文字
tool_choice: { type: 'function', function: { name: 'get_weather' } }  // 强制调用指定工具
```

---

## 关于 choices 数组

LLM 响应里的 `choices` 是一个数组，因为 OpenAI API 支持 `n` 参数，可以一次生成多个候选回复：

```typescript
// 默认 n: 1，choices 里只有一个元素
const choice = llmResponse.choices[0]; // 取唯一的那个

// 如果传 n: 3，模型会独立生成 3 个不同的回复供你选择
// 但费用是 3 倍，实际场景很少用
```

---

## 和 ai SDK 的对应关系

| 我们手写 | ai SDK 封装 |
|---------|------------|
| `tools: availableTools`（JSON schema） | `tools: { get_weather: tool({...}) }` |
| `tool_choice: 'auto'` | 默认行为 |
| `while` 循环 | `maxSteps` 参数 |
| `finish_reason === 'tool_calls'` 判断 | 内部自动处理 |
| `executeTool(name, args)` | `execute` 函数 |
| `messages.push({ role: 'tool', ... })` | 自动拼接 |
| `finish_reason === 'stop'` 退出 | 内部自动处理 |

---

## 完整代码

见 `src/raw/agent-loop.ts`，运行方式：

```bash
npx tsx src/raw/agent-loop.ts
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Agent Loop** | while 循环，直到 `finish_reason === 'stop'` 才退出 |
| **tool_calls** | LLM 的工具调用请求，包含工具名和参数（JSON 字符串） |
| **role: "tool"** | 工具执行结果消息，必须带 `tool_call_id` 和 LLM 的请求对应 |
| **finish_reason** | 循环控制信号：`tool_calls` 继续，`stop` 退出 |
| **执行权在 Agent 层** | LLM 只输出"想调什么"，真正执行的是我们的代码 |
| **tool_choice** | 控制 LLM 是否调用工具：auto / none / 指定工具 |

---

## 下一步

- [ ] **第8课：上下文管理** — 对话历史越来越长，超出 Token 限制怎么办？
