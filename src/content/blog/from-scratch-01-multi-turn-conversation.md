---
title: "从单次对话到多轮对话"
date: 2026-11-25
excerpt: "为什么 LLM 每次都要带上完整对话历史？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 2
---

> 目标：理解多轮对话的核心原理，并用 Node.js 实现一个 CLI 交互式 Agent

---

## 背景

最初的 Agent 只能进行**一次性对话**：程序启动 → 发送一条消息 → 打印回复 → 退出。

```typescript
// 原始代码：单次对话，用完就退出
const response = await agent.chat('你好，你是谁?', {
  sessionId: 'session-001',
  workspaceRoot: process.cwd(),
  messages: []
});
console.log('Agent response:', response);
```

这显然不够用。我们希望像 ChatGPT 一样，能**持续对话**，而且 Agent 能**记住上下文**。

---

## 核心问题：为什么需要 messages 历史？

大语言模型（LLM）本身是**无状态**的——它不会记住你上一次说了什么。

每次调用 API，你必须把**完整的对话历史**一起发过去，模型才能理解上下文：

```
第1轮发送:
  [user: "你好"]

第2轮发送:
  [user: "你好", assistant: "你好！我是...", user: "你叫什么名字？"]
  ↑ 必须带上所有历史，模型才知道"你"在问谁
```

这就是为什么 `ChatContext` 里有一个 `messages` 数组。

---

## 改造一：让 Agent 自动维护对话历史

**文件：`src/agent/agent.ts`**

原来的 `chat()` 方法只是把历史和当前消息拼在一起发出去，但**没有把 AI 的回复存回去**：

```typescript
// ❌ 改造前：AI 回复丢失，下一轮对话没有上下文
async chat(message: string, context: ChatContext): Promise<string> {
  const messages = [...context.messages, { role: 'user', content: message }];
  const { text } = await generateText({ model: this.model, messages });
  return text; // AI 回复没有存回 context.messages！
}
```

改造后，每轮对话都把用户消息和 AI 回复**追加进 context.messages**：

```typescript
// ✅ 改造后：自动维护完整对话历史
async chat(message: string, context: ChatContext): Promise<string> {
  // 1. 把用户消息追加进历史
  const userMessage: CoreMessage = { role: 'user', content: message };
  context.messages.push(userMessage);

  // 2. 带着完整历史调用模型
  const { text } = await generateText({
    model: this.model,
    messages: context.messages,
  });

  // 3. 把 AI 回复也追加进历史，供下一轮使用
  const assistantMessage: CoreMessage = { role: 'assistant', content: text };
  context.messages.push(assistantMessage);

  return text;
}
```

数据流变化：

```
调用前: messages = [user: "你好", assistant: "你好！"]
调用后: messages = [user: "你好", assistant: "你好！", user: "新问题", assistant: "新回复"]
                                                        ↑ 本轮新增的两条
```

---

## 改造二：用 readline 实现 CLI 多轮对话

**文件：`src/index.ts`**

### 什么是 readline？

`readline` 是 **Node.js 内置标准库**，专门处理"逐行读取终端输入"的场景，无需安装任何依赖。

```
终端输入 (stdin) ──→ readline ──→ 你的代码逻辑
终端输出 (stdout) ←── readline ←── 你的代码逻辑
```

核心 API：
- **`rl.question('提示符', callback)`** — 打印提示符，阻塞等待用户按回车，回车后触发 callback
- **`rl.close()`** — 关闭输入流，程序退出

### 用递归实现"持续等待"

多轮对话的关键是：每次回复完，**立刻再次等待下一条输入**。

由于 `readline` 是异步回调模式，不能用 `while(true)` 同步阻塞，所以用**递归调用**来模拟循环：

```typescript
const askQuestion = () => {
  rl.question('You: ', async (userInput) => {
    // 处理输入...
    const response = await agent.chat(userInput, context);
    console.log('Agent:', response);

    askQuestion(); // ← 递归！处理完立刻进入下一轮等待
  });
};

askQuestion(); // 启动第一轮
```

执行流程：

```
askQuestion()
  └─ 等待用户输入
       └─ 用户按回车
            └─ 调用 agent.chat()
                 └─ 打印回复
                      └─ askQuestion()  ← 再次等待，形成"循环"
```

### 完整的 index.ts

```typescript
import 'dotenv/config';
import * as readline from 'readline';
import { Agent } from './agent/agent.js';
import type { ChatContext } from './agent/agent.js';

async function main() {
  const agent = new Agent(/* ... */);

  // 共享的对话上下文，messages 在每轮后自动累积
  const context: ChatContext = {
    sessionId: 'session-001',
    workspaceRoot: process.cwd(),
    messages: [],
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question('You: ', async (userInput) => {
      const trimmedInput = userInput.trim();

      if (!trimmedInput) { askQuestion(); return; }         // 空输入跳过
      if (trimmedInput.toLowerCase() === 'exit') {          // exit 退出
        console.log('\n👋 再见！');
        rl.close();
        return;
      }

      const response = await agent.chat(trimmedInput, context);
      console.log('Agent:', response, '\n');

      askQuestion(); // 进入下一轮
    });
  };

  askQuestion();
}
```

---

## 运行效果

```bash
npm run dev
```

```
🤖 Mini AI Agent 已启动！
   模型: gpt-4
   输入 exit 或按 Ctrl+C 退出

You: 你好，你叫什么名字？
Agent: 你好！我是一个 AI 助手...

You: 你刚才说你叫什么？
Agent: 我刚才说我是一个 AI 助手...  ✅ 记住上下文了！

You: exit
👋 再见！
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **LLM 无状态** | 模型不记忆历史，每次必须带上完整 messages |
| **messages 数组** | 对话历史的载体，格式为 `[{role, content}, ...]` |
| **readline** | Node.js 内置库，实现终端交互，无需额外依赖 |
| **递归回调** | 异步场景下模拟"持续循环等待"的经典模式 |

---

## 下一步

- [ ] 给 Agent 添加**系统提示词（System Prompt）**，赋予它角色定位
- [ ] 实现**流式输出（Streaming）**，让回复像 ChatGPT 一样逐字出现
- [ ] 给 Agent 添加**工具调用（Tool Use）**能力
