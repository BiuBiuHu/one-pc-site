import { personNode } from "../data/site.js";
import { hubPathForProject } from "../data/product-hubs.js";
import { inLanguageOf } from "./i18n.js";
import { opcSkillsJsonLd } from "./opc-skills-ld.js";

const PRODUCT_NAMES = ["Anpai.Life", "OPC Skills", "AI Gateway"];

const APPLICATION_CATEGORY = {
  "Anpai.Life": "ProductivityApplication",
  "AI Gateway": "DeveloperApplication"
};

/** Listed products on /projects/ — SoftwareApplication and/or SoftwareSourceCode. */
export function projectsPageJsonLd({ projects, isEn, authorUrl }) {
  const selected = PRODUCT_NAMES.map((name) => projects.find((p) => p.name === name)).filter(Boolean);

  return {
    "@context": "https://schema.org",
    "@graph": selected.map((project) => productNode({ project, isEn, authorUrl }))
  };
}

/** One product landing — WebPage + SoftwareApplication / SoftwareSourceCode. No ratings. */
export function productLandingJsonLd({ project, isEn, lang, pageUrl, authorUrl, name, description }) {
  const locale = lang || (isEn ? "en" : "zh");
  const entity = productNode({ project, isEn, lang: locale, authorUrl, pageUrl });
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    url: pageUrl,
    name,
    description,
    inLanguage: inLanguageOf(locale),
    mainEntity: entity,
    author: personNode({ url: authorUrl })
  };
}

function productNode({ project, isEn, lang, authorUrl, pageUrl }) {
  const locale = lang || (isEn ? "en" : "zh");
  if (project.name === "OPC Skills") {
    const hubPath = hubPathForProject(project.name, locale);
    const hubAbs = hubPath && authorUrl ? new URL(hubPath, authorUrl).href : undefined;
    const { "@context": _ctx, ...node } = opcSkillsJsonLd({
      isEn,
      lang: locale,
      authorUrl,
      pageUrl: pageUrl || hubAbs
    });
    return node;
  }

  const productUrl = project.homepage || project.repo || undefined;
  const node = {
    "@type": "SoftwareApplication",
    name: project.name,
    description: project.description,
    url: productUrl,
    applicationCategory: APPLICATION_CATEGORY[project.name] || "DeveloperApplication",
    author: personNode({ url: authorUrl })
  };

  const sameAs = [];
  if (project.homepage) sameAs.push(project.homepage);
  if (project.repo) {
    node.codeRepository = project.repo;
    if (!sameAs.includes(project.repo)) sameAs.push(project.repo);
  }
  if (pageUrl && !sameAs.includes(pageUrl)) sameAs.push(pageUrl);
  const hubPath = hubPathForProject(project.name, locale);
  if (hubPath && authorUrl) {
    const hubAbs = new URL(hubPath, authorUrl).href;
    if (!sameAs.includes(hubAbs)) sameAs.push(hubAbs);
  }
  if (sameAs.length) node.sameAs = sameAs;

  return node;
}
