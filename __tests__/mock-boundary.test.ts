import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { transform } from "esbuild";
import type { TestContext } from "vitest";
import { expect, test } from "vitest";

import type * as Core from "../src/core";

const require = createRequire(import.meta.url);
const { generateService } = require("umi-plugin-openapi/core") as typeof Core;
const response = (schema: unknown) => ({
  description: "sample",
  content: { "application/json": { schema } },
});

async function fixture(
  onTestFinished: TestContext["onTestFinished"],
  paths: unknown,
  components = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "openapi-mock-boundary-"));
  const schemaPath = join(directory, "schema.json");
  onTestFinished(async () => {
    delete require.cache[schemaPath];
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    schemaPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Mock boundary", version: "1" },
      paths,
      components,
    }),
  );
  return {
    schemaPath,
    serversPath: join(directory, "services"),
    mockFolder: join(directory, "mocks"),
  };
}

async function loadMocks(folder: string) {
  const actions: Record<string, unknown> = {};
  for (const name of await readdir(folder)) {
    const { code } = await transform(await readFile(join(folder, name), "utf8"), {
      loader: "ts",
      format: "cjs",
      target: "es2022",
    });
    const module = { exports: {} as { default: Record<string, unknown> } };
    runInNewContext(code, { module, exports: module.exports });
    Object.assign(actions, module.exports.default);
  }
  return actions;
}

function invoke(action: unknown) {
  let status: number | undefined;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    send(value: unknown) {
      payload = value;
      return res;
    },
  };
  (action as (req: unknown, res: unknown) => void)({}, res);
  return { status, payload };
}

test("all eight methods retain successful status and falsy samples through referenced paths", async ({
  onTestFinished,
}) => {
  const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
  const pathItem = Object.fromEntries(
    methods.map((method) => [
      method,
      {
        operationId: `${method}Boundary`,
        responses: {
          default: response({ type: "string", example: "error" }),
          "201": response({
            type: "object",
            required: ["secret"],
            properties: {
              disabled: { type: "boolean", example: false },
              zero: { type: "integer", default: 0 },
              empty: { type: "string", enum: [""] },
              nullable: { type: "string", nullable: true, example: null },
              emptyExample: { type: "string", example: "" },
              zeroExample: { type: "integer", example: 0 },
              falseDefault: { type: "boolean", default: false },
              emptyDefault: { type: "string", default: "" },
              secret: { type: "string", writeOnly: true },
            },
          }),
        },
      },
    ]),
  );
  const options = await fixture(onTestFinished, { "/items/{id}": { $ref: "#/x-items" } });
  const document = JSON.parse(await readFile(options.schemaPath, "utf8"));
  document["x-items"] = { ...pathItem, parameters: [{ $ref: "#/components/parameters/Id" }] };
  document.components = {
    parameters: { Id: { name: "id", in: "path", required: true, schema: { type: "string" } } },
  };
  await writeFile(options.schemaPath, JSON.stringify(document));
  await generateService(options);
  const actions = await loadMocks(options.mockFolder);
  expect(Object.keys(actions).sort()).toEqual(
    methods.map((method) => `${method.toUpperCase()} /items/:id`).sort(),
  );
  for (const action of Object.values(actions)) {
    expect(invoke(action)).toEqual({
      status: 201,
      payload: {
        disabled: false,
        zero: 0,
        empty: "",
        nullable: null,
        emptyExample: "",
        zeroExample: 0,
        falseDefault: false,
        emptyDefault: "",
      },
    });
  }
});

