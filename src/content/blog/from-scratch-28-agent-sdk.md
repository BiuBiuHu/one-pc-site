---
title: "第二十八课：Agent SDK 设计 — 把 Agent 封装成开箱即用的 SDK"
date: 2026-11-25
excerpt: "把前面所有能力收敛成一个自己的 SDK？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 29
---

> 目标：理解 SDK 的设计哲学，把前面所有课程的能力封装成一个链式 API、插件化的 Agent SDK

---

## 核心问题

**为什么需要 SDK？直接用 Agent 类不行吗？**

当然可以用。但随着项目变大，你会发现每次使用 Agent 都要：

```typescript
// 每次都要手动组装这一堆东西
const rulesManager = new RulesManager();
await rulesManager.loadFromDirectory('./rules');

const skillsManager = new SkillsManager();
skillsManager.register(codeReviewSkill);

const agent = new Agent(
  process.env.OPENAI_API_KEY!,
  'gpt-4',
  process.env.OPENAI_BASE_URL,
  systemPrompt,
  process.cwd(),
  rulesManager,
  skillsManager
);

const context: ChatContext = {
  sessionId: 'session-001',
  workspaceRoot: process.cwd(),
  messages: [],
};
```

这就是 **SDK 要解决的问题**：把重复的组装逻辑封装起来，让使用者只关心"我要做什么"，而不是"怎么组装"。

---

## SDK 的三个设计目标

| 目标 | 说明 | 实现方式 |
|------|------|----------|
| **开箱即用** | 最少只需要 apiKey 就能跑起来 | 所有参数都有合理默认值 |
| **链式 API** | 配置像搭积木一样直观 | Builder 模式 |
| **插件化** | 任何能力都可以热插拔 | Plugin 接口 + 钩子系统 |

---

## 设计模式：Builder + Plugin

### Builder 模式

Builder 模式的核心是：**把复杂对象的构建过程和它的表示分离**。

```
new AgentSDK(config)     ← 基础配置
  .use(plugin)           ← 插件注册（可多次调用）
  .withTools(tools)      ← 追加工具
  .withSystemPrompt(...) ← 覆盖 System Prompt
  .build()               ← 完成构建，初始化内部对象
```

每个 `.use()` / `.with*()` 方法都返回 `this`，所以可以无限链式调用。

### Plugin 接口

插件是一个实现了特定钩子的对象：

```typescript
interface AgentPlugin {
  name: string;                    // 插件名，用于调试

  // 能力扩展
  tools?: Record<string, CoreTool>;         // 提供额外工具
  systemPromptSection?: string;             // 注入 System Prompt 片段

  // 生命周期钩子
  onBeforeToolCall?: (toolName, args) => boolean | Promise<boolean>;  // 返回 false 可阻止工具执行
  onAfterToolCall?:  (toolName, result) => void | Promise<void>;
  onComplete?:       (fullText, context) => void | Promise<void>;
}
```

这个设计来自 **AOP（面向切面编程）** 思想：把横切关注点（日志、限流、鉴权）从业务逻辑中剥离出来。

---

## 文件结构

```
src/sdk/
├── index.ts        ← 统一导出（使用者只需要 import 这一个文件）
├── types.ts        ← 所有类型定义
├── agent-sdk.ts    ← SDK 主类（Builder + 运行时）
└── plugins.ts      ← 内置插件集合
```

---

## 核心实现

### types.ts — 类型定义

```typescript
// SDK 配置项
export interface AgentSDKConfig {
  apiKey: string;
  model?: string;          // 默认 'gpt-4'
  baseURL?: string;        // 兼容 DeepSeek、Qwen 等
  systemPrompt?: string;
  workspaceRoot?: string;
  maxSteps?: number;       // Agent Loop 最大步数，默认 5
}

// 每次 run() 的运行时选项
export interface RunOptions {
  sessionId?: string;
  stream?: boolean;
  onEvent?: (event: AgentEvent) => void;  // 完整事件流
  onChunk?: (chunk: string) => void;      // 只关心文字 token
}

// run() 的返回值
export interface RunResult {
  text: string;           // 最终完整回复
  toolsUsed: string[];    // 本次调用了哪些工具
  durationMs: number;     // 执行耗时
}
```

### agent-sdk.ts — SDK 主类（核心逻辑）

