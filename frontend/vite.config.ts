import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  if (process.env.VERCEL === "1") {
    const base = process.env.VITE_API_BASE || env.VITE_API_BASE;
    if (!base || !/^https:\/\/[^/]+\/?$/.test(base)) {
      throw new Error("Set VITE_API_BASE to the separate backend HTTPS origin before deploying.");
    }
  }
  return { plugins: [tailwindcss()] };
});
