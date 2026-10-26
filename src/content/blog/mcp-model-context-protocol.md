---
title: MCP — Model Context Protocol
date: 2026-10-15
excerpt: MCP 把工具从 Agent 里抽成独立进程，用标准协议对外暴露。这篇从普通 Tool 的局限出发，讲清如何实现自定义 MCP Server，让 Cursor 等 Client 直接调用。
category: AI
faq:
  - q: "MCP 和普通 Tool 的本质区别是什么？"
    a: "普通 Tool 是「函数」，只能在定义它的 Agent 进程内部调用。MCP Tool 是「服务」，运行在独立进程里，通过标准协议对外暴露。任何支持 MCP 的 Client 都能直接调用，不必把工具代码复制过去重新注册。"
  - q: "为什么 stdio 模式下不能用 console.log？"
    a: "stdio 模式下 stdout 是协议专用数据线，流动的是按行分隔的 JSON-RPC。console.log 会写入非 JSON 文字，Client 解析失败甚至断开连接。调试应走 console.error（stderr）；Node 里 console.info / console.warn 默认也写 stdout，同样危险。"
  - q: "JSON-RPC 2.0 和普通 JSON 有什么区别？"
    a: "JSON 是数据格式；JSON-RPC 2.0 是用 JSON 做远程调用的协议约定。它只有请求、响应、通知三种消息，靠 id 匹配请求和响应。MCP 选它是因为工具调用是「动作」语义，且适合 stdio 双向流。"
  - q: "MCP Server 什么时候启动？"
    a: "Cursor 在需要时自动执行 mcp.json 里配置的命令来启动进程，不需要时自动关闭。你不需要手动管理进程生命周期。"
  - q: "Agent 怎么知道 MCP Server 能做什么？"
    a: "连接后 Client 立即发送 tools/list。Server 返回已注册工具的名称、描述和参数 schema，Client 再注入给模型。Agent 不是提前知道能力，而是每次连接时动态发现。"
---

> 目标：理解 MCP 协议，实现一个自定义 MCP Server，让 Cursor 能调用我们的工具

---

## 背景：普通 Tool 的局限

第4课我们实现了工具调用，工具是这样定义的：

```typescript
// src/agent/tools.ts
export const getCurrentTimeTool = tool({
  description: '获取当前的日期和时间',
  parameters: z.object({}),
  execute: async () => { ... },
});

export const agentTools = {
  get_current_time: getCurrentTimeTool,
  read_file: readFileTool,
  // ...
};

然后在 Agent 里注册：

```typescript
// src/agent/agent.ts
const result = await generateText({
  model: this.model,
  messages: messagesWithSystem,
  tools: agentTools,  // ← 工具和 Agent 绑定在一起
  maxSteps: 5,
});
```

**问题在哪？** 工具只能被这个 Agent 使用。Cursor、Claude Desktop、你同事写的另一个 Agent——全都用不了。每次想复用，就要把工具代码复制过去重新注册一遍。

**MCP 的解法**：把工具从 Agent 里抽出来，变成一个**独立进程**，通过标准协议对外暴露。任何支持 MCP 协议的 Client 都能直接调用，不需要改一行代码。

```
┌─────────────────────────────────────────────────────┐
│  MCP Client                    MCP Server           │
│  ┌──────────┐                  ┌────────────────┐   │
│  │  Cursor  │◄── JSON-RPC ────►│ simple-agent   │   │
│  │  Claude  │    over stdio    │ - get_time     │   │
│  │  我们的  │                  │ - read_file    │   │
│  │  Agent   │                  │ - list_files   │   │
│  └──────────┘                  │ - write_file   │   │
│                                └────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 第一步：创建 MCP Server 实例

```typescript
// src/mcp/server.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'simple-agent-tools',  // Server 的名字，Client 用来识别
  version: '1.0.0',
});
```

`McpServer` 是 MCP SDK 提供的核心类，负责：

- 管理工具注册表
- 处理 Client 发来的协议消息
- 把工具调用结果按协议格式返回

---

## 第二步：注册工具

MCP 工具的注册方式和第4课的 `tool()` 很像，但有两个关键区别：

```typescript
// 第4课：普通 tool
export const getCurrentTimeTool = tool({
  description: '获取当前的日期和时间',
  parameters: z.object({}),
  execute: async () => {
    return { datetime: '...', timestamp: 123 };  // ← 返回任意值
  },
});

// 第12课：MCP tool
server.tool(
  'get_current_time',              // 参数1：工具名（字符串）
  '获取当前的日期和时间（上海时区）', // 参数2：描述
  {},                              // 参数3：参数 schema（zod 格式，和普通 tool 一样）
  async () => {
    const now = new Date();
    const datetime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const timestamp = now.getTime();

    return {
      content: [                   // ← 必须是 content 数组，这是 MCP 协议规范
        {
          type: 'text',
          text: `当前时间：${datetime}（时间戳：${timestamp}）`,
        },
      ],
    };
  }
);
```

**区别1**：注册方式从"导出对象"变成"调用 `server.tool()`"

**区别2**：返回值格式固定为 `{ content: [{ type: 'text', text: '...' }] }`，这是 MCP 协议规定的，Client 按这个格式解析结果

---

## 第三步：带参数的工具

```typescript
// src/mcp/server.ts

server.tool(
  'read_file',
  '读取指定路径的文件内容',
  {
    // 参数 schema：和普通 tool 完全一样，用 zod 定义
    file_path: z.string().describe('要读取的文件绝对路径或相对于工作区的路径'),
  },
  async ({ file_path: filePath }) => {  // ← 参数从 schema 自动推断类型
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      return {
        content: [{ type: 'text', text: `错误：文件不存在 ${absolutePath}` }],
        isError: true,  // ← 标记这是错误响应，Client 会知道工具执行失败
      };
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lineCount = content.split('\n').length;

    return {
      content: [
        {
          type: 'text',
          text: `文件：${absolutePath}（共 ${lineCount} 行）\n\n${content}`,
        },
      ],
    };
  }
);
```

