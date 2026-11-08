import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

import { transform } from "esbuild";
import * as ts from "typescript";
import type { TestContext } from "vitest";
import { describe, expect, test } from "vitest";

import type * as Core from "../src/core";

const require = createRequire(import.meta.url);
const { getSchema, generateService } = require("umi-plugin-openapi/core") as typeof Core;
const schema = {
  openapi: "3.0.3",
  info: { title: "Integration API", version: "1.0.0" },
  paths: {},
};

async function serveSchema(onTestFinished: TestContext["onTestFinished"]) {
  const server = createServer((request, response) => {
    if (request.url === "/disconnect") {
      request.socket.destroy();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      request.url === "/invalid"
        ? "not JSON"
        : JSON.stringify({ ...schema, authorization: request.headers.authorization ?? null }),
    );
  });
  onTestFinished(() => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
    return promise;
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Schema server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("published core schema loading", () => {
  test("reloads local JSON through a directory symlink and rejects missing files", async ({
    onTestFinished,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "openapi-core-"));
    const sourceDirectory = join(directory, "source");
    const linkedDirectory = join(directory, "linked");
    const schemaPath = join(linkedDirectory, "schema.json");
    let resolvedSchemaPath: string | undefined;
    onTestFinished(async () => {
      if (resolvedSchemaPath) delete require.cache[resolvedSchemaPath];
      await rm(directory, { recursive: true, force: true });
    });

    await mkdir(sourceDirectory);
    await symlink(sourceDirectory, linkedDirectory, "junction");
    await writeFile(schemaPath, JSON.stringify(schema));
    resolvedSchemaPath = require.resolve(schemaPath);
    await expect(getSchema(schemaPath)).resolves.toEqual(schema);

    const updatedSchema = { ...schema, info: { ...schema.info, version: "2.0.0" } };
    await writeFile(schemaPath, JSON.stringify(updatedSchema));
    await expect(getSchema(schemaPath)).resolves.toEqual(updatedSchema);
    await expect(getSchema(join(directory, "missing.json"))).rejects.toMatchObject({
      code: "MODULE_NOT_FOUND",
    });
  });

  test("fetches HTTP JSON with authorization and without leaking it to the next request", async ({
    onTestFinished,
  }) => {
    const url = await serveSchema(onTestFinished);

    await expect(getSchema(`${url}/schema`, "Bearer integration-token")).resolves.toEqual({
      ...schema,
      authorization: "Bearer integration-token",
    });
    await expect(getSchema(`${url}/schema`)).resolves.toEqual({
      ...schema,
      authorization: null,
    });
  });

  test("returns null for invalid remote JSON and a disconnected server", async ({
    onTestFinished,
  }) => {
    const url = await serveSchema(onTestFinished);

    await expect(getSchema(`${url}/invalid`)).resolves.toBeNull();
    await expect(getSchema(`${url}/disconnect`)).resolves.toBeNull();
  });
});

const petSchema = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "string", example: "pet-7" },
    name: { type: "string", example: "Milo" },
  },
};

function serviceDocument(swagger: boolean) {
  const response = swagger
    ? { description: "A pet", schema: { $ref: "#/definitions/Pet" } }
    : {
        description: "A pet",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
      };
  return {
    ...(swagger
      ? { swagger: "2.0", produces: ["application/json"], definitions: { Pet: petSchema } }
      : { openapi: "3.0.3", components: { schemas: { Pet: petSchema } } }),
    info: { title: "Generated pet API", version: "1.0.0" },
    paths: {
      "/pets/{id}": {
        get: {
          operationId: "getPet",
          tags: ["pets"],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              ...(swagger ? { type: "string" } : { schema: { type: "string" } }),
            },
            {
              name: "search",
              in: "query",
              ...(swagger ? { type: "string" } : { schema: { type: "string" } }),
            },
          ],
          responses: { "200": response },
        },
      },
    },
  };
}

async function generationFixture(onTestFinished: TestContext["onTestFinished"], document: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "openapi-generate-"));
  const schemaPath = join(directory, "schema.json");
  onTestFinished(async () => {
    delete require.cache[schemaPath];
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(schemaPath, JSON.stringify(document));
  return {
    schemaPath,
    serversPath: join(directory, "services"),
    mockFolder: join(directory, "mocks"),
    requestLibPath: "test-request",
  };
}

async function loadGenerated<T>(filename: string, request?: unknown): Promise<T> {
  const source = await readFile(filename, "utf8");
  const { code } = await transform(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
    sourcefile: filename,
  });
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require(name: string) {
      if (name === "test-request") return request;
      throw new Error(`Unexpected generated runtime dependency: ${name}`);
    },
  });
  return module.exports as T;
}

