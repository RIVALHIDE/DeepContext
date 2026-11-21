import { defineConfig } from "@neon/config/v1";

// Provisioned by `npx neon@latest deploy`. The bucket stays private; only the
// backend receives its S3-compatible credentials.
export default defineConfig({
  buckets: {
    "deepcontext-uploads": { access: "private" },
  },
});
