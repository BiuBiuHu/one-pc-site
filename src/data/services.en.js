// Services data (English)
import { site } from "./site.js";

export const services = [
  {
    icon: "sparkles",
    name: "AI Service",
    summary:
      "A unified multi-model gateway with agent capabilities — connect once to call every major model, with rate limiting, logging, and cost governance built in.",
    features: [
      "OpenAI-compatible API, zero refactor",
      "Multi-model routing & automatic failover",
      "Per-key quota, rate limit & billing",
      "Request logs & cost dashboard"
    ],
    cta: { label: "Learn more", href: "https://apistation.cn/", external: true },
    highlight: true
  },
  {
    icon: "shield",
    name: "AI Consulting",
    summary:
      "From demo to production — one-on-one support for architecture review, agent workflow design, model routing, RAG, and evaluation.",
    features: [
      "Architecture review & risk audit",
      "Agent workflow & model routing design",
      "RAG & evaluation setup",
      "Engineering & cost optimization"
    ],
    cta: { label: "Contact me", href: `mailto:${site.email}` },
    highlight: false
  }
];
