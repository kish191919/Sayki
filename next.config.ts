import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    // Local development sends uploaded videos through proxy.ts (which buffers request bodies,
    // 10 MB by default). Deployments upload straight to Vercel Blob instead.
    proxyClientMaxBodySize: "210mb",
  },
  partialPrefetching: true,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com", pathname: "/vi/**" }],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
