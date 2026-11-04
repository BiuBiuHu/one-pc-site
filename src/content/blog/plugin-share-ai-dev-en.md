---
title: "Sharing AI Development Capabilities Through Plugins: A Development Workflow in Practice"
date: 2026-11-04
excerpt: "Skills stay the entry point; plugins own the maintenance boundary. Three layers—core, base, and scene—separate shared frontend AI workflow from business recipes, with real onboarding and verification scope."
category: Engineering
lang: en
---

> We originally started frontend tasks through a skill, loading design, implementation, testing, and deployment instructions as needed. Reuse across businesses raised ownership questions: who maintains the shared process, who owns business differences, and how do common fixes reach each project?
>
> We adopted three plugin layers: core owns the workflow and harness, base provides shared capabilities, and scene carries business recipes. Users still start through a scene skill. This account explains the decision and implementation, with business names and internal platforms anonymized.
>
> **Skills remain execution entry points; plugins provide release units aligned with ownership.**

## 1. Why we chose shared plugins over template copies

We compared generating complete scene instances from a template with separating shared implementations into plugins referenced by scenes.

| Criterion | Option one: Complete instances from a template | Option two: Shared plugins and scene packages |
|---|---|---|
| Business handoff | Locally editable shared implementation and scene capabilities | Scene recipes, resources, and adapters |
| Propagating fixes | Version snapshots detect updates; merge shared and local changes, with backup and recovery | Release common packages and update compatible dependencies |
| Main maintenance work | Synchronizing copies, resolving conflicts, and verifying merges | Contracts, compatibility, and cross-scene regression checks |

The first option required fewer changes, allowed extensive customization, and addressed upgrades. We chose the second because of the handoff: the common team builds scenes initially, then hands them to businesses while retaining long-term ownership of the workflow, harness, and shared capabilities.

Common defects return to core/base, reducing repeated merges into business copies. The cost is maintaining contracts and compatibility ranges. Complete instances remain useful when businesses need lasting, extensive changes to shared code.

Dependency checks and update policies still require implementation.

## 2. Make ownership boundaries explicit

The workflow describes stage progression; the harness enforces gates through state, scripts, and artifact validation. Core owns both.

| Layer | Responsibility | What a business needs to establish |
|---|---|---|
| core | Workflow, state, gates, recovery, host integration, and stage events | Process and artifact contracts fit |
| base | Documents, design collection, testing, shared deployment, and telemetry collection | Tools, frameworks, and platforms are supported |
| scene | Business recipe, project context, and private steps | Business rules, application and environment mappings |

![Core reads the scene recipe and invokes base; scene declares capability references executed by the core main session. Shared maintainers own core/base and businesses own scene](/images/plugin-architecture.en.png)

Solid lines show main-session reads and calls; the dashed line shows recipe references. From the scene entry, the main session prepares dependencies, loads the workflow and recipe, and initializes the harness. Each requirement stores its own state and artifacts.

Ownership follows reuse. Shared deployment logic belongs in base; scenes supply application, branch, package scope, and verification URLs. Base must define its supported behavior, beyond moving a business directory into a shared package.

## 3. Keep one scene entry point and load private steps when needed

The new scene initially exposed five skills: a workflow entry plus design, planning, implementation, and deployment. Users had to work out how to combine them. We reduced this to one public entry:

```text
skills/<scene-entry>/
├── SKILL.md
├── recipe/recipe.md
├── resources/
├── scripts/bootstrap-deps.mjs
└── subskills/
    ├── spec/INSTRUCTIONS.md
    ├── tasks/INSTRUCTIONS.md
    ├── code/INSTRUCTIONS.md
    └── deploy/INSTRUCTIONS.md
```

Names are illustrative. The main session reads private `INSTRUCTIONS.md` files at the relevant stage; shared base skills remain independently reusable. Bundling recipes and resources with the entry also prevents skill extraction from leaving necessary files behind.

### 3.1 How a scene is actually invoked

**One scene entry, one main session, one core-managed state.** Users can name the skill or use natural language. Ambiguous scenes are clarified without requiring a fixed command prefix.

The published entry currently:

1. Establishes the scene, project, and feature; checks core/base dependencies and host integration.
2. Reads the core workflow from the installer's returned path, then the recipe and business resources; checks capability gaps.
3. Initializes the harness through core and saves the scene and recipe snapshot. Resuming uses the saved recipe and progress.
4. Reads private steps, loads shared capabilities, and produces artifacts stage by stage. Core validates them and advances state.

