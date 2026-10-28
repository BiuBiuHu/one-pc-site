// 服务数据 —— 改成你的真实服务
import { site } from "./site.js";

export const services = [
  {
    icon: "sparkles",
    name: "AI 服务",
    summary:
      "统一的多模型中转与 Agent 能力，一次接入调用所有主流模型，自带限流、日志和成本治理。",
    features: [
      "OpenAI 兼容接口，零改造接入",
      "多模型路由与自动故障转移",
      "按 Key 的配额、限流与计费",
      "请求日志与成本看板"
    ],
    cta: { label: "了解 AI 服务", href: "https://apistation.cn/", external: true },
    highlight: true
  },
  {
    icon: "shield",
    name: "AI 研发咨询",
    summary:
      "从 Demo 到生产，提供架构评审、Agent 工作流设计、模型路由、RAG 与评测的一对一支持。",
    features: [
      "架构评审与风险排查",
      "Agent 工作流与模型路由设计",
      "RAG 检索与评测体系搭建",
      "工程化与成本优化"
    ],
    cta: { label: "联系我", href: `mailto:${site.email}` },
    highlight: false
  }
];
