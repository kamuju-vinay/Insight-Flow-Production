import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.VITE_API_URL || "http://localhost:3001";

  return {
    plugins: [react()],
    // In dev, proxy /api/* → backend so you never need CORS locally
    server: {
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
    // Ensures assets are referenced with absolute paths (required for Vercel)
    base: "/",
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
