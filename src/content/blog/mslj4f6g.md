---
title: Loop Engineering 没有银弹：垂直场景的 Skills + spec/TDD 落地实践
date: 2026-08-09
excerpt: 追求大而全的"全自动驾驶"行不通。我用 coding agent 密集开发半年后的结论：Loop Engineering 的正确载体是垂直场景的 Skills，核心是 spec + TDD。
category: 思考
---

Loop Engineering（让 AI agent 自己写代码、自己测试、自己发布的全自动开发流程）没有银弹——追求一个大而全的"全自动驾驶"是错的。我踩了大半年的坑得出的结论：**正确做法是每个垂直场景一套 Skills，核心是 spec + TDD**。这篇文章讲我是怎么落地的。

从去年 11 月到现在，我密集地用 coding agent 编程，一直期望实现全自动驾驶——也就是现在时髦的 Loop Engineering。

## 核心思路：/goal + Skills

Skills 就是 Loop Engineering 的最佳载体：每个垂直场景应该有自己的一套 Loop Engineering，而不是一个大而全的 Loop Engineering。

几个术语先对齐：

- **Skills**：给 agent 用的、针对某个垂直场景的能力包（约束它怎么做某一类事）
- **spec**：需求规格说明
- **TDD**：测试驱动开发，先写测试用例再写实现

一个好的 Loop Engineering 由两部分组成：`/goal` + Skills。而 Skills 里最重要的是 spec + TDD——每次需求，除了把 spec 写清楚，测试用例也要写得足够清晰。

## Skills 约束研发流程

每次落地 goal 时，要求必须用 Skills 约束生产流程：

1. 需求澄清
2. 技术方案分析
3. 任务分解
4. 编码实现
5. 单测补全
6. 测试验收

## TDD 约束研发质量

### 测试能力预埋

对于存量仓库，可以切一个新分支，一次性补全所有单元测试用例，然后合并回主干。这样后期切新分支也不受影响。

### 质量保障伴生

技术方案阶段就要做影响面分析；测试方案阶段就要做单元测试分析、集成测试分析，对应的产物是单元测试文档、冒烟用例、完整用例。

这样代码写完后，agent 开始编写各种用例，并在每次部署前进入自测环节。因为有大量测试用例，能保证工程质量相对稳定，减少返工。

### Token 消耗的控制

大量测试用例虽然解放了人的精力，但也会带来 token 消耗暴增。两个解法：

1. **测试范围分析**：只对本次改到的内容做测试，而不是全量 case 都跑一遍
2. **集成测试框架**：让测试框架直接跑，agent 拿结果即可，不要让 AI 逐个执行用例

质量部分这么改造后，产出的代码基本可以直接使用，测试成本也降下来了。

## 发布能力集成

既然是 Loop Engineering，就要考虑发布环节。我用 Vercel 承担 DevOps 的角色：把 vercel 的预发/线上环境逻辑、vercel-cli 都集成到 Skills 里，代码每次执行完就自动发布，省了我大量时间。

项目地址：https://github.com/BiuBiuHu/opc-skills

欢迎大家提 PR。