```typescript
export class AgentSDK {
  private config: Required<AgentSDKConfig>;
  private plugins: AgentPlugin[] = [];
  private extraTools: Record<string, CoreTool> = {};
  private sessions: Map<string, ChatContext> = new Map();  // 多会话管理
  private isBuilt = false;

  constructor(config: AgentSDKConfig) {
    // 填充所有默认值
    this.config = {
      model: 'gpt-4',
      baseURL: '',
      systemPrompt: '你是一个友好、专业的 AI 助手，回答简洁清晰。',
      workspaceRoot: process.cwd(),
      maxSteps: 5,
      ...config,
    };
  }

  // ─── Builder 链式 API ──────────────────────────────────────────────────────

  use(plugin: AgentPlugin): this { ... }
  withTools(tools: Record<string, CoreTool>): this { ... }
  withSystemPrompt(prompt: string): this { ... }
  withMaxSteps(maxSteps: number): this { ... }

  build(): this {
    // 初始化 OpenAI Provider 和 MemoryManager
    // 只有 build() 之后才能调用 run()
    this.isBuilt = true;
    return this;
  }

  // ─── 核心运行方法 ──────────────────────────────────────────────────────────

  async run(message: string, options: RunOptions = {}): Promise<RunResult> {
    this.assertBuilt();

    // 1. 获取或创建会话上下文（自动管理多会话）
    const context = this.getOrCreateSession(options.sessionId ?? 'default');

    // 2. 构建 System Prompt（基础 + 记忆 + 插件注入）
    const systemPrompt = this.buildSystemPrompt();

    // 3. 合并所有工具（内置 + 插件 + 手动注册）
    const allTools = this.buildTools();

    // 4. 执行（流式 or 非流式）
    // 5. 触发插件钩子
    // 6. 返回 RunResult
  }
}
```

### 关键设计：多会话管理

SDK 内部用一个 `Map<sessionId, ChatContext>` 管理所有会话：

```typescript
// 每次 run() 时，根据 sessionId 自动获取或创建对话上下文
private getOrCreateSession(sessionId: string): ChatContext {
  if (!this.sessions.has(sessionId)) {
    this.sessions.set(sessionId, {
      sessionId,
      workspaceRoot: this.config.workspaceRoot,
      messages: [],
    });
  }
  return this.sessions.get(sessionId)!;
}
```

这样使用者不需要手动管理 `ChatContext`，SDK 自动维护每个用户的对话历史。

### 关键设计：插件钩子链

```typescript
// 所有插件的 onBeforeToolCall 都要返回 true，工具才会执行
// 任意一个返回 false，工具调用被阻止
private async runBeforeToolCallHooks(toolName, args): Promise<boolean> {
  for (const plugin of this.plugins) {
    if (plugin.onBeforeToolCall) {
      const allowed = await plugin.onBeforeToolCall(toolName, args);
      if (!allowed) return false;  // 短路：一票否决
    }
  }
  return true;
}
```

---

## 内置插件

### 日志插件

```typescript
import { loggingPlugin } from './sdk/index.js';

sdk.use(loggingPlugin({ verbose: true }));
// 输出：[SDK] 🔧 工具调用: read_file | 参数: {"path":"./src/index.ts"}
// 输出：[SDK] ✅ 工具完成: read_file | 结果: ...
// 输出：[SDK] 💬 回复完成，共 256 字符
```

### 限流插件

```typescript
import { rateLimitPlugin } from './sdk/index.js';

// 1 分钟内最多调用 10 次工具
sdk.use(rateLimitPlugin({ maxCallsPerWindow: 10, windowMs: 60_000 }));
// 超限时：[SDK] ⚠️ 限流触发：工具 read_file 被阻止。请等待 30 秒后重试。
```

### 工具黑名单插件

```typescript
import { toolBlocklistPlugin } from './sdk/index.js';

// 禁止 Agent 执行命令（安全限制）
sdk.use(toolBlocklistPlugin({ blockedTools: ['execute_command'] }));
```

### 统计插件

```typescript
import { callStatsPlugin } from './sdk/index.js';

const statsTracker = callStatsPlugin();
sdk.use(statsTracker.plugin);

// 随时查看统计
console.log(statsTracker.getStats());
// {
//   totalToolCalls: 12,
//   totalCompletions: 5,
//   toolCallCounts: { read_file: 8, list_directory: 4 },
//   totalCharacters: 3840
// }
```

---

## 完整使用示例

### 最简用法（3 行）

```typescript
import { AgentSDK } from './sdk/index.js';

const sdk = new AgentSDK({ apiKey: process.env.OPENAI_API_KEY! }).build();
const result = await sdk.run('帮我写一个快速排序算法');
console.log(result.text);
```

### 生产级用法

