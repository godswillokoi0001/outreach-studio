import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Makes D1 (and other) bindings from the Wrangler config available in `next dev`.
// On Cloudflare the bindings are provided by the platform itself.
initOpenNextCloudflareForDev({ configPath: "./wrangler.jsonc" });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
