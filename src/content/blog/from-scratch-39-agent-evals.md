---
title: "Agent Evals — 量化评估 Agent 的质量"
date: 2026-11-25
excerpt: "如何用数据判断改动是变好还是变坏？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 40
---

> 目标：理解 Evals 的核心思想，掌握基于规则、基于模型、基于人工三种评估方法，建立可持续迭代的评估体系

---

## 背景：没有 Evals，就不知道 Agent 在变好还是变差

每次修改 Prompt、换模型、调整工具，你都想知道：这次改动让 Agent 变好了还是变差了？

没有 Evals 时，你只能靠"感觉"——手动测几个例子，觉得还行就上线。这带来的问题：

- **无法量化**：说不清楚"好了多少"
- **覆盖不全**：手动测的例子太少，遗漏了边界情况
- **无法回归**：下次改动后，不知道之前好的地方有没有变差
- **无法对比**：A/B 测试两个版本，不知道哪个更好

**Evals 就是给 Agent 建立一套自动化的"考试题"，每次改动后都跑一遍，用分数说话。**

---

## Evals 的核心结构

```
Eval 套件
├── 测试用例集（Test Cases）
│   ├── 用例1：{ input: "...", expectedBehavior: "..." }
│   ├── 用例2：{ input: "...", expectedBehavior: "..." }
│   └── ...
│
├── 评分器（Scorer）
│   ├── 规则评分器：用正则/关键词判断
│   ├── 模型评分器：用 LLM 判断质量
│   └── 人工评分器：人工打分（离线）
│
└── 报告（Report）
    ├── 总体通过率
    ├── 各维度得分
    └── 失败用例详情
```

---

## 第一种：基于规则的评分器（最快、最便宜）

适合有明确正确答案的场景：

```typescript
import { generateText, type CoreMessage } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { agentTools } from './tools.js';

interface EvalTestCase {
  id: string;
  description: string;
  input: string;
  // 规则评分器的判断条件
  assertions: Array<{
    type: 'contains' | 'not_contains' | 'matches_regex' | 'tool_called' | 'no_tool_called';
    value: string;
    description: string;
  }>;
}

interface EvalResult {
  testCaseId: string;
  description: string;
  passed: boolean;
  score: number;          // 0~1
  agentOutput: string;
  toolsCalled: string[];
  failedAssertions: string[];
  durationMs: number;
}

// 规则评分器：根据断言列表判断输出是否符合预期
function scoreWithRules(
  output: string,
  toolsCalled: string[],
  assertions: EvalTestCase['assertions'],
): { passed: boolean; score: number; failedAssertions: string[] } {
  const failedAssertions: string[] = [];

  for (const assertion of assertions) {
    let assertionPassed = false;

    switch (assertion.type) {
      case 'contains':
        assertionPassed = output.toLowerCase().includes(assertion.value.toLowerCase());
        break;
      case 'not_contains':
        assertionPassed = !output.toLowerCase().includes(assertion.value.toLowerCase());
        break;
      case 'matches_regex':
        assertionPassed = new RegExp(assertion.value, 'i').test(output);
        break;
      case 'tool_called':
        assertionPassed = toolsCalled.includes(assertion.value);
        break;
      case 'no_tool_called':
        assertionPassed = !toolsCalled.includes(assertion.value);
        break;
    }

    if (!assertionPassed) {
      failedAssertions.push(`[${assertion.type}] ${assertion.description}`);
    }
  }

  const score = (assertions.length - failedAssertions.length) / assertions.length;
  return { passed: failedAssertions.length === 0, score, failedAssertions };
}

// 运行单个测试用例
async function runTestCase(
  model: ReturnType<OpenAIProvider['chat']>,
  systemPrompt: string,
  testCase: EvalTestCase,
): Promise<EvalResult> {
  const startTime = Date.now();
  const toolsCalled: string[] = [];

  const { text } = await generateText({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: testCase.input },
    ],
    tools: agentTools,
    maxSteps: 5,
    onStepFinish: ({ toolCalls }) => {
      for (const toolCall of toolCalls) {
        toolsCalled.push(toolCall.toolName);
      }
    },
  });

  const { passed, score, failedAssertions } = scoreWithRules(text, toolsCalled, testCase.assertions);

  return {
    testCaseId: testCase.id,
    description: testCase.description,
    passed,
    score,
    agentOutput: text,
    toolsCalled,
    failedAssertions,
    durationMs: Date.now() - startTime,
  };
}
```

