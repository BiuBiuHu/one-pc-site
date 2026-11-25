---
title: "第八课：上下文管理（Context Management）"
date: 2026-11-25
excerpt: "历史越来越长超出 Token 限制怎么办？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 9
---

> 目标：理解 Token 限制问题，实现裁剪和摘要压缩两种上下文管理策略

---

## 背景

随着对话越来越长，messages 数组会不断增长：

```
第1轮：messages = 2条   → 消耗 ~100 tokens
第10轮：messages = 20条 → 消耗 ~2000 tokens
第50轮：messages = 100条 → 💥 超出模型上下文限制！报错或截断
```

每个模型都有 **Context Window（上下文窗口）** 限制，超出就会报错。我们需要主动管理对话历史的长度。

---

## 两种策略

### 策略一：滑动窗口裁剪（Trim）

只保留最近 N 条消息，超出的旧消息直接丢弃：

```
原始历史（30条）：
[msg1, msg2, ..., msg20, msg21, ..., msg30]

裁剪后（保留最近20条）：
[msg11, msg12, ..., msg30]
⚠️ msg1~msg10 的信息完全丢失
```

- ✅ 实现简单，零额外开销
- ❌ 旧信息永久丢失
- 适用场景：短对话、闲聊、不需要记住早期信息

### 策略二：摘要压缩（Compress）

把超出窗口的旧消息用 AI 总结成一段摘要，用摘要替代原始消息：

```
原始历史（30条）：
[msg1...msg10] + [msg11...msg30]
    ↓ 超出窗口的旧消息        ↓ 最近保留的消息

调用模型总结 msg1~msg10 → "摘要：用户询问了...，AI 回答了..."

压缩后（22条）：
[user: "摘要：...", assistant: "好的，我记住了", msg11...msg30]
✅ 旧信息以摘要形式保留
```

- ✅ 旧信息以摘要形式保留
- ❌ 需要额外调用一次模型，有时间和费用开销
- 适用场景：长对话、需要记住早期信息

---

## 关键设计：为什么 maxMessages 必须是偶数？

messages 里的消息是 user/assistant 成对出现的：

```
user: "你好"        ← 第1条
assistant: "你好！"  ← 第2条（成对）
user: "新问题"      ← 第3条
assistant: "回答"   ← 第4条（成对）
```

如果裁剪成奇数条，可能出现开头是 assistant 的情况：

```
❌ 奇数裁剪结果：
[assistant: "你好！", user: "新问题", assistant: "回答"]
↑ 开头是 assistant，模型会困惑：谁先说话的？
```

所以 `maxMessages` 必须向下取偶数，保证消息始终成对。

---

## 摘要为什么用第三人称？

摘要最终被包装成 `user` 消息塞回 messages：

```json
{ "role": "user", "content": "[对话历史摘要]\n..." }
```

如果用第一人称写摘要，会产生角色混乱：

```
❌ 第一人称（有歧义）：
"我问了关于 package.json 的问题，你告诉我依赖有 ai、zod..."
↑ 这条消息是 user 发的，但"我"指谁？"你"指谁？模型会困惑

✅ 第三人称（清晰）：
"用户询问了 package.json 的内容，AI 回答了项目依赖包括 ai、zod..."
↑ 角色关系一目了然，无论谁读到都清楚
```

**摘要是"旁白"，不是"对话"**。第三人称天然适合描述"发生了什么"，避免模型产生角色混淆。

---

## 压缩质量取决于什么？

### 1. 模型质量（最关键）

```
弱模型做摘要：
原始：用户问了 package.json 的内容，AI 列出了所有依赖，
      然后讨论了 zod 的作用，解释了 JSON Schema 的生成原理...
摘要：用户问了文件，AI 回答了。  ← 信息严重丢失 ❌

强模型做摘要：
摘要：用户查看了 package.json，了解到项目依赖 ai/zod/dotenv，
      并深入理解了 zod 自动生成 JSON Schema 的机制。  ← 关键信息保留 ✅
```

### 2. Prompt 质量（我们能控制的）

```typescript
// 基础版
"请将以下对话历史总结成简洁的摘要，用第三人称描述"

// 更精确的版本
"重点保留：1.用户的具体问题 2.达成的结论 3.涉及的技术细节 4.未解决的问题"
```

### 3. 实际工程中的常见做法

| 做法 | 说明 |
|------|------|
| **用小模型做摘要** | 用 GPT-3.5/Qwen-7B 做摘要，省钱省时间 |
| **用大模型做对话** | 主对话用 GPT-4，保证质量 |
| **摘要模型和对话模型分离** | `summaryModel` 作为独立参数传入，灵活切换 |
| **结构化摘要** | 强制输出 JSON 格式，避免信息随机丢失 |

