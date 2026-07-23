import type { NextConfig } from "next";

const LONG_CACHE = [
  {
    key: "Cache-Control",
    // Homepage art assets rarely change; bust cache by renaming files (e.g. typing-v2.webp)
    value: "public, max-age=31536000, immutable",
  },
];

const NO_STORE = [
  {
    key: "Cache-Control",
    value: "no-store",
  },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [
      // :path+ requires at least one sub-segment, so the /home HTML page itself is excluded
      { source: "/home/:path+", headers: LONG_CACHE },
      { source: "/mate-avatar.png", headers: LONG_CACHE },
      { source: "/digitalmate-icon.png", headers: LONG_CACHE },
      {
        source: "/_admin-console/assets/:path+",
        headers: LONG_CACHE,
      },
      {
        source: "/_admin-console/index.html",
        headers: NO_STORE,
      },
    ];
  },
};

export default nextConfig;
