export const landingSiteUrl = "https://caplets.dev";

export type BlogPostLike = {
  slug: string;
  data: {
    date: Date;
    draft?: boolean;
  };
};

export function blogPostUrl(slug: string): string {
  return `/blog/${slug}/`;
}

export function blogIndexUrl(): string {
  return new URL("/blog/", landingSiteUrl).href;
}

export function absoluteBlogPostUrl(slug: string): string {
  return new URL(blogPostUrl(slug), landingSiteUrl).href;
}

export function sortBlogPostsNewestFirst<const TPost extends BlogPostLike>(
  posts: TPost[],
): TPost[] {
  return posts
    .filter((post) => !post.data.draft)
    .toSorted((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export async function getSortedBlogPosts() {
  const { getCollection } = await import("astro:content");
  return sortBlogPostsNewestFirst(
    (await getCollection("blog")).map((entry) => ({
      ...entry,
      slug: entry.id,
    })),
  );
}