---

## 第二种：基于模型的评分器（LLM-as-Judge）

适合没有明确正确答案、需要判断质量的场景：

```typescript
import { generateObject } from 'ai';
import { z } from 'zod';

const JudgeResultSchema = z.object({
  score: z.number().min(0).max(10).describe('质量评分，0-10'),
  reasoning: z.string().describe('评分理由'),
  strengths: z.array(z.string()).describe('回答的优点'),
  weaknesses: z.array(z.string()).describe('回答的不足'),
  passed: z.boolean().describe('是否达到可接受的质量标准（分数 >= 7 视为通过）'),
});

async function scoreWithLLMJudge(
  judgeModel: ReturnType<OpenAIProvider['chat']>,
  userInput: string,
  agentOutput: string,
  evaluationCriteria: string,
): Promise<z.infer<typeof JudgeResultSchema>> {
  const { object } = await generateObject({
    model: judgeModel,
    schema: JudgeResultSchema,
    messages: [
      {
        role: 'system',
        content: `你是一个严格的 AI 输出质量评审专家。
评审标准：
${evaluationCriteria}

评分规则：
- 0-3：完全不符合要求，有严重错误
- 4-6：部分符合要求，有明显不足
- 7-8：基本符合要求，有小的改进空间
- 9-10：完全符合要求，高质量输出`,
      },
      {
        role: 'user',
        content: `用户输入：${userInput}\n\nAgent 回答：${agentOutput}\n\n请评审这个回答的质量。`,
      },
    ],
  });

  return object;
}
```

---

## 构建完整的 Eval 套件

```typescript
interface EvalSuite {
  name: string;
  systemPrompt: string;
  testCases: EvalTestCase[];
}

interface EvalReport {
  suiteName: string;
  runAt: string;
  modelName: string;
  totalCases: number;
  passedCases: number;
  passRate: string;
  avgScore: string;
  avgDurationMs: number;
  results: EvalResult[];
}

async function runEvalSuite(
  model: ReturnType<OpenAIProvider['chat']>,
  modelName: string,
  suite: EvalSuite,
): Promise<EvalReport> {
  console.log(`\n🧪 开始运行 Eval 套件：${suite.name}`);
  console.log(`   共 ${suite.testCases.length} 个测试用例\n`);

  const results: EvalResult[] = [];

  for (const testCase of suite.testCases) {
    process.stdout.write(`  运行 [${testCase.id}] ${testCase.description}... `);
    const result = await runTestCase(model, suite.systemPrompt, testCase);
    results.push(result);
    console.log(result.passed ? '✅ 通过' : `❌ 失败（${result.failedAssertions.join(', ')}）`);
  }

  const passedCount = results.filter((r) => r.passed).length;
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const avgDuration = results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;

  const report: EvalReport = {
    suiteName: suite.name,
    runAt: new Date().toISOString(),
    modelName,
    totalCases: results.length,
    passedCases: passedCount,
    passRate: `${((passedCount / results.length) * 100).toFixed(1)}%`,
    avgScore: avgScore.toFixed(2),
    avgDurationMs: Math.round(avgDuration),
    results,
  };

  console.log(`\n📊 Eval 结果：${suite.name}`);
  console.log(`   通过率：${report.passRate} (${passedCount}/${results.length})`);
  console.log(`   平均得分：${report.avgScore}`);
  console.log(`   平均耗时：${report.avgDurationMs}ms`);

  return report;
}

// 使用示例：定义一个代码助手的 Eval 套件
const codeAssistantEvalSuite: EvalSuite = {
  name: '代码助手基础能力评估',
  systemPrompt: '你是一个代码助手，帮助用户解决编程问题。回答简洁，给出可运行的代码。',
  testCases: [
    {
      id: 'TC-001',
      description: '读取文件时应该调用 read_file 工具',
      input: '读取 package.json 文件，告诉我项目名称',
      assertions: [
        { type: 'tool_called', value: 'read_file', description: '应该调用 read_file 工具' },
        { type: 'contains', value: 'simple-agent', description: '回答中应包含项目名称' },
      ],
    },
    {
      id: 'TC-002',
      description: '回答简单问题时不应该调用工具',
      input: '什么是 TypeScript？',
      assertions: [
        { type: 'no_tool_called', value: 'read_file', description: '不应该调用 read_file' },
        { type: 'contains', value: 'TypeScript', description: '回答中应包含 TypeScript' },
      ],
    },
    {
      id: 'TC-003',
      description: '不应该产生幻觉（凭空捏造文件内容）',
      input: '读取 src/nonexistent-file-xyz.ts 的内容',
      assertions: [
        { type: 'tool_called', value: 'read_file', description: '应该尝试调用 read_file' },
        { type: 'not_contains', value: 'export', description: '不应该凭空捏造文件内容' },
      ],
    },
  ],
};

const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = provider.chat('gpt-4o-mini');

const report = await runEvalSuite(model, 'gpt-4o-mini', codeAssistantEvalSuite);

// 保存报告到文件，用于历史对比
import * as fs from 'fs';
fs.writeFileSync(
  `eval-report-${Date.now()}.json`,
  JSON.stringify(report, null, 2),
  'utf-8',
);
```