注意 `isError: true` 这个字段——普通 tool 里出错通常是 `return { error: '...' }`，MCP 协议有专门的错误标记，Client 可以据此决定是否重试或报错。

---

## 第四步：启动 Server（stdio 传输）

```typescript
// src/mcp/server.ts

export async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ⚠️ 这里必须用 console.error，不能用 console.log！
  console.error('[MCP Server] simple-agent-tools 已启动，等待连接...');
}
```

**为什么不能用 `console.log`？**

stdio 传输模式下，MCP 协议用 `stdout` 传输 JSON-RPC 消息：

```
stdin  ← Client 发送请求：{"jsonrpc":"2.0","method":"tools/call",...}
stdout → Server 返回响应：{"jsonrpc":"2.0","result":{...}}
stderr → 调试日志（不参与协议通信，可以随便写）
```

如果你在 `startServer()` 里写了 `console.log('启动成功')`，这段文字会混入 `stdout`，Client 收到后尝试按 JSON-RPC 格式解析，直接报错崩溃。

---

## 第五步：入口文件

```typescript
// src/mcp/index.ts

// MCP Server 入口：作为独立进程运行，通过 stdio 与 MCP Client 通信
// 运行方式：npx tsx src/mcp/index.ts
import { startServer } from './server.js';

startServer().catch((error) => {
  console.error('[MCP Server] 启动失败：', error);
  process.exit(1);
});
```

这个文件很简单，就是启动 Server。它的意义在于：**这是一个独立进程的入口**。Cursor 不会 `import` 我们的代码，而是用 `npx tsx src/mcp/index.ts` 启动一个子进程，然后通过 stdin/stdout 和它通信。

---

## 第六步：接入 Cursor

在项目根目录创建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "simple-agent-tools": {
      "command": "npx",
      "args": ["tsx", "src/mcp/index.ts"],
      "cwd": "/Users/takeseiko/code/ai/core/simple-agent"
    }
  }
}
```

这个配置告诉 Cursor：

- **`command` + `args`**：用什么命令启动 MCP Server 进程
- **`cwd`**：在哪个目录下执行（影响相对路径的解析）

Cursor 会在需要时自动启动这个进程，不需要时自动关闭，你不用手动管理。

重启 Cursor 后，在 Agent 模式下直接说"列出当前目录的文件"，Cursor 就会自动调用我们的 `list_files` 工具。

---

## 进阶：让我们自己的 Agent 也接入 MCP

前面讲的是 Cursor 作为 MCP Client 调用我们的 Server。现在反过来——**让我们自己写的 Agent 也能作为 MCP Client，动态拉取 MCP Server 的工具**。

### 第七步：创建 MCP Client（`src/mcp/client.ts`）

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tool } from 'ai';

export class McpClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(command: string, args: string[], cwd?: string) {
    // StdioClientTransport 会自动 spawn MCP Server 子进程
    this.transport = new StdioClientTransport({ command, args, cwd });
    this.client = new Client({ name: 'simple-agent-mcp-client', version: '1.0.0' });
  }

  async connect() { await this.client.connect(this.transport); }
  async disconnect() { await this.client.close(); }

  // 核心：拉取工具列表，转成 ai SDK 的 tool 格式
  async getTools(): Promise<Record<string, ReturnType<typeof tool>>> {
    // 1. 发送 tools/list 请求，拉取所有工具描述
    const { tools: mcpTools } = await this.client.listTools();

    const aiTools: Record<string, ReturnType<typeof tool>> = {};

    for (const mcpTool of mcpTools) {
      // 2. JSON Schema → zod schema（ai SDK 需要 zod 格式，MCP 返回 JSON Schema）
      const zodSchema = jsonSchemaToZod(mcpTool.inputSchema);

      aiTools[mcpTool.name] = tool({
        description: mcpTool.description ?? mcpTool.name,
        parameters: zodSchema,
        execute: async (args) => {
          // 3. 实际调用时，通过协议转发给 MCP Server 执行
          const result = await this.client.callTool({ name: mcpTool.name, arguments: args });
          // 4. 把 MCP 的 content 数组转成字符串返回给 ai SDK
          return result.content.filter(i => i.type === 'text').map(i => i.text).join('\n');
        },
      });
    }

    return aiTools;
  }
}
```

**最大的难点**：MCP 返回的工具参数是 **JSON Schema** 格式，但 ai SDK 的 `tool()` 需要 **zod schema**，需要手动做一次格式转换（`jsonSchemaToZod` 函数，见完整代码）。

### 第八步：Agent 接入 MCP 工具（`src/mcp-agent-demo.ts`）

```typescript
// 第一步：启动 MCP Client，连接到 MCP Server（自动 spawn 子进程）
const mcpClient = new McpClient('npx', ['tsx', 'src/mcp/index.ts'], process.cwd());
await mcpClient.connect();

// 第二步：动态拉取工具列表（tools/list）
const mcpTools = await mcpClient.getTools();
// → { get_current_time: tool(...), read_file: tool(...), ... }

// 第三步：注入 generateText，和第4课硬编码工具完全一样的用法！
const { text } = await generateText({
  model,
  messages,
  tools: mcpTools,  // ← 动态拉取的，不是硬编码的
  maxSteps: 5,
});
```

对比第4课的硬编码方式：

```typescript
// 第4课：工具在代码里写死
import { agentTools } from './agent/tools.js';
generateText({ tools: agentTools });

// 第12课：运行时从 MCP Server 动态拉取
const mcpTools = await mcpClient.getTools();
generateText({ tools: mcpTools });
```

