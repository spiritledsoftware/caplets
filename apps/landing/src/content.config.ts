import { defineCollection, z } from "astro:content";

export const collections = {
  blog: defineCollection({
    type: "content",
    schema: z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      canonicalPath: z.string().regex(/^\/blog\/[a-z0-9-]+\/$/u),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
      ogImage: z.string().optional(),
    }),
  }),
};
