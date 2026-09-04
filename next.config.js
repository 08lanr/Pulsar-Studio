/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A review build can run beside `next dev` without both processes writing
  // incompatible chunk manifests into the same .next directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

module.exports = nextConfig;