**对 ai SDK 来说，两者没有任何区别**——都是一个 `Record<string, tool>` 对象。MCP 的魔法发生在 `getTools()` 内部，对外完全透明。

---

## 目录结构

```
simple-agent/
├── src/
│   ├── mcp/
│   │   ├── server.ts        ← MCP Server 核心：注册工具、启动服务
│   │   ├── index.ts         ← Server 入口：作为独立进程运行
│   │   └── client.ts        ← MCP Client：连接 Server，动态拉取工具
│   └── mcp-agent-demo.ts    ← Agent 接入 MCP 的完整演示
├── .cursor/
│   └── mcp.json             ← Cursor 配置：告诉 Cursor 如何启动我们的 Server
```

---

## 运行方式

**测试 MCP Server 是否正常启动：**

```bash
npx tsx src/mcp/index.ts
# stderr 输出：[MCP Server] simple-agent-tools 已启动，等待连接...
# Ctrl+C 退出
```

**运行 Agent 接入 MCP 的演示：**

```bash
npx tsx src/mcp-agent-demo.ts
# Agent 会自动启动 MCP Server 子进程，拉取工具列表，然后进入对话
```

**通过 Cursor 使用：**

1. 确保 `.cursor/mcp.json` 配置正确（`cwd` 改成你的实际路径）
2. 重启 Cursor
3. 在 Cursor Agent 模式下，直接说"列出当前目录的文件"，Cursor 会自动调用我们的 `list_files` 工具

---

## 普通 Tool vs MCP Tool 对比


| 对比维度     | 普通 Tool（第4课）        | MCP Tool（本课）                |
| ------------ | ------------------------- | ------------------------------- |
| **作用范围** | 只能被当前 Agent 调用     | 任何 MCP Client 都能调用        |
| **运行方式** | 在 Agent 进程内执行       | 独立进程，通过协议通信          |
| **复用性**   | 每个 Agent 重新定义       | 一次实现，到处使用              |
| **接入方式** | 代码里`tools: agentTools` | 配置 JSON 文件                  |
| **返回格式** | 任意值                    | `{ content: [{ type, text }] }` |
| **错误标记** | 自定义`{ error: '...' }`  | `isError: true`                 |

---

## MCP 协议全景：生命周期 / 原语 / 错误码 / SDK 分层

前面几节从"动手实现"讲了 Server & Client & 远端传输，这里把 MCP **协议本身**归成一张全景图，方便日后反查。

### 三种消息形态（JSON-RPC 2.0）

`jsonrpc` 恒为 `"2.0"`。**判定是哪种消息，就看有没有 `id`**：有 `id` 是 Request（必期待响应）；无 `id` 是 Notification（不期待响应）。


| 消息             | 有没有`id`          | 期待响应   | 例子                                                       |
| ---------------- | ------------------- | ---------- | ---------------------------------------------------------- |
| **Request**      | ✅                  | 对方必须回 | `tools/list`、`tools/call`、`initialize`                   |
| **Response**     | ✅（沿用请求的 id） | 发起者接收 | `{ "id":1, "result":{...} }` / `{ "id":1, "error":{...} }` |
| **Notification** | ❌                  | 无人期待   | `notifications/initialized`                                |

成功用 `result`、失败用 `error`，**二者互斥**。`id` 是请求与响应配对的钥匙：同一连接可并发发多个请求，靠 `id` 各找各的响应（通知无 `id`，Server 可主动推送进度）——这就是 MCP 选 JSON-RPC 的原因。

### 错误码标准


| code              | 含义                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `-32700`          | 解析错误（非法 JSON）                                             |
| `-32600`          | 非法请求                                                          |
| `-32601`          | 方法不存在（method not found）                                    |
| `-32602`          | 参数错误（invalid params）                                        |
| `-32603`          | 内部错误                                                          |
| `-32000 ~ -32099` | **MCP 保留**，供 Server 自定义错误（如资源找不到常返回 `-32002`） |

### 生命周期：三次握手

```
Client                                 Server
  │  1. initialize（协议版本 + capabilities）─────►
  │  ◄───────────────────────────── 2. 响应：协议版本、capabilities、instructions
  │  3. notifications/initialized ─────►   ← 进入"操作阶段"
  │  ......... 正常操作：tools/list、tools/call、resources/read、ping .........
  │  ◄───── Server 可主动推 notifications/tools/list_changed 等
  │  4. 关闭：断开传输层（协议没有标准关闭请求）
```

`initialize` 里的 `protocolVersion` 双方**取较低的版本降级协商**；`capabilities` 声明各自能力集。

### 三大原语

MCP 给 LLM 提供"感知 + 行动"，靠的就是这三样，各有专属方法：

**Tools（可执行动作，最常用）**


| 方法                               | 方向 | 说明                                               |
| ---------------------------------- | ---- | -------------------------------------------------- |
| `tools/list`                       | C→S | 枚举工具（含 JSON Schema 入参），支持`cursor` 分页 |
| `tools/call`                       | C→S | 调用工具，返回执行结果                             |
| `notifications/tools/list_changed` | S→C | 工具列表变更通知                                   |

**Resources（可读取的数据/文件）**


| 方法                                          | 说明                                          |
| --------------------------------------------- | --------------------------------------------- |
| `resources/list` / `resources/templates/list` | 枚举资源 / 参数化 URI 模板                    |
| `resources/read`                              | 按`uri` 读取，返回 `text` 或 `blob`（base64） |
| `notifications/resources/list_changed`        | 资源变更通知                                  |

**Prompts（可复用的提示模板）**


| 方法                                 | 说明                                       |
| ------------------------------------ | ------------------------------------------ |
| `prompts/list` / `prompts/get`       | 枚举模板 / 拟合参数返回带 role 的 messages |
| `notifications/prompts/list_changed` | 模板变更通知                               |

