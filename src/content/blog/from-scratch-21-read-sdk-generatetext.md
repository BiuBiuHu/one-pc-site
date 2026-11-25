---
title: "第二十一课：generateText 源码解析"
date: 2026-11-25
excerpt: "Provider 抽象层是什么设计模式？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 22
---

> 目标：通过阅读 Vercel ai SDK 源码，理解 generateText 的内部实现，掌握 Provider 抽象层的设计模式

---

## 背景：为什么要读源码？

前面的课程我们一直在用 `generateText`，但它内部到底做了什么？

```typescript
const { text } = await generateText({
  model: provider.chat('gpt-4'),
  messages: [...],
});
```

这一行代码背后：
- `provider.chat('gpt-4')` 返回的是什么？
- `generateText` 怎么知道要调用 OpenAI 还是 Anthropic？
- 工具调用的循环是在哪里实现的？

---

## 整体架构：三层抽象

```
你的代码
    │
    ▼
generateText()          ← 统一入口，与模型无关
    │
    ▼
LanguageModel 接口      ← 抽象层，定义"模型"应该有哪些能力
    │
    ▼
OpenAIProvider          ← 具体实现，负责和 OpenAI API 通信
AnthropicProvider
GoogleProvider
...
```

这是经典的**适配器模式（Adapter Pattern）**：`generateText` 只和抽象接口打交道，不关心底层是哪家模型。

---

## 第一层：LanguageModel 接口

`ai` SDK 的核心是 `LanguageModel` 接口（位于 `packages/ai/core/types/language-model.ts`）：

```typescript
// 简化版，展示核心结构
export interface LanguageModel {
  // 模型的唯一标识符，如 "openai:gpt-4"
  readonly specificationVersion: 'v1';
  readonly provider: string;
  readonly modelId: string;

  // 核心方法：执行一次 LLM 调用（非流式）
  doGenerate(options: LanguageModelV1CallOptions): Promise<{
    text?: string;
    toolCalls?: Array<LanguageModelV1ToolCall>;
    finishReason: 'stop' | 'length' | 'tool-calls' | 'error';
    usage: { promptTokens: number; completionTokens: number };
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }>;

  // 核心方法：执行一次 LLM 调用（流式）
  doStream(options: LanguageModelV1CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV1StreamPart>;
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }>;
}
```

**关键洞察**：`generateText` 只调用 `model.doGenerate()`，不关心 `model` 是 OpenAI 还是 Anthropic。

---

## 第二层：generateText 内部实现

`generateText` 的核心逻辑（位于 `packages/ai/core/generate-text/generate-text.ts`）：

```typescript
// 大幅简化，保留核心逻辑
export async function generateText({
  model,
  messages,
  tools,
  maxSteps = 1,
  onStepFinish,
}: GenerateTextParams): Promise<GenerateTextResult> {

  const allSteps: StepResult[] = [];
  let currentMessages = [...messages];

  // ── Agent Loop：最多执行 maxSteps 步 ──────────────────────────────────────
  for (let step = 0; step < maxSteps; step++) {

    // 1. 调用模型（通过抽象接口，不关心底层是哪家）
    const modelResponse = await model.doGenerate({
      inputFormat: 'messages',
      mode: tools
        ? { type: 'regular', tools: convertToolsToModelFormat(tools) }
        : { type: 'regular' },
      prompt: convertMessagesToModelFormat(currentMessages),
    });

    // 2. 收集本步骤的工具调用
    const toolCalls = modelResponse.toolCalls ?? [];
    const toolResults: ToolResult[] = [];

    // 3. 执行工具（如果有）
    for (const toolCall of toolCalls) {
      const tool = tools?.[toolCall.toolName];
      if (tool?.execute) {
        const result = await tool.execute(toolCall.args, {
          toolCallId: toolCall.toolCallId,
          messages: currentMessages,
        });
        toolResults.push({ toolCallId: toolCall.toolCallId, result });
      }
    }

    // 4. 触发 onStepFinish 钩子（这就是我们在第15课用到的！）
    await onStepFinish?.({
      text: modelResponse.text ?? '',
      toolCalls,
      toolResults,
      finishReason: modelResponse.finishReason,
      stepType: step === 0 ? 'initial' : 'continue',
    });

    allSteps.push({ text: modelResponse.text ?? '', toolCalls, toolResults });

    // 5. 判断是否继续循环
    if (modelResponse.finishReason === 'stop' || toolCalls.length === 0) {
      break; // 模型说"我说完了"，或者没有工具调用，退出循环
    }

    // 6. 把工具结果追加到消息历史，进入下一轮
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: toolCalls }, // 模型的工具调用请求
      ...toolResults.map(r => ({                  // 工具执行结果
        role: 'tool' as const,
        content: [{ type: 'tool-result', toolCallId: r.toolCallId, result: r.result }],
      })),
    ];
  }

  // 7. 返回最终结果（汇总所有步骤的 token 用量）
  const lastStep = allSteps[allSteps.length - 1];
  const totalUsage = allSteps.reduce(
    (acc, step) => ({
      promptTokens: acc.promptTokens + (step.usage?.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (step.usage?.completionTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0 }
  );

  return {
    text: lastStep.text,
    toolCalls: lastStep.toolCalls,
    toolResults: lastStep.toolResults,
    steps: allSteps,
    usage: totalUsage,
  };
}
```

