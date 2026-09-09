---
title: "Loop Engineering Has No Silver Bullet: Vertical Skills + spec/TDD"
date: 2026-08-09
excerpt: "Chasing one big \"fully autonomous\" loop doesn't work. After half a year of intensive coding-agent development, my conclusion: the right carrier for Loop Engineering is per-vertical Skills, with spec + TDD at the core."
category: Thoughts
lang: en
---

Loop Engineering — the fully automated dev flow where an AI agent writes, tests, and ships code itself — has no silver bullet. Chasing one big "fully autonomous" loop is wrong. After half a year of pitfalls, my conclusion: **the right way is one set of Skills per vertical scenario, with spec + TDD at the core**. This post is about how I landed it.

Since last November, I've been coding intensively with coding agents, always chasing full autonomy — what's now fashionably called Loop Engineering.

## Core idea: /goal + Skills

Skills are the best carrier for Loop Engineering: each vertical scenario should have its own Loop Engineering, not one big catch-all Loop Engineering.

A few terms first:

- **Skills**: a capability pack for the agent, scoped to one vertical scenario (constraining how it does a certain kind of work)
- **spec**: the requirement specification
- **TDD**: test-driven development, write test cases before implementation

A good Loop Engineering has two parts: `/goal` + Skills. The most important thing inside Skills is spec + TDD — for every requirement, write the spec clearly, and write the test cases clearly too.

## Skills constrain the dev process

When landing each goal, the Skills must constrain the production flow:

1. Requirement clarification
2. Technical design analysis
3. Task decomposition
4. Implementation
5. Unit test completion
6. Test acceptance

## TDD constrains dev quality

### Test capability pre-embedding

For an existing repo, cut a new branch, fill in all the unit test cases at once, then merge back to trunk. That way later branches aren't affected.

### Quality assurance alongside

Do impact analysis at the technical-design stage; do unit-test analysis and integration-test analysis at the test-plan stage — the artifacts are the unit-test doc, smoke cases, and full cases.

After the code is written, the agent starts writing all kinds of cases and enters a self-test phase before every deploy. With a large set of test cases, engineering quality stays relatively stable and rework drops.

### Controlling token consumption

A large test suite frees up human effort but also makes token consumption explode. Two solutions:

1. **Test-scope analysis**: only test what this change touches, not the full case set every time
2. **Integration test framework**: let the framework run the tests and the agent just take the results — don't make the AI execute cases one by one

After reworking the quality side like this, the code produced is basically usable as-is, and test cost drops.

## Shipping integration

Since it's Loop Engineering, shipping has to be part of the loop. I use Vercel as the DevOps role: I integrated Vercel's preprod/production environment logic and the vercel-cli into the Skills, so every time code finishes it auto-deploys — saving me a ton of time.

Project: https://github.com/BiuBiuHu/opc-skills

PRs welcome.
