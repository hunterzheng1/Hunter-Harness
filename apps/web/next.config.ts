import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  reactStrictMode: true,

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
