/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A review build can run beside `next dev` without both processes writing
  // incompatible chunk manifests into the same .next directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The Instant Page master is read as exact bytes for a pinned SHA-256 check.
  // Include it in standalone/server traces for the staff and producer launch APIs.
  experimental: {
    outputFileTracingIncludes: {
      "/*": ["./lib/tiktok/masters/sales.json"],
    },
  },
};

module.exports = nextConfig;
