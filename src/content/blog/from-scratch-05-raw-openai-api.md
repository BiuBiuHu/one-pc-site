---
title: "手写 OpenAI API 调用"
date: 2026-11-25
excerpt: "SDK 的 generateText 底层到底发了什么请求？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 6
---

> 目标：不依赖 ai SDK，用原生 fetch 直接调用 OpenAI API，彻底理解 generateText 的底层实现

---

## 背景

前四课我们一直用 `ai` SDK 的 `generateText`，它帮我们封装了很多细节。这节课我们把它拆开，用原生 `fetch` 重新实现一遍，搞清楚底层到底发生了什么。

```
ai SDK 的 generateText()
         ↓ 拆开看
原生 fetch → POST /v1/chat/completions → 解析响应 JSON → 返回文字
```

---

## OpenAI API 的本质：一个 HTTP 请求

调用 OpenAI API 就是发一个普通的 HTTP POST 请求：

```typescript
const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,  // ← API Key 认证
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [...],   // ← 对话历史
    temperature: 0.7,  // ← 控制随机性
  }),
});
```

就这些，没有任何魔法。

---

## Authorization: Bearer 是什么？

`Authorization` 头是 HTTP 协议规定的认证字段，格式是：

```
Authorization: <认证类型> <凭证>
```

`Bearer` 是**认证类型**，来自英文"持有者"，意思是：

> "我是这个 Token 的持有者，它就是我的身份证明"

| 认证类型 | 格式 | 场景 |
|---------|------|------|
| `Bearer` | `Bearer sk-xxx` | OAuth 2.0、API Key（最常见） |
| `Basic` | `Basic dXNlcjpwYXNz` | 用户名+密码（Base64 编码） |

OpenAI 使用 `Bearer` 类型，遵循 OAuth 2.0 标准，是业界最通用的 API 认证规范。**`Bearer` 不是 OpenAI 发明的，而是 HTTP 协议的行业标准。**

---

## 请求体（Request Body）结构

```json
{
  "model": "qwen3.5-plus",
  "temperature": 0.7,
  "messages": [
    {
      "role": "system",
      "content": "你是一个简洁的 AI 助手，回答不超过两句话。"
    },
    {
      "role": "user",
      "content": "你好，你叫什么名字？"
    }
  ]
}
```

### 四个 role 的含义

把整个对话想象成一个**剧本**，每条消息都是某个角色说的台词：

| role | 是谁 | 说明 |
|------|------|------|
| `system` | 导演 | 在幕后设定规则，AI 必须遵守，用户看不到 |
| `user` | 你 | 向 AI 提问的人 |
| `assistant` | AI | 根据导演规则和用户问题来回应 |

**关键**：模型每次都把整个剧本从头读一遍，不是"记忆"了上一轮，而是靠完整的 messages 历史理解上下文。

---

## temperature：控制输出的随机性

请求体里的 `temperature` 是**采样温度**，控制模型生成文字时的随机程度，取值范围通常是 `0 ~ 2`。

### 原理：它作用于概率分布

模型生成每个 token 时，会给词表里所有候选 token 打一个概率分。temperature 会在采样前缩放这些概率（logits 除以 temperature）：

- **temperature 低**（如 0.2）→ 概率分布被"拉尖"，高概率词的优势被放大 → 输出更**确定、保守、可复现**
- **temperature 高**（如 1.5）→ 概率分布被"拉平"，低概率词也有机会被选中 → 输出更**随机、多样、有创意**
- **temperature = 0** → 退化为贪心解码，每次都选概率最高的 token，输出基本确定

### 不同场景的推荐值

| 场景 | 推荐值 | 原因 |
|------|--------|------|
| 结构化输出 / JSON 提取 | `0 ~ 0.2` | 要的是准确，不要发挥 |
| 代码生成、工具调用 | `0 ~ 0.3` | 语法必须严谨 |
| 通用对话、问答 | `0.7`（默认） | 平衡准确性与自然度 |
| 文案、头脑风暴、创意写作 | `1.0+` | 鼓励多样性 |

