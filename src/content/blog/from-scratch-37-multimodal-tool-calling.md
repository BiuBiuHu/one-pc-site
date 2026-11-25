---
title: "第三十七课：多模态工具调用 — 让 Agent 看懂图片"
date: 2026-11-25
excerpt: "如何让 Agent 看懂截图并调用工具修复？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 38
---

> 目标：理解多模态 LLM 的输入格式，掌握在 Agent 中处理图片输入并结合工具调用的实现方法，以及"图片直读 vs 先识别后入参"两种架构范式的选型

---

## 背景：从"只能读文字"到"能看图"

前面所有课程的 Agent 都只处理文字。但现实中的任务经常涉及图片：

- 用户截图报错 → Agent 看图分析问题
- 用户上传 UI 设计图 → Agent 生成对应代码
- 用户发一张架构图 → Agent 解读并提出优化建议

支持多模态的模型（如 GPT-4o、Claude 3）可以同时接收文字和图片作为输入，并在理解图片内容的基础上调用工具。

---

## 多模态消息格式

OpenAI 的多模态消息格式：用户消息的 `content` 从字符串变成数组，每个元素是一个"内容块"：

```typescript
import type { CoreMessage } from 'ai';

// 普通文字消息
const textOnlyMessage: CoreMessage = {
  role: 'user',
  content: '帮我分析这段代码',
};

// 多模态消息：文字 + 图片
const multimodalMessage: CoreMessage = {
  role: 'user',
  content: [
    {
      type: 'text',
      text: '这张截图里的报错是什么原因？',
    },
    {
      type: 'image',
      // 方式一：Base64 编码的图片数据
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...',
    },
  ],
};

// 也可以用图片 URL（模型会自动下载）
const messageWithImageUrl: CoreMessage = {
  role: 'user',
  content: [
    {
      type: 'text',
      text: '分析这张架构图，指出潜在的单点故障',
    },
    {
      type: 'image',
      image: new URL('https://example.com/architecture.png'),
    },
  ],
};
```

---

## 从文件读取图片并转为 Base64

```typescript
import * as fs from 'fs';
import * as path from 'path';

type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const EXTENSION_TO_MIME: Record<string, SupportedImageMimeType> = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

interface ImageData {
  base64: string;
  mimeType: SupportedImageMimeType;
  sizeBytes: number;
}

function loadImageFromFile(filePath: string): ImageData {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = EXTENSION_TO_MIME[ext];

  if (!mimeType) {
    throw new Error(`不支持的图片格式：${ext}，支持的格式：${Object.keys(EXTENSION_TO_MIME).join(', ')}`);
  }

  const buffer = fs.readFileSync(filePath);

  // GPT-4o 对单张图片的大小限制是 20MB
  const maxSizeBytes = 20 * 1024 * 1024;
  if (buffer.length > maxSizeBytes) {
    throw new Error(`图片文件过大：${(buffer.length / 1024 / 1024).toFixed(1)}MB，上限为 20MB`);
  }

  return {
    base64: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    sizeBytes: buffer.length,
  };
}
```

---

## 构建多模态 Agent

把图片处理能力集成到 Agent 中，支持文字 + 图片混合输入：

```typescript
import { generateText, type CoreMessage, type ImagePart, type TextPart } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { agentTools } from './tools.js';
import type { ChatContext } from './context-manager.js';
import { ContextManager } from './context-manager.js';

export interface MultimodalInput {
  text: string;
  imagePaths?: string[];    // 本地图片文件路径列表
  imageUrls?: string[];     // 图片 URL 列表
}

export async function chatWithImages(
  model: ReturnType<OpenAIProvider['chat']>,
  input: MultimodalInput,
  context: ChatContext,
  systemPrompt: string,
): Promise<string> {
  // 构建多模态消息的 content 数组
  const contentParts: Array<TextPart | ImagePart> = [
    { type: 'text', text: input.text },
  ];

  // 添加本地图片（转为 Base64）
  if (input.imagePaths && input.imagePaths.length > 0) {
    for (const imagePath of input.imagePaths) {
      const imageData = loadImageFromFile(imagePath);
      contentParts.push({
        type: 'image',
        image: imageData.base64,
      });
    }
  }

  // 添加图片 URL
  if (input.imageUrls && input.imageUrls.length > 0) {
    for (const imageUrl of input.imageUrls) {
      contentParts.push({
        type: 'image',
        image: new URL(imageUrl),
      });
    }
  }

  const userMessage: CoreMessage = {
    role: 'user',
    content: contentParts,
  };

  context.messages.push(userMessage);

  const messages = await ContextManager.buildMessages(systemPrompt, context, model);

  const { text } = await generateText({
    model,
    messages,
    tools: agentTools,
    maxSteps: 5,
  });

  const assistantMessage: CoreMessage = { role: 'assistant', content: text };
  context.messages.push(assistantMessage);

  return text;
}

// 使用示例
const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
// 必须使用支持视觉的模型
const visionModel = provider.chat('gpt-4o');

const context: ChatContext = {
  sessionId: 'vision-demo',
  workspaceRoot: process.cwd(),
  messages: [],
};

const result = await chatWithImages(
  visionModel,
  {
    text: '这张截图里的 TypeScript 报错是什么原因？请帮我修复',
    imagePaths: ['/tmp/error-screenshot.png'],
  },
  context,
  '你是一个代码助手，能分析截图中的错误并给出修复方案。',
);

console.log(result);
```

