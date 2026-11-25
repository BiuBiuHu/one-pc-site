---
title: "第九课：记忆系统（Memory System）"
date: 2026-11-25
excerpt: "如何让 Agent 记住跨会话的信息？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 10
---

> 目标：实现跨会话的长期记忆，让 Agent 记住不同对话间的用户信息

---

## 背景

第8课的上下文管理解决了**单次会话内** Token 超限的问题，但有一个根本缺陷：

```
会话A：用户说"我叫张三，是一名前端工程师"
会话B（新开对话）：用户问"你还记得我叫什么吗？"
Agent：❌ 不记得，messages 数组是全新的
```

**记忆系统**要解决的是**跨会话**的信息持久化。

---

## 两个机制的区别

这是本课最容易混淆的地方，必须先搞清楚：

| | 上下文压缩（第8课） | 长期记忆（第9课） |
|---|---|---|
| **解决的问题** | 单次会话 Token 超限 | 跨会话信息丢失 |
| **触发方式** | 消息数超过阈值，自动触发 | AI 主动调用工具 |
| **存储位置** | 内存（messages 数组） | 磁盘（memory.json） |
| **生命周期** | 单次会话结束即消失 | 永久保存 |
| **内容** | 对话摘要 | 重要事实（用户信息、偏好等） |

**一句话区分**：压缩是为了省 Token，记忆是为了跨会话。

---

## 设计思路

最简单、最实用的长期记忆方案：

```
保存：AI 主动调用 save_memory 工具 → 写入 .agent-memory/memory.json
读取：每次对话开始时，自动读取 memory.json → 注入 System Prompt
```

记忆的三个操作：

```
写入 → save_memory 工具   → AI 主动决定
查询 → recall_memory 工具 → AI 主动决定
注入 → buildSystemPrompt() → 每次对话自动执行（系统自动）
```

---

## 核心认知：记忆工具和普通工具没有区别

`save_memory`、`recall_memory` 和 `get_current_time`、`read_file` 本质上完全一样——都是 `tool({ description, parameters, execute })`，都由 AI 自主决定要不要调用。

**触发的关键在于 `description`**：

```typescript
export const saveMemoryTool = tool({
  description: '把需要长期记住的重要信息保存到记忆库，比如用户的名字、偏好、重要结论等。
               当用户告诉你关于他们自己的信息，或者明确要求你记住某件事时，调用此工具。',
  //           ↑ AI 靠这段描述判断"什么时候该调用"
  ...
});
```

**这就是为什么提示词工程这么重要**：你怎么描述工具，AI 就怎么用工具。描述写得越清晰，AI 触发越准确。

---

## 触发场景

**会触发 `save_memory` 的情况：**
```
用户："我叫张三"                    → AI 判断：用户信息，值得记住 ✅
用户："记住我喜欢用 TypeScript"      → AI 判断：用户明确要求记住 ✅
用户："我的项目用的是 React 18"      → AI 判断：技术栈信息，值得记住 ✅
```

**不会触发的情况：**
```
用户："今天天气怎么样？"             → AI 判断：临时问题，不需要记 ❌
用户："帮我解释一下闭包"             → AI 判断：通用知识，不需要记 ❌
```

---

## 记忆注入：buildSystemPrompt()

每次对话时，`Agent` 会把记忆追加到 System Prompt 末尾：

```typescript
private buildSystemPrompt(): string {
  return this.baseSystemPrompt + this.memory.format_for_system_prompt();
}
```

`format_for_system_prompt()` 的输出：

```
## 你记住的关于用户的信息
- 用户叫张三，是一名前端工程师
- 用户喜欢用 TypeScript
- 用户的项目使用 React 18
```

这段文字追加到 System Prompt 后，AI 在每次对话时都能"天然知道"这些信息，不需要用户重复告知。

---

## 记忆数据结构

```json
{
  "facts": [
    {
      "id": "mem_1712345678901",
      "content": "用户叫张三，是一名前端工程师",
      "createdAt": "2024-04-01T09:00:00.000Z",
      "tags": ["用户信息"]
    },
    {
      "id": "mem_1712345679000",
      "content": "用户喜欢用 TypeScript",
      "createdAt": "2024-04-01T09:01:00.000Z",
      "tags": ["偏好", "技术栈"]
    }
  ]
}
```

---

## 文件结构

```
src/agent/
├── agent.ts            ← 改造：buildSystemPrompt() 注入记忆
├── context-manager.ts  ← 不变：上下文压缩（第8课）
├── memory-manager.ts   ← 新建：读写 memory.json
└── tools.ts            ← 新增：save_memory、recall_memory、delete_memory

.agent-memory/
└── memory.json         ← 长期记忆存储文件（自动创建）
```

---

## 完整调用链路

```
用户说："我叫张三"
  ↓
LLM 读到 save_memory 的 description，判断需要调用
  ↓
Agent Loop 执行 saveMemoryTool.execute()
  ↓
MemoryManager.save_fact("用户叫张三") → 写入 memory.json

─────────────────────────────────────

下次新开对话：
  ↓
Agent 构造时：new MemoryManager(workspaceRoot) → 读取 memory.json
  ↓
每次请求 LLM 前：buildSystemPrompt() → 把记忆追加到 System Prompt
  ↓
LLM 天然知道"用户叫张三" ✅
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **长期记忆 vs 上下文压缩** | 前者跨会话持久化，后者单次会话内省 Token |
| **记忆工具** | `save_memory`、`recall_memory` 都是普通工具，AI 自主决定调用 |
| **description 的重要性** | AI 靠 description 判断何时调用工具，写得越清晰触发越准确 |
| **自动注入** | `buildSystemPrompt()` 每次对话自动把记忆追加到 System Prompt |
| **存储格式** | JSON 文件，每条记忆有 id、content、createdAt、tags |

---

## 下一步

- [ ] **第10课：多 Agent 协作** — 一个主 Agent 调度多个专业子 Agent 分工协作
