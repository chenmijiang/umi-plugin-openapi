import { describe, expect, expectTypeOf, test } from "vitest";

import { configItemSchema, configSchema, type ConfigItem } from "../src/config";
import type { GenerateServiceProps } from "../src/core/types";

const schemaPath = "./openapi.json";

describe("openAPI config schema", () => {
  test.each([{ config: { schemaPath } }, { config: [{ schemaPath }] }])(
    "accepts a minimal schemaPath config: $config",
    ({ config }) => {
      expect(configSchema.parse(config)).toEqual(config);
    },
  );

  test("retains optional configuration fields", () => {
    const config = {
      schemaPath,
      requestLibPath: "import { request } from '@umijs/max'",
      mock: true,
      projectName: "gen",
      apiPrefix: "/api",
      namespace: "API",
      nullable: true,
      dataFields: ["data"],
      isCamelCase: false,
    };

    expect(configSchema.parse(config)).toEqual(config);
  });

  test("retains supported callbacks rather than stripping them from parsed configuration", () => {
    const input: ConfigItem = {
      schemaPath,
      apiPrefix: ({ namespace, path }) => `/${namespace}${path}`,
      hook: {
        afterOpenApiDataInited: (document) => document,
        customFunctionName: () => "listPets",
        customTypeName: () => "Pet",
        customClassName: (tagName) => `${tagName}Service`,
        customOptionsDefaultValue: () => ({ credentials: "include" }),
        customType: (_schema, _namespace, originGetType) => originGetType(_schema),
        customFileNames: () => ["pets"],
      },
    };

    expect(configItemSchema.parse(input)).toEqual({
      schemaPath,
      apiPrefix: expect.any(Function),
      hook: {
        afterOpenApiDataInited: expect.any(Function),
        customFunctionName: expect.any(Function),
        customTypeName: expect.any(Function),
        customClassName: expect.any(Function),
        customOptionsDefaultValue: expect.any(Function),
        customType: expect.any(Function),
        customFileNames: expect.any(Function),
      },
    });
  });

  test("preserves generator-compatible configuration and exact callback signatures", () => {
    expectTypeOf<ConfigItem>().toExtend<GenerateServiceProps>();
    expectTypeOf<ConfigItem["apiPrefix"]>().toEqualTypeOf<GenerateServiceProps["apiPrefix"]>();
    expectTypeOf<ConfigItem["hook"]>().toEqualTypeOf<GenerateServiceProps["hook"]>();
  });

  test.each([
    { config: {}, field: "schemaPath" },
    { config: { schemaPath: 123 }, field: "schemaPath" },
    { config: { schemaPath, mock: "true" }, field: "mock" },
    { config: { schemaPath, apiPrefix: 123 }, field: "apiPrefix" },
    { config: { schemaPath, hook: "not an object" }, field: "hook" },
    ...[
      "afterOpenApiDataInited",
      "customFunctionName",
      "customTypeName",
      "customOptionsDefaultValue",
      "customClassName",
      "customType",
      "customFileNames",
    ].map((hook) => ({
      config: { schemaPath, hook: { [hook]: "not a function" } },
      field: `hook.${hook}`,
    })),
  ])("rejects invalid $field", ({ config, field }) => {
    const result = configSchema.safeParse(config);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.format()).toHaveProperty(
        `${field}._errors`,
        expect.arrayContaining([expect.any(String)]),
      );
    }
  });

  test.each([null, "./openapi.json", [{ schemaPath }, {}]])(
    "rejects an invalid configuration or array item: %j",
    (config) => {
      expect(configSchema.safeParse(config).success).toBe(false);
    },
  );
});
