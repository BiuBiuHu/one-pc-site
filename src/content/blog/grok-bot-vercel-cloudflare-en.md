---
title: "Why We Moved Anpai Calendar to Cloudflare After Starting to Use Grok Bot"
date: 2026-10-29
excerpt: "Grok Bot used up our Vercel deployment quota. We moved Anpai to native Cloudflare Workers, kept PostgreSQL, and found that some endpoints got slower."
category: 技术实践
lang: en
---

After we started using Grok Bot to work on Anpai Calendar, Vercel's free deployment allowance stopped being enough.

Grok Bot could readily deploy the whole set of services. Make a change, deploy it, find a problem, fix it, deploy again. A few rounds used a noticeable share of the allowance. We still had work to do, but could no longer publish the next change.

My concern was straightforward: I didn't want development to keep stopping halfway through the day because we couldn't deploy. Waiting might be manageable during ordinary work. It would be much less convenient when we needed to fix a problem or ship a release.

We considered upgrading to Vercel Pro. We also decided to take a serious look at Cloudflare. The blog moved first, followed by the marketing site and web frontend, then the backend services.

Once we started, we had several more decisions to make: how the applications would run, where we would build them, and whether the database should move too.

## 1. Cloudflare has limits too, but counts different things

Vercel's free deployment limit is fairly direct: the Hobby plan allows up to 100 deployments in a 24-hour window, with additional limits over shorter periods.

That counts deployments. When a project has several services, a single round of work can create several of them. Grok Bot doesn't need to finish 100 features, or make 100 commits, to exhaust the allowance.

Cloudflare required a closer look. Pages, Workers Builds, and uploading an application built elsewhere have different constraints.

| Approach | Main limit | What it counts |
|---|---|---|
| Vercel Hobby | Up to 100 deployments per 24 hours, plus shorter rate limits | Deployments created |
| Cloudflare Pages free builds | 500 per month; 1 concurrent build | Builds on the platform |
| Cloudflare Workers Builds, free plan | 3,000 minutes per month; 1 concurrent build | Time spent building on the platform |
| External CI, then deployment to Workers | Uses the CI provider's resources; API and upload limits still apply | CI resources, deployment operations, and subsequent runtime usage |

