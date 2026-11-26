---
title: "工具调用（Tool Use）"
date: 2026-11-25
excerpt: "如何让 Agent 从「只会聊天」变成「能干活」？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 5
---

> 目标：理解工具调用的完整原理，让 Agent 从"只会聊天"变成"能干活"

---

## 背景

前三课的 Agent 只能"说话"，无法执行真实操作：

```
You: 现在几点了？
Agent: 抱歉，我没有获取实时时间的能力...  ← 只能认怂
```

**工具调用（Tool Use）** 让 Agent 能执行真实操作：

```
You: 现在几点了？
🔧 正在调用工具: get_current_time...
Agent: 现在是 2026年3月31日 17:49  ← 真实查询！
```

---

## 核心原理：模型不执行代码，只负责"点菜"

这是工具调用最重要的认知：

```
┌─────────────────────────────────┐    ┌──────────────────────────────┐
│       我们的 Node.js 进程        │    │          模型（云端）          │
│                                 │    │                              │
│  tool 定义：                    │    │  收到：                       │
│    description ──────────────────────→  "有个工具叫 get_current_time │
│    parameters  ──────────────────────→   不需要参数，能获取当前时间"  │
│    execute（代码）  ✗ 不发送     │    │                              │
│                                 │    │  判断：用户问时间，调它！      │
│                                 │←──────  返回：调用 get_current_time│
│  我们执行 execute()             │    │                              │
│    → { datetime: "17:49" }      │──────→  收到工具执行结果           │
│                                 │    │  生成最终回复："现在是 17:49"  │
└─────────────────────────────────┘    └──────────────────────────────┘
```

**模型永远不知道 `execute` 里写的是什么代码**，它只知道：
1. 有哪些工具（靠 `description`）
2. 每个工具需要什么参数（靠 `parameters`）
3. 工具执行后返回了什么结果（靠我们把结果传回去）

---

## 完整的一次工具调用流程

以"看看 package.json 的内容"为例，完整拆解每一步：

### 第一步：我们发给模型的请求

```json
{
  "messages": [
    { "role": "system", "content": "你是 Mini Coder..." },
    { "role": "user",   "content": "看看当前文件夹下的 package.json 中的内容是什么?" }
  ],
  "tools": {
    "read_file": {
      "description": "读取指定路径的文件内容，路径相对于工作区根目录",
      "parameters": {
        "filePath": { "type": "string", "description": "要读取的文件路径" }
      }
    }
  }
}
```

注意：**发给模型的只有工具的描述和参数格式，execute 代码完全不发送**。

### 第二步：模型返回"点菜单"，不是文字

模型读完用户的话，判断："用户要读文件，我有 `read_file` 工具，`package.json` 就在根目录"，于是返回：

```json
{
  "tool_calls": [{
    "toolName": "read_file",
    "args": {
      "filePath": "package.json"   ← 模型根据用户意图自己推断出来的！
    }
  }]
}
```

**模型是怎么知道传 `"package.json"` 的？**

靠的是**语义理解**：
- 用户说"当前文件夹下" → 根目录 → 不需要加路径前缀
- 用户说"package.json" → 文件名就是 `package.json`
- 结合 `filePath` 参数的 description → 推断出 `"package.json"`

### 第三步：ai SDK 自动执行工具

```typescript
// SDK 内部自动做了这件事：
const result = await tools.read_file.execute({ filePath: "package.json" })
//                                                ↑ 模型填的参数，SDK 自动传进来
```

### 第四步：把工具结果塞回 messages，再次请求模型

```json
{
  "messages": [
    { "role": "system",    "content": "你是 Mini Coder..." },
    { "role": "user",      "content": "看看当前文件夹下的 package.json..." },
    { "role": "assistant", "content": null, "tool_calls": [{ "toolName": "read_file", "args": {...} }] },
    { "role": "tool",      "content": "{ name: 'mini-ai-coder', version: '0.1.0'... }" }  ← 工具结果
  ]
}
```

### 第五步：模型根据工具结果生成最终回复

模型看到工具返回的 JSON 内容，用自然语言整理成最终回复。

---