> 注意：工具的入参是 **JSON Schema**（不是 zod）——这正是前面 `McpClient` 里要 `jsonSchemaToZod` 转换的原因。`server.tool()` / `server.resource()` / `server.prompt()` 只是 SDK 把底层方法封装成了简单 API。

### 内容类型 Content

Tool / Resource 返回的 `content` 数组，每项按类型定型：

```json
{ "type": "text",       "text": "..." }
{ "type": "image",      "data": "<base64>", "mimeType": "image/png" }
{ "type": "resource",   "resource": { "uri": "...", "text": "...", "mimeType": "..." } }
```

工具执行"失败但可恢复"时返回 `{ "content": [...], "isError": true }`，Client 可据此决定重试还是报错。

### SDK 三层封装

你现在用的 `McpServer` 只是**最高一层**的封装，下面还有两层：

```
第1层：Protocol   → JSON-RPC 收发、自动分配 id、能力校验、ping 自动回 pong
   └─ 第2层：Server  → 把 request/response/notification 路由到对应 handler
        └─ 第3层：McpServer → 把 tool/resource/prompt 结构化注册成" Server API"
```

所以 `server.tool()` 最终会被转成 `tools/list`、`tools/call` 等**标准 JSON-RPC 消息**走 transport 出去。**协议本身才是硬标准，SDK 只是生成/解析这些报文的实现。**

### 几个反直觉的隐藏细节

1. **`ping` 不用自己实现**：SDK 的 `McpServer` 默认自动回 `{}`。`ping` 是探活请求，收到必须及时应答，否则可能被对方断连。
2. **能力协商是强制的**：必须在 `initialize` 里声明 `capabilities`；SDK 在调某方法前会 `assertCapabilityForMethod()`，**没协商过的能力方法不能调**。
3. **`id` 匹配由 SDK 兜底**：`Client.callTool()` → `Protocol.request()`（自动分配唯一 `id`、建响应 Promise、`transport.send()`）→ `_onResponse()` 用同一 `id` 还原响应。若手写裸 JSON-RPC，这套 `id` 关联得自己维护。

---

## 核心问题回答

**Q：MCP 和普通 Tool 的本质区别是什么？**

A：普通 Tool 是"函数"，只能在定义它的 Agent 进程内部调用。MCP Tool 是"服务"，运行在独立进程里，通过标准协议对外暴露。就像本地函数 vs REST API——API 可以被任何人调用，本地函数只能在同一个程序里用。

**Q：为什么 stdio 模式下不能用 `console.log`？**

A：这是 MCP stdio 传输模式里最经典的一个坑。**核心：stdio 模式下，stdout 是一根"专用数据线"，不是给人看的输出。**

MCP 的 stdio 传输模式，Client 通过启动子进程的方式运行 Server，三条标准流各司其职：

```
Client（父进程）
   │  stdin  ──────────→  Server（子进程）   Client 把请求写进 Server 的 stdin
   │  stdout ←──────────  Server（子进程）   Server 把响应写到自己的 stdout
   │  stderr ←──────────  Server（子进程）   日志/调试信息走这里
```

stdout 被协议征用，里面流动的是按行分隔的 JSON-RPC 消息（newline-delimited JSON），Client 的读取逻辑是逐行 `JSON.parse`：

```typescript
// Client 端伪代码
serverProcess.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);  // ← 每一行都必须是合法 JSON
    handleMessage(message);
  }
});
```

一旦随手写了 `console.log('收到请求了', params)`，stdout 就变成：

```
收到请求了 { path: '/tmp' }                ← 调试文字，不是 JSON
{"jsonrpc":"2.0","id":1,"result":{...}}    ← 真正的协议消息
```

Client 读到第一行时 `JSON.parse` 直接抛异常——轻则丢弃消息报 `ParseError`，重则认为 Server 协议损坏**直接断开连接**。而且这种 bug 极难排查：Server 本地跑得好好的，一被 Client 连上就断。

正确姿势是调试信息走 stderr（`console.error` 写向 stderr，不参与协议传输）：

```typescript
console.error('[debug] 收到请求，参数:', params);  // ✅ 安全
```


| 输出方式                        | 写向                | 在 stdio 模式下的后果            |
| ------------------------------- | ------------------- | -------------------------------- |
| `console.log`                   | stdout              | 💥 污染协议通道，Client 解析失败 |
| `console.info` / `console.warn` | stdout（Node 默认） | 💥 同样污染                      |
| `console.error`                 | stderr              | ✅ 安全，走日志通道              |

> 注意 Node.js 细节：`console.log`、`console.info`、`console.warn` **默认都写 stdout**，只有 `console.error` 写 stderr。所以不是"只有 log 危险"，而是"除了 error 都危险"。

延伸：这也正是 stdio 与 HTTP/SSE 模式的本质区别——HTTP/SSE 走网络端口，stdout 没被占用，可以随便 `console.log`。很多 MCP SDK 还提供专门的 logging 机制，通过 `notifications/message` 这条 JSON-RPC 通知把日志**合法地**发给 Client，而不是往 stdout 裸写文字。

**Q：JSON-RPC 2.0 是什么？和普通 JSON 有什么区别？**

A：**一句话：JSON 是"数据格式"，JSON-RPC 2.0 是"用 JSON 格式来发起远程调用的协议约定"。** 两者不是同一层的东西。

JSON 本身只规定数据长什么样（键值对、数组、字符串），不关心你拿它干嘛。而 JSON-RPC 2.0 是一个**远程过程调用（RPC）协议**，规定用 JSON 表达"调用某个方法、拿到结果"时必须遵守的固定结构。它只有三种消息：

**1. 请求（Request）** —— "调用某个方法"