We checked these rules on October 29, 2026, against the official [Vercel](https://vercel.com/docs/limits), [Cloudflare Pages](https://developers.cloudflare.com/pages/platform/limits/), and [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) documentation.

Five hundred Pages builds per month is not an invitation to redeploy endlessly either. Vercel's 24-hour window also shouldn't be interpreted as a universal reset at midnight.

We chose the green path in the diagram: build with GitHub Actions, upload and deploy with Wrangler, and run on Cloudflare Workers.

![Deployment and build quotas for Vercel, Cloudflare-hosted builds, and the external CI path we chose for Anpai](/images/grok-bot-hosting-comparison-en.png)

Building on GitHub does not consume Cloudflare-hosted build minutes, but GitHub's own resources and allowances still need managing. Runtime costs are separate again.

The migration removed the Vercel deployment limit we had been hitting. It did not give us unlimited free deployments.

We also needed to stop redeploying unrelated services. A documentation change, or a change to one frontend, doesn't require publishing every backend again. Moving platforms doesn't remove that waste.

## 2. The roughly $48 proposal made us reconsider

Our first backend proposal involved containers.

The services already ran on Node.js. Containers would have reduced some of the work needed to adapt them to a new runtime. But the proposal used always-on instances, with an estimate of roughly $48 per month.

At that point, I asked:

> We're already running serverless on Vercel. Why are we moving to an always-on service here?

The applications executed on demand. They didn't require us to keep a dedicated instance running when no requests were arriving. We were moving to address a deployment problem; changing the execution model and adding a fixed cost deserved another look.

We put the always-on container proposal aside and reassessed native Workers.

That meant accepting adaptation work. We had to check the framework, database drivers, monitoring, and image-processing dependencies against the Workers runtime. For Anpai at its current stage, we preferred that work to changing how the services ran.

The roughly $48 figure remained an estimate for the discarded proposal. It never became our final bill.

We enabled Workers Paid instead. Its base subscription is $5 per month shared across the account, with usage charges on top. That is not the cost of the entire product: the database, models, email, and storage are billed separately. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

## 3. We left the database where it was

We did not replace the database as part of this move.

Anpai kept its existing PostgreSQL database, data, and schemas. The backend scope covered four services: the main API, authentication, email, and AI. We kept our model and email providers too.

That spared us from diagnosing a new runtime and a data migration at the same time.

The connection setup still caused trouble.

When we first connected through Hyperdrive, we used the database's existing pooled endpoint and encountered timeouts. Switching Hyperdrive to the direct endpoint of the same database restored the connection. We then checked connection counts and whether application-side resources were released after normal responses, errors, and stream cancellations.

We proceeded with the backend after the frontend had moved and login was working. Each service was verified in staging before production. We retained the old Vercel deployments and snapshots as planned, while disabling automatic builds to avoid publishing to both platforms.

This added no new product features. Most of the work was checking that existing ones still behaved as before.

## 4. Several apparently straightforward paths needed rework

After deployment, the image endpoint returned 503 errors.

The services had deployed successfully, but Core and the AI service were missing a shared internal credential. Checking whether each service was online hadn't exposed it. Following a real image request did.

Once we configured the credential, we used existing production images in R2 to check the path. We retrieved them through the AI service, the Core proxy, and signed download URLs, then compared SHA-256 hashes. The returned bytes matched.

Login also needed more than reaching a homepage.

We checked that the same user was recognized before and after the move, that existing calendars and goals remained available, and that sessions could refresh. GitHub login went through a real browser flow. For Apple, we verified callback forwarding first, then the user confirmed a complete login with their own account.

Streaming AI requests raised another question: what kept running after the user cancelled?

In staging, we used a protected provider fixture that deliberately delayed its response. That let us repeat cancellation checks and inspect connections and subsequent writes without calling a paid model on every run.

We also tried placing execution closer to the database to improve response times. Cancellation checks failed in two consecutive staging runs, so we withdrew that configuration before production. With the default placement restored, all 15 checks in the final cross-service suite passed.

These paths took considerably more work than uploading code to a new platform. They are easy to overlook when comparing subscription prices.

## 5. Some endpoints got slower

We measured endpoints before and after the move. The results were mixed.

These are median end-to-end times from five requests per endpoint in each phase, using the same development machine and network egress:

| Endpoint | Vercel | Final Cloudflare sample |
|---|---:|---:|
| User information | 363 ms | 768 ms |
| Calendar list | 407 ms | 526 ms |
| Event query | 867 ms | 763 ms |
| Goal list | 377 ms | 436 ms |
| Review list | 730 ms | 677 ms |

User information slowed down the most. Calendar and goal lists also took longer, while event queries and review lists were slightly faster.

The database remained in its original region. Worker execution location, calls between services, and database round trips could all affect the total. We did not control cold starts, cache temperature, or public-network variation, and each phase had only five requests per endpoint. These measurements cannot establish long-term performance or represent users in every region.

They were enough to drop any claim that moving to Cloudflare made everything faster.

We had addressed the deployment constraint. We still needed to investigate the queries and call paths behind the slower endpoints.

## 6. The migration is finished; the full bill isn't in yet

At the time of writing, all four business backends are running on native Cloudflare Workers. The user has also confirmed that the full Apple login works.

We can trace the production domains to their deployed versions, source commits, and CI builds. Automatic publishing after changes reach the default branch has been exercised successfully.

On cost, we can confirm the account's $5 monthly Workers Paid base subscription. The migration's incremental usage has not been separately settled, and we do not yet have a full monthly bill.

We completed the native migration and avoided the always-on container proposal. We cannot yet say that running Anpai will cost only $5 a month.

My original concern was quite modest: after starting to use Grok Bot, I didn't want to run out of deployments before the work was done. Addressing that also meant sorting out where builds happen, how the services execute, and how we verify them after a move.

We chose Cloudflare. For another project that already runs well and only needs more deployments, upgrading the existing plan could be entirely reasonable. Our willingness to do this adaptation work doesn't make it worth repeating for every application.

The migration is now complete. Two concrete questions remain: why some endpoints became slower, and what the bill looks like after a full billing period.