## generateText 内部是怎么驱动工具调用的？

上面讲的是"我们看到的"流程，但 `generateText` 内部到底做了什么？理解这一层，才能真正明白 Agent Loop 为什么能自动运转。

### 第一步：把工具描述序列化成 JSON Schema 发给 LLM

`generateText` 拿到你定义的 `tools` 对象后，会把每个工具的 zod schema 转成 JSON Schema，拼进请求体：

```
你写的：
  z.object({ filePath: z.string().describe('文件路径') })

发给 LLM 的：
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "读取指定路径的文件内容",
      "parameters": {
        "type": "object",
        "properties": {
          "filePath": { "type": "string", "description": "文件路径" }
        },
        "required": ["filePath"]
      }
    }
  }
```

**execute 函数完全不发送**，LLM 永远看不到你的代码。

### 第二步：LLM 返回 `tool_calls`，不是文字

LLM 判断需要调用工具时，返回的不是普通文字，而是一个特殊结构：

```json
{
  "finish_reason": "tool_calls",
  "message": {
    "role": "assistant",
    "content": null,
    "tool_calls": [{
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"filePath\": \"package.json\"}"
      }
    }]
  }
}
```

注意两个关键点：
- `finish_reason` 是 `"tool_calls"` 而不是 `"stop"`，这是 SDK 判断"还没完，要继续循环"的信号
- `arguments` 是**字符串化的 JSON**，SDK 需要 `JSON.parse` 后再传给 `execute`

### 第三步：SDK 内部的 while 循环（Agent Loop 的本质）

这是最核心的部分，`generateText` 内部大致是这样的逻辑：

```typescript
// generateText 内部伪代码（简化）
async function generateText({ model, messages, tools, maxSteps }) {
  let currentMessages = [...messages];
  let stepCount = 0;

  while (stepCount < maxSteps) {
    // 1. 调用 LLM
    const response = await model.doGenerate({
      messages: currentMessages,
      tools: serializeTools(tools),  // zod → JSON Schema
    });

    stepCount++;

    // 2. 判断是否需要调用工具
    if (response.finishReason === 'stop') {
      // 模型直接给出文字回复，循环结束
      return { text: response.text };
    }

    if (response.finishReason === 'tool-calls') {
      // 3. 把模型的 tool_calls 消息追加到历史
      currentMessages.push({
        role: 'assistant',
        content: response.toolCalls,
      });

      // 4. 执行每个工具（调用我们写的 execute 函数）
      const toolResults = [];
      for (const toolCall of response.toolCalls) {
        const tool = tools[toolCall.toolName];
        const args = JSON.parse(toolCall.args);   // 解析参数
        const result = await tool.execute(args);  // 执行！
        toolResults.push({ toolCallId: toolCall.toolCallId, result });
      }

      // 5. 把工具结果追加到历史，准备下一轮
      currentMessages.push({
        role: 'tool',
        content: toolResults,
      });

      // 继续循环，带着工具结果再次请求 LLM
      onStepFinish?.({ toolCalls: response.toolCalls, toolResults });
    }
  }
}
```

**这个 while 循环就是 `maxSteps` 控制的 Agent Loop**，第7课"手写 Agent Loop"就是让你自己实现这段逻辑。

### 完整的消息历史演变

以"读取 package.json"为例，每一轮 messages 的变化：

```
第1轮发给 LLM：
  [system, user("看看package.json")]

LLM 返回：finish_reason: "tool_calls"，调用 read_file("package.json")

第2轮发给 LLM：
  [system, user("看看package.json"),
   assistant(tool_calls: [read_file]),    ← 追加
   tool(result: "{ name: 'xxx'... }")]    ← 追加

LLM 返回：finish_reason: "stop"，text: "package.json 的内容是..."

循环结束，返回最终文字
```

### 一图总结