test("response refs decode JSON pointers, compose properties, and prefer wildcard success over default", async ({
  onTestFinished,
}) => {
  const options = await fixture(
    onTestFinished,
    {
      "/composed": {
        get: {
          operationId: "composed",
          responses: {
            default: response({ type: "string", example: "error" }),
            "2XX": { $ref: "#/components/responses/ok~1value" },
          },
        },
      },
      "/empty": {
        get: { operationId: "empty", responses: { "204": { description: "No content" } } },
      },
      "/fallback": {
        get: {
          operationId: "fallback",
          responses: { default: response({ type: "string", example: "error" }) },
        },
      },
    },
    {
      responses: {
        "ok/value": response({
          allOf: [
            { $ref: "#/components/schemas/a~0b" },
            { type: "object", properties: { second: { oneOf: [{ type: "integer", enum: [0] }] } } },
          ],
        }),
      },
      schemas: {
        "a~b": { type: "object", properties: { first: { type: "boolean", enum: [false] } } },
      },
    },
  );
  await generateService(options);
  const actions = await loadMocks(options.mockFolder);
  expect(invoke(actions["GET /composed"])).toEqual({
    status: 200,
    payload: { first: false, second: 0 },
  });
  expect(invoke(actions["GET /empty"])).toEqual({ status: 204, payload: undefined });
  expect(invoke(actions["GET /fallback"])).toEqual({ status: 500, payload: "error" });
});

test("MSW keeps primitive media examples rather than replacing them with objects", async ({
  onTestFinished,
}) => {
  const options = await fixture(onTestFinished, {
    "/false": {
      get: {
        operationId: "falseExample",
        responses: {
          "200": {
            description: "false",
            content: { "application/json": { example: false, schema: { type: "boolean" } } },
          },
        },
      },
    },
  });
  await generateService({ ...options, mockConfig: { msw: true } });
  expect((await loadMocks(options.mockFolder))["GET /false"]).toBe(false);
});

for (const ref of ["#/components/schemas/Missing", "#/components/schemas/Loop"]) {
  test(`unresolvable or required cyclic schema ${ref} fails explicitly`, async ({
    onTestFinished,
  }) => {
    const options = await fixture(
      onTestFinished,
      {
        "/invalid": {
          get: { operationId: "invalid", responses: { "200": response({ $ref: ref }) } },
        },
      },
      {
        schemas: {
          Loop: {
            type: "object",
            required: ["next"],
            properties: { next: { $ref: "#/components/schemas/Loop" } },
          },
        },
      },
    );
    await expect(generateService(options)).rejects.toThrow(/ref|recurs|cycl/i);
  });
}

test("finite recursive responses omit optional links, allow nullable required links, and empty recursive arrays", async ({
  onTestFinished,
}) => {
  const schemas = {
    Optional: {
      type: "object",
      properties: {
        value: { type: "integer", example: 7 },
        next: { $ref: "#/components/schemas/Optional" },
      },
    },
    Nullable: {
      type: "object",
      nullable: true,
      required: ["next"],
      properties: { next: { $ref: "#/components/schemas/Nullable" } },
    },
    Array: { type: "array", items: { $ref: "#/components/schemas/Array" } },
  };
  const paths = Object.fromEntries(
    Object.keys(schemas).map((name) => [
      `/${name}`,
      {
        get: {
          operationId: name,
          responses: { "200": response({ $ref: `#/components/schemas/${name}` }) },
        },
      },
    ]),
  );
  const options = await fixture(onTestFinished, paths, { schemas });
  await generateService(options);
  const actions = await loadMocks(options.mockFolder);
  expect(invoke(actions["GET /Optional"])).toEqual({ status: 200, payload: { value: 7 } });
  expect(invoke(actions["GET /Nullable"])).toEqual({ status: 200, payload: { next: null } });
  expect(invoke(actions["GET /Array"])).toEqual({ status: 200, payload: [[]] });
});

test("non-200 success codes keep their actual status and beat default errors", async ({
  onTestFinished,
}) => {
  const statuses = [202, 206, 299];
  const paths = Object.fromEntries(
    statuses.map((status) => [
      `/status${status}`,
      {
        get: {
          operationId: `status${status}`,
          responses: {
            default: response({ type: "string", example: "failure" }),
            [status]: response({ type: "integer", example: status }),
          },
        },
      },
    ]),
  );
  const options = await fixture(onTestFinished, paths);
  await generateService(options);
  const actions = await loadMocks(options.mockFolder);
  for (const status of statuses)
    expect(invoke(actions[`GET /status${status}`])).toEqual({ status, payload: status });
});