```json
{
  "jsonrpc": "2.0",          // 必须是 "2.0"，标识协议版本
  "method": "tools/call",    // 要调用的方法名
  "params": { "name": "read_file" },  // 参数
  "id": 1                    // 请求编号，用来匹配响应
}
```

**2. 响应（Response）** —— "调用的结果"，成功和失败二选一

```json
// 成功
{ "jsonrpc": "2.0", "id": 1, "result": { "content": "文件内容..." } }
// 失败
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found" } }
```

**3. 通知（Notification）** —— "只告诉你一声，不用回"（没有 `id` 字段）

```json
{ "jsonrpc": "2.0", "method": "notifications/progress", "params": {...} }
```


|                      | 普通 JSON        | JSON-RPC 2.0                                          |
| -------------------- | ---------------- | ----------------------------------------------------- |
| **本质**             | 数据格式（语法） | 调用协议（语义约定）                                  |
| **层级**             | 底层             | 建立在 JSON 之上                                      |
| **结构**             | 任意合法结构     | 必须有`jsonrpc`、`method`/`result`/`error` 等固定字段 |
| **有无"动作"含义**   | ❌ 纯数据        | ✅ 表达"调用 → 响应"                                 |
| **有无 id 匹配机制** | ❌               | ✅ 靠`id` 把请求和响应对上                            |

MCP 用它的原因：`id` 让 Client 在并发时把响应对应到正确的请求；`result`/`error` 互斥便于判断成败；通知无 `id`，Server 可主动推送进度。

类比理解：**JSON ≈ 信封和纸张的规格，JSON-RPC 2.0 ≈ 寄信规则**（收件人写哪、怎么编号对账）。REST API 的响应体也是 JSON，但不是 JSON-RPC——JSON-RPC 只是"用 JSON 承载 RPC 调用"的一种标准化玩法。

顺带对比 REST：JSON-RPC 面向**动作**（`method: "tools/call"`）、单一端点，适合双向通信和工具调用；REST 面向**资源**（`GET /tools/123`）、多端点，适合 CRUD。MCP 选 JSON-RPC 正是因为工具调用天然是"动作"语义，且 stdio 双向流更适合一问一答+通知的模式。

**Q：stdin 听起来像进程间通信的手段？**

A：**直觉正确。** stdin/stdout/stderr 确实是最古老、最朴素的**进程间通信（IPC, Inter-Process Communication）**手段之一。

IPC 的定义是两个独立进程之间交换数据，stdio 通信恰好满足：Client 用 `spawn` 启动 Server 子进程，操作系统把父子进程之间的**管道（pipe）**接好，之后双方靠读写管道传数据。stdin/stdout 本身只是"标准输入/输出流"的抽象，真正让它们变成 IPC 的是背后的 pipe 机制。

stdio 在 IPC 家族里的位置：


| IPC 手段              | 原理                 | 特点                                         |
| --------------------- | -------------------- | -------------------------------------------- |
| **管道 pipe / stdio** | 字节流，单向         | 最简单，父子进程间，MCP stdio 模式用的就是它 |
| **命名管道 FIFO**     | 有名字的管道         | 无亲缘关系的进程也能用                       |
| **Socket**            | 网络套接字           | 可跨机器，HTTP/SSE 走这个                    |
| **共享内存**          | 多进程读写同一块内存 | 最快，但要自己处理同步                       |
| **消息队列**          | 内核维护的队列       | 结构化消息                                   |
| **信号 signal**       | 异步通知             | 只能传很简单的信息                           |

stdio 作为 IPC 的优缺点（也是 MCP 选它的原因）：

- **优点**：零配置（不用开端口建连接）、跨语言（任何语言都能读写）、天然隔离（子进程崩了不影响父进程）、无需网络
- **缺点**：只能父子关系、不能跨机器、单通道串行（消息得排队，所以 JSON-RPC 需要 `id` 匹配）

这正好解释了 MCP 为什么要设计两种 transport：


|          | stdio                          | HTTP/SSE               |
| -------- | ------------------------------ | ---------------------- |
| 底层 IPC | 管道（pipe）                   | Socket（网络）         |
| 进程关系 | 必须父子（Client 启动 Server） | 任意，可跨机器         |
| 部署     | Server 随 Client 起停          | Server 独立常驻        |
| 适用     | 本地工具、IDE 插件             | 远程服务、多客户端共享 |

**一句话总结**：stdio 确实是 IPC 手段——靠操作系统管道把父子进程连起来传字节流。MCP stdio 模式就是"把 JSON-RPC 消息塞进这根管道"，简单可靠，但代价是只能本地、只能父子关系。

**Q：MCP Server 什么时候启动？**

A：Cursor 在需要时自动执行 `mcp.json` 里配置的命令来启动进程，不需要时自动关闭。你不需要手动管理进程生命周期。

**Q：MCP 接入后，Agent 怎么知道 MCP Server 能做什么？**

A：这是 MCP 协议的核心机制之一——**工具发现（Tool Discovery）**。流程如下：

1. MCP Client 连接到 Server 后，立即发送一个 `tools/list` 请求
2. Server 把所有已注册工具的**元信息**返回给 Client：工具名、描述、参数 schema（JSON Schema 格式）
3. Client 把这些元信息转成 ai SDK 的 `tool()` 格式，注入到 `generateText` 的 `tools` 参数里
4. ai SDK 把工具描述拼进 System Prompt，LLM 就知道"我有哪些工具、每个工具是干什么的、需要什么参数"

```typescript
// McpClient.getTools() 内部做的事：
const { tools: mcpTools } = await this.client.listTools(); // ← 发送 tools/list 请求

for (const mcpTool of mcpTools) {
  // mcpTool.name        → 工具名
  // mcpTool.description → 工具描述（LLM 靠这个判断什么时候调用）
  // mcpTool.inputSchema → 参数 schema（JSON Schema 格式）
  aiTools[mcpTool.name] = tool({ ... });
}
```

