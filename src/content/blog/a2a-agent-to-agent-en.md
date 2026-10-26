---
title: "A2A — Agent-to-Agent Protocol"
date: 2026-10-23
excerpt: "A2A lets agents in different processes, orgs, and vendors collaborate via a task state machine. This post covers Agent Cards, the four-step flow, and a runnable TypeScript sample."
category: AI
lang: en
---

> Goal: understand the A2A protocol, learn how agents collaborate across processes and organizations, and write a runnable TypeScript sample.

---

## Background

The **Orchestrator** pattern you see in most multi-agent tutorials is **in-process** collaboration:

```
Main Agent ──(function call / tool wrapper)──▶ Sub-agent    ← same process
```

In the real world, agents usually live in **different processes, different organizations, even different vendors**:

```
User request:
"Find weekend flights from Shanghai to Beijing and back, then book a hotel near the airport."

Agents you need:
✈️ Airline agent     — likely hosted by the airline itself
🏨 Hotel agent       — likely hosted by an OTA
👤 Your travel agent — the one you write
```

These three agents are **built by different teams and deployed on different systems**. You cannot simply `import` the other side's code, and you certainly cannot expose their internal tools. What you need is a **cross-system agent communication protocol** — that is **A2A (Agent-to-Agent)**.

---

## What A2A is

**A2A (Agent-to-Agent)** is an open protocol Google published in April 2025 and later donated to the **Linux Foundation**. It complements MCP, which Anthropic has been driving on the "agent interoperability" track.

The core problem it solves: **let one agent delegate a "task" to a completely unfamiliar agent, and get a result back**. Participants are treated as a **black box** — you only need to know **what the other side can do** and **how to submit a task**. You neither need nor are allowed to peek at how they implement it.

### A2A vs MCP (one sentence)

```
MCP  = Agent → tools / data        (vertical link; the agent's "hands")
A2A  = Agent → Agent               (horizontal link; the "diplomatic protocol" between agents)
```

They **complement each other; they do not compete**. One agent can use both at once:

```
┌─────────────────────────────────────────────┐
│                Your Agent                    │
│                                             │
│   ┌──────────────┐   ┌──────────────────┐   │
│   │  Down: MCP    │   │  Sideways: A2A   │   │
│   │ DB / tools    │   │ talk to others   │   │
│   └──────────────┘   └──────────────────┘   │
└─────────────────────────────────────────────┘
```

> MCP is the agent's "hands"; A2A is the "diplomatic protocol" between agents. Complementary, not competing.
> A three-way MCP / ACP / A2A comparison is complementary reading; this post only unpacks A2A.
> To first get MCP as the "hands" side, see the on-site [MCP intro](/en/blog/mcp-model-context-protocol/) and [one platform, two roles](/en/blog/mcp-dual-role/).

---

## Core concepts

### 1. Agent Card (capability card)

Every A2A agent exposes a `/.well-known/agent.json` that describes **what it can do**:
- `name`, `description` — human- and machine-readable capability text
- `skills` — the list of skills it offers
- `defaultInputModes / defaultOutputModes` — supported content types (text, file, …)
- `securityMeasures` — auth methods, identity checks, and so on

```
GET https://travel.agent/.well-known/agent.json
```

With the Agent Card, a client knows "it can book flights" and "how to call it".

### 2. Task

The smallest unit of an A2A interaction is a **Task**. It is a state machine with a full lifecycle:

```
submitted → working → input-required ─┐
     │            │                   │(when more info is needed)
     │            ▼                   │
     └────► completed ←───────────────┘
            │
            ├── succeeded (success, with Artifact)
            └── failed (failure, with error info)

Also: canceled, rejected
```

A task can be **long-running** (order review may take hours), so A2A is async by design:
after submitting, the client can poll, subscribe over SSE, or wait for a callback.

### 3. Message and Artifact (conversation and deliverable)

- **Message**: the conversation during the task, `{ role: "user" | "agent", parts: [...] }`
- **Artifact**: the task **deliverable** (final file, JSON, image, …), attached to a completed task

```
System: please arrange a Beijing → Shanghai flight
  ↓ Message (user / agent back and forth)
Agent: done → Artifact: [ticket PDF, order id, price]
```

### 4. Capability negotiation

When the client submits a task it can attach a `Message`, and it can be asked for more information at any time (`input-required`).
That mirrors real human collaboration — the other side does not one-click a result; it comes back and asks.

---

## Workflow (four steps)

```
① Discover     GET https://travel.agent/.well-known/agent.json
                    → Agent Card (what it does, how to call it)

② Send task    POST /message  { method: "tasks/send", params: { message } }
                    → returns task and taskId

③ Get progress POST /message  { method: "tasks/get", params: { id } }
                    → poll status (working / input-required / completed…)
                    or subscribe via SSE /tasks/pushSubscription

④ Take output  task completed(succeeded) → final deliverable in Task.artifacts
```

