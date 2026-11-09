---
title: "MCP — Model Context Protocol: Build a Custom Server Cursor Can Call"
date: 2026-10-15
excerpt: "MCP pulls tools out of the agent into a standalone process and exposes them over a standard protocol. Starting from the limits of ordinary in-process tools, this post walks through a custom MCP Server that clients like Cursor can call directly — plus remote MCP, auth, and the 2026 stateless spec."
category: AI Infrastructure
lang: en
faq:
  - q: "What is the essential difference between MCP and an ordinary Tool?"
    a: "An ordinary Tool is a function that can only be called inside the agent process that defined it. An MCP Tool is a service that runs in a standalone process and is exposed over a standard protocol. Any client that speaks MCP can call it; you do not copy the tool code over and register it again."
  - q: "Why can't you use console.log in stdio mode?"
    a: "In stdio mode, stdout is a dedicated protocol wire for newline-delimited JSON-RPC. console.log writes non-JSON text, so the client fails to parse or disconnects. Send debug to console.error (stderr). In Node, console.info and console.warn also write stdout by default and are equally unsafe."
  - q: "What is JSON-RPC 2.0, and how is it different from ordinary JSON?"
    a: "JSON is a data format; JSON-RPC 2.0 is a protocol convention for remote calls in JSON. It has only request, response, and notification messages, and uses id to pair requests with responses. MCP picked it because a tool call is an action, and a bidirectional stdio stream fits request/response plus notifications."
  - q: "When does the MCP Server start?"
    a: "Cursor runs the command configured in mcp.json when it needs the process, and shuts it down when it does not. You do not manage the process lifecycle yourself."
  - q: "How does the agent know what the MCP Server can do?"
    a: "After connecting, the client sends tools/list. The server returns name, description, and parameter schema for every registered tool; the client injects that into the model. The agent does not know in advance — it discovers tools dynamically on every connection."
---

> Goal: understand the MCP protocol, implement a custom MCP Server, and let Cursor call our tools

---

## Background: the limits of ordinary tools

In lesson 4 we implemented tool calling. A tool was defined like this:

```typescript
// src/agent/tools.ts
export const getCurrentTimeTool = tool({
  description: 'Get the current date and time',
  parameters: z.object({}),
  execute: async () => { ... },
});

export const agentTools = {
  get_current_time: getCurrentTimeTool,
  read_file: readFileTool,
  // ...
};
```

Then we registered it on the agent:

```typescript
// src/agent/agent.ts
const result = await generateText({
  model: this.model,
  messages: messagesWithSystem,
  tools: agentTools,  // ← tools are bound to this agent
  maxSteps: 5,
});
```

**What is the problem?** The tools can only be used by this agent. Cursor, Claude Desktop, another agent a colleague wrote — none of them can use them. Every time you want reuse, you copy the tool code over and register it again.

**MCP's answer**: pull the tools out of the agent, turn them into a **standalone process**, and expose them over a standard protocol. Any client that speaks MCP can call them directly. You do not change a line of application code.

```
┌─────────────────────────────────────────────────────┐
│  MCP Client                    MCP Server           │
│  ┌──────────┐                  ┌────────────────┐   │
│  │  Cursor  │◄── JSON-RPC ────►│ simple-agent   │   │
│  │  Claude  │    over stdio    │ - get_time     │   │
│  │  our     │                  │ - read_file    │   │
│  │  Agent   │                  │ - list_files   │   │
│  └──────────┘                  │ - write_file   │   │
│                                └────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## Step 1: create an MCP Server instance

```typescript
// src/mcp/server.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'simple-agent-tools',  // Server name, used by the Client to identify it
  version: '1.0.0',
});
```

`McpServer` is the core class from the MCP SDK. It:

- Manages the tool registry
- Handles protocol messages from the Client
- Returns tool results in the protocol format

---

## Step 2: register tools

Registering an MCP tool looks a lot like lesson 4's `tool()`, with two important differences:

```typescript
// Lesson 4: ordinary tool
export const getCurrentTimeTool = tool({
  description: 'Get the current date and time',
  parameters: z.object({}),
  execute: async () => {
    return { datetime: '...', timestamp: 123 };  // ← return any value
  },
});

// Lesson 12: MCP tool
server.tool(
  'get_current_time',              // arg 1: tool name (string)
  'Get the current date and time (Shanghai timezone)', // arg 2: description
  {},                              // arg 3: parameter schema (zod, same as an ordinary tool)
  async () => {
    const now = new Date();
    const datetime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const timestamp = now.getTime();

    return {
      content: [                   // ← must be a content array; this is the MCP spec
        {
          type: 'text',
          text: `Current time: ${datetime} (timestamp: ${timestamp})`,
        },
      ],
    };
  }
);
```

**Difference 1**: registration changes from "export an object" to "call `server.tool()`"

**Difference 2**: the return shape is fixed as `{ content: [{ type: 'text', text: '...' }] }`. That is what MCP specifies, and the Client parses results in that shape.

---

## Step 3: tools with parameters

```typescript
// src/mcp/server.ts

