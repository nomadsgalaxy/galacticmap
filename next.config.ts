import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 Cache Components: data is dynamic by default; opt into caching with the
  // `use cache` directive + cacheTag/cacheLife. See plan.md §8.
  cacheComponents: true,
};

export default nextConfig;
