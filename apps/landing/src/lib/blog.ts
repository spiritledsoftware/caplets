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

export function sortBlogPostsNewestFirst<const TPost extends BlogPostLike>(
  posts: TPost[],
): TPost[] {
  return posts
    .filter((post) => !post.data.draft)
    .toSorted((a, b) => b.data.date.getTime() - a.data.date.getTime());
}
