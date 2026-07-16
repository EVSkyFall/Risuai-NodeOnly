import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    svelte(),
  ],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
    server: {
      deps: {
        // The package's published Node entry mixes ESM and UMD. Vitest must
        // inline it so the real SentencePiece/WASM smoke uses the browser build.
        inline: ['@mlc-ai/web-tokenizers'],
      },
    },
    // compat suite has its own node-environment config (vitest.config.compat.ts);
    // exclude here so `pnpm test` doesn't pick them up under the wrong environment.
    exclude: ['node_modules/**', 'test/compat/**'],
  },
})