### 与 JSON 输出的关系

让模型强制返回 JSON 时（见上文 response_format），建议把 temperature 调低。虽然 `json_schema` + `strict` 模式在解码层面已经保证了结构合法，但**字段里填的内容**（比如提取出的人名、分类结果）仍然受 temperature 影响——低温度下提取结果更稳定准确。

### 相关参数：top_p

`top_p`（核采样）和 temperature 作用类似，都是控制随机性：只从累积概率达到 p 的候选 token 里采样。**两者一般只调一个**，另一个保持默认，同时调整容易行为叠加难以归因。

---

## 响应体（Response Body）结构

```json
{
  "id": "chatcmpl-xxx",
  "model": "qwen3.5-plus",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "你好，我是一个人工智能助手。有什么可以帮你的吗？",
        "reasoning_content": "Thinking Process:\n1. Analyze..."
      }
    }
  ],
  "usage": {
    "prompt_tokens": 33,
    "completion_tokens": 1041,
    "total_tokens": 1074
  }
}
```

关键字段：
- **`choices[0].message.content`** — AI 的最终回复，我们取这个
- **`choices[0].message.reasoning_content`** — 推理模型的内部思考过程（普通模型没有这个字段）
- **`usage`** — Token 消耗统计

---

## 多轮对话的本质

**`assistant` 的内容是我们自己存进去的，不是自动的！**

```typescript
// 第一轮：调用 API
const reply1 = await chatCompletion(messages, model);

// 手动把 AI 的回复存进 messages（这是关键！）
messages.push({ role: 'assistant', content: reply1 });

// 第二轮：带着完整历史再次调用
messages.push({ role: 'user', content: '你刚才说你叫什么？' });
const reply2 = await chatCompletion(messages, model);
```

API 只负责返回这一次的回复，**不会帮你维护历史**。下一轮要带上 AI 的回复，必须我们自己 push 进 messages。这正是 `ai` SDK 帮我们封装的事情之一。

---

## 两轮对话的 Token 增长规律

从实际运行结果可以看到：

```
第一轮请求：messages = 2 条（system + user）
  prompt_tokens = 33

第二轮请求：messages = 4 条（system + user + assistant + user）
  prompt_tokens = 60

差值 = 27 ← 正好是上一轮 user + assistant 消息的 token 数
```

**每多一轮对话，输入 token 就增加一轮的消息量**，这就是为什么需要上下文管理（第8课）！

---

## 推理模型的特殊字段：reasoning_content

`qwen3.5-plus` 是推理模型，响应里有一个特殊字段 `reasoning_content`，记录了模型的完整思考过程：

```
Thinking Process:
1. Analyze the Request: 用户问名字，要求不超过两句话
2. Drafting the Response:
   Draft 1: 你好，我是一个人工智能助手...
   Draft 2: 你好！我是你的智能助手...
3. Final Check: 是否超过两句话？✓
4. Final decision: 你好，我是一个人工智能助手。有什么可以帮你的吗？
```

这就是推理模型和普通模型的本质区别——**它会先"想清楚"再回答**，类似 OpenAI 的 o1 系列。

Token 消耗对比：
```
prompt_tokens:     33   ← 输入
reasoning_tokens:  1024 ← 内部思考消耗（不展示给用户）
text_tokens:       17   ← 实际输出文字
total_tokens:      1074
```

---

## baseUrl 的注意事项

`.env` 里的 `OPENAI_BASE_URL` 可能已经包含了 `/v1`，代码里拼接时要避免重复：

```typescript
// ❌ 错误：URL 变成 /v1/v1/chat/completions
const url = `${process.env.OPENAI_BASE_URL}/v1/chat/completions`;

// ✅ 正确：先去掉末尾的 /v1，再拼接
const baseUrl = rawBaseUrl.replace(/\/v1\/?$/, '');
const url = `${baseUrl}/v1/chat/completions`;
```

---

## 让原生接口强制返回 JSON：response_format