---

## 图片 + 工具调用的组合场景

多模态最强大的地方是：**看图后调用工具**。例如：

```typescript
// 场景：用户上传一张报错截图，Agent 看图后自动读取相关文件并修复
const errorAnalysisPrompt = `
你是一个代码调试专家。当用户提供报错截图时：
1. 分析截图中的错误信息
2. 使用 read_file 工具读取相关源文件
3. 定位问题根因
4. 给出具体的修复方案
`;

const result = await chatWithImages(
  visionModel,
  {
    text: '这个报错怎么修？相关文件在 src/agent/agent.ts',
    imagePaths: ['/tmp/typescript-error.png'],
  },
  context,
  errorAnalysisPrompt,
);
// Agent 会：看图 → 理解报错 → 调用 read_file 读取 agent.ts → 给出修复方案
```

---

## 注意事项

### 图片 Token 消耗

图片会消耗大量 Token，GPT-4o 的图片计费规则：

| 图片尺寸 | 消耗 Token 数（约） |
|---------|------------------|
| 512×512 | ~170 tokens |
| 1024×1024 | ~765 tokens |
| 2048×2048 | ~1105 tokens |

**建议**：在发送前压缩图片到合理尺寸（1024px 以内），既省 Token 又不影响识别效果。

### 多模态消息在历史中的处理

图片消息存入 `context.messages` 后，每次对话都会把图片带上，Token 消耗会快速增长。建议：

```typescript
// 图片消息只保留最近 N 轮，或在存入历史时把图片替换为文字描述
const assistantMessage: CoreMessage = {
  role: 'assistant',
  content: text,
};
// 把用户消息里的图片替换为占位符，减少后续对话的 Token 消耗
const userMessageForHistory: CoreMessage = {
  role: 'user',
  content: `[图片已分析] ${input.text}`,
};
context.messages.push(userMessageForHistory);
context.messages.push(assistantMessage);
```

---

## 扩展：先识别、后入参 —— 让图片不占用上下文

> 前面讲的都是"图片直接进上下文、模型看图"。还有一种架构范式：**先把图片识别成结构化文字，再让主 Agent 拿着文字做决策**。这样图片本身完全不占上下文，长期看更省、更稳、更适合流水线。

### 为什么需要第二种方式

前面的方案有个现实问题：图片一旦进了 `context.messages`，**每次后续对话都会把整张图重新带上**。

- 图片按尺寸计费，一张 1024×1024 就是 ~765 tokens
- 一次"看图 → 改代码 → 再验证 → 再改"的任务，可能反复带同一张图十几轮
- 历史里图片越多，上下文越早被打满，还触发第 8 课的裁剪逻辑

第 37 课正文末尾那个"把图片替换为 `[图片已分析] ${input.text}` 占位符存入历史"的小技巧，本质就是这个思路的雏形。而真正彻底的解法是：**把"看图"这一步前移到写入历史之前**——用一个专门的视觉步骤把图变成文字。

### 范式对比：直读 vs 先识别

```
方式 A · 图片直读（正文方案）
  图片 ──Base64/URL──▶ model context ──▶ 主模型看图 + 调工具
                        （图片长期驻留上下文）

方式 B · 先识别后入参（扩展方案）
  图片 ──▶ 视觉识别步骤 ──▶ 结构化文字描述 ──▶ model context ──▶ 主模型基于文字推理
                │ （只识别一次）
                └─▶ 文字结果可入库存档 / 可进 RAG 检索
```