```
generateText()
    │
    ▼
┌─────────────────────────────────────┐
│  while (step < maxSteps)            │
│                                     │
│  ① 发请求给 LLM（带工具描述）        │
│         ↓                           │
│  ② finishReason === 'stop'?         │
│     → 是：返回文字，退出循环         │
│     → 否（tool-calls）：继续         │
│         ↓                           │
│  ③ 执行 tool.execute(args)          │
│         ↓                           │
│  ④ 把结果追加到 messages            │
│         ↓                           │
│  ⑤ 回到 ①，带结果再问 LLM          │
└─────────────────────────────────────┘
```

---

## Agent Loop：工具调用的循环机制

工具调用不一定只发生一次，模型可能需要**连续调用多个工具**才能完成任务：

```
用户："列出 src 目录的文件，然后读一下 index.ts 的内容"

第1轮：模型调用 list_files("src")
        → 返回文件列表
第2轮：模型调用 read_file("src/index.ts")
        → 返回文件内容
第3轮：模型生成最终回复（不再调工具）
```

这个"模型 → 工具 → 模型"的循环就叫 **Agent Loop**，`maxSteps: 5` 控制最大循环次数，防止无限循环。

---

## 工具的三要素

每个工具由三部分组成：

```typescript
tool({
  // 1. description：告诉模型这个工具是干什么的
  //    ⚠️ 这是最重要的！模型靠它决定要不要调用这个工具
  description: '读取指定路径的文件内容，路径相对于工作区根目录',

  // 2. parameters：定义模型需要传什么参数（用 zod 定义）
  //    ai SDK 会自动把 zod 转成 JSON Schema 发给模型
  parameters: z.object({
    filePath: z.string().describe('要读取的文件路径'),
  }),

  // 3. execute：实际执行逻辑（这段代码不会发给模型）
  execute: async ({ filePath }) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content };
  },
})
```

---

## 补充：zod 是什么？

`zod` 是一个 **TypeScript 数据验证库**，`z` 是它导出的核心命名空间对象。

```typescript
import { z } from 'zod';

z.string()           // 字符串类型
z.number()           // 数字类型
z.boolean()          // 布尔类型
z.object({ ... })    // 对象类型
z.array(z.string())  // 字符串数组类型
```

在工具调用里，zod 做了两件事：

**1. 运行时验证**：确保模型传过来的参数格式正确，不是乱传的

**2. 自动生成 JSON Schema**：ai SDK 把 zod 定义转成 JSON Schema 发给模型

```
z.object({ filePath: z.string().describe('要读取的文件路径') })
         ↓ ai SDK 自动转换
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string", "description": "要读取的文件路径" }
  },
  "required": ["filePath"]
}
```

**为什么用 zod 而不是直接写 JSON Schema？**

```typescript
// ❌ 直接写 JSON Schema：冗长、没有类型提示
parameters: {
  type: "object",
  properties: { filePath: { type: "string" } },
  required: ["filePath"]
}

// ✅ 用 zod：简洁，且 execute({ filePath }) 里的 filePath 自动推断为 string 类型！
parameters: z.object({
  filePath: z.string().describe('要读取的文件路径')
})
```

---

## 参数是怎么传递进去的？

这是工具调用里最容易困惑的地方：

```
我们定义结构          模型填值              SDK 自动执行
z.object({      →   { filePath:      →   execute({ filePath: "package.json" })
  filePath: str }     "package.json" }        → 读文件，返回内容
```

**三方各司其职**：
- **我们**：定义"需要什么参数"（参数结构）
- **模型**：根据用户意图"填写参数值"
- **ai SDK**：把填好的参数传给 `execute` 函数执行

---

## 代码实现

### `src/agent/tools.ts` — 工具定义

