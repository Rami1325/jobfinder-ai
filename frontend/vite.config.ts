import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to the FastAPI backend during dev.
      // 127.0.0.1, NOT localhost: Node resolves localhost to ::1 first, and
      // uvicorn binds 127.0.0.1 — so `localhost` here fails to connect on
      // Windows with a misleading ECONNREFUSED.
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
