import { defineConfig } from "tsdown/config";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  platform: "node",
  format: ["cjs"],
  fixedExtension: false,
  dts: true,
  exports: true,
});
