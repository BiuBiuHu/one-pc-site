---
title: "多 Agent 协作（Multi-Agent Collaboration）"
date: 2026-11-25
excerpt: "一个 Agent 不够用时，多个 Agent 怎么分工？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 11
---

> 目标：实现 Orchestrator 模式，让主 Agent 拆解任务、委托专业子 Agent 分工处理

---

## 背景

前9课我们一直在做**单个 Agent**，但现实中有些任务一个 Agent 搞不定：

```
用户："帮我分析这个项目的代码质量，然后写一份技术报告"

单 Agent 的问题：
- 又要读代码、又要分析、又要写报告，上下文越来越长
- 不同任务需要不同的"专业角色"和 System Prompt
- 单一 Agent 容易在复杂任务中跑偏
```

**多 Agent 协作**的解法：

```
Orchestrator（主 Agent）：拆解任务 → 委托子 Agent → 汇总结果
  ↓
Code Analyzer Agent：专门分析代码质量
  ↓
Report Writer Agent：专门写技术报告
```

---

## 核心认知：子 Agent 调用也是工具

多 Agent 协作最优雅的实现方式：**把子 Agent 的调用封装成主 Agent 的工具**。

```typescript
const delegateToCodeAnalyzer = tool({
  description: '委托代码分析专家 Agent 分析代码质量...',  // ← 主 Agent 靠这个决定何时委托
  parameters: z.object({ task: z.string() }),
  execute: async ({ task }) => {
    // 在工具内部实例化子 Agent，完全独立
    const subAgent = new Agent(..., '你是一个代码质量分析专家...');
    return await subAgent.chat(task, subContext);
  }
});
```

这样主 Agent 的 Agent Loop 里，调用子 Agent 和调用普通工具（查时间、读文件）**没有任何区别**——都是 `tool_calls` → `execute` → 返回结果。

---

## Orchestrator 模式

```
用户任务
  ↓
Orchestrator（主 Agent）
  ├── 分析任务，决定调用哪些子 Agent
  ├── delegate_to_code_analyzer → Code Analyzer Agent
  ├── delegate_to_report_writer → Report Writer Agent（可以把上一步结果传进去）
  └── 汇总所有子 Agent 的结果，生成最终回答
```

**串行调用**：前一个子 Agent 的输出作为后一个子 Agent 的输入：

```
分析代码 → 得到分析结果 → 把分析结果传给报告撰写 Agent → 得到正式报告
```

**并行调用**：主 Agent 可以一次 `tool_calls` 里调用多个子 Agent（OpenAI 支持一次返回多个 tool_calls）。

---

## 每个子 Agent 都是独立的

```typescript
function createSubAgent(apiKey, modelName, baseURL, systemPrompt, workspaceRoot) {
  const agent = new Agent(..., systemPrompt);  // 独立的 System Prompt
  const context: ChatContext = {
    sessionId: `sub-agent-${Date.now()}`,
    messages: [],  // 独立的对话历史，互不干扰
  };
  return { agent, context };
}
```

每个子 Agent 有：
- **独立的 System Prompt**：决定它的专业角色
- **独立的 messages 数组**：对话历史互不干扰
- **独立的上下文窗口**：不会因为主 Agent 的历史太长而超限

---

## 资产共享 vs 隔离

子 Agent 是**同一个 `Agent` 类的不同实例**，不是同一个对象。它的工具、Skills、Rules、MCP 是否共享，取决于这些资产的**归属层级**：

### 1. 基础工具 `agentTools` —— 天然共享 ✅

```typescript
import { agentTools } from './tools.js';  // 模块级单例，全局只有一份
```

`agentTools` 是模块级单例，所有 Agent 实例 `import` 的都是**同一份对象引用**。不管 new 多少个 Agent，基础工具都是共享的。

### 2. Skills / Rules —— 取决于是否注入同一个实例 ⚠️

