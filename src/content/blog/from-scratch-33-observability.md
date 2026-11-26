---
title: "Agent 可观测性 — Trace、Span 与日志链路追踪"
date: 2026-11-25
excerpt: "生产出问题时，如何追踪一次请求的完整链路？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 34
---

> 目标：理解可观测性的三大支柱，掌握在 Agent 中实现完整链路追踪的工程方法

---

## 背景：没有可观测性，生产问题无法排查

Agent 在生产环境中出问题时，你需要回答：

- 这次请求总共调用了几次 LLM？每次耗时多少？
- 哪个工具调用最慢？是工具本身慢还是网络慢？
- 用户说"AI 回答错了"，当时的完整上下文是什么？
- 这个错误是偶发的还是系统性的？

**没有可观测性，这些问题都无法回答。** 你只能靠猜。

---

## 可观测性的三大支柱

```
可观测性
├── Logs（日志）：记录"发生了什么"
│   └── 例：2024-01-01 10:00:01 [INFO] 工具 read_file 执行成功，耗时 23ms
│
├── Metrics（指标）：记录"发生了多少次、多快、多少"
│   └── 例：工具调用成功率 98.5%，平均耗时 45ms，P99 耗时 320ms
│
└── Traces（链路追踪）：记录"一次请求经历了哪些步骤"
    └── 例：请求 #abc123 → LLM调用(120ms) → read_file(23ms) → LLM调用(340ms) → 完成
```

对 Agent 来说，**Traces 最重要**——因为 Agent 的执行是多步骤的，必须把整个链路串起来才能理解一次执行的全貌。

---

## 核心概念：Trace 和 Span

```
Trace（一次完整的请求链路）
└── Span: "处理用户消息"（根 Span，总耗时 1200ms）
    ├── Span: "LLM 调用 #1"（耗时 450ms）
    │   └── 属性：model=gpt-4o, promptTokens=1200, completionTokens=80
    ├── Span: "工具调用 read_file"（耗时 23ms）
    │   └── 属性：filePath=src/agent.ts, success=true
    ├── Span: "LLM 调用 #2"（耗时 680ms）
    │   └── 属性：model=gpt-4o, promptTokens=1800, completionTokens=320
    └── 属性：sessionId=abc123, totalTokens=3400, success=true
```

每个 Span 记录：开始时间、结束时间、属性（key-value）、状态（成功/失败）。

---

## 实现：轻量级 Tracer

不依赖外部系统，先实现一个可以独立运行的轻量级 Tracer：

```typescript
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  endTimeMs: number | null;
  durationMs: number | null;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  errorMessage?: string;
}

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly startTimeMs: number;
  private endTimeMs: number | null = null;
  private attributes: Record<string, string | number | boolean> = {};
  private status: 'ok' | 'error' = 'ok';
  private errorMessage?: string;
  private onEnd: (span: SpanData) => void;

  constructor(
    traceId: string,
    spanId: string,
    parentSpanId: string | null,
    name: string,
    onEnd: (span: SpanData) => void,
  ) {
    this.traceId = traceId;
    this.spanId = spanId;
    this.parentSpanId = parentSpanId;
    this.name = name;
    this.startTimeMs = Date.now();
    this.onEnd = onEnd;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setError(error: Error): this {
    this.status = 'error';
    this.errorMessage = error.message;
    return this;
  }

  end(): void {
    this.endTimeMs = Date.now();
    this.onEnd({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTimeMs: this.startTimeMs,
      endTimeMs: this.endTimeMs,
      durationMs: this.endTimeMs - this.startTimeMs,
      attributes: { ...this.attributes },
      status: this.status,
      errorMessage: this.errorMessage,
    });
  }
}

export class Tracer {
  private spans: SpanData[] = [];

  // 生成唯一 ID（生产环境应使用 UUID 库）
  private generateId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  // 开始一个新的 Trace（根 Span）
  startTrace(name: string): { traceId: string; span: Span } {
    const traceId = this.generateId();
    const spanId = this.generateId();
    const span = new Span(traceId, spanId, null, name, (data) => this.spans.push(data));
    return { traceId, span };
  }

  // 在已有 Trace 下开始一个子 Span
  startSpan(traceId: string, parentSpanId: string, name: string): Span {
    const spanId = this.generateId();
    return new Span(traceId, spanId, parentSpanId, name, (data) => this.spans.push(data));
  }

  // 获取某个 Trace 的所有 Span，按时间排序
  getTrace(traceId: string): SpanData[] {
    return this.spans
      .filter((span) => span.traceId === traceId)
      .sort((a, b) => a.startTimeMs - b.startTimeMs);
  }

  // 打印 Trace 的可读摘要
  printTrace(traceId: string): void {
    const traceSpans = this.getTrace(traceId);
    if (traceSpans.length === 0) {
      console.log(`Trace ${traceId} 不存在`);
      return;
    }

    console.log(`\n📊 Trace: ${traceId}`);
    for (const span of traceSpans) {
      const indent = span.parentSpanId ? '  └── ' : '';
      const duration = span.durationMs !== null ? `${span.durationMs}ms` : '进行中';
      const status = span.status === 'error' ? '❌' : '✅';
      console.log(`${indent}${status} [${span.name}] ${duration}`);
      for (const [key, value] of Object.entries(span.attributes)) {
        console.log(`${indent}    ${key}: ${value}`);
      }
      if (span.errorMessage) {
        console.log(`${indent}    error: ${span.errorMessage}`);
      }
    }
  }
}
```

