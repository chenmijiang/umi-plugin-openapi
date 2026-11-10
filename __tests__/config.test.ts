import { describe, expect, test } from "vitest";

import { configItemSchema, configSchema, type ConfigItem } from "../src/config";

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
      typeFileHeader: "// @ts-nocheck\n/* oxlint-disable */",
    };

    expect(configSchema.parse(config)).toEqual(config);
  });

  test.each([
    "oxfmt",
    "prettier",
    "auto",
    "none",
    { external: { command: "prettier", arguments: ["--stdin-filepath", "{buffer_path}"] } },
  ])("preserves formatter configuration: %j", (formatter) => {
    expect(configSchema.parse({ schemaPath, formatter })).toEqual({ schemaPath, formatter });
  });

  test.each([
    "unknown",
    null,
    { external: { command: "", arguments: [] } },
    { external: { command: "prettier" } },
    { external: { command: "prettier", arguments: [123] } },
  ])("rejects invalid formatter configuration: %j", (formatter) => {
    expect(configSchema.safeParse({ schemaPath, formatter }).success).toBe(false);
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

    expect(configItemSchema.parse(input)).toEqual(input);
  });

  test.each([
    { config: {}, field: "schemaPath" },
    { config: { schemaPath: 123 }, field: "schemaPath" },
    { config: { schemaPath, mock: "true" }, field: "mock" },
    { config: { schemaPath, typeFileHeader: true }, field: "typeFileHeader" },
    { config: { schemaPath, apiPrefix: 123 }, field: "apiPrefix" },
    { config: { schemaPath, hook: "not an object" }, field: "hook" },
    {
      config: { schemaPath, hook: { customFunctionName: "not a function" } },
      field: "hook.customFunctionName",
    },
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