所以 Agent 并不是"提前知道"MCP 能做什么，而是**每次连接时动态询问**。这也是 MCP 灵活的地方——Server 可以随时增减工具，Client 下次连接就能自动感知变化，不需要改任何代码。

**Q：`spawn` 是什么意思？**

A：`spawn` 的英文原意是"产卵、大量产生"，在编程里专指**创建子进程**。

Node.js 有内置的 `child_process.spawn()` 函数，用于启动一个新的操作系统进程。`StdioClientTransport` 内部就是调用它来启动 MCP Server 进程的：

```
你的 Agent 进程（父进程）
    │
    │  child_process.spawn('npx', ['tsx', 'src/mcp/index.ts'])
    │  ← 这就是 "spawn 一个子进程"
    ▼
MCP Server 进程（子进程）
    │
    │  stdin ← 父进程发请求
    │  stdout → 父进程收响应
    │  stderr → 调试日志
```

你在 `McpClient` 构造函数里传入的 `command` 和 `args`，最终就是被 `spawn` 用来启动子进程的命令：

```typescript
// 你写的：
const mcpClient = new McpClient('npx', ['tsx', 'src/mcp/index.ts'], process.cwd());

// StdioClientTransport 内部等价于：
const child = child_process.spawn('npx', ['tsx', 'src/mcp/index.ts'], { cwd: process.cwd() });
// 然后通过 child.stdin / child.stdout 进行 JSON-RPC 通信
```

简单记忆：**spawn = 生出一个新进程**。

---

### 动手写一个：纯 JS 的 spawn + stdin 通信示例

不依赖任何库，两个文件，还原 MCP stdio 模式最底层的通信原理：**父进程 spawn 出子进程，往子进程的 stdin 写数据，子进程处理后从 stdout 写回来**。

**child.js —— 子进程：从 stdin 按行读取，转成大写后从 stdout 写回**

```javascript
// child.js —— 子进程
// 职责：监听 stdin，每收到一行就转成大写，通过 stdout 返回
// 单独运行：node child.js，然后手动敲字回车即可看到效果

// 日志走 stderr，不污染 stdout（和 MCP Server 的规矩一样）
process.stderr.write('[child] 子进程已启动，等待 stdin 输入...\n');

process.stdin.setEncoding('utf-8');

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // 按换行符切分，处理"粘包"：一次 data 事件可能包含多行
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (line === 'exit') {
      process.stdout.write('bye\n');
      process.exit(0);
    }

    // 处理结果从 stdout 写回给父进程
    process.stdout.write(`echo: ${line.toUpperCase()}\n`);
  }
});
```

**parent.js —— 父进程：spawn 子进程，往它的 stdin 写，从它的 stdout 读**

```javascript
// parent.js —— 父进程
// 运行方式：node parent.js

const { spawn } = require('node:child_process');
const path = require('node:path');

// 1. spawn 出子进程，等价于在终端执行 `node child.js`
const child = spawn('node', [path.join(__dirname, 'child.js')], {
  // stdio: ['pipe', 'pipe', 'inherit'] 的含义：
  //   stdin  → pipe：父进程可以往 child.stdin 写数据
  //   stdout → pipe：父进程可以从 child.stdout 读数据
  //   stderr → inherit：子进程的 stderr 直接接到父进程的终端，日志直接可见
  stdio: ['pipe', 'pipe', 'inherit'],
});

// 2. 监听子进程的 stdout —— 这就是"通信通道"的读端
child.stdout.setEncoding('utf-8');
child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim()) {
      console.log(`[parent] 收到子进程回复 → ${line}`);
    }
  }
});

// 3. 子进程退出时的收尾
child.on('exit', (code) => {
  console.log(`[parent] 子进程已退出，exit code = ${code}`);
});

// 4. 往子进程的 stdin 写数据 —— 这就是"通信通道"的写端
child.stdin.write('hello world\n');
child.stdin.write('mcp is fun\n');

// 5. 延迟 500ms 再发 exit，确保前面的消息先被处理
setTimeout(() => {
  child.stdin.write('exit\n');
}, 500);
```

**运行：**

```bash
node parent.js
```

**预期输出：**

```
[child] 子进程已启动，等待 stdin 输入...
[parent] 收到子进程回复 → echo: HELLO WORLD
[parent] 收到子进程回复 → echo: MCP IS FUN
[parent] 收到子进程回复 → bye
[parent] 子进程已退出，exit code = 0
```

**对照 MCP 看这个例子**：


| 示例里的角色                    | 对应 MCP stdio 模式                   |
| ------------------------------- | ------------------------------------- |
| `parent.js`                     | MCP Client（如 Cursor、我们的 Agent） |
| `child.js`                      | MCP Server                            |
| `child.stdin.write(...)`        | Client 发送 JSON-RPC 请求             |
| `child.stdout` 上的 `data` 事件 | Client 接收 JSON-RPC 响应             |
| 子进程的`process.stderr.write`  | Server 的`console.error` 调试日志     |
| 按`\n` 切分 buffer              | MCP 的"按行分隔 JSON"消息边界         |

唯一的区别是：这个例子里传的是普通文本，MCP 把文本换成了**每行一个 JSON-RPC 消息**。理解了这段代码，就理解了 `StdioClientTransport` 内部做的事。

---

## 进阶：远端 MCP 与 2026 规范演进

前面讲的都是本地 stdio 模式。这一节展开远端 MCP：怎么调用、怎么授权、POST/SSE 如何协商，以及 2026-07-28 规范的重大更新。

### 远端 MCP 是怎么调用的

