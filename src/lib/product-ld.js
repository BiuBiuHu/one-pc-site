import { personNode } from "../data/site.js";
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

function productNode({ project, isEn, authorUrl }) {
  if (project.name === "OPC Skills") {
    const { "@context": _ctx, ...node } = opcSkillsJsonLd({ isEn, authorUrl });
    return node;
  }

  const url = project.homepage || project.repo || undefined;
  const node = {
    "@type": "SoftwareApplication",
    name: project.name,
    description: project.description,
    url,
    applicationCategory: APPLICATION_CATEGORY[project.name] || "DeveloperApplication",
    author: personNode({ url: authorUrl })
  };

  if (project.homepage) node.sameAs = [project.homepage];
  if (project.repo) {
    node.codeRepository = project.repo;
    node.sameAs = [...(node.sameAs || []), project.repo];
  }

  return node;
}
