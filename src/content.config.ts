import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    excerpt: z.string().optional(),
    category: z.string().default("工程"),
    ogImage: z.string().optional(),
    lang: z.string().default("zh"),
    draft: z.boolean().default(false),
    series: z.string().optional(),
    faq: z
      .array(
        z.object({
          q: z.string(),
          a: z.string()
        })
      )
      .optional()
  })
});

export const collections = { blog };
