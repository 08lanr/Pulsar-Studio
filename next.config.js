/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A review build can run beside `next dev` without both processes writing
  // incompatible chunk manifests into the same .next directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The Instant Page master is read as exact bytes for a pinned SHA-256 check.
  // Include it in standalone/server traces for the staff and producer launch APIs.
  //
  // The runtime folders are never traced: lib/data/storage.ts and
  // lib/data/launch.ts join process.cwd() with ".uploads", and the trace step
  // (run inside the compile) followed that into the whole folder - 33 GB, some
  // ten thousand entries - until the build ran out of heap (the phase 3a
  // review). The same for the e2e server's copy and the scratch folder.
  // outputFileTracingIgnores is the key that keeps nft out of the folder (it
  // is the trace's own ignore list, in the compile and in the collect step);
  // outputFileTracingExcludes only drops matches from the route lists after
  // the trace. Next 14.2 warns that Ignores "has moved" to Excludes: keep
  // both, the warning is expected.
  experimental: {
    outputFileTracingIncludes: {
      "/*": ["./lib/tiktok/masters/sales.json"],
    },
    outputFileTracingIgnores: [".uploads/**", ".uploads-e2e/**", "tmp/**"],
    outputFileTracingExcludes: {
      "*": [".uploads/**", ".uploads-e2e/**", "tmp/**"],
    },
  },
};

module.exports = nextConfig;