```typescript
// 共享：主/子 Agent 传入同一个 manager 实例
const skillsManager = new SkillsManager(...);
const mainAgent = new Agent(..., skillsManager);
const subAgent  = new Agent(..., skillsManager);  // 同一个引用 → 共享

// 不共享：子 Agent 不传或传新的
const subAgent = new Agent(...);  // skillsManager = null → 没有 skills
```

> 注意：本文档 `createSubAgent` 的写法是 `new Agent(..., systemPrompt)`，**没传 manager**，所以子 Agent 默认**没有** skills/rules。想要就必须显式传入。

### 3. MCP —— 同理，看 client 归属

- MCP client 是**模块级单例**或**注入同一实例** → 共享连接和工具
- 每个子 Agent 各自 `new` 一个 MCP client → 各自独立连接

### 一张表总结

| 资产 | 是否共享 | 原因 |
|------|---------|------|
| **基础工具** `agentTools` | ✅ 天然共享 | 模块级单例，同一引用 |
| **Skills / Rules** | ⚠️ 看注入 | 传同一个 manager 实例才共享 |
| **MCP** | ⚠️ 看 client 归属 | 单例/注入则共享，各自 new 则独立 |
| **System Prompt** | ❌ 隔离 | 构造参数各自传入 |
| **对话历史 messages** | ❌ 隔离 | 每个 context 独立数组 |

**关键区分**：工具定义（schema + execute 函数）是**无状态**的，共享没问题；但"这个 Agent 知不知道有这些工具、会不会被规则约束"取决于它的 System Prompt 里注入了什么——这才是主/子 Agent 真正的差异所在。

---

## 和单 Agent 的对比

| | 单 Agent | 多 Agent 协作 |
|---|---|---|
| **适用场景** | 简单、单一任务 | 复杂、多步骤任务 |
| **上下文** | 单一，越来越长 | 每个子 Agent 独立，互不干扰 |
| **专业化** | 一个角色干所有事 | 每个子 Agent 专注一个领域 |
| **实现复杂度** | 简单 | 较复杂，需要 Orchestrator |
| **Token 消耗** | 较少 | 较多（每个子 Agent 都有独立请求） |

---

## 文件结构

```
src/
├── agent/
│   ├── agent.ts            ← 基础 Agent（子 Agent 复用）
│   ├── orchestrator.ts     ← 新建：Orchestrator 主 Agent
│   ├── context-manager.ts  ← 不变
│   ├── memory-manager.ts   ← 不变
│   └── tools.ts            ← 不变
└── multi-agent-demo.ts     ← 新建：多 Agent 协作演示
```

---

## 完整调用链路

```
用户："分析代码质量，然后写成技术报告"
  ↓
Orchestrator 的 Agent Loop 开始
  ↓
Step 1：LLM 决定调用 delegate_to_code_analyzer
  → 内部实例化 Code Analyzer Agent
  → Code Analyzer Agent 分析代码，返回分析结果
  ↓
Step 2：LLM 拿到分析结果，决定调用 delegate_to_report_writer
  → 内部实例化 Report Writer Agent
  → Report Writer Agent 把分析结果整理成报告
  ↓
Step 3：LLM 拿到报告，finish_reason === 'stop'
  → 汇总输出最终结果
```

---

## 运行方式

```bash
npx tsx src/multi-agent-demo.ts
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Orchestrator 模式** | 主 Agent 负责拆解任务和汇总，子 Agent 负责专业执行 |
| **子 Agent 即工具** | 把子 Agent 调用封装成 tool，主 Agent 的 Agent Loop 无感知 |
| **独立上下文** | 每个子 Agent 有独立的 messages 和 System Prompt，互不干扰 |
| **串行调用** | 前一个子 Agent 的输出作为后一个的输入 |
| **并行调用** | 主 Agent 一次 tool_calls 里同时调用多个子 Agent |

---

## 下一步

- [ ] **第11课：Rules 系统** — 把 System Prompt 的工程化拆分，让行为约束变成可组合的规则模块
- [ ] **第14课：Agent 安全** — 权限控制与沙箱隔离，防止 Agent 做不该做的事