| 维度 | A · 图片直读 | B · 先识别后入参 |
|------|-------------|-----------------|
| 上下文占用 | 图片每次对话都在，1024×1024≈765 tokens/张 | 只留识别后的文字，通常 <100 tokens，图片永不出现在历史 |
| 多轮成本 | 同一张图反复计费，任务越长越贵 | 图只被识别一次，后续零图片开销 |
| 细节保真 | 模型直接看原图，像素级细节不丢 | 受识别模型能力上限，可能丢细节（图表数字、OCR 错字） |
| 可审计/可检索 | 图片不可搜索、不可溯源 | 识别结果是文本，可入库、可进向量库做 RAG |
| 确定性 | 自由看图，结果偏软 | 可强制结构化 schema，适合票据/表单/OCR 等硬字段场景 |
| 实现复杂度 | 一步到位，简单 | 多一个识别步骤，要设计 prompt + 结果 schema |
| 适用场景 | 一次交互、需要主模型自由看细节 | 长对话、批量流水线、入库检索、强确定性需求 |

**一句话**：方式 A 把"看图"当成主模型的能力，方式 B 把"看图"当成一次**可复用的前置服务**，让主模型永远只做它最擅长的"基于文字推理"。

### 代码实现：先识别后入参

核心是把识别结果固化成 schema，用 `generateObject` 拿到结构化描述，再注入主 Agent：

```typescript
import { generateObject, generateText, type CoreMessage } from 'ai';
import { z } from 'zod';
import { loadImageFromFile } from './multimodal.js'; // 复用前面的图片读取

// ① 定义识别结果的结构化 schema —— 这是"图像→文字"的契约
const ImageAnalysisSchema = z.object({
  summary: z.string().describe('这张图的整体概括（一句话）'),
  content: z.object({
    text:     z.array(z.string()).describe('图中出现的全部文字/报错信息'),
    numbers:  z.array(z.string()).optional().describe('图中关键数字/金额/日期等'),
    layout:   z.string().optional().describe('图的布局/结构描述，如图表、流程、界面'),
    issues:   z.array(z.string()).optional().describe('图中暴露出来的问题点，如报错、异常'),
  }),
  riskDetail: z.string().optional().describe('需要特别留意、但主模型自己读图容易忽略的细节'),
});

// ② 视觉识别步骤：独立的一次调用，结果可直接入库 / 进 RAG
async function analyzeImage(imageBase64: string, visionModel: any) {
  const { object } = await generateObject({
    model: visionModel,          // 用支持视觉的模型，如 gpt-4o
    schema: ImageAnalysisSchema,
    prompt: `
你是一个图片识别前置服务。请把图片内容转换成结构化文字，供下游 Agent 使用。
要求：
1. 完整保留文字类信息（报错、标题、标签），不要意译或概括丢失
2. 数字要原样保留
3. summary 一句话概述即可
4. 识别不出来的不要编造，宁缺毋滥
`,
    messages: [
      { role: 'user', content: [{ type: 'image', image: imageBase64 }] },
    ],
  });
  return object;
}

// ③ 主 Agent：只接收文字，图片不再进上下文
async function chatWithPreAnalyzedImage(
  model: any,                       // 主 Agent 模型，可以是纯文本模型，更省钱
  text: string,
  imagePaths: string[],
  context: ChatContext,
  visionModel: any,                 // 识别用视觉模型，可与主模型不同
  systemPrompt: string,
) {
  // 先识别（图片只在这里被消费一次）
  const analyses = [];
  for (const p of imagePaths) {
    const data = loadImageFromFile(p);
    analyses.push(await analyzeImage(data.base64, visionModel));
  }

  // 把识别结果压成简洁文字，注入上下文
  const imageBrief = analyses.map((a, i) => `
