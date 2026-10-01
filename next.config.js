/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // pdfjs-dist's code includes a Node.js-only path that references the
    // optional "canvas" package. We only ever call pdfjs-dist client-side
    // (rendering PDF page thumbnails after a user picks a file), but
    // webpack still tries to resolve every require() it can see while
    // bundling, and fails the build over a native dependency that isn't
    // installed and is never actually used in the browser.
    config.resolve.fallback = { ...config.resolve.fallback, canvas: false };
    return config;
  },
};

module.exports = nextConfig;