server.tool(
  'read_file',
  'Read the contents of a file at a given path',
  {
    // parameter schema: identical to an ordinary tool, defined with zod
    file_path: z.string().describe('Absolute path, or a path relative to the workspace'),
  },
  async ({ file_path: filePath }) => {  // ← types are inferred from the schema
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      return {
        content: [{ type: 'text', text: `Error: file does not exist ${absolutePath}` }],
        isError: true,  // ← mark this as an error response so the Client knows the tool failed
      };
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lineCount = content.split('\n').length;

    return {
      content: [
        {
          type: 'text',
          text: `File: ${absolutePath} (${lineCount} lines)\n\n${content}`,
        },
      ],
    };
  }
);
```

Note the `isError: true` field — in an ordinary tool you usually `return { error: '...' }`. MCP has a dedicated error flag, and the Client can use it to decide whether to retry or surface an error.

---

## Step 4: start the Server (stdio transport)

```typescript
// src/mcp/server.ts

export async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ⚠️ must use console.error here, not console.log!
  console.error('[MCP Server] simple-agent-tools started, waiting for a connection...');
}
```

**Why not `console.log`?**

In stdio transport mode, MCP uses `stdout` for JSON-RPC messages:

```
stdin  ← Client sends a request: {"jsonrpc":"2.0","method":"tools/call",...}
stdout → Server returns a response: {"jsonrpc":"2.0","result":{...}}
stderr → debug logs (not part of the protocol; write whatever you want)
```

If you write `console.log('started')` inside `startServer()`, that text is mixed into `stdout`. The Client tries to parse it as JSON-RPC and crashes.

---

## Step 5: the entry file

```typescript
// src/mcp/index.ts

// MCP Server entry: runs as a standalone process and talks to the MCP Client over stdio
// How to run: npx tsx src/mcp/index.ts
import { startServer } from './server.js';

startServer().catch((error) => {
  console.error('[MCP Server] failed to start:', error);
  process.exit(1);
});
```

This file is simple: it just starts the Server. Its point is: **this is the entry of a standalone process**. Cursor does not `import` our code. It starts a child process with `npx tsx src/mcp/index.ts` and talks to it over stdin/stdout.

---

## Step 6: plug into Cursor

Create `.cursor/mcp.json` at the project root:

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

This config tells Cursor:

- **`command` + `args`**: which command starts the MCP Server process
- **`cwd`**: which directory to run it in (this affects how relative paths resolve)

Cursor starts the process when it needs it and shuts it down when it does not. You do not manage the lifecycle yourself.

After restarting Cursor, say "list the files in the current directory" in Agent mode. Cursor will call our `list_files` tool on its own.

---

## Advanced: let our own agent speak MCP too

So far Cursor has been the MCP Client calling our Server. Now flip it — **let the agent we wrote also act as an MCP Client and dynamically pull tools from an MCP Server**.

### Step 7: create an MCP Client (`src/mcp/client.ts`)

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tool } from 'ai';

export class McpClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(command: string, args: string[], cwd?: string) {
    // StdioClientTransport automatically spawns the MCP Server child process
    this.transport = new StdioClientTransport({ command, args, cwd });
    this.client = new Client({ name: 'simple-agent-mcp-client', version: '1.0.0' });
  }

  async connect() { await this.client.connect(this.transport); }
  async disconnect() { await this.client.close(); }

  // The core: fetch the tool list and convert it into the ai SDK's tool shape
  async getTools(): Promise<Record<string, ReturnType<typeof tool>>> {
    // 1. Send tools/list and pull every tool description
    const { tools: mcpTools } = await this.client.listTools();

    const aiTools: Record<string, ReturnType<typeof tool>> = {};

    for (const mcpTool of mcpTools) {
      // 2. JSON Schema → zod schema (the ai SDK wants zod; MCP returns JSON Schema)
      const zodSchema = jsonSchemaToZod(mcpTool.inputSchema);

      aiTools[mcpTool.name] = tool({
        description: mcpTool.description ?? mcpTool.name,
        parameters: zodSchema,
        execute: async (args) => {
          // 3. On a real call, forward through the protocol to the MCP Server
          const result = await this.client.callTool({ name: mcpTool.name, arguments: args });
          // 4. Flatten MCP's content array into a string for the ai SDK
          return result.content.filter(i => i.type === 'text').map(i => i.text).join('\n');
        },
      });
    }

    return aiTools;
  }
}
```

**The hardest part**: MCP returns tool parameters as **JSON Schema**, but the ai SDK's `tool()` wants a **zod schema**. You have to convert (`jsonSchemaToZod`; see the full code).

### Step 8: wire MCP tools into the agent (`src/mcp-agent-demo.ts`)

```typescript
// 1. Start the MCP Client and connect to the MCP Server (it spawns the child process)
const mcpClient = new McpClient('npx', ['tsx', 'src/mcp/index.ts'], process.cwd());
await mcpClient.connect();

// 2. Dynamically fetch the tool list (tools/list)
const mcpTools = await mcpClient.getTools();
// → { get_current_time: tool(...), read_file: tool(...), ... }

// 3. Inject into generateText — same usage as the hard-coded tools in lesson 4
const { text } = await generateText({
  model,
  messages,
  tools: mcpTools,  // ← fetched at runtime, not hard-coded
  maxSteps: 5,
});
```

