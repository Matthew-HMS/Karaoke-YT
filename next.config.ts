import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow phones/other devices on the LAN to load dev resources (HMR, etc.)
  // when the app is opened via the Mac's IP instead of localhost.
  // Next 16 blocks cross-origin dev requests by default, which breaks client
  // interactivity. Add any LAN IPs/hosts you test from here.
  allowedDevOrigins: [
    "172.18.168.122",
    "curtain-lesser-plexiglas.ngrok-free.dev",
    // Cloudflare quick-tunnel gives a new random subdomain each restart;
    // the wildcard covers all of them so dev-mode HMR isn't blocked.
    "*.trycloudflare.com",
  ],
};

export default nextConfig;