---

## 把 Tracer 集成到 Agent 执行流程

```typescript
import { generateText, type CoreMessage } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { agentTools } from './tools.js';
import type { ChatContext } from './context-manager.js';
import { ContextManager } from './context-manager.js';

export async function chatWithTracing(
  model: ReturnType<OpenAIProvider['chat']>,
  message: string,
  context: ChatContext,
  systemPrompt: string,
  tracer: Tracer,
): Promise<{ text: string; traceId: string }> {
  // 为本次请求开启一个新 Trace
  const { traceId, span: rootSpan } = tracer.startTrace('agent.chat');
  rootSpan
    .setAttribute('sessionId', context.sessionId)
    .setAttribute('messageLength', message.length);

  const userMessage: CoreMessage = { role: 'user', content: message };
  context.messages.push(userMessage);

  const messages = await ContextManager.buildMessages(systemPrompt, context, model);

  let stepIndex = 0;

  try {
    const { text, usage, steps } = await generateText({
      model,
      messages,
      tools: agentTools,
      maxSteps: 5,
      onStepFinish: ({ toolCalls, toolResults, usage: stepUsage }) => {
        stepIndex++;

        // 为每个工具调用创建子 Span
        for (let i = 0; i < toolCalls.length; i++) {
          const toolSpan = tracer.startSpan(traceId, rootSpan.spanId, `tool.${toolCalls[i].toolName}`);
          toolSpan
            .setAttribute('toolName', toolCalls[i].toolName)
            .setAttribute('args', JSON.stringify(toolCalls[i].args));

          const result = toolResults[i];
          if (result) {
            toolSpan.setAttribute('resultLength', JSON.stringify(result.result).length);
          }
          toolSpan.end();
        }

        // 为每个 LLM 调用步骤创建子 Span
        const llmSpan = tracer.startSpan(traceId, rootSpan.spanId, `llm.step_${stepIndex}`);
        llmSpan
          .setAttribute('promptTokens', stepUsage.promptTokens)
          .setAttribute('completionTokens', stepUsage.completionTokens)
          .setAttribute('toolCallCount', toolCalls.length);
        llmSpan.end();
      },
    });

    rootSpan
      .setAttribute('totalSteps', stepIndex)
      .setAttribute('totalPromptTokens', usage.promptTokens)
      .setAttribute('totalCompletionTokens', usage.completionTokens)
      .setAttribute('responseLength', text.length);
    rootSpan.end();

    const assistantMessage: CoreMessage = { role: 'assistant', content: text };
    context.messages.push(assistantMessage);

    return { text, traceId };
  } catch (error) {
    rootSpan.setError(error instanceof Error ? error : new Error(String(error))).end();
    throw error;
  }
}

// 使用示例
const tracer = new Tracer();
const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = provider.chat('gpt-4o');

const context: ChatContext = {
  sessionId: 'user-123',
  workspaceRoot: process.cwd(),
  messages: [],
};

const { text, traceId } = await chatWithTracing(
  model,
  '读取 src/agent.ts 并告诉我 Agent 类有哪些方法',
  context,
  '你是一个代码助手。',
  tracer,
);

// 打印完整链路
tracer.printTrace(traceId);
```

---

## 对接外部可观测性平台

生产环境中，Span 数据应该发送到专业的可观测性平台（如 Langfuse、LangSmith、OpenTelemetry）：

```typescript
// Vercel ai SDK 内置了 OpenTelemetry 支持
import { generateText } from 'ai';

const { text } = await generateText({
  model,
  messages,
  // 开启实验性遥测，自动把 Span 数据发送到 OpenTelemetry Collector
  experimental_telemetry: {
    isEnabled: true,
    functionId: 'agent.chat',          // 在追踪平台中显示的函数名
    metadata: {
      sessionId: context.sessionId,
      userId: 'user-123',
    },
  },
});
```

配合 `@opentelemetry/sdk-node` 和任意 OTLP Exporter（如 Jaeger、Grafana Tempo），即可在可视化界面中查看完整的 Agent 执行链路。

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Logs** | 记录离散事件，适合排查具体错误 |
| **Metrics** | 记录聚合指标（成功率、耗时分布），适合监控系统健康 |
| **Traces** | 记录一次请求的完整执行链路，适合理解 Agent 的行为 |
| **Span** | Trace 中的一个执行单元，记录名称、耗时、属性、状态 |
| **traceId** | 一次请求的唯一标识，用于把所有 Span 串联成一条链路 |
| **experimental_telemetry** | Vercel ai SDK 内置的 OpenTelemetry 集成，零侵入地采集 LLM 调用数据 |

---

## 与其他课程的关联

- **第16课（Hooks/Middleware）**：Tracer 可以作为一个基于 `onEvent` 的中间件注入，在收到 `tool_call_start` 和 `tool_call_result` 事件时自动创建 Span，无需在每个工具里手动埋点
- **第31课（Token 成本控制）**：Token 消耗数据可以作为 Span 的属性记录，在追踪平台中直接看到每次请求的成本
