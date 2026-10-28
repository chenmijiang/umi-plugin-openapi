import { defineConfig } from "tsdown/config";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core/index.ts",
  },
  platform: "node",
  format: ["cjs"],
  fixedExtension: false,
  dts: true,
  copy: [{ from: "src/templates/*.njk", to: "dist/templates" }],
  exports: true,
});
