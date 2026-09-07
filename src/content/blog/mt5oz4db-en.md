---
title: "I Gave Up the Ops Workbench and Generated a Thousand Calendar Images with a Few Sentences"
date: 2026-08-23
excerpt: "In the AI era, if you can finish something by 'talking', don't fall back into the old 'build a system' mindset."
category: AI
lang: en
---

> Subtitle: In the AI era, if you can finish something by "talking", don't fall back into the old "build a system" mindset.

Over the past week I batch-generated over a thousand images for a calendar product — Mao's Selected Works, Naval, Tang poetry, and Tao Te Ching, covering July through December. After repeated pitfalls and rework, I reached a conclusion more important than "how to generate images".

**The conclusion first: I originally wanted to turn the skill's image-generation ability into an ops workbench, then realized it was unnecessary — doing it directly is faster.**

The instinct is natural: "you have image generation, don't you need a UI? Pick a date, pick a series, click generate, watch progress." But once you start building, any seemingly simple thing, the moment you turn it into a system, demands real time and manpower: backend, permissions, state management, deployment, ops. And all I wanted was "get the images generated".

A Skill is already the capability — just run it. Why wrap another workbench around it? So I didn't build the workbench. I used **skill + local code**, a few dozen lines of script, run it whenever.

**In the AI era, don't use the old "build a system" mindset for things you can finish by "talking" — unless you really need it.** Minimal investment is the key to getting things done.

Here are the specific pits I hit in this "minimal investment" approach.

## 1. The most counterintuitive one: copy authenticity matters more than "looking real"

At first I casually wrote 400 "quotes" for the Mao calendar, things like "集中兵力打关键仗" and "每天进步 1%". Users saw through it instantly:

> "Keep what's actually in Mao's works, don't fabricate what isn't. If you can't fill the count, repeating is fine."

That one line woke me up. **Once AI-generated copy contains a "fake classic", the whole image is ruined** — not because the drawing is bad, but because that one "lie" drags down the product's whole tone.

Later I cut the Mao pool from 400 to 200, tagged each with its source (which essay "星星之火可以燎原" is from, which line of "七律·长征"), and deleted anything with confidence below 80%. Better to repeat than fabricate.

**Lesson**: before generating, ask one question — can I name the exact source of this copy? If not, don't use it.

## 2. Review the copy first, then code, then generate

This workflow was forced out by repeated rework.

My earliest approach was: write code directly → batch generate → find the copy is wrong → redo everything. I redid it several times in a week.

Later I switched to three steps:

