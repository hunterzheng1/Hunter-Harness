import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Keep local submit/check builds responsive on high-core developer machines.
    cpus: 2,
    staticGenerationMaxConcurrency: 2
  },

  async rewrites() {
    const internalApi = process.env.HUNTER_HARNESS_INTERNAL_API_URL;
    return internalApi === undefined || internalApi === ""
      ? []
      : [{
        source: "/api/v1/:path*",
        destination: internalApi.replace(/\/$/, "") + "/api/v1/:path*"
      }];
  }
};

export default config;
