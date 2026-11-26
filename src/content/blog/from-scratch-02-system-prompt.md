---
title: "系统提示词（System Prompt）"
date: 2026-11-25
excerpt: "如何给 Agent 赋予角色和行为规范？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 3
---

> 目标：理解 System Prompt 的作用，给 Agent 赋予角色和行为规范

---

## 背景

上一课实现了多轮对话，但 Agent 还是一张"白纸"——没有名字、没有性格、没有专业方向。

**System Prompt** 就是解决这个问题的工具。它是在对话开始前，悄悄塞给模型的一段"角色说明书"，让 Agent 知道自己是谁、该怎么表现。

---

## System Prompt 在 messages 中的位置

LLM 的 messages 支持四种 role：

| role | 说明 |
|------|------|
| `system` | 系统指令，定义 AI 的角色和行为规范 |
| `user` | 用户的输入 |
| `assistant` | AI 的回复（也可能包含"我要调用某个工具"的请求） |
| `tool` | 工具的执行结果，由程序执行完工具后回传给模型 |

> 💡 `tool` 角色会在后面的**工具调用（Tool Use）**一课中详细讲解，这里先有个印象：
> 模型自己不能执行工具，它只能在 assistant 消息里"声明"要调用什么；
> 真正执行的是你的程序，执行完把结果包装成 `tool` 消息塞回 messages，再让模型生成最终回答。

`system` 消息**永远放在最前面**，模型每次生成回复前都会先读它：

```
发给模型的完整 messages：
[
  { role: "system",    content: "你是 Mini Coder，一个专业的编程助手..." },  ← System Prompt
  { role: "user",      content: "你好" },
  { role: "assistant", content: "你好！我是 Mini Coder，有什么代码问题？" },
  { role: "user",      content: "帮我写个冒泡排序" },
]
```

---

## 改造：给 Agent 添加 System Prompt 支持

**文件：`src/agent/agent.ts`**

### 改动一：构造函数接收 systemPrompt 参数

```typescript
export class Agent {
  private model: ReturnType<OpenAIProvider['chat']>;
  private systemPrompt: string;  // ← 新增

  constructor(
    apiKey: string,
    modelName: string = 'gpt-4',
    baseURL?: string,
    systemPrompt?: string  // ← 新增，可选参数
  ) {
    // ...
    // 如果没有传入，使用默认的通用提示词
    this.systemPrompt = systemPrompt ?? '你是一个友好、专业的 AI 助手，回答简洁清晰。';
  }
}
```

### 改动二：chat() 发送时把 system 消息拼在最前面

```typescript
async chat(message: string, context: ChatContext): Promise<string> {
  const userMessage: CoreMessage = { role: 'user', content: message };
  context.messages.push(userMessage);

  // system 消息放最前面，但不存入 context.messages
  const messagesWithSystem: CoreMessage[] = [
    { role: 'system', content: this.systemPrompt },
    ...context.messages,
  ];

  const { text } = await generateText({
    model: this.model,
    messages: messagesWithSystem,  // ← 用带 system 的版本
  });

  const assistantMessage: CoreMessage = { role: 'assistant', content: text };
  context.messages.push(assistantMessage);

  return text;
}
```

---

## 关键设计决策：为什么 system 消息不存入 context.messages？

这是一个重要的设计选择，原因有三：

**1. 避免重复累积**
如果把 system 消息存进 `context.messages`，每轮对话后它就会出现一次，最终变成：
```
[system, system, system, ..., user, assistant, user, assistant]  ← 错误！
```

**2. 职责分离**
`context.messages` 只记录"对话历史"（user/assistant 的来回），system prompt 是 Agent 的"固定设定"，两者性质不同。

**3. 灵活性**
未来可以动态修改 `systemPrompt`（比如根据用户权限切换角色），而不影响对话历史。

---

## 在 index.ts 中定义角色

```typescript
const systemPrompt = `你是一个专业的 AI 编程助手，名字叫 Mini Coder。
你的特点：
- 回答简洁、准确，优先给出可运行的代码示例
- 遇到代码问题时，先分析原因，再给出解决方案
- 使用中文回答，代码注释也用中文`;

const agent = new Agent(apiKey, modelName, baseUrl, systemPrompt);
```

---

## System Prompt 的写法技巧

好的 System Prompt 通常包含以下要素：

```
1. 角色定义   → "你是一个专业的..."
2. 能力边界   → "你只回答关于...的问题"
3. 行为规范   → "回答要简洁，不超过200字"
4. 输出格式   → "用 Markdown 格式回答，代码用代码块包裹"
5. 语气风格   → "使用友好、专业的语气"
```

---

## 运行效果对比

**没有 System Prompt：**
```
You: 你叫什么名字？
Agent: 我是 ChatGPT，由 OpenAI 开发...
```

**有 System Prompt 之后：**
```
You: 你叫什么名字？
Agent: 我是 Mini Coder，一个专业的 AI 编程助手！有什么代码问题需要帮忙？
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **System Prompt** | 定义 AI 角色和行为的系统指令，放在 messages 最前面 |
| **role: system** | 专门用于系统指令的消息类型，优先级最高 |
| **不存入历史** | system 消息是固定设定，不属于对话历史，每次动态拼接 |
| **`??` 运算符** | TypeScript 空值合并，`undefined` 时使用默认值 |

---

## 下一步

- [ ] 实现**流式输出（Streaming）**，让回复像 ChatGPT 一样逐字出现
- [ ] 给 Agent 添加**工具调用（Tool Use）**能力