async function compileGeneratedConsumer(outputPath: string, consumer: string) {
  const consumerPath = join(outputPath, "consumer.ts");
  const requestTypesPath = join(outputPath, "request.d.ts");
  await writeFile(consumerPath, consumer);
  await writeFile(
    requestTypesPath,
    `declare module "test-request" {
      export default function request<T>(url: string, options: Record<string, unknown>): Promise<T>;
    }`,
  );
  const program = ts.createProgram({
    rootNames: (await readdir(outputPath, { recursive: true }))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(outputPath, name)),
    options: {
      strict: true,
      noEmit: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (filename) => filename,
      getCurrentDirectory: () => outputPath,
      getNewLine: () => "\n",
    }),
  ).toBe("");
  return program;
}

type GeneratedPetService = {
  getPet: (
    params: { id: string; search: string },
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
};

describe("published core service generation", () => {
  test("consumers retain recursive nullability, dictionaries, unions and nested documentation", async ({
    onTestFinished,
  }) => {
    const config = await generationFixture(onTestFinished, {
      ...schema,
      components: {
        schemas: {
          Reference: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          Nested: {
            type: "object",
            required: ["details"],
            properties: {
              details: {
                type: "object",
                nullable: true,
                required: ["label", "items", "reference", "dictionary", "typedDictionary"],
                properties: {
                  label: {
                    type: "string",
                    nullable: true,
                    description:
                      "Nested label 中文 <tag> & quotes\nclosing */ remains documentation",
                  },
                  items: {
                    type: "array",
                    description: "Nested item collection",
                    items: { type: "string", nullable: true },
                  },
                  reference: { $ref: "#/components/schemas/Reference", nullable: true },
                  dictionary: { type: "object", additionalProperties: {} },
                  typedDictionary: { type: "object", additionalProperties: { type: "string" } },
                },
              },
              references: {
                type: "array",
                items: { $ref: "#/components/schemas/Reference", nullable: true },
              },
              loose: { type: "object" },
            },
          },
          Dictionary: { type: "object", additionalProperties: true },
          Choice: {
            oneOf: [
              {
                type: "object",
                required: ["kind", "name"],
                properties: { kind: { type: "string", enum: ["named"] }, name: { type: "string" } },
              },
              {
                type: "object",
                required: ["kind", "count"],
                properties: {
                  kind: { type: "string", enum: ["counted"] },
                  count: { type: "number" },
                },
              },
            ],
          },
          Either: { anyOf: [{ type: "string" }, { type: "number" }] },
          Names: { type: "array", items: { type: "string" } },
          Alternatives: {
            type: "array",
            items: { oneOf: [{ type: "string" }, { type: "number" }] },
          },
          Combined: {
            type: "array",
            items: {
              allOf: [
                { type: "object", required: ["id"], properties: { id: { type: "string" } } },
                { type: "object", required: ["count"], properties: { count: { type: "number" } } },
              ],
            },
          },
          Child: {
            type: "object",
            nullable: true,
            required: ["name"],
            properties: {
              name: { type: "string" },
              child: { $ref: "#/components/schemas/Child" },
            },
          },
        },
      },
    });
    await generateService(config);
    const outputPath = join(config.serversPath, "api");
    const program = await compileGeneratedConsumer(
      outputPath,
      `const nullableDetails: API.Nested = { details: null };
      const nested: API.Nested = {
        details: { label: null, items: [null, "value"], reference: null,
          dictionary: { value: 123 }, typedDictionary: { value: "text" } },
        references: [null, { id: "ref" }], loose: { value: 123 }
      };
      const details: NonNullable<API.Nested["details"]> = {
        label: "text", items: [], reference: { id: "ref" },
        dictionary: {}, typedDictionary: {}
      };
      // @ts-expect-error nullable labels cannot be used as a string without narrowing
      const label: string = details.label;
      // @ts-expect-error nullable items cannot be used as a string without narrowing
      const item: string = details.items[0];
      // @ts-expect-error nullable references require narrowing
      const reference: API.Reference = details.reference;
      const unknownNestedValue: unknown = details.dictionary.value;
      const unknownLooseValue: unknown = nested.loose!.value;
      // @ts-expect-error dictionary values are unknown, not any
      const dictionaryValue: string = details.dictionary.value;
      // @ts-expect-error empty object schemas are unknown dictionaries, not any
      const looseValue: string = nested.loose!.value;
      const dictionary: API.Dictionary = { value: 123 };
      const unknownTopLevelValue: unknown = dictionary.value;
      // @ts-expect-error top-level dictionary values also require narrowing
      const topLevelValue: string = dictionary.value;
      const typedValue: string = details.typedDictionary.value;
      const named: API.Choice = { kind: "named", name: "value" };
      const counted: API.Choice = { kind: "counted", count: 1 };
      function consumeChoice(choice: API.Choice): string {
        return choice.kind === "named" ? choice.name : choice.count.toFixed();
      }
      // @ts-expect-error a union branch must provide its required properties
      const invalidChoice: API.Choice = { kind: "named", count: 1 };
      const eitherText: API.Either = "value";
      const eitherNumber: API.Either = 1;
      // @ts-expect-error anyOf retains the declared alternatives
      const invalidEither: API.Either = false;
      const names: API.Names = ["first", "second"];
      const firstName: string = names[0];
      // @ts-expect-error primitive array aliases retain their item type
      const invalidNames: API.Names = [1];
      const alternatives: API.Alternatives = ["text", 1];
      // @ts-expect-error array item unions do not allow a scalar array alternative
      const invalidAlternatives: API.Alternatives = "text";
      const combined: API.Combined = [{ id: "record", count: 1 }];
      // @ts-expect-error each array item must meet both allOf branches
      const invalidCombined: API.Combined = [{ count: 1 }];
      const child: API.Child = { name: "parent", child: { name: "leaf", child: null } };
      const absentChild: API.Child = null;`,
    );
    const declarations = program.getSourceFile(join(outputPath, "typings.d.ts"))!;
    const checker = program.getTypeChecker();
    const documentation = new Map<string, string>();
    function visit(node: ts.Node) {
      if (ts.isPropertySignature(node) && node.name) {
        const symbol = checker.getSymbolAtLocation(node.name);
        documentation.set(
          node.name.getText(declarations).replace(/['"]/g, ""),
          ts.displayPartsToString(symbol?.getDocumentationComment(checker)),
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(declarations);
    expect(documentation.get("label")).toContain("Nested label 中文 <tag> & quotes");
    expect(documentation.get("label")).toContain("remains documentation");
    expect(documentation.get("items")).toBe("Nested item collection");
  });

  test("consumers distinguish closed empty objects from dictionaries and objects with properties", async ({
    onTestFinished,
  }) => {
    const closedEmpty = { type: "object", properties: {}, additionalProperties: false };
    const config = await generationFixture(onTestFinished, {
      ...schema,
      components: {
        schemas: {
          ClosedEmpty: closedEmpty,
          ClosedWithoutProperties: { type: "object", additionalProperties: false },
          OpenEmpty: { type: "object", properties: {}, additionalProperties: true },
          DefaultEmpty: { type: "object", properties: {} },
          TypedDictionary: { type: "object", additionalProperties: { type: "string" } },
          ClosedNamed: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: { type: "string" } },
          },
          NestedEmpty: {
            type: "object",
            required: ["entries"],
            properties: {
              entries: { type: "array", items: { ...closedEmpty, nullable: true } },
            },
          },
        },
      },
      paths: {
        "/empty": {
          post: {
            operationId: "submitEmpty",
            tags: ["empty"],
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ClosedEmpty" } },
              },
            },
            responses: {
              "200": {
                description: "Nullable empty objects",
                content: {
                  "application/json": {
                    schema: { type: "array", items: { ...closedEmpty, nullable: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    await generateService(config);
    await compileGeneratedConsumer(
      join(config.serversPath, "api"),
      `import { submitEmpty } from "./empty";
      const empty: API.ClosedEmpty = {};
      const withoutProperties: API.ClosedWithoutProperties = {};
      // @ts-expect-error closed empty objects reject scalar values
      const scalar: API.ClosedEmpty = 1;
      // @ts-expect-error closed empty objects reject additional keys
      const extra: API.ClosedEmpty = { unexpected: "value" };
      // @ts-expect-error absent properties do not open a closed object
      const extraWithoutProperties: API.ClosedWithoutProperties = { unexpected: true };
      const open: API.OpenEmpty = { unexpected: 1 };
      const defaultOpen: API.DefaultEmpty = { unexpected: true };
      // @ts-expect-error open empty objects are still objects, not scalars
      const openScalar: API.OpenEmpty = "value";
      const typed: API.TypedDictionary = { name: "value" };
      // @ts-expect-error schema-valued dictionaries retain their value type
      const invalidTyped: API.TypedDictionary = { name: 1 };
      const named: API.ClosedNamed = { name: "value" };
      // @ts-expect-error declared properties retain their required status
      const missingName: API.ClosedNamed = {};
      const nested: API.NestedEmpty = { entries: [{}, null] };
      // @ts-expect-error nested nullable array items still reject extra keys
      const invalidNested: API.NestedEmpty = { entries: [{ unexpected: true }] };
      submitEmpty({});
      // @ts-expect-error generated request bodies reject additional keys
      submitEmpty({ unexpected: true });
      // @ts-expect-error generated request bodies reject scalar values
      submitEmpty(1);
      submitEmpty({}).then((response) => {
        const item: API.ClosedEmpty | null = response[0];
        response.push({}, null);
        // @ts-expect-error generated responses preserve nested closed object constraints
        response.push({ unexpected: true });
      });`,
    );
  });

  test("consumers can omit optional and default request bodies without changing data or options", async ({
    onTestFinished,
  }) => {
    const bodyContent = {
      "application/json": {
        schema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
      },
    };
    const operation = (operationId: string, requestBody: unknown) => ({
      post: {
        operationId,
        tags: ["bodies"],
        requestBody,
        responses: { "204": { description: "Saved" } },
      },
    });
    const config = await generationFixture(onTestFinished, {
      ...schema,
      components: {
        requestBodies: { RequiredBody: { required: true, content: bodyContent } },
      },
      paths: {
        "/required": operation("requiredBody", { required: true, content: bodyContent }),
        "/optional": operation("optionalBody", { required: false, content: bodyContent }),
        "/default": operation("defaultBody", { content: bodyContent }),
        "/referenced": operation("referencedBody", {
          $ref: "#/components/requestBodies/RequiredBody",
        }),
      },
    });
    await generateService(config);
    const outputPath = join(config.serversPath, "api");
    await compileGeneratedConsumer(
      outputPath,
      `import { requiredBody, optionalBody, defaultBody, referencedBody } from "./bodies";
      requiredBody({ value: "required" });
      referencedBody({ value: "referenced" });
      // @ts-expect-error required request bodies cannot be omitted
      requiredBody();
      // @ts-expect-error resolved requestBody refs retain required
      referencedBody();
      optionalBody();
      defaultBody();
      optionalBody(undefined, { timeout: 10 });
      defaultBody(undefined, { timeout: 20 });
      optionalBody({ value: "optional" }, { timeout: 30 });
      // @ts-expect-error omitting the body does not make its required fields optional
      optionalBody({});`,
    );
    const service = await loadGenerated<{
      requiredBody: (
        body: { value: string },
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
      optionalBody: (
        body?: { value: string },
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
      defaultBody: (
        body?: { value: string },
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
    }>(join(outputPath, "bodies.ts"), async (url: string, options: unknown) => ({ url, options }));
    for (const [name, body, options] of [
      ["requiredBody", { value: "required" }, { timeout: 10 }],
      ["optionalBody", undefined, undefined],
      ["defaultBody", undefined, { timeout: 20 }],
      ["optionalBody", { value: "optional" }, { timeout: 30 }],
    ] as const) {
      await expect(service[name](body!, options)).resolves.toEqual({
        url:
          name === "requiredBody"
            ? "/required"
            : name === "optionalBody"
              ? "/optional"
              : "/default",
        options: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: body,
          ...options,
        },
      });
    }
  });

  test("regenerates glob-character paths while preserving top-level hidden and _deperated entries", async ({
    onTestFinished,
  }) => {
    const fixture = await generationFixture(onTestFinished, serviceDocument(false));
    const config = { ...fixture, serversPath: join(fixture.serversPath, "[generated]") };
    const outputPath = join(config.serversPath, "api");
    await generateService({
      ...config,
      hook: { customFileNames: () => ["obsoletePets"] },
    });
    await mkdir(join(outputPath, "nested"), { recursive: true });
    await writeFile(join(outputPath, "nested", "obsolete.ts"), "old nested output");
    await writeFile(join(outputPath, "obsolete.ts"), "old output");
    await writeFile(join(outputPath, ".keep"), "hidden file");
    await mkdir(join(outputPath, ".hidden"));
    await writeFile(join(outputPath, ".hidden", "keep.txt"), "hidden directory");
    await mkdir(join(outputPath, "_deperated"));
    await writeFile(join(outputPath, "_deperated", "keep.ts"), "deprecated output");
    await writeFile(join(outputPath, "nested", ".hidden"), "nested hidden output");
    await writeFile(join(outputPath, "nested", "_deperated.ts"), "nested deprecated output");

    await generateService(config);

    expect((await readdir(outputPath)).sort()).toEqual([
      ".hidden",
      ".keep",
      "_deperated",
      "index.ts",
      "pets.ts",
      "typings.d.ts",
    ]);
    expect(await readFile(join(outputPath, ".keep"), "utf8")).toBe("hidden file");
    expect(await readFile(join(outputPath, ".hidden", "keep.txt"), "utf8")).toBe(
      "hidden directory",
    );
    expect(await readFile(join(outputPath, "_deperated", "keep.ts"), "utf8")).toBe(
      "deprecated output",
    );
  });

  for (const swagger of [false, true]) {
    test(`generates executable requests and stable response mocks (Swagger 2: ${swagger})`, async ({
      onTestFinished,
    }) => {
      const config = await generationFixture(onTestFinished, serviceDocument(swagger));
      await generateService(config);
      const requests: unknown[] = [];
      const result = { id: "pet-7", name: "Milo" };
      const service = await loadGenerated<GeneratedPetService>(
        join(config.serversPath, "api", "pets.ts"),
        async (url: string, options: unknown) => {
          requests.push({ url, options });
          return result;
        },
      );

      await expect(
        service.getPet({ id: "pet-7", search: "Milo" }, { timeout: 500 }),
      ).resolves.toEqual(result);
      expect(requests).toEqual([
        {
          url: "/pets/pet-7",
          options: { method: "GET", params: { search: "Milo" }, timeout: 500 },
        },
      ]);

      const mock = await loadGenerated<{
        default: Record<
          string,
          (
            request: unknown,
            response: { status: (code: number) => { send: (body: unknown) => void } },
          ) => void
        >;
      }>(join(config.mockFolder, "getPet.ts"));
      const responses: unknown[] = [];
      mock.default["GET /pets/:id"](
        {},
        {
          status: (status) => ({ send: (body) => responses.push({ status, body }) }),
        },
      );
      expect(responses).toEqual([{ status: 200, body: result }]);
    });
  }

  for (const [name, functionName] of [
    ["class", "classUsingGet"],
    ["await", "awaitUsingGet"],
    ["interface", "interfaceUsingGet"],
    ["arguments", "argumentsUsingGet"],
    ["type", "type"],
  ]) {
    test(`consumes a service whose operation is named ${name}`, async ({ onTestFinished }) => {
      const document = serviceDocument(false);
      const config = await generationFixture(onTestFinished, {
        ...document,
        components: { schemas: { [name]: petSchema } },
        paths: {
          "/reserved/{id}": {
            get: {
              ...document.paths["/pets/{id}"].get,
              operationId: name,
              responses: {
                "200": {
                  description: "A named model",
                  content: {
                    "application/json": { schema: { $ref: `#/components/schemas/${name}` } },
                  },
                },
              },
            },
          },
        },
      });
      await generateService(config);
      const requests: unknown[] = [];
      const service = await loadGenerated<Record<string, GeneratedPetService["getPet"]>>(
        join(config.serversPath, "api", "pets.ts"),
        async (url: string, options: unknown) => {
          requests.push({ url, options });
        },
      );
      await service[functionName]({ id: name, search: "reserved" }, { timeout: 75 });
      expect(requests).toEqual([
        {
          url: `/reserved/${name}`,
          options: { method: "GET", params: { search: "reserved" }, timeout: 75 },
        },
      ]);
    });
  }

  test("consumes Chinese schema, tag and operation names without transliteration", async ({
    onTestFinished,
  }) => {
    const config = await generationFixture(onTestFinished, {
      openapi: "3.0.3",
      info: { title: "中文接口", version: "1.0.0" },
      components: {
        schemas: {
          中文模型: {
            type: "object",
            required: ["编号"],
            properties: { 编号: { type: "string", example: "记录七" } },
          },
        },
      },
      paths: {
        "/资料/{id}": {
          get: {
            operationId: "查询资料",
            tags: ["中文服务"],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              "200": {
                description: "资料",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/中文模型" } },
                },
              },
            },
          },
        },
      },
    });
    await generateService(config);
    const requests: unknown[] = [];
    const service = await loadGenerated<{
      查询资料: (params: { id: string }) => Promise<unknown>;
    }>(join(config.serversPath, "api", "中文服务.ts"), async (url: string, options: unknown) => {
      requests.push({ url, options });
    });
    await service.查询资料({ id: "记录七" });
    expect(requests).toEqual([{ url: "/资料/记录七", options: { method: "GET", params: {} } }]);

    const mock = await loadGenerated<{
      default: Record<
        string,
        (
          request: unknown,
          response: { status: (code: number) => { send: (body: unknown) => void } },
        ) => void
      >;
    }>(join(config.mockFolder, "查询资料.ts"));
    const responses: unknown[] = [];
    mock.default["GET /资料/:id"](
      {},
      {
        status: (status) => ({ send: (body) => responses.push({ status, body }) }),
      },
    );
    expect(responses).toEqual([{ status: 200, body: { 编号: "记录七" } }]);
  });

  for (const splitDeclare of [false, true]) {
    test(`resolves parameter and response refs while preserving naming and request-option hooks (splitDeclare: ${splitDeclare})`, async ({
      onTestFinished,
    }) => {
      const document = serviceDocument(false);
      const operation = document.paths["/pets/{id}"].get;
      const config = await generationFixture(onTestFinished, {
        ...document,
        components: {
          schemas: { Pet: petSchema },
          parameters: { PetId: operation.parameters[0], PetSearch: operation.parameters[1] },
          responses: { PetResponse: operation.responses["200"] },
        },
        paths: {
          "/pets/{id}": {
            get: {
              ...operation,
              parameters: [
                { $ref: "#/components/parameters/PetId" },
                { $ref: "#/components/parameters/PetSearch" },
              ],
              responses: { "200": { $ref: "#/components/responses/PetResponse" } },
            },
          },
        },
      });
      await generateService({
        ...config,
        splitDeclare,
        hook: {
          customFunctionName: () => "readPet",
          customFileNames: () => ["customPets"],
          customOptionsDefaultValue: () => ({ timeout: 1234 }),
        },
      });
      const service = await loadGenerated<{ readPet: GeneratedPetService["getPet"] }>(
        join(config.serversPath, "api", "customPets.ts"),
        async (url: string, options: unknown) => ({ url, options }),
      );
      await expect(service.readPet({ id: "pet-7", search: "Milo" })).resolves.toEqual({
        url: "/pets/pet-7",
        options: { method: "GET", params: { search: "Milo" }, timeout: 1234 },
      });
      await expect(
        service.readPet({ id: "pet-7", search: "Milo" }, { timeout: 50 }),
      ).resolves.toEqual({
        url: "/pets/pet-7",
        options: { method: "GET", params: { search: "Milo" }, timeout: 50 },
      });
      await compileGeneratedConsumer(
        join(config.serversPath, "api"),
        `import { readPet } from "./customPets";
         async function consume() {
           const pet = await readPet({ id: "pet-7", search: "Milo" });
           readPet({ id: "pet-7" });
           const id: string = pet.id;
           const name: string = pet.name;
           // @ts-expect-error referenced path parameters retain their schema type
           readPet({ id: 7 });
           // @ts-expect-error referenced path parameters remain required
           readPet({ search: "Milo" });
           // @ts-expect-error referenced query parameters retain their schema type
           readPet({ id: "pet-7", search: 7 });
           // @ts-expect-error referenced responses retain their schema type
           const invalidName: number = pet.name;
         }`,
      );
    });
  }
});

const execFileAsync = promisify(execFile);
const unformattedSource = 'export const marker={value:"unformatted"}\n';
const prettierSource = "export const marker = { value: 'unformatted' }\n";
const oxfmtSource = 'export const marker = { value: "unformatted" };\n';

async function formatterFixture(
  onTestFinished: TestContext["onTestFinished"],
  splitDeclare = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "openapi formatter-"));
  const cwd = join(directory, "consumer");
  const templatesFolder = join(cwd, "templates");
  const config = {
    schemaPath: join(cwd, "schema.json"),
    serversPath: join(cwd, "generated", "services"),
    mockFolder: join(cwd, "generated", "mocks"),
    templatesFolder,
    splitDeclare,
  };
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await mkdir(templatesFolder, { recursive: true });
  await writeFile(config.schemaPath, JSON.stringify(serviceDocument(false)));
  for (const name of ["interface", "serviceController", "serviceIndex"]) {
    await writeFile(join(templatesFolder, `${name}.njk`), unformattedSource);
  }
  await writeFile(join(cwd, "package.json"), JSON.stringify({ private: true }));
  await writeFile(
    join(cwd, ".prettierrc.json"),
    JSON.stringify({ singleQuote: true, semi: false }),
  );
  const files = [
    ...["index.ts", "pets.ts", splitDeclare ? "types/pets.d.ts" : "typings.d.ts"].map((name) =>
      join(config.serversPath, "api", name),
    ),
    join(config.mockFolder, "getPet.ts"),
  ];
  return {
    cwd,
    directory,
    config,
    files,
    async generate(
      formatter?: Parameters<typeof generateService>[0]["formatter"],
      path = dirname(process.execPath),
    ) {
      const result = await execFileAsync(
        process.execPath,
        [
          "-e",
          `require(${JSON.stringify(require.resolve("umi-plugin-openapi/core"))})
            .generateService(JSON.parse(process.argv[1]))
            .catch(error => { console.error(error); process.exitCode = 1; });`,
          JSON.stringify({ ...config, ...(formatter === undefined ? {} : { formatter }) }),
        ],
        { cwd, env: { ...process.env, PATH: path }, timeout: 30_000 },
      );
      return {
        ...result,
        sources: await Promise.all(files.map((file) => readFile(file, "utf8"))),
      };
    },
    async installOxfmt(packageLink = false) {
      const packageDirectory = dirname(require.resolve("oxfmt/package.json"));
      const nodeModules = join(cwd, "node_modules");
      await mkdir(join(nodeModules, ".bin"), { recursive: true });
      await symlink(join(packageDirectory, "bin", "oxfmt"), join(nodeModules, ".bin", "oxfmt"));
      if (packageLink) await symlink(packageDirectory, join(nodeModules, "oxfmt"), "junction");
    },
  };
}

describe("published core formatter selection", () => {
  test("none preserves rendered bytes for every service file and mock", async ({
    onTestFinished,
  }) => {
    const fixture = await formatterFixture(onTestFinished);
    await fixture.installOxfmt(true);
    const { sources } = await fixture.generate("none");
    expect(sources.slice(0, 3)).toEqual(Array(3).fill(unformattedSource));
    expect(sources[3].endsWith("\n    }")).toBe(true);
  });

  test("explicit prettier overrides consumer oxfmt and resolves config from the generated filepath", async ({
    onTestFinished,
  }) => {
    const fixture = await formatterFixture(onTestFinished);
    await fixture.installOxfmt(true);
    await mkdir(fixture.config.serversPath, { recursive: true });
    await writeFile(
      join(fixture.config.serversPath, ".prettierrc.json"),
      JSON.stringify({ singleQuote: false, semi: true }),
    );
    const { sources } = await fixture.generate("prettier");
    expect(sources.slice(0, 3)).toEqual(Array(3).fill(oxfmtSource));
    expect(sources[3]).toContain("from 'express'");
  });

  test("default auto uses prettier without selecting the plugin's own oxfmt dependency", async ({
    onTestFinished,
  }) => {
    const fixture = await formatterFixture(onTestFinished);
    const { sources } = await fixture.generate();
    expect(sources.slice(0, 3)).toEqual(Array(3).fill(prettierSource));
    expect(sources[3]).toContain("from 'express'");
  });

  test("explicit oxfmt runs without consumer dependency or configuration", async ({
    onTestFinished,
  }) => {
    const fixture = await formatterFixture(onTestFinished);
    await fixture.installOxfmt();
    const { sources } = await fixture.generate("oxfmt");
    expect(sources.slice(0, 3)).toEqual(Array(3).fill(oxfmtSource));
    expect(sources[3]).toContain('from "express";');
  });

  for (const dependency of ["devDependencies", "installed"]) {
    test(`auto prefers real oxfmt for a consumer ${dependency} package`, async ({
      onTestFinished,
    }) => {
      const fixture = await formatterFixture(onTestFinished);
      await fixture.installOxfmt(dependency === "installed");
      if (dependency !== "installed") {
        await writeFile(
          join(fixture.cwd, "package.json"),
          JSON.stringify({ private: true, [dependency]: { oxfmt: "*" } }),
        );
      }
      const { sources } = await fixture.generate("auto");
      expect(sources.slice(0, 3)).toEqual(Array(3).fill(oxfmtSource));
      expect(sources[3]).toContain('from "express";');
    });
  }

  test("auto discovers .oxfmtrc.jsonc above the generated file rather than only cwd", async ({
    onTestFinished,
  }) => {
    const fixture = await formatterFixture(onTestFinished);
    await fixture.installOxfmt();
    await mkdir(fixture.config.serversPath, { recursive: true });
    await writeFile(
      join(fixture.config.serversPath, ".oxfmtrc.jsonc"),
      '{ "singleQuote": false, "semi": true, "tabWidth": 4 }',
    );
    const { sources } = await fixture.generate();
    expect(sources.slice(0, 3)).toEqual(Array(3).fill(oxfmtSource));
    expect(sources[3]).toContain("from 'express'");
  });

  test("external uses ancestor local bin before PATH, pipes source once and substitutes every absolute filepath", async ({
    onTestFinished,
  }) => {
    const fixture = await formatterFixture(onTestFinished);
    const baseline = await fixture.generate("none");
    const localBin = join(fixture.directory, "node_modules", ".bin");
    const pathBin = join(fixture.directory, "path-bin");
    await mkdir(localBin, { recursive: true });
    await mkdir(pathBin);
    const command = "openapi-test-formatter";
    const executable = join(localBin, command);
    await writeFile(
      executable,
      `#!${process.execPath}\nlet input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => process.stdout.write(
  '// ' + JSON.stringify(process.argv.slice(2)) + '\\n' + input));\n`,
    );
    await chmod(executable, 0o755);
    const fallback = join(pathBin, command);
    await writeFile(fallback, `#!${process.execPath}\nprocess.stdout.write('WRONG PATH');\n`);
    await chmod(fallback, 0o755);
    const { sources } = await fixture.generate(
      {
        external: {
          command,
          arguments: [
            "--file={buffer_path}",
            "{buffer_path}|{buffer_path}",
            "literal;$(echo unsafe)",
          ],
        },
      },
      [pathBin, dirname(process.execPath)].join(delimiter),
    );
    expect(sources).toEqual(
      fixture.files.map((file, index) => {
        const arguments_ = [`--file=${file}`, `${file}|${file}`, "literal;$(echo unsafe)"];
        return `// ${JSON.stringify(arguments_)}\n${baseline.sources[index]}`;
      }),
    );
  });

  for (const target of ["typings.d.ts", "types/pets.d.ts", "getPet.ts"]) {
    test(`formatting failure for ${target} preserves its content and a later generation succeeds`, async ({
      onTestFinished,
    }) => {
      const fixture = await formatterFixture(onTestFinished, target.startsWith("types/"));
      const baseline = await fixture.generate("none");
      const failedFile = fixture.files.find((file) => file.endsWith(`/${target}`))!;
      const formatSource = `let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if (process.argv[2] === process.argv[1]) {
    process.stdout.write('PARTIAL');
    process.stderr.write('formatter failed');
    process.exit(2);
  }
  process.stdout.write('// formatted\\n' + input);
});`;
      const result = await fixture.generate({
        external: {
          command: process.execPath,
          arguments: ["-e", formatSource, failedFile, "{buffer_path}"],
        },
      });
      // execFile resolves only for exit code 0; reading every file also proves none were discarded.
      expect(result.sources).toEqual(
        baseline.sources.map((source, index) =>
          fixture.files[index] === failedFile ? source : `// formatted\n${source}`,
        ),
      );
      expect(result.stderr).toContain(failedFile);
      const recovered = await fixture.generate({
        external: {
          command: process.execPath,
          arguments: ["-e", formatSource, "no failing file", "{buffer_path}"],
        },
      });
      expect(recovered.sources).toEqual(
        baseline.sources.map((source) => `// formatted\n${source}`),
      );
      expect(recovered.stderr).toBe("");
    });
  }

  for (const failure of ["missing executable", "auto oxfmt unavailable"]) {
    test(`formatter ${failure} preserves every unformatted file and warns`, async ({
      onTestFinished,
    }) => {
      const fixture = await formatterFixture(onTestFinished);
      const baseline = await fixture.generate("none");
      let formatter: Parameters<typeof generateService>[0]["formatter"];
      if (failure === "auto oxfmt unavailable") {
        await writeFile(
          join(fixture.cwd, "package.json"),
          JSON.stringify({ devDependencies: { oxfmt: "*" } }),
        );
        formatter = "auto";
      } else {
        formatter = {
          external: { command: "openapi-nonexistent-formatter", arguments: [] },
        };
      }
      const result = await fixture.generate(
        formatter,
        failure === "auto oxfmt unavailable" ? "" : dirname(process.execPath),
      );
      expect(result.sources).toEqual(baseline.sources);
      expect(result.stderr).toMatch(/format|warn/i);
      expect(result.stderr).toContain(fixture.files[1]);
    });
  }
});