Compare with lesson 4's hard-coded approach:

```typescript
// Lesson 4: tools are written into the code
import { agentTools } from './agent/tools.js';
generateText({ tools: agentTools });

// Lesson 12: pull them from the MCP Server at runtime
const mcpTools = await mcpClient.getTools();
generateText({ tools: mcpTools });
```

**To the ai SDK there is no difference** — both are a `Record<string, tool>`. MCP's magic happens inside `getTools()` and is fully transparent outside.

---

## Directory layout

```
simple-agent/
├── src/
│   ├── mcp/
│   │   ├── server.ts        ← MCP Server core: register tools, start the service
│   │   ├── index.ts         ← Server entry: runs as a standalone process
│   │   └── client.ts        ← MCP Client: connect to the Server, fetch tools dynamically
│   └── mcp-agent-demo.ts    ← full demo of an agent using MCP
├── .cursor/
│   └── mcp.json             ← Cursor config: how to start our Server
```

---

## How to run it

**Check that the MCP Server starts:**

```bash
npx tsx src/mcp/index.ts
# stderr prints: [MCP Server] simple-agent-tools started, waiting for a connection...
# Ctrl+C to quit
```

**Run the agent-plus-MCP demo:**

```bash
npx tsx src/mcp-agent-demo.ts
# The agent starts an MCP Server child process, fetches the tool list, then enters the chat
```

**Use it from Cursor:**

1. Make sure `.cursor/mcp.json` is correct (`cwd` should be your real path)
2. Restart Cursor
3. In Cursor Agent mode, say "list the files in the current directory"; Cursor will call our `list_files` tool

---

## Ordinary Tool vs MCP Tool


| Dimension | Ordinary Tool (lesson 4) | MCP Tool (this lesson) |
| ------------ | ------------------------- | ------------------------------- |
| **Scope** | Only the current agent | Any MCP Client |
| **How it runs** | Inside the agent process | A standalone process, over the protocol |
| **Reuse** | Redefined per agent | Implement once, use everywhere |
| **How you attach it** | `tools: agentTools` in code | A JSON config file |
| **Return shape** | Any value | `{ content: [{ type, text }] }` |
| **Error flag** | Custom `{ error: '...' }` | `isError: true` |

---

## MCP panorama: lifecycle / primitives / error codes / SDK layers

The earlier sections built a Server, a Client, and remote transport by hand. Here the **protocol itself** is collapsed into one map you can look up later.

### Three message shapes (JSON-RPC 2.0)

`jsonrpc` is always `"2.0"`. **Which kind of message it is depends on whether `id` is present**: with `id` it is a Request (a response is required); without `id` it is a Notification (no response is expected).


| Message | Has `id`? | Expects a response | Example |
| ---------------- | ------------------- | ---------- | ---------------------------------------------------------- |
| **Request** | ✅ | The other side must reply | `tools/list`, `tools/call`, `initialize` |
| **Response** | ✅ (reuses the request id) | Received by the initiator | `{ "id":1, "result":{...} }` / `{ "id":1, "error":{...} }` |
| **Notification** | ❌ | Nobody expects a reply | `notifications/initialized` |

Success uses `result`, failure uses `error`, and **the two are mutually exclusive**. `id` is the key that pairs a request with its response: one connection can send many requests in flight, and each finds its own response by `id` (notifications have no `id`; the Server can push progress on its own). That is why MCP chose JSON-RPC.

### Standard error codes


| code | Meaning |
| ----------------- | ----------------------------------------------------------------- |
| `-32700` | Parse error (illegal JSON) |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32000 ~ -32099` | **Reserved for MCP**, for Server-defined errors (a missing resource often returns `-32002`) |

### Lifecycle: a three-way handshake

```
Client                                 Server
  │  1. initialize (protocol version + capabilities) ─────►
  │  ◄───────────────────────────── 2. response: protocol version, capabilities, instructions
  │  3. notifications/initialized ─────►   ← enter the "operations" phase
  │  ......... normal ops: tools/list, tools/call, resources/read, ping .........
  │  ◄───── Server may push notifications/tools/list_changed etc.
  │  4. close: tear down the transport (the protocol has no standard close request)
