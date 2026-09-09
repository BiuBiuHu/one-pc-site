---
title: "How to Get Traffic to a Personal Site: SEO, GEO, Content Engineering, and Bilingual"
date: 2026-09-07
excerpt: "Traffic to a personal site isn't \"post and wait for indexing\" — it's four layers: technical foundation (sitemap/rss/structured data, so content is findable), content engineering (topic + writing pipeline, so content is worth searching), GEO (llms.txt + citable content, so AI engines cite you), and bilingual (to reach a bigger market). This is my full record."
category: Thoughts
ogImage: /images/personal-site-traffic.png
lang: en
---

Starting from "zero traffic" on a Chinese tech blog, the work I did converged into four layers: **technical foundation, content engineering, GEO, and bilingual**. This isn't an SEO tutorial — it's the execution record of what I actually did on this site (`www.peak-lake.com`).

One belief runs through everything: **traffic comes from content; technology only makes content findable.** A perfect sitemap does nothing without good content. Good content is buried if search engines can't crawl it and AI engines can't read it. So the four layers are the foundation that makes content findable; content itself is the lever that actually brings traffic.

## Layer 1: technical SEO foundation, so content gets indexed

A new domain won't get crawled proactively. You open the door first — give search engines a map and directions. Here's what I did:

**sitemap + robots.txt**. `@astrojs/sitemap` generates the map automatically; `robots.txt` points to it and allows all crawlers. The most basic "tell Google which pages I have".

**RSS**. `@astrojs/rss` generates a feed. RSS doesn't bring traffic directly, but it turns "subscribers" into a stable return audience — for a personal site, retention beats a one-off click.

**Structured data (JSON-LD)**. Every post emits a `BlogPosting` schema, telling Google "this is an article, by whom, when" — a prerequisite for rich results.

**Social card (og:image)**. A cover image when a post is shared to X or WeChat. It's the facade that decides whether anyone clicks.

**canonical + 301 dedup**. This site had duplicate posts early on (the same article under two ids) and redirect pages with Chinese slugs. Dedup plus Vercel edge 301s (instead of static meta refresh) avoids content dilution.

After these, the site went from "Google can't find it" to "Google can index it". But it's just the foundation — **indexed ≠ traffic**. Traffic still comes down to content.

## Layer 2: GEO, so AI engines cite you too

Traditional SEO aims at "Google indexing + ranking". But more people use ChatGPT, Perplexity, and similar AI search, which cite content differently from Google.

GEO (generative engine optimization) is about one thing: **make your content extractable, citable, and summarizable by AI engines.** I did two things:

**llms.txt**. An emerging sitemap meant specifically for LLM crawlers (like robots.txt but for AI). I put an `llms.txt` at the site root listing the site intro, key pages, and every post's title + summary, so AI tools can quickly understand what this site has.

**Writing style suited to AI citation**. AI engines prefer content they can extract answers from: lead with the conclusion, define terms in one sentence, prefer tables and steps. These are also good SEO habits — both are really about "make content machine-extractable".

GEO and SEO share most of the foundation (structured data, static HTML, crawlability), so layer 1 already wins half the GEO game.

## Layer 3: content engineering, the real traffic lever

The first two layers make content *findable*; this layer makes content *worth finding*. The biggest trap of a personal site is treating notes as articles — posting a few lines of thought that neither Google nor AI engines will cite.

I built a content pipeline around three moves:

**Topic selection: translate "first-hand experience" into "questions people search"**. Topic choice sets the traffic ceiling, and it matters more than post-optimization. The method: mine your own code and git commits for points with information, numbers, and battle scars; turn them into "questions people search" (how / why / comparison / pitfall); verify with WebSearch whether anyone searches and whether there's a gap.

**Material collection: the first-hand stuff is in code, not in articles**. Articles are second-hand processing; commits and code are the raw data. Writing the Chinese-time-parsing post, I dug real cases like "两点 silent slot loss" and "7点半 ambiguity" out of `schedule-time.service.ts` — every number and snippet has a source. That kind of "read only here" exclusivity is what makes differentiation.

**Writing: total-part-total, one topic told through**. Give the whole structure first, then dive per section, then converge on core principles. Don't pad the word count, and don't be afraid to write long — the depth you write should match the time your practice took.

The output of this pipeline is the long posts on my site: intent recognition system, memory system, Chinese time parsing, exit validation — each from a real project, not a tutorial rewrite.

## Layer 4: bilingual, to reach a bigger search market

Chinese content is capped by Chinese search volume. English search volume for technical content is several to dozens of times larger — "LLM agent safety" and "intent recognition" have far more demand in English.

So I made the site **bilingual**:

**Astro i18n**. Chinese without a prefix (`/`), English under `/en/`, each post with independent Chinese and English versions (`xxx.md` + `xxx-en.md`). English isn't "translation" — it's "re-expressing in English". Chinese favors elaboration, English favors directness; word-for-word translation always produces Chinglish.

**hreflang**. Tells Google the Chinese and English versions are the same article in two languages, avoiding duplicate-content penalties.

**Browser-language auto-redirect + user preference**. English browsers automatically land on the English version, Chinese browsers on the Chinese one; once a user manually switches language, remember the preference and stop overriding it. Each visitor sees their own language.

The point of this layer isn't "translation" — it's reaching an order-of-magnitude larger search market with the deep content you already have. The cost is AI translation plus term review; the payoff is English long-tail traffic.

## Next step: distribution

The four layers above make content *findable*. One more layer is still missing: pushing it out actively — distribution.

Once content is written, sync it to X, Reddit, and dev communities, with a backlink at the end. I haven't done this systematically yet — it's the next step. But the logic is clear: **foundation + content + bilingual determines "how much traffic can come"; distribution determines "how fast".**

## Summary

Getting traffic to a personal site, my experience condenses to four sentences:

1. **Technical foundation** makes content indexable — sitemap, rss, structured data, og:image, dedup. Do these before Google bothers to come.
2. **GEO** makes content citable by AI — llms.txt + extractable writing, riding the ChatGPT search wave.
3. **Content engineering** is the real lever — mine exclusive topics from your code, write them through, so readers can only find it at your place.
4. **Bilingual** amplifies the search market — English + Chinese for technical content; the cost is translation, the payoff is several times the long-tail traffic.

One last reminder: **don't spend your time on "sitemap details", spend it on "writing something people can only read at your place".** The technical foundation takes two days; content is an ongoing thing — and traffic, in the end, is bought with content.
