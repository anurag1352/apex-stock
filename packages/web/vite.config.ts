import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) return "charts";
          if (id.includes("node_modules/react")) return "react-vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4100", changeOrigin: true },
      "/ws": { target: "ws://localhost:4100", ws: true },
    },
  },
});