远端 MCP 走 **HTTP 传输**，不再 spawn 子进程，而是像调 REST API 一样连一个 URL：

```
stdio 模式：Client spawn 子进程 → 管道通信（本地）
远端模式：  Client 发 HTTP 请求 → 远端服务器响应（可跨机器）
```

配置上的差异一目了然：

```json
// stdio：配置的是"启动命令"
{ "mcpServers": { "local-tools": { "command": "npx", "args": ["tsx", "server.ts"] } } }

// 远端：配置的是"URL"
{ "mcpServers": { "remote-tools": { "url": "https://mcp.example.com/mcp" } } }
```

**两代传输方案**：

第一代 **HTTP + SSE（双端点）**：Client 先 `GET /sse` 建立 SSE 长连接专门收响应，发请求用 `POST /messages`。问题是需要两个端点、长连接有状态，对负载均衡/无服务器部署不友好。

第二代 **Streamable HTTP（单端点，新规范主推）**：只有一个端点，所有交互都走 `POST /mcp`。简单请求直接返回 JSON；长任务的响应升级为 SSE 流，Server 边执行边推进度。无状态友好，适合云端部署。

完整调用流程（以 tools/call 为例）：

```
1. initialize 握手（交换协议版本、能力）
2. tools/list → 拿到工具元信息（和 stdio 一样）
3. LLM 决定调用某工具
4. POST：{ "jsonrpc":"2.0", "id":3, "method":"tools/call", "params":{...} }
5. Server 执行并返回：{ "jsonrpc":"2.0", "id":3, "result":{...} }
6. Client 把结果喂回 LLM，继续 Agent Loop
```

**注意**：JSON-RPC 消息格式和 stdio 完全一样，变的只是运输工具——从"管道里的字节流"变成"HTTP 请求体"。

### MCP 授权是怎么做的

授权分两个层面：**远端服务的 OAuth 2.0 标准流程**和**本地 Server 的凭证注入**。

**远端 MCP：OAuth 2.1 授权码流程**（和"用 GitHub 登录第三方应用"同一套机制）：

```
Client                                远端 MCP Server
  │  1. POST /mcp（无 token）──────────→
  │  ←────────────────────────────────  401 Unauthorized（告知授权服务器地址）
  │  2. 打开浏览器跳转授权页 ──────────→  Authorization Server
  │     用户登录 + 点击"授权"
  │  ←────────────────────────────────  3. 回调带回 authorization code
  │  4. 用 code 换 access_token ──────→
  │  ←────────────────────────────────  返回 access_token（+ refresh_token）
  │  5. 后续请求带 Authorization: Bearer <token> → 正常响应
```

关键设计点：动态客户端注册（Client 首次连接自动注册，即插即用）、PKCE（防授权码截获）、token 静默刷新、scope 控制权限范围。

日常见到的几种形态：


| 形态                     | 例子                     | 授权方式                            |
| ------------------------ | ------------------------ | ----------------------------------- |
| **浏览器 OAuth 弹窗**    | GitHub/Notion/Linear MCP | 标准 OAuth 流程，点"授权"即可       |
| **API Key / PAT**        | 自建 Server、托管 Server | 配置里填 token，放 Authorization 头 |
| **托管平台代发**         | Smithery、mcp.run        | 平台统一 OAuth，再注入各 Server     |
| **本地 Server 自带凭证** | 文件系统、数据库类       | 不走网络授权，凭证在环境变量里      |

**本地 stdio Server 的"授权"= 凭证注入**（通过环境变量传给子进程）：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxx" }
    }
  }
}
```

"授权"发生在生成 PAT 的时候（在 GitHub 网站勾选权限），而不是连接 MCP 的时候。

**容易混淆的两层授权**：

```
用户 ──OAuth──→ MCP Server ──Server 自己的凭证──→ 下游 API（GitHub/数据库）
     （第一层：你能不能用这个 Server）   （第二层：Server 有没有权限调下游）
```

这就是为什么有些 Server 要你"连接后还要再授权一次下游服务"。

### POST 和 SSE 什么时候用

**POST 和 SSE 不是二选一的两种请求，而是"请求"和"响应形态"的关系**——永远用 POST 发起，SSE 只是响应体可能呈现的形态之一。

**情况一：简单请求 → 普通 JSON 响应**（`initialize`、`tools/list`、快速工具）：

```
Client:  POST /mcp  { "method": "tools/list" }
Server:  200 OK, Content-Type: application/json
         { "jsonrpc":"2.0", "id":1, "result": {...} }   （连接随即结束）
```

**情况二：长任务/需推送 → 响应升级为 SSE 流**：

```
Client:  POST /mcp  { "method": "tools/call", "params": {"name":"long_task"} }
Server:  200 OK, Content-Type: text/event-stream        ← 响应类型变了
         data: {进度通知 30%}
         data: {进度通知 80%}
         data: {最终结果}                                  （流结束，连接关闭）
```

Client 发完 POST 后，**根据响应头 Content-Type 决定怎么读**：`application/json` 读一次就结束；`text/event-stream` 持续监听直到流关闭。

**谁来决定用 SSE？——Server 决定，但必须在 Client 允许的范围内**：

```
1. Client 发 POST，Accept 头声明可接受的形态：
   Accept: application/json, text/event-stream
2. Server 检查 Accept：
   - Client 不接受 SSE → 只能返回 JSON
   - Client 接受 SSE → 按任务性质自由选择