```typescript
import {
  AgentSDK,
  loggingPlugin,
  rateLimitPlugin,
  toolBlocklistPlugin,
  callStatsPlugin,
} from './sdk/index.js';

// 1. 创建统计追踪器
const statsTracker = callStatsPlugin();

// 2. 构建 SDK
const sdk = new AgentSDK({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.MODEL_NAME ?? 'gpt-4',
  baseURL: process.env.OPENAI_BASE_URL,
  systemPrompt: '你是一个专业的 TypeScript 代码助手，回答简洁、准确。',
  maxSteps: 8,
})
  .use(loggingPlugin({ verbose: true }))
  .use(rateLimitPlugin({ maxCallsPerWindow: 20 }))
  .use(toolBlocklistPlugin({ blockedTools: ['execute_command'] }))
  .use(statsTracker.plugin)
  .build();

// 3. 多用户多会话
const aliceResult = await sdk.run('帮我分析这段代码', { sessionId: 'alice' });
const bobResult   = await sdk.run('写一个 React 组件', { sessionId: 'bob' });

// Alice 继续追问（SDK 自动维护对话历史）
const aliceFollowUp = await sdk.run('能帮我优化一下吗？', { sessionId: 'alice' });

// 4. 流式输出
await sdk.run('解释一下 async/await', {
  sessionId: 'alice',
  onChunk: (chunk) => process.stdout.write(chunk),
});

// 5. 完整事件流（用于 UI 展示执行过程）
await sdk.run('帮我读取 package.json', {
  onEvent: (event) => {
    if (event.type === 'tool_call_start') {
      console.log(`🔧 调用工具: ${event.toolName}`);
    } else if (event.type === 'text_delta') {
      process.stdout.write(event.content);
    }
  },
});

// 6. 查看统计
console.log(statsTracker.getStats());
```

### 自定义插件

```typescript
import type { AgentPlugin } from './sdk/index.js';

// 写一个审计日志插件，把所有工具调用写入文件
const auditPlugin: AgentPlugin = {
  name: 'audit-log',

  async onBeforeToolCall(toolName, args) {
    await fs.appendFile(
      './audit.log',
      `${new Date().toISOString()} CALL ${toolName} ${JSON.stringify(args)}\n`
    );
    return true; // 不阻止执行
  },

  async onAfterToolCall(toolName, result) {
    await fs.appendFile(
      './audit.log',
      `${new Date().toISOString()} DONE ${toolName}\n`
    );
  },
};

sdk.use(auditPlugin);
```

---

## SDK vs 直接用 Agent 类

| 对比维度 | 直接用 Agent 类 | 用 AgentSDK |
|----------|----------------|-------------|
| **上手成本** | 需要理解所有内部模块 | 只需要 apiKey |
| **会话管理** | 手动创建和维护 ChatContext | 自动按 sessionId 管理 |
| **能力扩展** | 修改 Agent 类源码 | 注册插件，不改源码 |
| **横切逻辑** | 散落在业务代码里 | 统一在插件中管理 |
| **适用场景** | 学习底层原理 | 构建实际应用 |

---

## 架构图

```
┌─────────────────────────────────────────────────────┐
│                    AgentSDK                          │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Builder  │  │ Plugin   │  │  Session Manager  │  │
│  │  API     │  │  Chain   │  │  (Map<id,Context>)│  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │              run(message, options)           │    │
│  │                                              │    │
│  │  buildSystemPrompt()  →  buildTools()        │    │
│  │         ↓                                    │    │
│  │  ContextManager.buildMessages()              │    │
│  │         ↓                                    │    │
│  │  generateText() / streamText()               │    │
│  │         ↓                                    │    │
│  │  Plugin Hooks (before/after/complete)        │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
└──────────────────────┬──────────────────────────────┘
                       │ 调用
                       ▼
         ┌─────────────────────────┐
         │    底层 Agent 模块       │
         │  agent.ts / tools.ts    │
         │  context-manager.ts     │
         │  memory-manager.ts      │
         └─────────────────────────┘
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Builder 模式** | 把复杂对象的构建过程链式化，每个 `.use()/.with*()` 返回 `this` |
| **Plugin 接口** | 用钩子函数实现能力的热插拔，不修改核心代码 |
| **AOP 思想** | 把日志、限流等横切关注点从业务逻辑中剥离 |
| **一票否决** | `onBeforeToolCall` 任意插件返回 false 即阻止工具执行 |
| **会话隔离** | `Map<sessionId, ChatContext>` 让多用户对话互不干扰 |
| **门面模式** | SDK 是底层 Agent 模块的"门面"，简化外部调用接口 |

---

## 下一步

- [ ] **第29课：幻觉防治** — SDK 把能力收敛后，下一个要解决的是"如何保证 Agent 不说谎"：从架构层面系统性切断幻觉传播链
- [ ] 为 SDK 增加持久化会话（把 ChatContext 存入 Redis，跨进程重启不丢失）
- [ ] 为 SDK 增加 `middleware` 中间件链（比插件钩子更灵活的拦截机制）
- [ ] 把 SDK 发布为 npm 包，让其他项目可以直接安装使用
