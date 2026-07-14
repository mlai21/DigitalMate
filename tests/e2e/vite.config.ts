import path from "node:path";
import { defineConfig } from "vite";

const repositoryRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  root: path.resolve(__dirname, "fixtures/chat"),
  publicDir: path.resolve(repositoryRoot, "public"),
  resolve: {
    alias: {
      "next/link": path.resolve(__dirname, "fixtures/chat/src/next-link.tsx"),
      "@": path.resolve(repositoryRoot, "src"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    fs: {
      allow: [repositoryRoot],
    },
  },
});
