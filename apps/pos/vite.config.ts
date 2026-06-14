import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * POS PWA config.
 *
 * Why a PWA:
 *   The branch counter must keep billing when the internet drops. Workbox
 *   gives us a cached app shell (HTML/JS/CSS) plus a network-first cache of
 *   the menu API so the cashier can still punch item codes offline.
 *
 *   Orders punched offline aren't routed through workbox — they go into an
 *   IndexedDB queue (src/offline/orderQueue.ts) and drain when the connection
 *   returns. Workbox cannot replay POSTs correctly here because each order
 *   needs the latest auth token; queue-and-replay is owned by the app.
 *
 * Local dev:
 *   `devOptions.enabled: true` means the service worker is active in `pnpm dev`,
 *   not just production. This is what makes "kill the API and keep punching"
 *   work during development.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.ico", "icon-192.png", "icon-512.png", "logo.png"],
      manifest: {
        name: "Sabir Juice Corner — POS",
        short_name: "SJC POS",
        description: "Counter billing for Sabir Juice Corner (Multan, est. 1973).",
        theme_color: "#f59e0b",
        background_color: "#fef3c7",
        display: "standalone",
        orientation: "landscape",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // Menu items — cache so cashier can still look them up when offline.
            urlPattern: ({ url }) => url.pathname.startsWith("/api/v1/items"),
            handler: "NetworkFirst",
            options: {
              cacheName: "sjc-menu-cache",
              networkTimeoutSeconds: 3,
              expiration: { maxAgeSeconds: 60 * 60 * 24 },     // 24h
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname === "/api/v1/auth/me",
            handler: "NetworkFirst",
            options: {
              cacheName: "sjc-me-cache",
              networkTimeoutSeconds: 2,
            },
          },
        ],
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
  ],
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