> Every method is a **JSON-RPC 2.0** request/response over HTTP (internally a POST `/message` endpoint).

---

## Sample code (TypeScript)

We implement a "weather agent" server plus a client, and run the four steps end to end.

> Note: the official `a2a-sdk` TypeScript package is still immature. To keep the focus on the protocol,
> this sample uses **Express + raw JSON-RPC**, with no third-party A2A SDK.

### Dependencies

```bash
tnpm install express @types/express cors
# Local equivalent: npm install / pnpm add the same packages
```

### Server: weather agent (`server.ts`)

```typescript
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json());

/** In-memory task store: taskId -> Task */
const tasks = new Map<string, Task>();

// ---------- Types (a minimal slice of A2A messages) ----------
type TaskStatus =
  | 'submitted' | 'working'
  | 'input-required' | 'completed'
  | 'failed' | 'canceled' | 'rejected';

type Task = {
  id: string;
  status: TaskStatus;
  messages: Message[];
  artifacts: Artifact[];
};

type Message = { role: 'user' | 'agent'; parts: { text?: string }[] };
type Artifact = { id: string; name: string; parts: { text?: string }[] };

// ---------- ① Agent Card ----------
app.get('/.well-known/agent.json', (_req, res) => {
  res.json({
    name: 'Weather Agent',
    description:
      'Look up today's weather for a city: temperature, conditions, and a short suggestion. ' +
      'Input must be a city name, e.g. "北京".',
    skills: [
      {
        id: 'weather_lookup',
        name: 'Weather lookup',
        description: 'Given a city name, return the current weather',
        tags: ['weather'],
      },
    ],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    securityMeasures: [],
  });
});

// ---------- Business logic: look up weather ----------
function lookupWeather(city: string): string {
  const records: Record<string, string> = {
    北京: 'Sunny, 25°C, good for going out',
    上海: 'Cloudy, 27°C, muggy',
    深圳: 'Thunderstorms, 30°C, bring an umbrella',
  };
  return records[city] ?? `No weather data for ${city}`;
}

// ---------- ②③④ Message entry: tasks/send, tasks/get ----------
app.post('/message', (req, res) => {
  const { id: requestId, method, params } = req.body;

  // ③ Get task progress
  if (method === 'tasks/get') {
    const task = tasks.get(params.id);
    if (!task) return res.status(404).json(jsonrpcError(requestId, -32001, 'Task not found'));
    return res.json(jsonrpcResult(requestId, { task }));
  }

  // ② Submit a task
  if (method === 'tasks/send') {
    const taskId = randomUUID();
    const userMessage: Message = params.message;
    // Demo: strip Chinese filler so "北京今天天气怎么样？" collapses to "北京"
    const city = userMessage.parts?.[0]?.text?.replace(/[的天气，。\s]/g, '') ?? '';

    const task: Task = {
      id: taskId,
      status: 'working',
      messages: [userMessage],
      artifacts: [],
    };
    tasks.set(taskId, task);

    // Simulate a long task: finish after 500ms
    setTimeout(() => {
      task.status = 'completed';
      task.messages.push({ role: 'agent', parts: [{ text: `Lookup done` }] });
      task.artifacts.push({
        id: randomUUID(),
        name: 'weather-result',
        parts: [{ text: lookupWeather(city) }],
      });
    }, 500);

    return res.json(jsonrpcResult(requestId, { task }));
  }

  // Unimplemented method
  return res.json(jsonrpcError(requestId, -32601, 'Method not found'));
});

// ---------- JSON-RPC 2.0 wrappers ----------
function jsonrpcResult(id: string, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcError(id: string, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

app.listen(3001, () => console.log('Weather Agent listening: http://localhost:3001'));
```

### Client: submit a task and poll (`client.ts`)

```typescript
const AGENT_URL = 'http://localhost:3001';

type AgentCard = {
  name: string;
  description: string;
  skills: { id: string; name: string }[];
};

type Task = {
  id: string;
  status:
    | 'working'
    | 'completed'
    | 'input-required'
    | 'failed'
    | 'canceled'
    | 'rejected';
  artifacts: { parts: { text?: string }[] }[];
};

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(`${AGENT_URL}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// ① Discover: fetch the Agent Card, confirm what the other side can do
async function discover() {
  const card: AgentCard = await fetch(
    `${AGENT_URL}/.well-known/agent.json`,
  ).then((r) => r.json());
  console.log(`Discovered Agent: ${card.name} — ${card.description}`);
  console.log('Skills:', card.skills.map((s) => s.name).join(', '));
}