**关键洞察**：`maxSteps` 控制的 while 循环，就是我们在第7课手写的 Agent Loop！SDK 只是把它封装好了。

---

## 第三层：OpenAIProvider 实现

`@ai-sdk/openai` 的 `doGenerate` 方法（位于 `packages/openai/src/openai-chat-language-model.ts`）：

```typescript
// 大幅简化
class OpenAIChatLanguageModel implements LanguageModel {
  readonly provider = 'openai';
  readonly modelId: string;

  constructor(modelId: string, private config: OpenAIConfig) {
    this.modelId = modelId;
  }

  async doGenerate(options: LanguageModelV1CallOptions) {
    // 1. 把 SDK 的通用格式转成 OpenAI 特有的请求格式
    const openAIRequest = {
      model: this.modelId,
      messages: convertToOpenAIMessages(options.prompt),
      tools: options.mode.tools?.map(convertToOpenAITool),
      tool_choice: 'auto',
      stream: false,
    };

    // 2. 发起 HTTP 请求（就是第5课手写的那个 fetch）
    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(openAIRequest),
    });

    const json = await response.json();

    // 3. 把 OpenAI 的响应格式转成 SDK 的通用格式
    const choice = json.choices[0];
    return {
      text: choice.message.content ?? undefined,
      toolCalls: choice.message.tool_calls?.map(convertFromOpenAIToolCall),
      finishReason: convertFinishReason(choice.finish_reason),
      usage: {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
      },
      rawCall: { rawPrompt: openAIRequest, rawSettings: {} },
    };
  }
}
```

---

## 设计模式总结

### 适配器模式（Adapter）

```
generateText ──调用──▶ LanguageModel.doGenerate()
                              ▲
                    ┌─────────┴──────────┐
                    │                    │
           OpenAIAdapter          AnthropicAdapter
           (转换格式，调用          (转换格式，调用
            OpenAI API)            Anthropic API)
```

每个 Provider 都是一个适配器，把各家 API 的不同格式统一成 SDK 的通用格式。

### 模板方法模式（Template Method）

`generateText` 定义了 Agent Loop 的骨架（调用模型 → 执行工具 → 判断是否继续），具体的"调用模型"步骤由各 Provider 实现。

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **LanguageModel 接口** | SDK 的核心抽象，定义 `doGenerate` 和 `doStream` 两个方法 |
| **适配器模式** | 各 Provider 把不同 API 格式统一成 SDK 通用格式 |
| **Agent Loop** | `generateText` 内部的 for 循环，就是第7课手写的 while 循环 |
| **onStepFinish** | SDK 在每个 Agent Loop 步骤完成后调用的钩子，第15课用到的 |
| **convertToOpenAIMessages** | 把 SDK 的 CoreMessage 格式转成 OpenAI 的 messages 格式 |

---

## 下一步

- [ ] 阅读 `streamText` 源码，理解 AsyncIterator 和背压机制