```

`protocolVersion` in `initialize` is **negotiated down to the lower of the two versions**. `capabilities` declares each side's feature set.

### The three primitives

MCP gives an LLM "perception + action" through these three, each with its own methods:

**Tools (executable actions; the most common)**


| Method | Direction | Notes |
| ---------------------------------- | ---- | -------------------------------------------------- |
| `tools/list` | C→S | Enumerate tools (with JSON Schema inputs); supports `cursor` pagination |
| `tools/call` | C→S | Call a tool and return the result |
| `notifications/tools/list_changed` | S→C | The tool list changed |

**Resources (readable data / files)**


| Method | Notes |
| --------------------------------------------- | --------------------------------------------- |
| `resources/list` / `resources/templates/list` | Enumerate resources / parameterized URI templates |
| `resources/read` | Read by `uri`; returns `text` or `blob` (base64) |
| `notifications/resources/list_changed` | Resources changed |

**Prompts (reusable prompt templates)**


| Method | Notes |
| ------------------------------------ | --------------------------------------- |
| `prompts/list` / `prompts/get` | Enumerate templates / bind params and return role-tagged messages |
| `notifications/prompts/list_changed` | Templates changed |

> Note: tool inputs are **JSON Schema** (not zod) — that is why `McpClient` earlier has to run `jsonSchemaToZod`. `server.tool()` / `server.resource()` / `server.prompt()` are just the SDK wrapping those lower-level methods into a simple API.

### Content types

Each item in the `content` array returned by a Tool / Resource is typed:

```json
{ "type": "text",       "text": "..." }
{ "type": "image",      "data": "<base64>", "mimeType": "image/png" }
{ "type": "resource",   "resource": { "uri": "...", "text": "...", "mimeType": "..." } }
```

When a tool "failed but is recoverable", return `{ "content": [...], "isError": true }` so the Client can decide whether to retry or surface an error.

### Three layers of SDK wrapping

The `McpServer` you are using is only the **top layer**. There are two more underneath:

```
Layer 1: Protocol   → JSON-RPC send/receive, auto-assign id, capability checks, ping auto-replies pong
   └─ Layer 2: Server  → route request/response/notification to the matching handler
        └─ Layer 3: McpServer → register tool/resource/prompt as a structured "Server API"
```

So `server.tool()` is eventually turned into standard JSON-RPC messages such as `tools/list` and `tools/call` and sent over the transport. **The protocol is the hard standard; the SDK is only an implementation that produces and parses those frames.**

### A few counter-intuitive details

1. **You do not implement `ping` yourself**: the SDK's `McpServer` replies `{}` by default. `ping` is a liveness request; you must answer promptly or the other side may disconnect.
2. **Capability negotiation is mandatory**: you must declare `capabilities` in `initialize`. Before calling a method the SDK runs `assertCapabilityForMethod()` — **a capability that was never negotiated cannot be called**.
3. **`id` matching is handled by the SDK**: `Client.callTool()` → `Protocol.request()` (assign a unique `id`, build a response Promise, `transport.send()`) → `_onResponse()` restores the response by the same `id`. If you write raw JSON-RPC, you maintain that `id` association yourself.

---

## FAQ

**Q: What is the essential difference between MCP and an ordinary Tool?**

A: An ordinary Tool is a "function" that can only be called inside the agent process that defined it. An MCP Tool is a "service" that runs in a standalone process and is exposed over a standard protocol. Think local function vs REST API — an API can be called by anyone; a local function can only be used in the same program.

**Q: Why can't you use `console.log` in stdio mode?**

A: This is the classic pitfall of MCP's stdio transport. **The core: in stdio mode, stdout is a dedicated data wire, not output for humans.**

In stdio transport the Client runs the Server as a child process. The three standard streams each have a job:

```
Client (parent)
   │  stdin  ──────────→  Server (child)   Client writes requests into the Server's stdin
   │  stdout ←──────────  Server (child)   Server writes responses to its own stdout
   │  stderr ←──────────  Server (child)   logs / debug go here