The recipe is Markdown with scene, version, and workflow identifiers plus stage differences. Core needs no registry of business branches. Private steps introduce no separate state or orchestration; independent review follows the shared workflow.

### 3.2 A worked example: an event registration page

This anonymized teaching example uses the intended native invocation path. The current installer has not migrated; the next section gives the verification scope.

The user asks:

> Use the event frontend workflow to add a registration page, feature event-signup. Include event details, a phone number, and a registration button. Use the design link I supplied.

The host loads `event-workflow/SKILL.md`. The entry reuses core and this recipe excerpt:

```markdown
---
scene: event
version: 1.0.0
workflow: 2
---

Use core for all other stages.

## S2 Design
Read ../resources/event-context.md for APIs and form rules.
Read ../subskills/spec/INSTRUCTIONS.md for standard design and test artifacts.
When a design is supplied, invoke base design-fetch.

## S4 Implementation
Read ../subskills/tasks/INSTRUCTIONS.md and ../subskills/code/INSTRUCTIONS.md.
Implement tasks with unit tests; invoke base unit-test for selected tests.

## S5 Preproduction
Read ../subskills/deploy/INSTRUCTIONS.md with target=pre; submit a preproduction report.

## S7 Production
After core's authorization gate, read the same adapter with target=production.
Publish the version tested in S6 and submit a separate production report.
```

Relative paths start from the recipe directory. Business resources supply facts; private steps describe adaptations. The execution sequence is:

```text
event-workflow entry
  → Check plugin installation, compatible versions, and host integration
  → Load core and the scene recipe; initialize event-signup
  → Complete S1 and enter S2
  → Read subskills/spec/INSTRUCTIONS.md
  → Skill("frontend-base:design-fetch", args="<design-link> <artifact-directory>")
  → Main session collects the design and writes the design and test plan
  → Core validates S2; advance only when it passes
```

This illustrates execution relationships. Actual stage boundaries use core commands from the project root:

```bash
node "$SKILL_DIR/hooks/hooks.js" start event-signup S2
# The main session completes design work and writes artifacts before validation
node "$SKILL_DIR/hooks/hooks.js" pass event-signup S2
```

`$SKILL_DIR` identifies the loaded core directory. Initialization and S1 are omitted here. S2 delivers:

```text
docs/event-signup/
├── technical-spec.md
├── api-consumption.json
├── test-outline.md
└── unit-test-plan.json
```

S4 consumes these artifacts for implementation. S5 uses the scene deployment adapter, S6 runs shared validation, and S7 requires production authorization. Another business mainly replaces the recipe, resources, and necessary private steps.

### 3.3 Invoke shared skills by qualified name; let plugins manage updates

The target standard invocation is:

```text
Skill("frontend-base:design-fetch", args="<design-link> <artifact-directory>")
```

The plugin name is anonymized. **Plugins manage installation and updates, qualified names reference capabilities, and the main session executes their tools and procedures.** `Skill(...)` is a host loading operation; reading Markdown does not itself collect a design.

After a compatible package update, projects update the plugin and reload it or start a new session. Scenes keep the same qualified name, while dependency ranges still need checking.

In an isolated host CLI, we verified complete native plugin installation, a real successful `Skill` tool invocation, and loading updated test-plugin content through the same name in a new session. Tests used a local release package and local marketplace. IDE invocation, online distribution authentication and updates, and hot reloading within an in-progress session remain unverified. Design collection was not executed.

**The published installer still extracts skills** into `.agents/skills/`, maintains versions, and returns a `base_skills` path map for the main session to read and follow. Native migration is outstanding. Private instructions remain file reads, and harness gates remain scripts.

## 4. A second business tested our assumptions about reuse

The second scene used older `architecture.md`, `detail.md`, separate task cards, and a different deployment position. Renaming files could not align fields, test mappings, and completion state. We changed it to produce the shared artifacts directly:

| Stage | Formal handoff |
|---|---|
| S2 Design | `technical-spec.md`, `api-consumption.json`, `test-outline.md`, `unit-test-plan.json` |
| S4 Implementation | `tasks.md`, implementation, corresponding tests, and quality evidence |
| S5 Preproduction | Preproduction context and report |
| S6 Validation | Cases, results, and evidence bound to the preproduction version |
| S7 Production | Separate context and report for the tested version |

