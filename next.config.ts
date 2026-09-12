import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone output is for the Docker self-host path; Vercel's builder
  // needs the regular traced output (standalone breaks its .nft.json pickup)
  output: process.env.VERCEL ? undefined : "standalone",
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