test("paths extensions and unsampled error responses do not prevent successful mocks", async ({
  onTestFinished,
}) => {
  const options = await fixture(
    onTestFinished,
    {
      "x-purpose": "mock boundaries",
      "x-data": { nested: [null, false, 0, "", { arbitrary: "JSON" }] },
      "x-null": null,
      "/success": {
        get: {
          operationId: "successWithUnsampledErrors",
          responses: {
            "200": response({
              type: "object",
              properties: { ok: { type: "boolean", example: true } },
            }),
            "400": response({ not: { type: "string" } }),
            "401": {
              description: "external",
              content: {
                "application/json": {
                  examples: {
                    remote: { externalValue: "https://example.test/sample.json" },
                  },
                },
              },
            },
            "500": response({ $ref: "#/components/schemas/InfiniteError" }),
          },
        },
      },
    },
    {
      schemas: {
        InfiniteError: {
          type: "object",
          required: ["next"],
          properties: {
            next: { $ref: "#/components/schemas/InfiniteError" },
          },
        },
      },
    },
  );
  await generateService(options);
  const actions = await loadMocks(options.mockFolder);
  expect(Object.keys(actions)).toEqual(["GET /success"]);
  expect(invoke(actions["GET /success"])).toEqual({ status: 200, payload: { ok: true } });
});

test("unsamplable mock schemas preserve existing service and mock outputs", async ({
  onTestFinished,
}) => {
  const options = await fixture(onTestFinished, {
    "/unsupported": {
      get: {
        operationId: "unsupportedSample",
        responses: { "200": response({ not: { type: "string" } }) },
      },
    },
  });
  const serviceDirectory = join(options.serversPath, "api");
  await mkdir(serviceDirectory, { recursive: true });
  await mkdir(options.mockFolder, { recursive: true });
  const serviceSource = "export const preservedService = 'original';\n";
  const mockSource = "export default { 'GET /original': false };\n";
  await writeFile(join(serviceDirectory, "original.ts"), serviceSource);
  await writeFile(join(options.mockFolder, "original.ts"), mockSource);

  await expect(generateService(options)).rejects.toThrow(/not schema/i);

  expect(await readdir(options.serversPath)).toEqual(["api"]);
  expect(await readdir(serviceDirectory)).toEqual(["original.ts"]);
  expect(await readFile(join(serviceDirectory, "original.ts"), "utf8")).toBe(serviceSource);
  expect(await readdir(options.mockFolder)).toEqual(["original.ts"]);
  expect(await readFile(join(options.mockFolder, "original.ts"), "utf8")).toBe(mockSource);
});

for (const msw of [false, true]) {
  test(`quoted mock routes and own prototype keys survive generation (MSW: ${msw})`, async ({
    onTestFinished,
  }) => {
    const example = JSON.parse(
      '{"__proto__":{"marker":"preserved"},"nested":[{"__proto__":false}]}',
    );
    const properties = JSON.parse(
      '{"__proto__":{"type":"object","properties":{"marker":{"type":"string","example":"sampled"}}}}',
    );
    const options = await fixture(onTestFinished, {
      "/users/o'clock": {
        get: {
          operationId: "quotedRoute",
          responses: {
            "200": response({ type: "object", example }),
          },
        },
      },
      "/sampled": {
        get: {
          operationId: "prototypeProperty",
          responses: {
            "200": response({ allOf: [{ type: "object", properties }] }),
          },
        },
      },
    });
    await generateService({ ...options, mockConfig: { msw } });
    const actions = await loadMocks(options.mockFolder);
    const payload = (
      msw ? actions["GET /users/o'clock"] : invoke(actions["GET /users/o'clock"]).payload
    ) as typeof example;
    expect(Object.hasOwn(payload, "__proto__")).toBe(true);
    expect(payload.__proto__).toEqual({ marker: "preserved" });
    expect(Object.hasOwn(payload.nested[0], "__proto__")).toBe(true);
    expect(payload.nested[0].__proto__).toBe(false);
    const sampled = (
      msw ? actions["GET /sampled"] : invoke(actions["GET /sampled"]).payload
    ) as Record<string, unknown>;
    expect(Object.hasOwn(sampled, "__proto__")).toBe(true);
    expect(sampled.__proto__).toEqual({ marker: "sampled" });
  });
}