1. **Write the copy doc first** (each series' daily-sentence pool, tagged with source), show it to the user
2. After the user confirms, **then write it into code**
3. **Test 1 image first**, check color, layout, size; only batch once it's right

The "test 1 first" rule especially matters. A batch run is hundreds of images; finding out after the run that the color is too dark or a sentence has an extra period costs too much.

## 3. Size validation is the first gate against wasted images

The easiest thing to screw up in batch generation is **wrong size**. The AI model occasionally spits out a square image, or a wrong aspect ratio.

I first only checked "tall enough" (ratio > 1.35), and let through a pile of 1254×1254 square waste.

Later I tightened it to **target 9:16, ±10% tolerance**:

```typescript
const aspect = height / width;
const minAspect = 1.60;  // 9:16=1.778, lower bound
const maxAspect = 1.96;  // upper bound
if (aspect < minAspect || aspect > maxAspect) {
  throw new Error('size wrong, regenerate');
}
```

Once the size fails, mark it failed and auto-retry. **Better to spend one more API call than accept one waste image.**

## 4. Layout details: only "plain language" can specify them

The most annoying part of AI image generation is layout — it won't guess whether you want vertical or horizontal, big or small text.

Two concrete pits:

**Pit 1: the do/don't lines went vertical.** The user wanted "one row, three horizontal", but the AI stacked them vertically. The prompt had to say it in plain words:

> "The '宜' line stands alone, 3 horizontal left-to-right; the '忌' line on the next line, 3 horizontal. No vertical stacking, must be three horizontal per line."

**Pit 2: the sentence got an extra period.** My copy pool already had periods ("道法自然。"), and the prompt concatenation added another, producing "道法自然。。" on the image. That's a **code bug, not an AI problem** — but the AI faithfully copied and amplified the mistake.

**Lesson**: layout constraints need concrete, executable instructions — "no vertical", "don't touch the edge", "40px margin" — not vague "make the layout beautiful".

## 5. Decorative elements overrunning the frame is a common disease

On ink-wash style images, the mountains and pine decorations in the corners often "poke out of the frame" or get half-cut.

Saying "don't exceed the frame" isn't enough; the AI still does it. I wrote the constraint harder:

> "The four corner decorative elements must be fully present, with at least 40px safe margin on all sides; no element may be cut off or extend beyond the canvas."

And **double insurance** — add it to both the global prompt and the series-level visual instruction.

## 6. Color must anchor to the brand color

I gave the Tao Te Ching calendar a "gray-teal" color, and the user said it was too dark and dull. By contrast, the Naval series using the brand teal looked clean.

I settled on an iron rule: **all series' themeColor uses the brand primary; only accentColor varies to distinguish mood**.

```
Primary #4ECDC4 (brand teal, unified across all series)
Mao       accent #D94A38 (red)
Naval     accent #2F6F73 (ink green)
Tang      accent #7A8F52 (olive green)
Tao       accent #7A9E9E (pale gray-teal)
```

Primary doesn't move; mood is fine-tuned by accent. Unified yet distinctive.

## 7. Model quota exhausted, have a backup

Mid-batch, the API suddenly returned `Account quota is insufficient (403)`. Checking, I found the same provider had two models with **independent quotas**:

- `gpt-image-2` (quota exhausted first)
- `gpt-image-2-client` (independent quota, switched and kept going)

**Lesson**: before batch generation, confirm which models the provider has and whether quotas are independent. Quota exhaustion isn't the end — switching models keeps it going.

## 8. Network flakiness, handle with "retry + longer timeout"

Batch-generating thousands, network problems are almost inevitable. The most common I saw was `fetch failed` — not a quota issue, but the upstream image service timing out intermittently.

The response:

1. Auto-retry on failure (up to 4 times)
2. Raise the image-fetch timeout from 30s to 90s
3. Record a failure list, and backfill after the run

**Key mindset**: batch generation shouldn't chase "all succeed in one pass"; it should chase "failures are retryable and backfillable". After the run, backfill the failure list once and it's done.

## Summary: a reusable image-generation workflow

String the pits together and it's a workflow:

1. **Copy authenticity**: tag each with source, delete below 80% confidence, better to repeat
2. **Review first**: copy doc → user confirms → code → test 1 → batch
3. **Size validation**: 9:16 ±10%, auto-retry on fail
4. **Layout in plain words**: horizontal/vertical/margin/size, concrete instructions, not vague
5. **Anti-overrun**: 40px margin, prompt + visual instruction double constraint
6. **Anchor to brand**: themeColor unified, accentColor for mood
7. **Model backup**: switch to backup model when quota runs out
8. **Network fallback**: retry + longer timeout + failure-list backfill

The underlying logic is one sentence: **turn "uncontrollable AI generation" into "controllable engineering"** — controllable copy, controllable size, controllable layout, controllable color, and hand the remaining randomness to retry and backfill.

But more important than this is the opening conclusion.

Looking back, the best decision I made wasn't writing a rigorous copy pool or tuning precise size validation — it was **not wrapping the skill's image ability in another ops workbench**.

If I'd dived into "turning the capability into a system" from the start, I might still be designing backend buttons today, with zero images generated. Instead I chose the most direct, fastest way: a Skill is already the capability — use it directly, write a few scripts and run.

**The biggest trap of the AI era is turning a "simple thing" into a "complex system" by habit.** The truly efficient way is minimal investment: get the thing done first, then decide whether to productize it.

If you can finish it by talking, don't build a system. Unless you really need it.