---

## 代码实现

### 文件结构

```
src/agent/
├── agent.ts            ← Agent 核心逻辑
├── context-manager.ts  ← 上下文管理（独立文件）
└── tools.ts            ← 工具定义
```

### `src/agent/context-manager.ts`

```typescript
import { generateText, type CoreMessage } from 'ai';

export interface ChatContext {
  sessionId: string;
  workspaceRoot: string;
  messages: CoreMessage[];
  maxMessages?: number;                        // 默认 20
  compressionStrategy?: 'trim' | 'compress';  // 默认 trim
}

export class ContextManager {
  // 策略一：滑动窗口裁剪
  static trimMessages(messages: CoreMessage[], maxMessages: number): CoreMessage[] {
    const limit = maxMessages % 2 === 0 ? maxMessages : maxMessages - 1;
    if (messages.length <= limit) return messages;
    return messages.slice(messages.length - limit);
  }

  // 策略二：摘要压缩
  static async compressMessages(
    messages: CoreMessage[],
    maxMessages: number,
    summaryModel: Parameters<typeof generateText>[0]['model']
  ): Promise<CoreMessage[]> {
    const limit = maxMessages % 2 === 0 ? maxMessages : maxMessages - 1;
    if (messages.length <= limit) return messages;

    const olderMessages = messages.slice(0, messages.length - limit);
    const recentMessages = messages.slice(messages.length - limit);

    // 把旧消息格式化成文本，让模型总结
    const conversationText = olderMessages
      .map((msg) => {
        const role = msg.role === 'user' ? '用户' : 'AI';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return `${role}: ${content}`;
      })
      .join('\n');

    const { text: summary } = await generateText({
      model: summaryModel,
      messages: [{
        role: 'user',
        content: `请将以下对话历史总结成简洁的摘要，保留关键信息、决策和重要细节，用第三人称描述：\n\n${conversationText}`,
      }],
    });

    // 摘要包装成 user/assistant 一对消息，放在最前面
    const summaryMessages: CoreMessage[] = [
      { role: 'user', content: `[对话历史摘要]\n${summary}` },
      { role: 'assistant', content: '好的，我已了解之前的对话内容，请继续。' },
    ];

    return [...summaryMessages, ...recentMessages];
  }

  // 统一入口：根据 compressionStrategy 自动选择策略
  static async buildMessages(
    systemPrompt: string,
    context: ChatContext,
    summaryModel?: Parameters<typeof generateText>[0]['model']
  ): Promise<CoreMessage[]> {
    const maxMessages = context.maxMessages ?? 20;
    const strategy = context.compressionStrategy ?? 'trim';

    const processedMessages =
      strategy === 'compress' && summaryModel
        ? await ContextManager.compressMessages(context.messages, maxMessages, summaryModel)
        : ContextManager.trimMessages(context.messages, maxMessages);

    return [
      { role: 'system', content: systemPrompt },
      ...processedMessages,
    ];
  }
}
```

### 在 `index.ts` 中使用

```typescript
// 使用裁剪策略（默认）
const context: ChatContext = {
  sessionId: 'session-001',
  workspaceRoot: process.cwd(),
  messages: [],
  maxMessages: 20,
  compressionStrategy: 'trim',
};

// 使用摘要压缩策略
const context: ChatContext = {
  sessionId: 'session-001',
  workspaceRoot: process.cwd(),
  messages: [],
  maxMessages: 20,
  compressionStrategy: 'compress',  // 开启压缩
};
```

---

## 两种策略对比

| | 裁剪（trim） | 压缩（compress） |
|---|---|---|
| **信息保留** | ❌ 旧信息完全丢失 | ✅ 旧信息以摘要保留 |
| **额外开销** | ✅ 无 | ❌ 需要额外调用一次模型 |
| **实现复杂度** | ✅ 简单 | ❌ 较复杂 |
| **适用场景** | 短对话、闲聊 | 长对话、需要记住早期信息 |

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Context Window** | 模型能处理的最大 Token 数，超出会报错 |
| **滑动窗口** | 只保留最近 N 条消息，简单高效 |
| **摘要压缩** | 用 AI 总结旧消息，保留关键信息 |
| **偶数限制** | maxMessages 必须是偶数，保证 user/assistant 成对 |
| **第三人称摘要** | 避免角色混乱，摘要是"旁白"不是"对话" |
| **摘要模型分离** | 可以用小模型做摘要，大模型做对话，降低成本 |

---

## 下一步

- [ ] **第9课：记忆系统** — 实现跨会话的长期记忆，让 Agent 记住不同对话间的信息
