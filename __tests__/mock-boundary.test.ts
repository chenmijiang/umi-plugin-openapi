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

for (const msw of [false, true]) {
  test(`explicit media samples override unsamplable schemas and retain primitives (MSW: ${msw})`, async ({
    onTestFinished,
  }) => {
    const options = await fixture(
      onTestFinished,
      {
        "/false": {
          get: {
            operationId: "falseExample",
            responses: {
              "200": {
                description: "false",
                content: {
                  "application/json": { example: false, schema: { not: { type: "string" } } },
                },
              },
            },
          },
        },
        "/zero": {
          get: {
            operationId: "referencedExample",
            responses: {
              "200": {
                description: "zero",
                content: {
                  "application/json": {
                    examples: { zero: { $ref: "#/components/examples/Zero" } },
                    schema: { not: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      { examples: { Zero: { value: 0 } } },
    );
    await generateService({ ...options, mockConfig: { msw } });
    const actions = await loadMocks(options.mockFolder);
    for (const [route, payload] of [
      ["/false", false],
      ["/zero", 0],
    ] as const) {
      expect(msw ? actions[`GET ${route}`] : invoke(actions[`GET ${route}`]).payload).toBe(payload);
    }
  });
}

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

test("recursive responses terminate through optional links, nullability, arrays, or a finite alternative", async ({
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
    Alternative: {
      anyOf: [{ $ref: "#/components/schemas/Alternative" }, { type: "integer", enum: [0] }],
    },
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
  expect(invoke(actions["GET /Alternative"])).toEqual({ status: 200, payload: 0 });
});

test("explicit responses preserve successful status boundaries and declared errors instead of default", async ({
  onTestFinished,
}) => {
  const cases = [
    {
      name: "success",
      responses: {
        "206": response({ type: "integer", example: 206 }),
        "2XX": response({ type: "integer", example: 299 }),
        default: response({ type: "integer", example: 500 }),
      },
      status: 206,
    },
    {
      name: "lastSuccess",
      responses: {
        "299": response({ type: "integer", example: 299 }),
        "400": response({ type: "integer", example: 400 }),
        default: response({ type: "integer", example: 500 }),
      },
      status: 299,
    },
    {
      name: "declaredError",
      responses: {
        "404": response({ type: "integer", example: 404 }),
        default: response({ type: "integer", example: 500 }),
      },
      status: 404,
    },
  ];
  const paths = Object.fromEntries(
    cases.map(({ name, responses }) => [
      `/${name}`,
      {
        get: {
          operationId: name,
          responses,
        },
      },
    ]),
  );
  const options = await fixture(onTestFinished, paths);
  await generateService(options);
  const actions = await loadMocks(options.mockFolder);
  for (const { name, status } of cases)
    expect(invoke(actions[`GET /${name}`])).toEqual({ status, payload: status });
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

for (const mutation of [
  "in-place",
  "replacement",
  "nested operation",
  "prototype method",
  "non-enumerable initializer",
] as const) {
  test(`client hooks with ${mutation} changes leave mock routes and samples unchanged`, async ({
    onTestFinished,
  }) => {
    const options = await fixture(onTestFinished, {
      "/baseline": {
        get: {
          tags: ["boundary"],
          operationId: "baseline",
          responses: { "200": response({ type: "string", example: "baseline sample" }) },
        },
      },
    });
    type ClientHook = NonNullable<Parameters<typeof generateService>[0]["hook"]>;
    const nestedOperation = mutation === "nested operation" || mutation === "prototype method";
    let hook: ClientHook;
    if (nestedOperation) {
      class ClientHooks {
        customFunctionName(
          this: void,
          operation: Parameters<NonNullable<ClientHook["customFunctionName"]>>[0],
        ) {
          operation.responses["200"] = response({ type: "string", example: "client sample" });
          return "clientOnly";
        }
      }
      const clientHooks = new ClientHooks();
      hook =
        mutation === "prototype method"
          ? clientHooks
          : { customFunctionName: clientHooks.customFunctionName };
    } else {
      hook = {
        afterOpenApiDataInited(document) {
          const client = mutation === "replacement" ? structuredClone(document) : document;
          client.paths = {
            "/client-only": {
              get: {
                tags: ["boundary"],
                operationId: "clientOnly",
                responses: {
                  "200": {
                    description: "client sample",
                    content: {
                      "application/json": {
                        schema: { type: "string", example: "client sample" },
                      },
                    },
                  },
                },
              },
            },
          };
          return mutation === "replacement" ? client : undefined;
        },
      };
      if (mutation === "non-enumerable initializer") {
        Object.defineProperty(hook, "afterOpenApiDataInited", { enumerable: false });
      }
    }
    await generateService({ ...options, hook });
    const actions = await loadMocks(options.mockFolder);
    expect(Object.keys(actions)).toEqual(["GET /baseline"]);
    expect(invoke(actions["GET /baseline"])).toEqual({ status: 200, payload: "baseline sample" });

    const serviceDirectory = join(options.serversPath, "api");
    const requests: string[] = [];
    const { code } = await transform(
      await readFile(join(serviceDirectory, "boundary.ts"), "utf8"),
      {
        loader: "ts",
        format: "cjs",
        target: "es2022",
      },
    );
    const module = { exports: {} as { clientOnly: () => Promise<unknown>; baseline?: unknown } };
    runInNewContext(code, {
      module,
      exports: module.exports,
      require: (specifier: string) => {
        if (specifier !== "umi") throw new Error(`Unexpected client dependency: ${specifier}`);
        return {
          request: (url: string) => {
            requests.push(url);
          },
        };
      },
    });
    expect(module.exports.baseline).toBeUndefined();
    await module.exports.clientOnly();
    expect(requests).toEqual([nestedOperation ? "/baseline" : "/client-only"]);
  });
}