// ② Submit a task
async function sendTask(message: string) {
  return rpc<{ task: Task }>('tasks/send', {
    message: { role: 'user', parts: [{ text: message }] },
  }).then((r) => r.task);
}

// ③ Poll until a terminal state
async function pollUntilDone(taskId: string, intervalMs = 300) {
  for (;;) {
    const { task } = await rpc<{ task: Task }>('tasks/get', { id: taskId });
    if (task.status === 'completed') return task;
    if (['failed', 'canceled', 'rejected'].includes(task.status)) {
      throw new Error(`Task failed: ${task.status}`);
    }
    await sleep(intervalMs); // not done yet; wait a bit
  }
}

async function main() {
  await discover();

  const task = await sendTask('北京今天天气怎么样？');
  console.log(`Task submitted: ${task.id} (status ${task.status})`);

  const done = await pollUntilDone(task.id);
  // ④ Take the deliverable
  console.log('Result:', done.artifacts[0].parts[0]?.text);
}

main().catch((e) => console.error(e));

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### Run it

```bash
# Two terminals
tnpm run tsx -- server.ts   # server
tnpm run tsx -- client.ts   # client
# Local equivalent: npx tsx server.ts / npx tsx client.ts
```

```
Discovered Agent: Weather Agent — Look up today's weather for a city: temperature, conditions, and a short suggestion.
Skills: Weather lookup
Task submitted: 3f7a... (status submitted)
Result: Sunny, 25°C, good for going out
```

The sample keeps the Chinese city names (`北京` / `上海` / `深圳`) so the lookup table and the client query stay aligned.

---

## Production notes (short)

1. **Auth**: the Agent Card declares `securityMeasures` (Bearer token / OAuth, …).
   Cross-org calls must authenticate. Do not run naked.
2. **Idempotency**: `tasks/send` can take a `taskId` as an idempotency key, so a network retry does not place the order twice.
3. **Long tasks**: subscribe to progress with SSE `tasks/pushSubscription`. Do not busy-poll forever.
4. **More information**: when the other side returns `input-required`, ack with `/tasks/acknowledged`,
   then `tasks/update` with extra `parts` to keep the task moving.
5. **Transport**: short, ad-hoc tasks can stay HTTP-sync; long-running ones fit SSE or a callback better.

---

## Combining A2A with MCP

A real agent is often "MCP inward, A2A outward":

```
┌──────────────────────── Your Agent ────────────────────────┐
│                                                           │
│   A2A exit: /message   ← external agents submit / query    │
│        │                     tasks/* here                  │
│        ▼                                                   │
│   ┌──────────────────────────────────────┐                 │
│   │          Your business logic          │                 │
│   │           need tools / data ↓         │                 │
│   │   ┌──────────────────────────────┐   │                 │
│   │   │ MCP Client                    │   │                 │
│   │   │   └─ DB tools / payment / …   │   │                 │
│   │   └──────────────────────────────┘   │                 │
│   └──────────────────────────────────────┘                 │
└───────────────────────────────────────────────────────────┘
```

- **Downward (same trust domain)**: MCP for databases, payments, internal services — fine-grained capabilities.
- **Sideways (cross-domain)**: A2A to negotiate tasks with other orgs / vendors — capabilities stay a black box.

That matches the official one-liner: **"A2A is complementary to MCP"** —
MCP gives the agent "hands"; A2A gives it "colleagues".

The same pairing shows up in the on-site [MCP dual-role write-up](/en/blog/mcp-dual-role/), which covers the engineering of "MCP downward for tools". This post is the other half: "A2A sideways for tasks".

---

## Interview follow-ups

**Q1: MCP can wrap a sub-agent as a tool. Why do you still need A2A?**
A: MCP is for in-process / same-trust-domain tool calls. It expects the other side to expose fine-grained capabilities.
Across organizations, the other party will not expose internal tools, and does not want you managing its task lifecycle. A2A uses
a task state machine plus a black-box envelope, specifically for cross-system collaboration.

**Q2: Do A2A and MCP conflict?**
A: No. A2A's official line is "complementary to MCP". One covers Agent–tool,
the other Agent–Agent.

**Q3: Why does A2A insist on async tasks?**
A: Real collaboration is long-running (approvals, bookings, external execution). Blocking sync is unrealistic.
The Task state machine plus poll / SSE lets both sides evolve independently.

---

## Summary

- A2A solves **cross-process / cross-org / cross-vendor** agent collaboration and complements MCP.
- Core abstractions: **Agent Card** (discovery), **Task** (lifecycle), **Message / Artifact** (conversation and deliverable).
- Four steps: discover → send task → get progress → take output, all JSON-RPC 2.0 over HTTP.
- MCP inward for tools, A2A outward for collaboration — the most common enterprise pairing.