---

## 在 CI 中集成 Evals

在 GitHub Actions 或其他 CI 系统中，每次 PR 都自动运行 Evals：

```yaml
# .github/workflows/evals.yml
name: Agent Evals

on:
  pull_request:
    paths:
      - 'src/prompts/**'    # Prompt 文件变更时触发
      - 'src/agent/**'      # Agent 代码变更时触发

jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: RUN_EVALS=true npx tsx src/evals/run-all.ts
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - name: 通过率低于 80% 时失败
        run: |
          PASS_RATE=$(cat eval-report-latest.json | jq -r '.passRate' | tr -d '%')
          if (( $(echo "$PASS_RATE < 80" | bc -l) )); then
            echo "❌ Eval 通过率 ${PASS_RATE}% 低于阈值 80%"
            exit 1
          fi
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Evals** | 给 Agent 建立自动化"考试题"，每次改动后跑一遍，用分数量化质量 |
| **测试用例（Test Case）** | 一个输入 + 一组断言，描述 Agent 在该输入下应该有什么行为 |
| **规则评分器** | 用关键词、正则、工具调用记录等客观规则判断输出，快速且免费 |
| **LLM-as-Judge** | 用另一个 LLM 评审输出质量，适合没有明确正确答案的场景 |
| **回归测试** | 每次改动后运行 Evals，确保之前好的地方没有变差 |
| **CI 集成** | 把 Evals 集成到 CI 流水线，通过率低于阈值时阻断合并 |

---

## 与其他课程的关联

- **第34课（Prompt 版本管理）**：A/B 测试的效果数据 + Evals 的通过率，共同决定哪个 Prompt 版本更好
- **第36课（Agent 测试）**：Evals 是测试金字塔的顶层，建立在单元测试和集成测试的基础上

---

## 下一步

卷六的空间质量保障到此收官。到这里，你的 Agent 已经**能干活、能并行、能记忆、能断点续传、还能用数据证明自己没变坏**。下一卷换一个视角——从"让 Agent 可靠"转向"**让 AI 自己写代码**"：

- [ ] **第40课：Harness 工程** — 如何把 AI 的非确定性输出约束成可靠的、可预期的产出
