---
title: "Skills 系统 — Agent 能力的模块化封装"
date: 2026-11-25
excerpt: "能力如何打包成可动态挂载的模块？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 14
---

> 目标：把"代码审查"、"文档生成"等能力打包成可复用的 Skill 模块，支持自动加载和渐进式激活

---

## 背景：工具越来越多的问题

第4课我们给 Agent 加了工具，第12课又通过 MCP 扩展了工具来源。但随着 Agent 能力增长，一个新问题出现了：

```typescript
// src/agent/tools.ts
export const agentTools = {
  get_current_time: ...,
  read_file: ...,
  list_files: ...,
  save_memory: ...,
  recall_memory: ...,
  delete_memory: ...,
  // 未来还会有：review_code, generate_doc, run_test, deploy...
};
```

**问题在哪？**

1. **工具和 Agent 耦合**：所有工具都堆在 `tools.ts` 里，不管用不用都注入给模型
2. **System Prompt 膨胀**：工具越多，模型需要理解的描述越多，容易混淆
3. **无法复用**：想在另一个 Agent 里用"代码审查"能力，只能复制代码
4. **无法按场景切换**：只读场景和写入场景用同一套工具，不合理

**Skills 的解法**：把相关的工具 + System Prompt 片段打包成一个 **Skill 模块**，Agent 按需注册，用不到的 Skill 完全不加载。

```
┌─────────────────────────────────────────────────────────┐
│  Agent                                                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │  基础工具：get_time, read_file, list_files...    │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌─────────────────┐  ┌──────────────────────────────┐  │
│  │  Skill:         │  │  Skill:                      │  │
│  │  code-review    │  │  doc-generator               │  │
│  │  - SKILL.md     │  │  - SKILL.md                  │  │
│  │  - .mjs 脚本    │  │  - .mjs 脚本                 │  │
│  └─────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 社区标准架构：声明式 + 独立脚本

本课采用的是社区标准的 Skill 架构，和简单的"直接 import 工具函数"方案有本质区别：

| 对比维度 | 简单方案（直接 import） | 社区标准（本课采用） |
|---------|----------------------|-------------------|
| **工具定义** | TypeScript 函数，直接 import | SKILL.md 声明式文档，解耦定义和实现 |
| **工具执行** | 在 Agent 进程内直接调用 | 通过 shell 调用独立 `.mjs` 脚本 |
| **加载方式** | 手动 import + register | 自动扫描目录，解析 SKILL.md |
| **激活控制** | 无，所有工具全部加载 | 渐进式披露：按需 activate/deactivate |
| **跨语言** | 只能 TypeScript | 任意语言写脚本（Python、Shell…） |

---

## Skill 的结构

```typescript
// src/agent/skills-manager.ts