```typescript
import { tool } from 'ai';
import * as fs from 'fs';
import { z } from 'zod';

// 工具1：获取当前时间
export const getCurrentTimeTool = tool({
  description: '获取当前的日期和时间',
  parameters: z.object({}),
  execute: async () => {
    return {
      datetime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    };
  },
});

// 工具2：读取文件内容
export const readFileTool = tool({
  description: '读取指定路径的文件内容，路径相对于工作区根目录',
  parameters: z.object({
    filePath: z.string().describe('要读取的文件路径，相对于工作区根目录'),
  }),
  execute: async ({ filePath }) => {
    if (!fs.existsSync(filePath)) {
      return { error: `文件不存在: ${filePath}` };
    }
    return { filePath, content: fs.readFileSync(filePath, 'utf-8') };
  },
});

// 工具3：列出目录内容（后面"多步任务"示例里用到）
export const listFilesTool = tool({
  description: '列出指定目录下的文件和子目录，路径相对于工作区根目录',
  parameters: z.object({
    dirPath: z.string().describe('要列出的目录路径，相对于工作区根目录'),
  }),
  execute: async ({ dirPath }) => {
    if (!fs.existsSync(dirPath)) {
      return { error: `目录不存在: ${dirPath}` };
    }
    return { dirPath, files: fs.readdirSync(dirPath) };
  },
});

export const agentTools = {
  get_current_time: getCurrentTimeTool,
  read_file: readFileTool,
  list_files: listFilesTool,
};
```

### `src/agent/agent.ts` — chatWithTools 方法

```typescript
async chatWithTools(
  message: string,
  context: ChatContext,
  onChunk: (chunk: string) => void,
  onToolCall?: (toolName: string) => void
): Promise<void> {
  const userMessage: CoreMessage = { role: 'user', content: message };
  context.messages.push(userMessage);

  const messagesWithSystem: CoreMessage[] = [
    { role: 'system', content: this.systemPrompt },
    ...context.messages,
  ];

  // maxSteps 控制 Agent Loop 的最大循环次数
  const result = await generateText({
    model: this.model,
    messages: messagesWithSystem,
    tools: agentTools,
    maxSteps: 5,
    onStepFinish: ({ toolCalls }) => {
      for (const toolCall of toolCalls) {
        onToolCall?.(toolCall.toolName);
      }
    },
  });

  for (const char of result.text) {
    onChunk(char);
  }

  context.messages.push({ role: 'assistant', content: result.text });
}
```

---

## 工具调用失败了怎么办？

工具调用可能失败，而且失败有**四种完全不同的来源**，检测方式各不相同：

### 1. 参数校验失败（模型传的参数不合法）

zod schema 是第一道防线。模型如果传了错误类型的参数（比如 `filePath` 传了数字），**SDK 在调用 `execute` 之前就会抛错**，`execute` 根本不会执行：

```typescript
parameters: z.object({
  filePath: z.string(),  // 模型传 123 → zod 校验失败 → generateText 抛 ZodError
})
```

**检测方式**：`generateText` 整体抛异常，在外层 try/catch 捕获。

### 2. execute 内部抛异常（硬失败）

工具代码运行时炸了，比如读文件时磁盘错误、网络请求超时：

```typescript
execute: async ({ filePath }) => {
  const content = fs.readFileSync(filePath, 'utf-8');  // 权限不足 → 抛 Error
}
```

**检测方式**：ai SDK 会把它包装成 `ToolExecutionError` 抛出，同样中断整个 `generateText`。**注意：模型看不到这个错误**，因为流程直接终止了，没有机会把错误塞回 messages。

### 3. 业务级失败（软失败）—— 推荐做法 ✅

不抛异常，而是**返回带 `error` 字段的结果**（本项目的 `tools.ts` 就是这么写的）：

```typescript
if (!fs.existsSync(absolutePath)) {
  return { error: `文件不存在: ${filePath}` };   // ← 不抛错，返回错误信息
}
```

这是**最佳实践**，原因：

- 这个 `{ error: "文件不存在" }` 会作为 `tool` 消息塞回 messages
- **模型能看到失败原因**，于是它可以自我纠正：换个路径重试、或者告诉用户"文件不存在"
- 而硬失败（抛异常）会直接终止，模型连补救的机会都没有

**检测方式**：在 `onStepFinish` 里检查 `toolResults`（见下一节）。

### 4. 模型层面的"失败"（没调工具/调错工具）

模型可能该调工具时不调（直接瞎编答案），或者调了错误的工具。这不算异常，只能靠：

- **写好 `description`**（模型靠它决策）
- 检查 `toolCalls` 是否为空来判断"模型是否真的用了工具"

### 四种失败对比