【图片${i + 1} 识别结果】
- 概述：${a.summary}
- 文字内容：${a.content.text.join('；')}
${a.content.numbers?.length ? `- 关键数字：${a.content.numbers.join(' / ')}` : ''}
${a.content.issues?.length ? `- 问题点：${a.content.issues.join('；')}` : ''}
${a.riskDetail ? `- 补充细节：${a.riskDetail}` : ''}
`).map(s => s.replace(/\n{2,}/g, '\n').trim()).join('\n');

  const userMessage: CoreMessage = {
    role: 'user',
    content: `${text}\n\n下面附上图片的识别结果：\n${imageBrief}`,
  };
  context.messages.push(userMessage);   // ← 注意：这里推入的是纯文字，没有 ImagePart

  const { text: answer } = await generateText({
    model,                              // 可用更便宜的纯文本模型做决策
    messages: await ContextManager.buildMessages(systemPrompt, context, model),
    maxSteps: 5,
  });

  context.messages.push({ role: 'assistant', content: answer });
  return answer;
}
```

关键点：

1. **图片只在识别步骤被消费一次**，主 Agent 的消息流里零 `ImagePart`，上下文长期稳定
2. **识别结果可下沉**：结构化的识别结果可写库、可进向量库做 RAG 溯源（对应第 18 课），同一张图后续任务能直接复用，不用再识别
3. **主模型可选纯文本模型**：识别交给视觉模型，决策交给便宜模型，整体成本可能比"全程用 gpt-4o"更低（对应第 31 课成本控制）
4. **强确定性**：OCR/票据/表单这种要硬字段的场景，schema 约束比"自由看图"稳得多

### 两种方式怎么选（决策建议）

| 场景 | 推荐 |
|------|------|
| 用户随手发一张图、问一句 | **A 直读**：最快，一步到位 |
| 长对话/多轮任务，图反复出现在历史 | **B 先识别**：避免图片反复计费 |
| 批量处理大量截图/文档 | **B 先识别**：可重复跑、可入库 |
| 报错图→Agent 自动读代码修 Bug | **A 直读**为主：主模型要自由看图找线索 |
| 票据/表单/OCR 要精确字段 | **B 先识别**：schema 强制结构化 |
| 图片结果要做 RAG / 多 Agent 共享 | **B 先识别**：文字才能检索、才能传 |

一个工程化技巧：**两种可以混用**——第一轮用 A 直读让模型充分看图，识别出的关键文字同步写回历史，从第二轮起用 B 的方式只带文字。这样既保留了首轮视觉细节，又避免了长任务里图片持续占坑。

### 识别结果存入历史（B 方式的配套注意）

即使用了先识别，识别后的文字也要注意不要把一长串原始识别结果全部堆进历史。可配合第 8 课上下文管理，把识别结果做**摘要压缩**：

```typescript
// 识别结果较长时，只保留关键字段，细节可写到外部存储按需召回
const historyEntry = `[图片已识别] ${a.summary}` +
  (a.content.issues?.length ? ` | 问题:${a.content.issues.slice(0, 3).join(';')}` : '');
context.messages.push({ role: 'user', content: historyEntry });
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **多模态消息** | `content` 从字符串变成数组，每个元素是 `TextPart` 或 `ImagePart` |
| **ImagePart** | 支持 Base64 字符串（`data:image/...;base64,...`）或 `URL` 对象两种格式 |
| **Vision 模型** | 支持图片输入的模型，如 `gpt-4o`、`gpt-4o-mini`（不是所有模型都支持） |
| **图片 Token 消耗** | 图片按尺寸计费，1024×1024 约消耗 765 个 Token |
| **图片 + 工具调用** | 模型可以先理解图片内容，再决定调用哪些工具，是多模态最强大的组合 |
| **两种接入范式** | A 直读：图片进上下文（保真、简单）；B 先识别后入参（省上下文、可复用、可检索） |
| **识别前置化** | 用 `generateObject` + schema 把"看图"固化成一次可复用的前置服务，结果可入库/进向量库 |
| **主模型降本** | B 方案下主 Agent 可选纯文本模型，视觉识别与文字决策解耦，单独选型 |

---

## 与其他课程的关联

- **第31课（Token 成本控制）**：图片消耗 Token 远多于文字，多模态场景下成本控制尤为重要；B 方案用视觉/文本模型解耦进一步降本
- **第8课（上下文管理）**：图片消息在历史中会快速撑大上下文，需要特殊的裁剪策略；"先识别后入参"是彻底避免图片占上下文的架构级解法
- **第18课（RAG）**：先识别产出的文字可进向量库做溯源检索，让图片知识可被检索复用
- **第39课（Agent Evals）**：B 方案的识别结果遵循固定 schema，更易写成可断言的评估用例