// 工具声明（只描述工具，不包含可执行代码）
export interface SkillTool {
  name: string;           // 工具名称，如 "read_file_for_review"
  description: string;    // 工具描述
  parameters: {           // 参数定义（JSON Schema 格式）
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// Skill 定义
export interface Skill {
  name: string;           // Skill 名称，如 "code-review"
  description: string;    // Skill 描述（会注入 System Prompt）
  version: string;        // 版本号
  systemPrompt?: string;  // 专属的 System Prompt 片段
  tools: SkillTool[];     // 工具声明列表（不含实现）
  skillPath: string;      // Skill 目录路径，执行脚本时使用
}
```

**注意 `tools` 的类型变了**：不再是 `Record<string, tool>`（AI SDK 格式），而是 `SkillTool[]`（纯声明式）。工具的真正实现放在 `.mjs` 脚本里，运行时通过 shell 调用。

---

## 第一步：创建 SKILL.md（声明式定义）

每个 Skill 是一个独立目录，包含两个文件：

```
skills/
├── code-review/
│   ├── SKILL.md          ← 声明式定义：Frontmatter + 工具说明
│   └── code-review.mjs   ← 可执行脚本：接收 JSON 参数，输出 JSON
└── doc-generator/
    ├── SKILL.md
    └── doc-generator.mjs
```

### SKILL.md 格式

```markdown
---
name: code-review
description: 对指定代码文件进行审查，指出潜在问题、改进建议和最佳实践。
version: 1.0.0
---

# 代码审查技能

...Skill 的详细描述...

## 工作流程（会作为 System Prompt 注入）

### 阶段一：读取代码
- 使用 `read_file_for_review` 工具读取目标文件内容
...

## 工具说明

### `read_file_for_review`
读取指定文件内容进行审查。

**参数：**
- `file_path`: 要读取的文件路径（相对路径或绝对路径）

### `write_review_report`
将审查报告写入 Markdown 文件。

**参数：**
- `file_path`: 报告输出路径
- `report`: 报告内容（Markdown 格式）
```

**SKILL.md 的三个关键部分：**

| 部分 | 注入位置 | 作用对象 |
|------|---------|---------|
| **YAML Frontmatter** | `name`/`description` → System Prompt | 模型知道有哪些 Skill |
| **`## 工作流程`** | → `systemPrompt`，注入 Agent | 模型知道怎么用这个 Skill |
| **`## 工具说明`** | → `tool.description`/`parameters` | 模型知道工具参数怎么填 |
| **```` ```bash ``` ```` 代码块** | 不注入任何地方 | 只是给开发者看的协议示例 |

> **核心原则：SKILL.md 里的所有内容，包括代码块，都是给大模型"看"的文字，不是给程序"执行"的代码。**
>
> 真正执行工具的只有一处：`executeTool()` 里的 `execSync()`。SKILL.md 中的 bash 示例是一份接口契约文档——说明 `.mjs` 脚本支持什么调用格式，`executeTool` 构建命令时必须人为遵守同样的约定，两者之间没有任何自动的解析或绑定关系。

---

## 第二步：创建 .mjs 可执行脚本

社区标准：独立可执行脚本，通过 stdin/argv 接收 JSON 参数，向 stdout 输出 JSON 结果。

```javascript
// skills/code-review/code-review.mjs
#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

// 从命令行参数接收 JSON
const params = process.argv[2] ? JSON.parse(process.argv[2]) : {};

async function main() {
  const { action } = params;

  try {
    let result;
    switch (action) {
      case 'read_file_for_review':
        result = await readFileForReview(params);
        break;
      case 'write_review_report':
        result = await writeReviewReport(params);
        break;
      default:
        throw new Error(`未知 action: ${action}`);
    }
    // 输出 JSON 结果（SkillsManager 会解析这个输出）
    console.log(JSON.stringify({ success: true, data: result }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error.message }));
    process.exit(1);
  }
}

async function readFileForReview({ file_path: filePath }) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`文件不存在: ${absolutePath}`);
  const content = fs.readFileSync(absolutePath, 'utf-8');
  return { file_path: absolutePath, content, lines: content.split('\n').length };
}

async function writeReviewReport({ file_path: filePath, report }) {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, report, 'utf-8');
  return { file_path: absolutePath, written: true };
}

main();
```

**脚本的约定：**
- 通过 `process.argv[2]` 接收 JSON 字符串参数
- 参数中必须有 `action` 字段，区分不同工具
- 输出格式固定：`{ success: true, data: ... }` 或 `{ success: false, error: ... }`

---

## 第三步：SkillsManager 自动加载

`SkillsManager` 构造时自动扫描指定目录，解析所有 SKILL.md 文件：

```typescript
// src/agent/skills-manager.ts

export class SkillsManager {
  private registeredSkills: Map<string, Skill> = new Map();
  private activeSkills: Set<string> = new Set(); // 渐进式披露：已激活的 Skill
  private skillsDir: string;

  constructor(skillsDir: string = './skills') {
    this.skillsDir = path.resolve(skillsDir);
    this.loadSkillsFromDirectory(); // 自动扫描并加载
  }

  // 自动扫描目录下所有 Skill
  private loadSkillsFromDirectory(): void {
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = path.join(this.skillsDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          this.loadSkillFromMarkdown(skillMdPath, ...);
        }
      }
    }
  }

  // 解析 SKILL.md：Frontmatter → 元数据，## 工具说明 → SkillTool[]，## 工作流程 → systemPrompt
  private loadSkillFromMarkdown(mdPath: string, skillPath: string): void {
    const content = fs.readFileSync(mdPath, 'utf-8');
    // 解析 YAML Frontmatter 获取 name、description、version
    // 解析 ## 工具说明 部分获取 SkillTool 列表
    // 解析 ## 工作流程 部分作为 systemPrompt
    ...
  }
}
```

**加载流程：**

```
new SkillsManager('./skills')
  ↓
扫描 ./skills/ 目录
  ↓
找到 code-review/SKILL.md、doc-generator/SKILL.md
  ↓
解析 Frontmatter → name, description, version
解析 ## 工具说明 → SkillTool[]
解析 ## 工作流程 → systemPrompt
  ↓
register(skill)，并自动 activate
```

---

## 第四步：渐进式披露

Skills 系统的核心设计之一：不是把所有 Skill 的工具一股脑传给模型，而是**按需激活**。

```typescript
// 激活/停用 Skill
skillsManager.activate('code-review');    // 激活后，工具才会注入 Agent
skillsManager.deactivate('code-review'); // 停用后，工具从 Agent 移除

// 根据用户输入自动匹配并激活
skillsManager.matchAndActivate('帮我审查代码');
// → 自动激活 code-review（因为描述中包含"代码"关键词）

// 查看激活状态
skillsManager.isActive('code-review');   // true/false
skillsManager.getActiveSkills();          // 返回所有已激活的 Skill
```

**`getAllTools()` 返回所有已激活 Skill 的工具（Agent 侧统一用它合并工具）：**

```typescript
// 实际执行时通过 execSync 调用 .mjs 脚本
getAllTools(): Record<string, ReturnType<typeof tool>> {
  const activeTools: Record<string, ReturnType<typeof tool>> = {};
  for (const skill of this.getActiveSkills()) {
    for (const skillTool of skill.tools) {
      activeTools[skillTool.name] = tool({
        description: `[${skill.name}] ${skillTool.description}`,
        parameters: buildZodSchema(skillTool.parameters),
        execute: async (params) => {
          // 关键：通过 shell 调用 .mjs 脚本
          return this.executeTool(skill.name, skillTool.name, params);
        },
      });
    }
  }
  return activeTools;
}

// shell 执行工具：先按 skillName 查表，再用 skillName.mjs 作为脚本入口，
// 并把工具名塞进 params.action —— 一个 Skill 的所有工具共用一个脚本，靠 action 分派
executeTool(skillName: string, toolName: string, params: Record<string, unknown>) {
  const skill = this.skills.find((s) => s.name === skillName);
  if (!skill) throw new Error(`Skill 不存在: ${skillName}`);

  const scriptPath = path.join(skill.skillPath, `${skillName}.mjs`);
  const payload = { ...params, action: toolName };
  const command = `node "${scriptPath}" '${JSON.stringify(payload)}'`;
  const result = execSync(command, { encoding: 'utf-8', timeout: 60000 });
  return JSON.parse(result); // 解析 JSON 输出
}
```

**渐进式披露的好处：**

| 场景 | 工具数量 | 效果 |
|------|---------|------|
| 普通对话 | 只有基础工具 | System Prompt 简洁，模型不会乱用工具 |
| 激活 code-review | 基础工具 + 审查工具 | 按需扩展能力 |
| 激活所有 Skill | 全部工具 | 功能最全，System Prompt 最长 |

---

## 第五步：把 SkillsManager 接入 Agent

```typescript
// src/agent/agent.ts

export class Agent {
  private skillsManager: SkillsManager | null;

  constructor(
    apiKey: string,
    modelName: string,
    baseURL?: string,
    systemPrompt?: string,
    workspaceRoot?: string,
    rulesManager?: RulesManager,
    skillsManager?: SkillsManager   // ← 新增：可选注入 SkillsManager
  ) {
    this.skillsManager = skillsManager ?? null;
  }

  // System Prompt = 基础提示 + 记忆 + Rules + Skills
  private buildSystemPrompt(): string {
    const memorySection = this.memory.format_for_system_prompt();
    const rulesSection = this.rulesManager?.formatForSystemPrompt() ?? '';
    const skillsSection = this.skillsManager?.formatForSystemPrompt() ?? '';
    return this.baseSystemPrompt + memorySection + rulesSection + skillsSection;
  }

  async chatWithTools(...) {
    // 合并基础工具 + 所有已激活 Skill 的工具
    const skillTools = this.skillsManager?.getAllTools() ?? {};
    const allTools = { ...agentTools, ...skillTools };

    const result = await generateText({
      model: this.model,
      messages: messagesWithSystem,
      tools: allTools,
      maxSteps: 5,
    });
  }
}
```

`formatForSystemPrompt()` 生成的内容结构：

```
## Available Skills

- ✓ code-review: 对指定代码文件进行审查...
- ✓ doc-generator: 根据源代码文件自动生成文档...

✓ = Activated (Available) | ○ = Not Activated

---

### Activated Skills Details

#### code-review (v1.0.0)
对指定代码文件进行审查...

[工作流程部分的内容作为行为规范]

**Available Tools:**
- read_file_for_review: 读取指定文件内容进行审查
- write_review_report: 将审查报告写入 Markdown 文件
```

---

## 第六步：完整使用示例

```typescript
// src/skills-demo.ts

import { Agent } from './agent/agent.js';
import { SkillsManager } from './agent/skills-manager.js';

// 第一步：创建 SkillsManager，自动扫描 ./skills 目录
// 会自动找到 code-review/SKILL.md 和 doc-generator/SKILL.md 并加载
const skillsManager = new SkillsManager('./skills');

// 打印已加载的 Skill 摘要
skillsManager.printSummary();
// 输出：
// Loaded 2 Skills:
//   - code-review (v1.0.0): read_file_for_review, write_review_report
//   - doc-generator (v1.0.0): read_source_file, write_documentation

// 渐进式披露：初始先停用所有 Skill
for (const skill of skillsManager.getSkills()) {
  skillsManager.deactivate(skill.name);
}

// 第二步：把 SkillsManager 注入 Agent
const agent = new Agent(
  apiKey,
  modelName,
  baseUrl,
  '你是一个专业的 AI 编程助手...',
  process.cwd(),
  undefined,       // rulesManager
  skillsManager    // ← Agent 会自动使用已激活的 Skill 工具
);

// 第三步：需要某个能力时手动激活，或根据用户输入自动激活
skillsManager.activate('code-review');
// 现在 read_file_for_review 和 write_review_report 会注入给 Agent

await agent.chatWithTools(
  '帮我审查 src/agent/tools.ts',
  context,
  (chunk) => process.stdout.write(chunk)
);
// Agent 会调用 read_file_for_review 工具（实际执行 code-review.mjs）
// 读取文件内容后，给出审查报告
```

**Demo 还支持手动命令：**

```bash
/activate code-review    # 手动激活 Skill
/deactivate code-review  # 手动停用 Skill
/status                  # 查看所有 Skill 激活状态
```

---

## 目录结构

```
simple-agent/
├── skills/                        ← Skill 模块目录（与 src 平级）
│   ├── code-review/
│   │   ├── SKILL.md               ← 声明式定义（Frontmatter + 工具说明 + 工作流程）
│   │   ├── code-review.mjs        ← 可执行脚本（接收 JSON，输出 JSON）
│   │   └── tools.ts               ← 可选：兼容旧版直接 import 方式
│   └── doc-generator/
│       ├── SKILL.md
│       ├── doc-generator.mjs
│       └── tools.ts
└── src/
    ├── agent/
    │   ├── skills-manager.ts      ← SkillsManager 核心类
    │   └── agent.ts               ← 集成了 SkillsManager
    └── skills-demo.ts             ← 完整演示（含渐进式披露）
```

---

## 运行方式

```bash
npx tsx src/skills-demo.ts
```

启动后，试试这些对话：

- `"帮我审查 src/agent/tools.ts"` → 激活 code-review → 调用 `read_file_for_review` 脚本读取文件 → 给出审查报告
- `"为 src/agent/skills-manager.ts 生成文档"` → 激活 doc-generator → 调用 `read_source_file` 脚本 → 生成 Markdown 文档
- `/activate code-review` → 手动激活
- `/status` → 查看当前 Skill 激活状态

---

## 核心问题回答

**Q：Skill 和普通工具有什么区别？**

A：普通工具是单个 TypeScript 函数，直接 import 后注入 Agent。Skill 是**一组相关工具 + 行为规范的打包**，工具实现是独立的可执行脚本，通过 shell 调用，Agent 进程和工具实现完全解耦。就像 npm 包和单个函数的区别——包里可以有多个函数，还有 README 说明怎么用，并且可以用任意语言实现。

**Q：为什么工具要放在 .mjs 脚本里，而不是直接 import？**

A：**解耦**是核心原因。SKILL.md 是纯声明式文档，谁都能读懂、谁都能扩展。`.mjs` 脚本是独立进程，可以用 Python、Shell 等任意语言写，不受 Agent 进程语言限制。另外，独立进程天然有沙箱隔离效果。

**Q：渐进式披露解决了什么问题？**

A：模型看到的工具越多，越容易混淆。渐进式披露让 Agent 在普通对话时只有基础工具，当用户真正需要某个能力时再激活对应 Skill。`matchAndActivate()` 还可以根据用户输入的关键词自动激活，实现智能按需扩展。

**Q：Skill 和 MCP 能同时用吗？**

A：可以。MCP 工具通过 `McpClient.getTools()` 拉取，Skill 工具通过 `skillsManager.getAllTools()` 获取，两者都是 `Record<string, tool>` 格式，合并后一起传给 `generateText`：

```typescript
const mcpTools = await mcpClient.getTools();
const skillTools = skillsManager.getAllTools();
const allTools = { ...agentTools, ...mcpTools, ...skillTools };
```

**Q：和 MCP（第12课）有什么本质区别？**

| 对比维度 | MCP（第12课） | Skills（本课） |
|---------|-------------|--------------|
| **定位** | 跨 Agent / 跨工具生态复用 | 同一 Agent 内按场景组合 |
| **工具来源** | 独立进程，通过协议拉取 | shell 调用，同 Agent 管理 |
| **System Prompt** | 不携带行为规范 | 可携带专属 System Prompt |
| **激活控制** | 无，全部工具加载 | 渐进式披露，按需激活 |
| **标准化** | 有正式协议规范 | 社区约定，更灵活 |

---

## 下一课预告

第14课：**Agent 安全 — 权限控制与沙箱隔离**

Agent 能操作文件系统，如何防止路径穿越攻击？如何识别 Prompt Injection？如何按场景限制工具权限？