| 失败类型 | 谁检测 | 模型能否看到 | 能否自我纠正 |
|---------|--------|------------|------------|
| zod 参数校验失败 | SDK 抛 `ZodError` | ❌ | ❌ 流程终止 |
| execute 抛异常 | SDK 抛 `ToolExecutionError` | ❌ | ❌ 流程终止 |
| **返回 `{ error }`（软失败）** | `onStepFinish` 检查 result | ✅ | ✅ 可重试/换方案 |
| 模型不调/调错工具 | 检查 toolCalls 是否为空 | — | 靠 description 优化 |

**核心结论**：能预期的失败（文件不存在、权限拒绝）一律用**软失败**返回 `{ error }`，让模型有机会自愈；只有真正意外的崩溃才让它抛异常。

---

## onStepFinish：观察 Agent Loop 的窗口

`onStepFinish` 是 ai SDK 暴露的**逐步回调**——`generateText` 内部是个 while 循环，`onStepFinish` 就是**每跑完一轮循环触发一次**的钩子。它是观察 Agent 内部运转的最佳窗口。

### 触发时机：一次循环 = 一次 step

```
while (step < maxSteps) {
  ① 发请求给 LLM
  ② LLM 返回
  ③ 如果是 tool_calls → 执行工具
  ④ onStepFinish 在这里触发 ← 本步骤的所有产出都齐了
  ⑤ 回到 ①
}
```

"用户问一句话 → 模型调了 2 次工具 → 最终回答"会触发 **3 次** `onStepFinish`：

| step | 本步骤 LLM 的产出 | toolCalls | text |
|------|------------------|-----------|------|
| 1 | 调用 `list_files` | 1 个 | 空 |
| 2 | 调用 `read_file` | 1 个 | 空 |
| 3 | 生成最终回复 | 空 | "src 目录下有..." |

### 回调参数里有什么

```typescript
onStepFinish: (step) => {
  step.text          // 本步骤 LLM 生成的文字（调工具的步骤通常为空）
  step.toolCalls     // 本步骤请求调用的工具列表 [{ toolName, args, toolCallId }]
  step.toolResults   // 对应的执行结果 [{ toolCallId, result }]
  step.finishReason  // 'stop' | 'tool-calls' | 'length'...
  step.usage         // 本步骤的 token 消耗 { promptTokens, completionTokens }
}
```

关键点：**`toolCalls` 和 `toolResults` 按顺序一一对应**，`toolCalls[i]` 的结果就是 `toolResults[i]`（也可用 `toolCallId` 精确匹配）。

### 一个巧妙的判断

**`toolCalls.length > 0` 意味着本步骤没结束、后面还有 step**（工具结果要喂回模型再想一轮）；`toolCalls` 为空则说明模型直接给出了最终回答。本项目的 `chatWithToolsStream` 就是靠它来决定要不要发射下一个 `thinking_start` 事件的。

### 除了驱动 UI，还能干什么

- **监控埋点**：采集成功率、耗时、失败原因（见下一节）
- **防御性熔断**：发现模型反复调同一个工具（死循环前兆），记录甚至提前干预
- **token 成本统计**：累加每步的 `step.usage`，算出一次对话的总消耗

### 和 result.steps 的区别

| 钩子 | 粒度 | 拿到什么 |
|------|------|---------|
| `onStepFinish` | **每个 step 执行完** | 该步骤完整的工具调用+结果+usage |
| `result.steps` | 全部结束后 | 所有 step 的数组（`onStepFinish` 的"事后版"） |

一句话：**`onStepFinish` 是"过程直播"，`result.steps` 是"赛后录像"**。要在执行过程中实时响应（推 UI 事件、埋点、熔断），必须用前者。

---

## 监控与可观测性：知道客户端发生了什么

软失败模式有个盲区：模型自己消化了错误并继续对话，用户侧看起来一切正常，但你的监控系统对"客户端到底发生了什么"一无所知。文件不存在、权限被拒、某个工具频繁失败——这些信号如果不采集，问题会一直潜伏。

### 埋点位置：onStepFinish

`onStepFinish` 每次工具执行完都会触发，且能同时拿到 `toolCalls` 和 `toolResults`，这就是监控的黄金采集点：

