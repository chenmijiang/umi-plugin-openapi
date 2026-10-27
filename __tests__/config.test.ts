import { createRequire } from "node:module";

import { describe, expect, test } from "vitest";

import openAPIPlugin from "../src/index";

const require = createRequire(import.meta.url);
const umiRequire = createRequire(require.resolve("umi"));
const coreRequire = createRequire(umiRequire.resolve("@umijs/core"));
const { zod } = coreRequire("@umijs/utils");

function getConfigSchema() {
  const sentinel = new Error("stop after config registration");
  let schema = zod.never();

  expect(() =>
    openAPIPlugin({
      onStart() {},
      EnableBy: { config: "config" },
      describe({
        config,
      }: {
        config: { schema: (options: { zod: typeof zod }) => typeof schema };
      }) {
        schema = config.schema({ zod });
        // Stop before the plugin creates or removes any directories.
        throw sentinel;
      },
    } as unknown as Parameters<typeof openAPIPlugin>[0]),
  ).toThrow(sentinel);

  return schema;
}

const schema = getConfigSchema();
const schemaPath = "./openapi.json";

describe("openAPI config schema", () => {
  test.each([{ config: { schemaPath } }, { config: [{ schemaPath }] }])(
    "accepts a minimal schemaPath config: $config",
    ({ config }) => {
      const result = schema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(config);
      }
    },
  );

  test("accepts and retains a single hook callback", () => {
    const result = schema.safeParse({
      schemaPath,
      hook: { customFunctionName: () => "customName" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        schemaPath,
        hook: { customFunctionName: expect.any(Function) },
      });
      expect(result.data.hook.customFunctionName()).toBe("customName");
    }
  });

  test.each([
    { config: {}, field: "schemaPath" },
    { config: { schemaPath: 123 }, field: "schemaPath" },
    { config: { schemaPath, mock: "true" }, field: "mock" },
    {
      config: { schemaPath, hook: { customFunctionName: "not a function" } },
      field: "hook.customFunctionName",
    },
  ])("rejects invalid $field", ({ config, field }) => {
    const result = schema.safeParse(config);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.format()).toHaveProperty(
        `${field}._errors`,
        expect.arrayContaining([expect.any(String)]),
      );
    }
  });
});