```

stdout is reserved by the protocol. What flows through it is newline-delimited JSON-RPC. The Client reads line by line and `JSON.parse`s:

```typescript
// Client-side pseudocode
serverProcess.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);  // ← every line must be valid JSON
    handleMessage(message);
  }
});
```

The moment you casually write `console.log('got a request', params)`, stdout becomes:

```
got a request { path: '/tmp' }                ← debug text, not JSON
{"jsonrpc":"2.0","id":1,"result":{...}}    ← the real protocol message
```

When the Client reads the first line, `JSON.parse` throws — at best it drops the message as a `ParseError`; at worst it treats the Server as protocol-corrupt and **disconnects**. These bugs are hard to chase: the Server looks fine locally and dies the moment a Client connects.

The right move is to send debug to stderr (`console.error` writes stderr and stays off the protocol wire):

```typescript
console.error('[debug] got a request, params:', params);  // ✅ safe
```


| How you print | Writes to | Consequence in stdio mode |
| ------------------------------- | ------------------- | -------------------------------- |
| `console.log` | stdout | 💥 pollutes the protocol channel; the Client fails to parse |
| `console.info` / `console.warn` | stdout (Node default) | 💥 same pollution |
| `console.error` | stderr | ✅ safe; goes to the log channel |

> A Node.js detail: `console.log`, `console.info`, and `console.warn` **all write stdout by default**; only `console.error` writes stderr. So it is not "only log is dangerous" — it is "everything except error is dangerous".

A related point: this is exactly the difference between stdio and HTTP/SSE. HTTP/SSE uses a network port, so stdout is free and you can `console.log` as you like. Many MCP SDKs also offer a dedicated logging path that sends logs **legally** to the Client via the `notifications/message` JSON-RPC notification, instead of writing raw text to stdout.

**Q: What is JSON-RPC 2.0, and how is it different from ordinary JSON?**

A: **In one sentence: JSON is a "data format"; JSON-RPC 2.0 is a "protocol convention for making remote calls in JSON".** They are not the same layer.

JSON only specifies what data looks like (key-value pairs, arrays, strings). It does not care what you do with it. JSON-RPC 2.0 is a **remote procedure call (RPC) protocol** that specifies the fixed structure you must follow when you use JSON to say "call this method, give me the result". It has only three messages:

**1. Request** — "call a method"

```json
{
  "jsonrpc": "2.0",          // must be "2.0", the protocol version
  "method": "tools/call",    // the method to call
  "params": { "name": "read_file" },  // arguments
  "id": 1                    // request number, used to match the response
}
```

**2. Response** — "the result of the call"; success and failure are exclusive

```json
// success
{ "jsonrpc": "2.0", "id": 1, "result": { "content": "file contents..." } }
// failure
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found" } }
```

**3. Notification** — "just telling you; do not reply" (no `id` field)

```json
{ "jsonrpc": "2.0", "method": "notifications/progress", "params": {...} }
```


|                      | Ordinary JSON | JSON-RPC 2.0 |
| -------------------- | ---------------- | ----------------------------------------------------- |
| **Essence** | A data format (syntax) | A calling protocol (semantic convention) |
| **Layer** | Bottom | Built on top of JSON |
| **Structure** | Any valid structure | Must have fixed fields such as `jsonrpc`, `method` / `result` / `error` |
| **Has an "action" meaning?** | ❌ pure data | ✅ expresses "call → response" |
| **Has id matching?** | ❌ | ✅ uses `id` to pair request and response |

Why MCP uses it: `id` lets the Client map a response to the right in-flight request; exclusive `result`/`error` makes success/failure easy to judge; notifications have no `id`, so the Server can push progress.

An analogy: **JSON ≈ the spec for envelopes and paper; JSON-RPC 2.0 ≈ the mailing rules** (where to write the recipient, how to number the books). A REST API response body is also JSON, but it is not JSON-RPC — JSON-RPC is just one standardized way to carry RPC calls in JSON.

Versus REST: JSON-RPC is **action-oriented** (`method: "tools/call"`), one endpoint, a good fit for bidirectional communication and tool calls. REST is **resource-oriented** (`GET /tools/123`), many endpoints, a good fit for CRUD. MCP picked JSON-RPC because a tool call is naturally an "action", and a bidirectional stdio stream fits request/response plus notifications.

**Q: stdin sounds like an inter-process communication mechanism?**

A: **The intuition is right.** stdin/stdout/stderr are among the oldest, plainest **IPC (Inter-Process Communication)** mechanisms.

IPC means two independent processes exchanging data. stdio communication fits: the Client `spawn`s the Server child process; the OS wires **pipes** between parent and child; both sides then read and write those pipes. stdin/stdout themselves are just the "standard input/output stream" abstraction; what makes them IPC is the pipe underneath.

Where stdio sits in the IPC family:


| IPC mechanism | How | Traits |
| --------------------- | -------------------- | -------------------------------------------- |
| **Pipe / stdio** | Byte stream, one direction | Simplest; parent–child; this is MCP stdio mode |
| **Named pipe (FIFO)** | A pipe with a name | Unrelated processes can use it |
| **Socket** | Network socket | Can cross machines; HTTP/SSE uses this |
| **Shared memory** | Many processes read/write the same memory | Fastest, but you handle sync yourself |
| **Message queue** | A kernel-managed queue | Structured messages |
| **Signal** | Async notification | Can only carry very simple information |

stdio as IPC — the reasons MCP chose it:

- **Pros**: zero config (no port, no connection setup), language-agnostic (anything can read/write streams), natural isolation (a crashed child does not take the parent down), no network
- **Cons**: parent–child only, cannot cross machines, a single serial channel (messages queue, so JSON-RPC needs `id` matching)

That is why MCP designed two transports:


|          | stdio | HTTP/SSE |
| -------- | ------------------------------ | ---------------------- |
| Underlying IPC | Pipe | Socket (network) |
| Process relationship | Must be parent–child (Client starts Server) | Arbitrary, can cross machines |
| Deploy | Server starts and stops with the Client | Server is a long-running process |
| Fit | Local tools, IDE plugins | Remote services, shared by many clients |

**One-line summary**: stdio really is IPC — the OS pipe connects parent and child and carries a byte stream. MCP stdio mode is "stuff JSON-RPC messages into that pipe": simple and reliable, at the cost of local-only and parent–child-only.

**Q: When does the MCP Server start?**

A: Cursor runs the command configured in `mcp.json` when it needs the process, and shuts it down when it does not. You do not manage the process lifecycle yourself.

**Q: After MCP is wired in, how does the agent know what the MCP Server can do?**

A: This is one of the protocol's core mechanisms — **Tool Discovery**. The flow:

1. After connecting, the MCP Client immediately sends a `tools/list` request
2. The Server returns **metadata** for every registered tool: name, description, parameter schema (JSON Schema)
3. The Client turns that metadata into the ai SDK's `tool()` shape and injects it into `generateText`'s `tools`
4. The ai SDK stitches the tool descriptions into the system prompt, so the LLM knows "which tools I have, what each one does, and what arguments it needs"

```typescript
// What McpClient.getTools() does internally:
const { tools: mcpTools } = await this.client.listTools(); // ← send tools/list