```typescript
onStepFinish: ({ toolCalls, toolResults }) => {
  for (let i = 0; i < toolCalls.length; i++) {
    const result = toolResults[i]?.result as { error?: string };
    reportToolCall({
      toolName: toolCalls[i].toolName,
      args: toolCalls[i].args,
      success: !result?.error,        // ← 软失败也能识别
      errorMessage: result?.error,
      timestamp: Date.now(),
      sessionId: context.sessionId,
    });
  }
}
```

### 关键：区分"成功"不能只看有没有抛异常

因为用的是软失败，**`success` 必须靠检查 `result.error` 字段判断**，而不是 try/catch。否则所有业务失败都会被统计成"成功"，监控数据就失真了。

### 该采集哪些指标

| 指标 | 用途 |
|------|------|
| **工具调用成功率**（按 toolName 分组） | 发现某个工具是否频繁失败 |
| **失败原因分布**（error message 聚类） | 定位是路径问题、权限问题还是别的 |
| **调用耗时**（P50/P99） | 发现慢工具 |
| **Agent Loop 步数分布** | 是否接近 maxSteps 上限（模型在反复重试） |
| **sessionId / traceId** | 串联一次完整对话，方便回放排查 |

### 上报到哪

- **结构化日志** → SLS / ELK，保留完整上下文可回溯
- **指标** → Prometheus / 内部监控，配告警（如某工具失败率 > 20% 报警）
- 注意**脱敏**：`args` 里可能有用户敏感路径/内容，上报前过滤

> 💡 软失败让**模型**能自愈，但**可观测性**必须靠你在 `onStepFinish` 主动埋点补上——把每次工具调用的 name/args/success/error/duration 结构化上报，才能知道客户端真实发生了什么。

---

## 运行效果

```
You: 现在几点了？
🔧 正在调用工具: get_current_time...
Agent: 现在是 2026年3月31日 17:49:00

You: 看看当前文件夹下的 package.json 内容
🔧 正在调用工具: read_file...
Agent: package.json 的内容如下：{ "name": "mini-ai-coder"... }

You: 列出 src 目录的文件，然后读一下 index.ts
🔧 正在调用工具: list_files...
🔧 正在调用工具: read_file...
Agent: src 目录下有 index.ts 和 agent/，index.ts 的内容是...
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **工具三要素** | description（模型看）、parameters（模型填）、execute（我们执行） |
| **模型只点菜** | 模型不执行代码，只返回"调哪个工具、传什么参数" |
| **参数由模型填** | 我们定义结构，模型根据用户意图推断具体值 |
| **Agent Loop** | "模型→工具→模型"的循环，maxSteps 控制上限 |
| **zod** | TypeScript 数据验证库，自动生成 JSON Schema 发给模型 |
| **description 很关键** | 模型靠 description 决定要不要调用工具，写得好坏直接影响效果 |
| **finish_reason** | LLM 返回 `"tool_calls"` 表示还需继续循环，返回 `"stop"` 表示任务完成 |
| **arguments 是字符串** | LLM 返回的工具参数是 JSON 字符串，SDK 内部 `JSON.parse` 后再传给 `execute` |
| **消息历史演变** | 每轮循环都把 `assistant(tool_calls)` 和 `tool(result)` 追加到 messages，LLM 靠完整历史决策 |
| **软失败 vs 硬失败** | 可预期的失败返回 `{ error }` 让模型自愈；意外崩溃才抛异常（模型看不到，流程终止） |
| **onStepFinish** | 每个 Agent Loop 步骤完成时触发的回调，可拿到本步骤的 toolCalls/toolResults/usage |
| **可观测性** | 软失败需靠 onStepFinish 主动埋点（成功率/耗时/失败原因），否则监控对客户端状态失明 |

---

## 与其他课程的关联

- **第5课（手写 OpenAI API 调用）**：用原生 fetch 实现 generateText，彻底理解 LLM 请求/响应的 JSON 格式
- **第7课（手写 Agent Loop）**：自己实现本课讲的 while 循环，不依赖 SDK，彻底掌握工具调用的底层机制