3. Server 判断：快任务 → JSON；长任务/需推进度 → SSE 流
4. Client 读 Content-Type，按对应方式解析
```

边界情况：Client 只接受 JSON 但任务很长时，Server 要么硬扛（等完再返回，Client 可能超时），要么报错提示需要流式支持。所以规范的 Client 都会把 `text/event-stream` 写进 Accept。

### 2026-07-28 规范更新：无状态化

2026 年 7 月的规范修订版（2026-07-28）是一次重大更新，主题是一个词：**无状态化（Stateless）**。

**最核心的变化**：

- **移除会话机制**：删除 `Mcp-Session-Id` 头和协议级会话；删除 `initialize` / `notifications/initialized` 握手。每个请求在 `_meta` 里自带协议版本和 Client 能力，Server 在每个响应的 `_meta` 里自报身份
- **新增 `server/discover`**：Server 必须实现此 RPC，声明支持的协议版本和能力，Client 可在任何请求前先探测
- **订阅机制重构**：HTTP GET 端点和 `resources/subscribe` 被 `subscriptions/listen` 取代——一个长连接 POST 响应流，Client 按需订阅变更通知
- **移除 SSE 断点续传**：删掉 `Last-Event-ID` 和消息重发。流断了就丢了，Client 必须用新的 request ID 重新发起请求
- **移除 `ping`、`logging/setLevel`**：日志级别改为每个请求通过 `_meta` 单独指定
- **Tasks 移出核心协议**：变成官方扩展 `io.modelcontextprotocol/tasks`，用 `tasks/get` 轮询替代阻塞式 `tasks/result`
- **多轮往返请求（MRTR）**：替代 Server 主动发起请求的旧方式。Server 返回 `resultType: "input_required"`，Client 补齐信息后重试原请求。所有结果现在都必须带 `resultType` 字段
- **废弃 Roots、Sampling、Logging 三大特性**：仍可用但新实现不应再支持
- **HTTP+SSE 传输正式归类为 Deprecated**：应迁移到 Streamable HTTP
- **废弃 OAuth 动态客户端注册（RFC7591）**：改用 Client ID Metadata Documents

### 无状态化带来的收益

**1. 水平扩展变得轻而易举**。有状态时必须做会话粘滞（sticky session），实例挂了会话全丢、扩缩容要迁移会话、负载不均。无状态后任何实例都能处理任何请求，负载均衡器随便分发，实例随时可增可删。

**2. 完美适配 Serverless / FaaS**。有状态长连接没法跑在 Lambda/函数计算上。无状态后每个请求独立自包含，可以按需冷启动、零成本闲置、自动扩容——对托管型 MCP 服务是质变。

**3. 容错和恢复变简单**。断点续传要 Server 缓存已发消息、维护游标，是 bug 温床。无状态后断了就重发，Server 不存任何中间状态，没有需要恢复的东西。

**4. 缓存命中率提升，省 token 省钱**。请求不依赖会话上下文，`tools/list` 结果对所有 Client 都一样，可走 CDN/共享缓存；工具列表稳定使 LLM prompt cache 命中率大幅提高，直接降低 token 成本。

**5. 开发和调试门槛降低**。不用实现握手状态机和会话生命周期管理；每个请求自包含，可用 curl 单独测试重放；标准 HTTP 中间件生态（网关、限流、监控、链路追踪）即插即用。

**代价**（公平起见）：


| 代价                   | 说明                                                     |
| ---------------------- | -------------------------------------------------------- |
| **请求变大**           | 每个请求都要带`_meta`（版本、能力、身份），有冗余        |
| **跨调用状态要自己管** | 需要状态的 Server 得自己发"句柄"（handle）当参数传来传去 |
| **断流丢请求**         | 没有重发机制，长任务断流要整个重来                       |
| **老特性陪葬**         | Roots/Sampling/Logging 被废弃，生态要迁移                |

### 无状态化后 SSE 还支持吗

**支持，但 SSE 的角色变了**——从"常驻的会话通道"降级为"单个请求的响应形态"。

关键区分：**SSE 本身不是"状态"**。被砍掉的是绑定在会话上的 SSE，而不是 SSE 这种技术：

```
旧模式（有状态）：
  GET /sse 挂一条长连接 ──绑定会话──→ 所有响应都从这条流推
  （连接即会话，断了要 Last-Event-ID 续传）

新模式（无状态）：
  POST /mcp 发一个请求 ──→ 这个请求的响应体恰好是 SSE 流
  （流的生命周期 = 单个请求的生命周期，和会话无关）
```

无状态下 SSE 的两种存活形态：

1. **请求作用域的 SSE 流（主力）**：流只活在这一次请求里，请求结束一切归零，没有任何跨请求状态。长任务也能享受无状态，因为"长"的只是这一个请求的响应时间，不是会话
2. **`subscriptions/listen`（可选订阅流）**：替代旧的 GET 端点，也是 POST 发起，Client 主动选择挂这条流，不承载会话状态，断了重连重新订阅即可

被砍掉的 SSE 相关能力：`Last-Event-ID` 断点续传（续传需要 Server 缓存已发消息 = 状态）、SSE 事件 ID/消息重发、GET 端点常驻连接。

设计自洽性：

```
无状态原则：Server 不保存跨请求的状态
   │
   ├─ SSE 流只活在单个请求内 → 不违反 ✅
   ├─ 断点续传要 Server 存已发消息 → 违反 → 砍掉 ❌
   └─ 常驻连接绑定会话 → 违反 → 改为可选订阅流 ❌→✅
```

**一句话总结**：无状态化后 SSE 依然支持，但从"绑定会话的常驻通道"变成"单个请求的响应形态"——长任务的进度推送照样能用，只是流的生命周期被限制在一次请求内，断了就重新发请求。既保住了流式能力，又守住了无状态原则。

**整节总结**：2026-07-28 版的主线是"去状态化"——砍掉会话、砍掉握手、砍掉断点续传，让每个请求自包含。本质是让 MCP Server 享受现代 HTTP 基础设施的全部红利，和当年 REST 取代有状态长连接、微服务取代单体是同一条演进路线。

```

```