for (const mcpTool of mcpTools) {
  // mcpTool.name        → tool name
  // mcpTool.description → tool description (the LLM uses this to decide when to call)
  // mcpTool.inputSchema → parameter schema (JSON Schema)
  aiTools[mcpTool.name] = tool({ ... });
}
```

So the agent does not "know in advance" what MCP can do. It **asks dynamically on every connection**. That is also where MCP is flexible — the Server can add or remove tools at any time, and the next Client connection picks up the change with no code edits.

**Q: What does `spawn` mean?**

A: The English word originally means "to produce offspring in large numbers". In programming it specifically means **create a child process**.

Node.js has a built-in `child_process.spawn()` for starting a new OS process. `StdioClientTransport` uses it internally to start the MCP Server:

```
Your agent process (parent)
    │
    │  child_process.spawn('npx', ['tsx', 'src/mcp/index.ts'])
    │  ← this is "spawn a child process"
    ▼
MCP Server process (child)
    │
    │  stdin ← parent sends requests
    │  stdout → parent receives responses
    │  stderr → debug logs
```

The `command` and `args` you pass to the `McpClient` constructor are exactly what `spawn` uses to start the child:

```typescript
// What you write:
const mcpClient = new McpClient('npx', ['tsx', 'src/mcp/index.ts'], process.cwd());

// Inside StdioClientTransport this is equivalent to:
const child = child_process.spawn('npx', ['tsx', 'src/mcp/index.ts'], { cwd: process.cwd() });
// then JSON-RPC over child.stdin / child.stdout
```

A simple mnemonic: **spawn = bring a new process into the world**.

---

### Hands-on: a pure-JS spawn + stdin example

No libraries. Two files. This is the lowest layer of MCP stdio: **the parent spawns a child, writes to the child's stdin, the child processes the data and writes back on stdout**.

**child.js — the child: read stdin line by line, uppercase, write back on stdout**

```javascript
// child.js — child process
// Job: listen on stdin; for each line, uppercase it and return it on stdout
// Run alone: node child.js, then type and hit enter

// Logs go to stderr so they do not pollute stdout (same rule as an MCP Server)
process.stderr.write('[child] child process started, waiting for stdin...\n');

process.stdin.setEncoding('utf-8');

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // Split on newlines; handle "sticky packets": one data event may contain several lines
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (line === 'exit') {
      process.stdout.write('bye\n');
      process.exit(0);
    }

    // Write the result back to the parent on stdout
    process.stdout.write(`echo: ${line.toUpperCase()}\n`);
  }
});
```

**parent.js — the parent: spawn the child, write its stdin, read its stdout**

```javascript
// parent.js — parent process
// How to run: node parent.js

const { spawn } = require('node:child_process');
const path = require('node:path');

// 1. Spawn the child — equivalent to running `node child.js` in a terminal
const child = spawn('node', [path.join(__dirname, 'child.js')], {
  // stdio: ['pipe', 'pipe', 'inherit'] means:
  //   stdin  → pipe: the parent can write to child.stdin
  //   stdout → pipe: the parent can read from child.stdout
  //   stderr → inherit: the child's stderr is attached to the parent's terminal, so logs are visible
  stdio: ['pipe', 'pipe', 'inherit'],
});

// 2. Listen on the child's stdout — the read end of the "channel"
child.stdout.setEncoding('utf-8');
child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim()) {
      console.log(`[parent] reply from child → ${line}`);
    }
  }
});

// 3. Cleanup when the child exits
child.on('exit', (code) => {
  console.log(`[parent] child exited, exit code = ${code}`);
});

// 4. Write to the child's stdin — the write end of the "channel"
child.stdin.write('hello world\n');
child.stdin.write('mcp is fun\n');

// 5. Delay 500ms before sending exit, so the earlier messages are processed first
setTimeout(() => {
  child.stdin.write('exit\n');
}, 500);
```

**Run:**

```bash
node parent.js
```

**Expected output:**

```
[child] child process started, waiting for stdin...
[parent] reply from child → echo: HELLO WORLD
[parent] reply from child → echo: MCP IS FUN
[parent] reply from child → bye
[parent] child exited, exit code = 0
```

**Map this example onto MCP:**


| Role in the example | Role in MCP stdio |
| ------------------------------- | ------------------------------------- |
| `parent.js` | MCP Client (Cursor, or our agent) |
| `child.js` | MCP Server |
| `child.stdin.write(...)` | Client sends a JSON-RPC request |
| `data` events on `child.stdout` | Client receives a JSON-RPC response |
| The child's `process.stderr.write` | The Server's `console.error` debug log |
| Splitting the buffer on `\n` | MCP's "one JSON message per line" framing |

The only difference: this example sends plain text; MCP replaces the text with **one JSON-RPC message per line**. Once you understand this code, you understand what `StdioClientTransport` does inside.

---

## Advanced: remote MCP and the 2026 spec

Everything above was local stdio. This section opens remote MCP: how you call it, how you authorize, how POST/SSE are negotiated, and the major 2026-07-28 revision.

### How remote MCP is called

Remote MCP uses **HTTP transport**. There is no child process. You hit a URL the way you hit a REST API:

```
stdio mode:   Client spawns a child → pipe communication (local)
remote mode:  Client sends HTTP → a remote server responds (can cross machines)
```

The config difference is obvious:

```json
// stdio: you configure a "start command"
{ "mcpServers": { "local-tools": { "command": "npx", "args": ["tsx", "server.ts"] } } }

