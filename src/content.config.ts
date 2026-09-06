import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    excerpt: z.string().optional(),
    category: z.string().default("思考"),
    ogImage: z.string().optional(),
    lang: z.string().default("zh")
  })
});

export const collections = { blog };