默认情况下 `message.content` 是自由文字。如果想让模型返回 JSON，原生 API 提供了 `response_format` 请求参数，有三个层次：

### 层次一：不传 response_format（纯提示词约束）

只在 system prompt 里要求"请输出 JSON"，模型**可能**输出 JSON，但也可能夹带 Markdown 代码块或多余文字，拿到后还得自己 `JSON.parse` + 容错，**不可靠**。

### 层次二：`type: 'json_object'`（JSON Mode）

```typescript
const requestBody = {
  model,
  messages: [
    { role: 'system', content: '从用户输入中提取用户信息，以 JSON 返回' },
    { role: 'user', content: '张三，28岁，前端工程师' },
  ],
  response_format: { type: 'json_object' },  // ← 关键参数
};
```

效果：**保证输出是语法合法的 JSON**（一定能 `JSON.parse` 成功），但**不保证字段结构**——字段叫什么、有几个，全靠 prompt 自觉。

> 注意：使用 JSON Mode 时，messages 里必须出现 "JSON" 相关的提示词，否则部分 API 会报错。

### 层次三：`type: 'json_schema'` + `strict: true`（Structured Outputs，推荐）

```typescript
const requestBody = {
  model,
  messages,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'user_info',
      strict: true,   // ← strict 模式才是真正的"强制"
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '用户姓名' },
          age: { type: 'number' },
          role: { type: 'string', enum: ['frontend', 'backend'] },
        },
        required: ['name', 'age', 'role'],
        additionalProperties: false,
      },
    },
  },
};
```

效果：模型在 **token 采样阶段就被 JSON Schema 约束**（constrained decoding，约束解码），输出**100% 符合给定的结构**——字段名、类型、枚举值都不会跑偏。

### 三种方式对比

| 方式 | 语法合法 | 结构保证 | 原理 |
|------|---------|---------|------|
| 纯提示词 | ❌ 不保证 | ❌ 不保证 | 靠模型自觉 |
| `json_object` | ✅ 保证 | ❌ 不保证 | 解码时屏蔽非法 token |
| `json_schema` + `strict` | ✅ 保证 | ✅ 保证 | 按 Schema 约束解码 |

### 兼容性说明

- **不是所有模型/网关都支持** `json_schema`：OpenAI gpt-4o 系列、通义千问较新版本支持；老的模型可能只支持 `json_object`，甚至完全不支持
- 不支持时 API 会返回 400 错误，需要降级为 JSON Mode 或提示词方式
- `ai` SDK 的 `generateObject`（见第17课）底层就是帮你做了这件事：把 Zod Schema 转成 JSON Schema，自动选择模型支持的模式

---

## 完整代码

见 `src/raw/openai-client.ts`，运行方式：

```bash
npx tsx src/raw/openai-client.ts
```

运行后会打印：
1. 完整的请求体 JSON
2. 完整的响应体 JSON（含 reasoning_content）
3. Token 消耗统计
4. 最终对话历史

---

## 示例数据

完整的两轮对话请求/响应数据见 `src/raw/sample-conversation.json`，包含真实的 `reasoning_content`，可用于分析模型的思考过程。

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **HTTP POST** | OpenAI API 就是一个普通的 HTTP 请求，没有魔法 |
| **Bearer 认证** | HTTP 协议标准，`Authorization: Bearer <token>` |
| **四个 role** | system（导演）、user（你）、assistant（AI 回复） |
| **assistant 要手动存** | API 不维护历史，需要我们自己 push assistant 消息 |
| **token 随轮次增长** | 每轮多 2 条消息，输入 token 线性增长 |
| **reasoning_content** | 推理模型的内部思考过程，消耗大量 token 但不展示给用户 |
| **response_format** | 原生接口强制 JSON 输出的参数：`json_object` 保证语法合法，`json_schema` + `strict` 保证结构 |

---

## 下一步

- [ ] **第6课：手写流式输出** — 不用 SDK，用原生 fetch + ReadableStream 实现逐字输出