// remote: you configure a "URL"
{ "mcpServers": { "remote-tools": { "url": "https://mcp.example.com/mcp" } } }
```

**Two generations of transport:**

Generation one, **HTTP + SSE (two endpoints)**: the Client first `GET /sse` to open a long-lived SSE connection just for responses, and sends requests with `POST /messages`. The problem is two endpoints and a stateful long connection — unfriendly to load balancers and serverless.

Generation two, **Streamable HTTP (one endpoint; what the new spec pushes)**: one endpoint, every interaction is `POST /mcp`. A simple request returns JSON; a long task upgrades the response to an SSE stream so the Server can push progress as it runs. Stateless-friendly, a better fit for the cloud.

A full call (tools/call as the example):

```
1. initialize handshake (exchange protocol version and capabilities)
2. tools/list → tool metadata (same as stdio)
3. The LLM decides to call a tool
4. POST: { "jsonrpc":"2.0", "id":3, "method":"tools/call", "params":{...} }
5. Server runs it and returns: { "jsonrpc":"2.0", "id":3, "result":{...} }
6. Client feeds the result back to the LLM and continues the agent loop
```

**Note**: the JSON-RPC message shape is identical to stdio. Only the vehicle changed — from "bytes in a pipe" to "an HTTP request body".

### How MCP authorization works

Auth has two layers: **the remote service's standard OAuth 2.0 flow**, and **credential injection for a local Server**.

**Remote MCP: OAuth 2.1 authorization-code flow** (the same mechanism as "log into a third-party app with GitHub"):

```
Client                                Remote MCP Server
  │  1. POST /mcp (no token) ──────────→
  │  ◄────────────────────────────────  401 Unauthorized (tells you the authorization-server URL)
  │  2. Open a browser on the consent page ──────────→  Authorization Server
  │     User signs in + clicks "Authorize"
  │  ◄────────────────────────────────  3. Callback brings back an authorization code
  │  4. Exchange the code for an access_token ──────→
  │  ◄────────────────────────────────  access_token (+ refresh_token)
  │  5. Later requests carry Authorization: Bearer <token> → normal responses
```

Key design points: dynamic client registration (the Client registers itself on first connect — plug and play), PKCE (stops authorization-code interception), silent token refresh, and scopes for permission range.

Shapes you see day to day:


| Shape | Example | How auth works |
| ------------------------ | ------------------------ | ----------------------------------- |
| **Browser OAuth popup** | GitHub / Notion / Linear MCP | Standard OAuth; click "Authorize" |
| **API Key / PAT** | Self-hosted or managed Server | Put the token in config, send it in the Authorization header |
| **A hosting platform issues it** | Smithery, mcp.run | The platform runs one OAuth, then injects into each Server |
| **Local Server brings its own credentials** | Filesystem, database | No network auth; credentials live in env vars |

**"Auth" for a local stdio Server = credential injection** (pass env vars into the child):

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

Authorization happened when you minted the PAT (you ticked scopes on GitHub's site), not when you connected MCP.

**Two layers of auth that are easy to mix up**:

```
user ──OAuth──→ MCP Server ──the Server's own credentials──→ downstream API (GitHub / a database)
     (layer 1: may you use this Server)   (layer 2: may the Server call the downstream)
```

That is why some Servers ask you to "authorize the downstream again after connecting".

### When POST is used and when SSE is used

**POST and SSE are not two kinds of request you pick between. They are "the request" and "a possible response shape"** — you always initiate with POST; SSE is one form the response body may take.

**Case 1: a simple request → ordinary JSON** (`initialize`, `tools/list`, a fast tool):

```
Client:  POST /mcp  { "method": "tools/list" }
Server:  200 OK, Content-Type: application/json
         { "jsonrpc":"2.0", "id":1, "result": {...} }   (the connection then ends)
```

**Case 2: a long task / you need to push → the response upgrades to an SSE stream**:

```
Client:  POST /mcp  { "method": "tools/call", "params": {"name":"long_task"} }
Server:  200 OK, Content-Type: text/event-stream        ← the response type changed
         data: {progress 30%}
         data: {progress 80%}
         data: {final result}                                  (the stream ends, the connection closes)
```

After sending the POST, the Client **decides how to read from the Content-Type header**: `application/json` is read once and done; `text/event-stream` is listened to until the stream closes.

**Who decides to use SSE? The Server does — but only inside what the Client allowed:**

```
1. The Client sends POST and declares acceptable shapes in Accept:
   Accept: application/json, text/event-stream
2. The Server checks Accept:
   - Client does not accept SSE → JSON only
   - Client accepts SSE → free to choose based on the task