S2 maps pages and source to tests, S4 generates tests with code, and S6 validates against them. Unit testing defaults to incremental scope; each validation round asks whether to include all tests for changed pages. Preproduction API, UI, and smoke validation remain required. Missing mappings or unsupported runners require adaptation rather than a repository-wide fallback.

Onboarding also exposed a common quality script that found nested packages but could miss a single application's root build. We fixed it in core and verified that a nonzero build exit fails the gate. A defect found by one business now has a shared fix available to compatible scenes.

## 5. Independent upgrades need explicit boundaries

Scenes declare compatible core/base ranges without sharing their version numbers:

```text
minimum supported ≤ installed version < incompatible boundary
```

The extraction installer installs missing dependencies, updates existing ones, and skips current versions with valid checksums. It checks only `latest`, stopping outside the range rather than searching historical compatible releases.

In-progress requirements save recipe snapshots but do not pin exact core/base implementations, so a snapshot cannot fully reproduce the runtime. Old workflows finish with their original versions without automatic stage migration. Compatibility ranges, regression checks, and precise version records remain maintenance responsibilities.

## 6. A new scene should reveal missing capabilities

The creation guide reviews the full lifecycle rather than only generating directories. Each gap needs an owner:

| Gap | Where to address it |
|---|---|
| Shared executor lacks test-framework support | Update base |
| Missing application, environment, or business rules | Adapt scene |
| Unavailable tools, accounts, or verification targets | Prepare the environment |

Different teams can maintain the workflow, executors, and recipes through a common repository, validation process, and plugin releases. Onboarding issues should reach the responsible maintainer rather than all accumulating in core.

## 7. Initialization belongs in the shared workflow

A real project could start its scene while the required host hooks remained unregistered. Skill installation, requirement initialization, and host configuration each needed implementation.

Startup and resume now share an initialization path: core checks registration, base supplies collectors, and scenes reuse it. Existing projects can repair missing hooks while preserving other configuration, stages, tasks, and recipes.

Domain selection also belongs in core's requirement clarification. Users confirm an existing domain; repository or knowledge-base names cannot establish business ownership. Scenes reuse the same selection behavior.

## 8. Make execution data verifiable

Registered hooks can still leave stage data missing, and connected events can still have unknown usage. Registration, request acceptance, and usable dashboard metrics need separate evidence.

Our existing telemetry pipeline emits events when core commits state transitions. The base collector binds real sessions to events and calculates input/output tokens and user/model turns within each window. Tool results are excluded and streaming messages deduplicated. Window totals do not represent the entire session or bill.

Records persist locally before delivery. Missing sources or late usage wait for evidence rather than becoming zero. Retries retain the original `event_id` and values; the receiver handles updates and deduplication. Historical recovery requires evidence of the requirement, stage, session, and window. Archives retain necessary metadata without conversation bodies.

A separate verification task in an existing project exercised collection and dashboard visibility without advancing the main workflow. We paused and resumed delivery, compared retry identifiers and values, independently recalculated archived metrics, and recovered supported historical records. Shared packages carry those fixes to other scenes.

## 9. What we have actually validated

The acceptance results below are from November 2:

- Regression and isolated smoke tests ran core, the shared unit test executor, Vitest, ESLint, TypeScript, and the root build, covering eight stages and key gates.
- Shared packages and two scenes were published; downloaded contents, remote installation, dependency updates, and existing-state preservation were checked.
- An existing project verified integration repair, real metrics, historical recovery, and retries. Native CLI verification is scoped in section 3.3.

Business-platform and browser evidence in isolated fixtures was simulated. No real business preproduction or production deployment was performed, and receiver deduplication was not verified.

The structure has reduced the business handoff and given common defects a shared repair location. Its long-term maintenance value still needs evidence from onboarding time, adoption of shared fixes, and rework in subsequent businesses.

## Further reading

Before plugins split ownership, Skills and the full software production loop are in [OPC software practice](/en/blog/opc-software-practice/). Vertical-scene Skills and spec/TDD are in [Loop Engineering](/en/blog/loop-engineering/). What engineering still has to close between demo and production is in [What Separates AI Development from Demo to Production](/en/blog/ai-rnd-prod-01/).