3. The Server judges: fast task → JSON; long task / progress → SSE stream
4. The Client reads Content-Type and parses accordingly
```

Edge case: the Client only accepts JSON but the task is long. The Server either waits it out (the Client may time out) or errors and asks for streaming support. A spec-compliant Client therefore always puts `text/event-stream` in Accept.

### The 2026-07-28 revision: going stateless

The July 2026 revision (2026-07-28) is a major update. The theme is one word: **stateless**.

**The core changes:**

- **Sessions are gone**: drop the `Mcp-Session-Id` header and protocol-level sessions; drop the `initialize` / `notifications/initialized` handshake. Each request carries protocol version and Client capabilities in `_meta`; the Server identifies itself in each response `_meta`
- **New `server/discover`**: the Server must implement this RPC and declare supported protocol versions and capabilities; the Client can probe before any request
- **Subscriptions redesigned**: the HTTP GET endpoint and `resources/subscribe` are replaced by `subscriptions/listen` — one long-lived POST response stream; the Client subscribes to change notifications as needed
- **SSE resume is gone**: drop `Last-Event-ID` and message replay. A broken stream is lost; the Client must start a new request with a new request ID
- **`ping` and `logging/setLevel` are gone**: log level is specified per request in `_meta`
- **Tasks leave the core protocol**: they become the official extension `io.modelcontextprotocol/tasks`, with `tasks/get` polling instead of a blocking `tasks/result`
- **Multi-round trip requests (MRTR)**: replace the old "Server initiates a request" pattern. The Server returns `resultType: "input_required"`; the Client fills in the missing information and retries the original request. Every result must now carry `resultType`
- **Roots, Sampling, and Logging are deprecated**: still usable, but new implementations should not support them
- **HTTP+SSE transport is officially Deprecated**: migrate to Streamable HTTP
- **OAuth dynamic client registration (RFC7591) is deprecated**: use Client ID Metadata Documents instead

### What going stateless buys you

**1. Horizontal scale becomes easy.** With state you needed sticky sessions. If an instance dies the session is gone; scaling requires migrating sessions; load is uneven. Stateless, any instance can handle any request. The load balancer can spray freely; instances can appear and disappear at any time.

**2. A perfect fit for Serverless / FaaS.** A stateful long connection cannot run on Lambda / function compute. Stateless, each request is independent and self-contained — cold-start on demand, idle at zero cost, autoscale. For hosted MCP this is a qualitative change.

**3. Fault tolerance and recovery get simpler.** Resume required the Server to cache already-sent messages and keep a cursor — a bug farm. Stateless, a break means resend. The Server stores no intermediate state, so there is nothing to restore.

**4. Cache hit rate goes up, which saves tokens and money.** Requests do not depend on session context. A `tools/list` result is the same for every Client and can sit on a CDN / shared cache. A stable tool list also raises LLM prompt-cache hit rate and cuts token cost.

**5. Development and debugging get easier.** No handshake state machine, no session lifecycle. Each request is self-contained and can be tested and replayed with curl. The standard HTTP middleware ecosystem (gateways, rate limits, monitoring, tracing) plugs in.

**The costs** (to be fair):


| Cost | Notes |
| ---------------------- | -------------------------------------------------------- |
| **Larger requests** | Every request carries `_meta` (version, capabilities, identity) — some redundancy |
| **Cross-call state is yours** | A Server that needs state has to mint its own "handles" and pass them around |
| **A broken stream drops the request** | No replay; a long task that breaks has to start over |
| **Old features are buried with it** | Roots / Sampling / Logging are deprecated; the ecosystem has to migrate |

### Does SSE still work after going stateless?

**Yes, but SSE's role changed** — from "a standing session channel" down to "the response shape of a single request".

The key distinction: **SSE itself is not "state"**. What was cut is session-bound SSE, not the SSE technique:

```
Old mode (stateful):
  GET /sse hangs a long connection ──bound to a session──→ every response is pushed on this stream
  (the connection is the session; a break needs Last-Event-ID to resume)

New mode (stateless):
  POST /mcp sends one request ──→ this request's response body happens to be an SSE stream
  (stream lifetime = that one request's lifetime; unrelated to a session)
```

Two surviving forms of SSE when you are stateless:

1. **Request-scoped SSE (the main one)**: the stream lives only inside this request; when the request ends, everything resets. A long task can still be stateless, because "long" is only this request's response time, not a session
2. **`subscriptions/listen` (optional subscription stream)**: replaces the old GET endpoint; also started with POST. The Client chooses to hang this stream. It does not carry session state; a break means reconnect and subscribe again

SSE-related capabilities that were cut: `Last-Event-ID` resume (resume means the Server cached already-sent messages = state), SSE event IDs / message replay, and a standing GET connection.

How the design stays consistent:

```
Stateless principle: the Server stores no state across requests
   │
   ├─ An SSE stream that lives inside one request → does not violate ✅
   ├─ Resume that requires the Server to store sent messages → violates → cut ❌
   └─ A standing connection bound to a session → violates → become an optional subscription stream ❌→✅
```

**One-line summary**: after going stateless, SSE still works, but it changed from "a standing channel bound to a session" into "the response shape of a single request" — long-task progress can still be pushed; the stream's lifetime is limited to one request; a break means send the request again. You keep streaming and you keep the stateless rule.

**Section summary**: the 2026-07-28 line is "remove state" — drop sessions, drop the handshake, drop resume, make every request self-contained. The point is to let an MCP Server enjoy the full dividend of modern HTTP infrastructure. It is the same evolutionary line as REST replacing stateful long connections, and microservices replacing the monolith.
