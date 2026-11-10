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
import { describe, expect, onTestFinished, test } from "vitest";

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
    onTestFinished(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    await mkdir(sourceDirectory);
    await symlink(sourceDirectory, linkedDirectory, "junction");
    await writeFile(schemaPath, JSON.stringify(schema));
    await expect(getSchema(schemaPath)).resolves.toEqual(schema);

    const updatedSchema = { ...schema, info: { ...schema.info, version: "2.0.0" } };
    await writeFile(schemaPath, JSON.stringify(updatedSchema));
    await expect(getSchema(schemaPath)).resolves.toEqual(updatedSchema);
    await expect(getSchema(join(directory, "missing.json"))).rejects.toThrow();
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
    Blob,
    File,
    FormData,
    URLSearchParams,
    URL,
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
        details: { label: null, items: [null, "value"], reference: { id: "ref" },
          dictionary: { value: 123 }, typedDictionary: { value: "text" } },
        references: [{ id: "ref" }], loose: { value: 123 }
      };
      const details: NonNullable<API.Nested["details"]> = {
        label: "text", items: [], reference: { id: "ref" },
        dictionary: {}, typedDictionary: {}
      };
      // @ts-expect-error nullable labels cannot be used as a string without narrowing
      const label: string = details.label;
      // @ts-expect-error nullable items cannot be used as a string without narrowing
      const item: string = details.items[0];
      const reference: API.Reference = details.reference;
      // @ts-expect-error OpenAPI 3.0 Reference Object ignores nullable siblings
      const invalidReference: NonNullable<API.Nested["details"]>["reference"] = null;
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

  test("nullable compositions preserve all constraints in original schema consumers", async ({
    onTestFinished,
  }) => {
    const compositions = ["allOf", "oneOf", "anyOf"] as const;
    const schemas = Object.fromEntries(
      compositions.flatMap((composition) => {
        const combined = {
          type: "object",
          required: ["own"],
          properties: { own: { type: "string" } },
          [composition]: [
            { type: "object", required: ["id"], properties: { id: { type: "string" } } },
            { type: "object", required: ["count"], properties: { count: { type: "number" } } },
          ],
        };
        return [
          [composition, { ...combined, nullable: true }],
          [`Strict${composition}`, combined],
        ];
      }),
    );
    const config = await generationFixture(onTestFinished, {
      ...schema,
      components: {
        schemas: {
          ...schemas,
          Envelope: {
            type: "object",
            required: [...compositions, "advertiser"],
            properties: {
              ...Object.fromEntries(
                compositions.map((name) => [name, { $ref: `#/components/schemas/${name}` }]),
              ),
              advertiser: { nullable: true, anyOf: [{ type: "number" }, { type: "string" }] },
            },
          },
        },
      },
      paths: {
        "/compositions": {
          post: {
            operationId: "saveCompositions",
            tags: ["compositions"],
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Envelope" } },
              },
            },
            responses: {
              "200": {
                description: "compositions",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Envelope" } },
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
      `import { saveCompositions } from './compositions';
      const response: Promise<API.Envelope> = saveCompositions({
        allOf: null, oneOf: null, anyOf: null, advertiser: null
      });
      const envelope: API.Envelope = {
        allOf: null, oneOf: null, anyOf: null, advertiser: null
      };
      const advertiserText: API.Envelope["advertiser"] = "text";
      const advertiserNumber: API.Envelope["advertiser"] = 1;
      // @ts-expect-error nullable primitive alternatives still reject booleans
      const invalidAdvertiser: API.Envelope["advertiser"] = false;
      ${compositions
        .map((composition) => {
          const valid =
            composition === "allOf"
              ? `{ own: "value", id: "id", count: 1 }`
              : `{ own: "value", id: "id" }`;
          return `const nil${composition}: API.${composition} = null;
          const valid${composition}: API.${composition} = ${valid};
          const strict${composition}: API.Strict${composition} = ${valid};
          // @ts-expect-error compositions without nullable still exclude null
          const invalidNull${composition}: API.Strict${composition} = null;
          // @ts-expect-error nullable applies to the entire intersection, not just own constraints
          const missingOwn${composition}: API.${composition} = { id: "id", count: 1 };
          // @ts-expect-error nullable does not make composition branches optional
          const missingBranch${composition}: API.${composition} = { own: "value" };
          // @ts-expect-error distinct branch constraints are not discarded
          const invalidBranch${composition}: API.${composition} = { own: "value", id: false, count: false };
          ${
            composition === "allOf"
              ? `// @ts-expect-error allOf still requires every branch
          const missingCount${composition}: API.${composition} = { own: "value", id: "id" };`
              : ""
          }`;
        })
        .join("\n")}`,
    );
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

  test("multipart consumers supply one FormData with requiredness independent of schema shape", async ({
    onTestFinished,
  }) => {
    const uploadSchema = {
      type: "object",
      required: ["file", "title"],
      properties: {
        file: { type: "string", format: "binary" },
        title: { type: "string" },
      },
    };
    const operation = (operationId: string, requestBody: unknown, withParams = false) => ({
      post: {
        operationId,
        tags: ["uploads"],
        ...(withParams
          ? {
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            }
          : {}),
        requestBody,
        responses: { "204": { description: "Uploaded" } },
      },
    });
    const config = await generationFixture(onTestFinished, {
      ...schema,
      components: {
        schemas: { Upload: uploadSchema },
        requestBodies: {
          RequiredUpload: {
            required: true,
            content: { "multipart/form-data": { schema: { $ref: "#/components/schemas/Upload" } } },
          },
          OptionalUpload: {
            required: false,
            content: { "multipart/form-data": { schema: uploadSchema } },
          },
        },
      },
      paths: {
        "/inline/{id}": operation(
          "inlineUpload",
          {
            required: true,
            content: { "multipart/form-data": { schema: uploadSchema } },
          },
          true,
        ),
        "/referenced": operation("referencedUpload", {
          $ref: "#/components/requestBodies/RequiredUpload",
        }),
        "/schema-ref": operation("schemaRefUpload", {
          content: { "multipart/form-data": { schema: { $ref: "#/components/schemas/Upload" } } },
        }),
        "/no-schema": operation("noSchemaUpload", {
          required: true,
          content: { "multipart/form-data": {} },
        }),
        "/optional-no-schema": operation("optionalNoSchemaUpload", {
          content: { "multipart/form-data": {} },
        }),
        "/file-only": operation("fileOnlyUpload", {
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        }),
        "/multiple-files": operation("multipleFilesUpload", {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  files: { type: "array", items: { type: "string", format: "binary" } },
                  preview: { type: "string", format: "binary" },
                },
              },
            },
          },
        }),
        "/optional/{id}": operation(
          "optionalUpload",
          {
            $ref: "#/components/requestBodies/OptionalUpload",
          },
          true,
        ),
      },
    });
    await generateService(config);
    await compileGeneratedConsumer(
      join(config.serversPath, "api"),
      `import { inlineUpload, referencedUpload, schemaRefUpload, noSchemaUpload,
        optionalNoSchemaUpload, fileOnlyUpload, multipleFilesUpload, optionalUpload } from "./uploads";
      const form = new FormData();
      const options = { timeout: 123, headers: { "X-Caller": "value" } };
      inlineUpload({ id: "record" }, form, options);
      referencedUpload(form, options);
      schemaRefUpload(form, options);
      schemaRefUpload();
      noSchemaUpload(form, options);
      optionalNoSchemaUpload(form, options);
      optionalNoSchemaUpload();
      optionalNoSchemaUpload(undefined, options);
      fileOnlyUpload(form, options);
      fileOnlyUpload();
      multipleFilesUpload(form, options);
      optionalUpload({ id: "record" }, form, options);
      optionalUpload({ id: "record" });
      optionalUpload({ id: "record" }, undefined, options);
      // @ts-expect-error params stay first, before FormData
      inlineUpload(form, { id: "record" });
      // @ts-expect-error required inline bodies cannot be omitted
      inlineUpload({ id: "record" });
      // @ts-expect-error requiredness is resolved from requestBody refs
      referencedUpload();
      // @ts-expect-error missing schemas do not remove required bodies
      noSchemaUpload();
      // @ts-expect-error optional file schema fields do not make the request body optional
      multipleFilesUpload();
      // @ts-expect-error ordinary objects are not multipart bodies
      referencedUpload({ file: new Blob(), title: "old" });
      // @ts-expect-error the old body/files/options signature is gone
      inlineUpload({ id: "record" }, { title: "old" }, new Blob(), options);
      // @ts-expect-error file-only uploads still accept FormData, not a standalone file
      fileOnlyUpload(new Blob());
      // @ts-expect-error missing schemas still require FormData instead of arbitrary objects
      noSchemaUpload({});
      // @ts-expect-error optional bodies do not accept ordinary objects
      optionalNoSchemaUpload({});
      // @ts-expect-error options remain last; skipping an optional body needs undefined
      optionalUpload({ id: "record" }, options);`,
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
    await service.查询资料({ id: encodeURIComponent("记录七") });
    expect(requests).toMatchObject([
      { url: "/资料/%E8%AE%B0%E5%BD%95%E4%B8%83", options: { method: "GET" } },
    ]);

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
    await compileGeneratedConsumer(
      join(config.serversPath, "api"),
      `import { 查询资料 } from "./中文服务";
      const model: API.中文模型 = { 编号: "记录七" };
      const response: Promise<API.中文模型> = 查询资料({ id: model.编号 });
      // @ts-expect-error Chinese model properties retain their declared type
      const invalidModel: API.中文模型 = { 编号: 7 };
      查询资料({ id: "记录七" }).then((record) => {
        const id: string = record.编号;
        // @ts-expect-error Chinese response models are typed, not any
        const invalidId: number = record.编号;
      });`,
    );
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

describe("OpenAPI 3.0 generation boundaries", () => {
  test.each([false, true])(
    "inherits parameters and generates every method (split=%s)",
    async (splitDeclare) => {
      const operation = (method: string) => ({
        operationId: method + "Boundary",
        tags: ["boundary"],
        responses: { "204": { description: "empty" } },
      });
      const config = await generationFixture(onTestFinished, {
        ...schema,
        components: { schemas: { Marker: { type: "string" } } },
        "x-sharedPath": {
          Shared: {
            parameters: [
              { name: "item-id", in: "path", required: true, schema: { type: "string" } },
              { name: "item-id", in: "header", schema: { type: "string" } },
              { name: "session", in: "query", schema: { type: "string" } },
              { name: "count", in: "query", schema: { type: "string" } },
            ],
            ...Object.fromEntries(
              ["get", "put", "post", "delete", "options", "head", "patch", "trace"].map(
                (method) => [
                  method,
                  {
                    ...operation(method),
                    parameters: [
                      { name: "count", in: "query", required: true, schema: { type: "number" } },
                      { name: "X-Token", in: "header", schema: { type: "string" } },
                      { name: "session", in: "cookie", schema: { type: "string" } },
                    ],
                  },
                ],
              ),
            ),
          },
        },
        paths: { "/boundary/{item-id}": { $ref: "#/x-sharedPath/Shared" } },
      });
      await generateService({ ...config, splitDeclare });
      const outputPath = join(config.serversPath, "api");
      const calls: [
        string,
        { method: string; params: Record<string, unknown>; headers: Record<string, string> },
      ][] = [];
      const service = await loadGenerated<
        Record<
          string,
          (params: Record<string, unknown>, options?: Record<string, unknown>) => Promise<void>
        >
      >(
        join(outputPath, "boundary.ts"),
        async (
          url: string,
          options: {
            method: string;
            params: Record<string, unknown>;
            headers: Record<string, string>;
          },
        ) => {
          calls.push([url, options]);
        },
      );
      for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
        const params = {
          "path.item-id": "a%2Fb",
          "header.item-id": "header-id",
          count: 2,
          "X-Token": "secret",
          "cookie.session": "abc",
          "query.session": "query-value",
        };
        await service[method + "Boundary"](params);
        expect(calls.at(-1)![1].headers).toEqual({
          "item-id": "header-id",
          "X-Token": "secret",
          Cookie: "session=abc",
        });
        await service[method + "Boundary"](params, {
          headers: { Authorization: "Bearer token", "X-Token": "override" },
        });
        const [url, options] = calls.at(-1)!;
        expect(url).toBe("/boundary/a%2Fb");
        expect(options.method).toBe(method.toUpperCase());
        expect(options.params).toEqual({ count: 2, session: "query-value" });
        expect(options.headers).toEqual({
          Authorization: "Bearer token",
          "X-Token": "override",
        });
      }
      await compileGeneratedConsumer(
        outputPath,
        `import { getBoundary } from './boundary'; const response: Promise<void> = getBoundary({ 'path.item-id': 'a', 'header.item-id': 'h', 'query.session': 'q', 'cookie.session': 'c', count: 2 });\n// @ts-expect-error operation parameter overrides inherited string\ngetBoundary({ 'path.item-id': 'a', count: 'wrong' });`,
      );
    },
  );

  test("selects successful JSON responses and preserves composition and literal escaping", async ({
    onTestFinished,
  }) => {
    const config = await generationFixture(onTestFinished, {
      ...schema,
      components: {
        schemas: {
          Literal: { type: "string", enum: ['quote"slash\\line\n'] },
          Flags: { type: "boolean", enum: [true, false] },
          Count: { type: "integer", enum: [0, 2] },
          NumericText: { type: "string", format: "int64" },
          NullableEnum: { type: "string", nullable: true, enum: ["only"] },
          Combined: {
            type: "object",
            required: ["own"],
            properties: { own: { type: "string" } },
            oneOf: [
              { type: "object", required: ["left"], properties: { left: { type: "number" } } },
              { type: "object", required: ["right"], properties: { right: { type: "number" } } },
            ],
          },
          Entity: {
            type: "object",
            required: ["id", "password", "name"],
            properties: {
              id: { type: "string", readOnly: true },
              password: { type: "string", writeOnly: true },
              name: { type: "string" },
              children: { type: "array", items: { $ref: "#/components/schemas/Entity" } },
            },
          },
        },
      },
      paths: {
        "/boundary": {
          post: {
            operationId: "save",
            tags: ["boundary"],
            requestBody: {
              required: true,
              content: {
                "text/plain": { schema: { type: "number" } },
                "application/problem+json": { schema: { $ref: "#/components/schemas/Entity" } },
              },
            },
            responses: {
              default: {
                description: "error",
                content: { "application/json": { schema: { type: "boolean" } } },
              },
              "202": {
                description: "accepted",
                content: {
                  "text/plain": { schema: { type: "number" } },
                  "application/problem+json": { schema: { $ref: "#/components/schemas/Entity" } },
                },
              },
              "204": { description: "empty" },
            },
          },
        },
      },
    });
    await generateService(config);
    await compileGeneratedConsumer(
      join(config.serversPath, "api"),
      `import { save } from './boundary'; const literal: API.Literal = ${JSON.stringify('quote"slash\\line\n')}; const flag: API.Flags = false; const zero: API.Count = 0; const numericText: API.NumericText = '123'; const only: API.NullableEnum = 'only';\n// @ts-expect-error enum still excludes null even when nullable extends type\nconst invalidNull: API.NullableEnum = null;\n// @ts-expect-error format must not override explicitly declared string type\nconst invalidNumber: API.NumericText = 1;\nconst combined: API.Combined = { own: 'a', left: 1 };\n// @ts-expect-error own properties must survive composition\nconst invalid: API.Combined = { left: 1 };\nconst response: Promise<API.Entity | void> = save({ password: 'p', name: 'n', children: [{ password: 'p', name: 'child' }] }); const output: API.Entity = { id: 'i', name: 'n', children: [{ id: 'c', name: 'child' }] };`,
    );
  });
});

test("non-JSON media accepts serialized payloads and requests text decoding", async ({
  onTestFinished,
}) => {
  const config = await generationFixture(onTestFinished, {
    ...schema,
    paths: {
      "/xml": {
        post: {
          operationId: "sendXml",
          tags: ["media"],
          requestBody: {
            required: true,
            content: {
              "application/xml": {
                schema: { type: "object", properties: { value: { type: "string" } } },
              },
            },
          },
          responses: {
            "200": {
              description: "XML",
              content: {
                "application/xml": {
                  schema: { type: "object", properties: { value: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
  });
  await generateService(config);
  const outputPath = join(config.serversPath, "api");
  const service = await loadGenerated<{ sendXml: (body: string) => Promise<unknown> }>(
    join(outputPath, "media.ts"),
    async (url: string, options: unknown) => ({ url, options }),
  );
  await expect(service.sendXml("<value>text</value>")).resolves.toEqual({
    url: "/xml",
    options: {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      responseType: "text",
      data: "<value>text</value>",
    },
  });
  await compileGeneratedConsumer(
    outputPath,
    `import { sendXml } from './media';
    const text: Promise<string> = sendXml('<value>text</value>');
    // @ts-expect-error text decoding must not expose an untyped or numeric response
    const invalidResponse: Promise<number> = sendXml('<value>text</value>');
    // @ts-expect-error XML must be serialized by the caller, not sent as a JSON object
    sendXml({ value: 'text' });`,
  );
});

test.each([
  { name: "without a prefix", apiPrefix: undefined, dedupeApiPrefix: true, prefix: "" },
  {
    name: "with a literal prefix",
    apiPrefix: '"/cost${notCode}/tick`/slash\\/quote\'"',
    dedupeApiPrefix: true,
    prefix: "/cost${notCode}/tick`/slash\\/quote'",
  },
  {
    name: "with a dynamic prefix expression",
    apiPrefix: JSON.stringify("/cost${notCode}/tick`/slash\\/quote'"),
    dedupeApiPrefix: false,
    prefix: "/cost${notCode}/tick`/slash\\/quote'",
  },
  {
    name: "with a substituted server prefix",
    apiPrefix: undefined,
    dedupeApiPrefix: true,
    prefix: "/cost${notCode}/tick`/slash\\/quote'",
    servers: [
      { url: "/{base}/", variables: { base: { default: "cost${notCode}/tick`/slash\\/quote'" } } },
    ],
  },
])(
  "literal path punctuation is preserved $name",
  async ({ apiPrefix, dedupeApiPrefix, prefix, servers }) => {
    const path = "/urn:lookup/cost/${amount}/tick`/slash\\/{item-id}";
    const staticPath = "/urn:lookup/cost$/tick`/slash\\/quote'\"";
    const overridePath = `${staticPath}/\${notCode}`;
    const config = await generationFixture(onTestFinished, {
      ...schema,
      servers,
      paths: {
        [path]: {
          get: {
            operationId: "literalPath",
            tags: ["literal"],
            responses: { "204": { description: "empty" } },
          },
        },
        [staticPath]: {
          get: {
            operationId: "staticPath",
            tags: ["literal"],
            responses: { "204": { description: "empty" } },
          },
        },
        "/overridden/{item-id}": {
          get: {
            operationId: "overriddenPath",
            tags: ["literal"],
            extensions: {
              "x-antTech-description": { antTechApiName: overridePath },
            },
            responses: { "204": { description: "empty" } },
          },
        },
      },
    });
    await generateService({ ...config, apiPrefix, dedupeApiPrefix });
    const outputPath = join(config.serversPath, "api");
    const service = await loadGenerated<{
      literalPath: (params: Record<string, string>) => Promise<unknown>;
      staticPath: () => Promise<unknown>;
      overriddenPath: (params: Record<string, string>) => Promise<unknown>;
    }>(join(outputPath, "literal.ts"), async (url: string) => url);
    await expect(service.literalPath({ amount: "5%2F6", "item-id": "a%2Fb" })).resolves.toBe(
      `${prefix}/urn:lookup/cost/$5%2F6/tick\`/slash\\/a%2Fb`,
    );
    await expect(service.staticPath()).resolves.toBe(`${prefix}${staticPath}`);
    await expect(service.overriddenPath({ "item-id": "unused" })).resolves.toBe(
      `${prefix}${overridePath}`,
    );
    await compileGeneratedConsumer(
      outputPath,
      `import { literalPath, staticPath } from './literal'; const empty: Promise<void> = literalPath({ amount: '5', 'item-id': 'a' }); const fixed: Promise<void> = staticPath();`,
    );
  },
);

test("original schemas with explicit Input names and reserved document names remain usable", async ({
  onTestFinished,
}) => {
  const config = await generationFixture(onTestFinished, {
    ...schema,
    components: {
      schemas: {
        Foo: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string", readOnly: true },
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/components/schemas/Foo" } },
            ["__proto__"]: { type: "string" },
          },
        },
        FooInput: { type: "string" },
      },
    },
    paths: {
      "/collision": {
        post: {
          operationId: "serializeParameters",
          tags: ["constructor"],
          parameters: [{ name: "__proto__", in: "query", schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Foo" } } },
          },
          responses: {
            "200": {
              description: "Foo",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Foo" } } },
            },
          },
        },
      },
    },
  });
  await generateService({ ...config, isCamelCase: true });
  const outputPath = join(config.serversPath, "api");
  const service = await loadGenerated<{
    serializeParameters: (params: Record<string, string>, body: unknown) => Promise<unknown>;
  }>(join(outputPath, "constructor.ts"), async (url: string, options: unknown) => ({
    url,
    options,
  }));
  await expect(
    service.serializeParameters(
      { ["__proto__"]: "wire" },
      { name: "parent", children: [{ name: "child" }] },
    ),
  ).resolves.toEqual({
    url: "/collision",
    options: {
      method: "POST",
      params: { ["__proto__"]: "wire" },
      headers: { "Content-Type": "application/json" },
      data: { name: "parent", children: [{ name: "child" }] },
    },
  });
  await compileGeneratedConsumer(
    outputPath,
    `import { serializeParameters } from './constructor'; const original: API.FooInput = 'original'; const input: API.Foo = { name: 'n', children: [{ name: 'c' }], ['__proto__']: 'field' }; const result: Promise<API.Foo> = serializeParameters({ ['__proto__']: 'wire' }, input);\n// @ts-expect-error the explicit FooInput schema remains a string, not a derived Foo model\nconst invalidOriginal: API.FooInput = input;\n// @ts-expect-error Foo retains its own object schema\nconst invalidFoo: API.Foo = original;`,
  );
});

test("semantic generation errors preserve existing service output", async ({ onTestFinished }) => {
  const config = await generationFixture(onTestFinished, serviceDocument(false));
  await generateService(config);
  const filename = join(config.serversPath, "api", "pets.ts");
  const original = await readFile(filename, "utf8");
  await expect(
    generateService({
      ...config,
      hook: {
        customType: () => {
          throw new Error("semantic type failure");
        },
      },
    }),
  ).rejects.toThrow("semantic type failure");
  expect(await readFile(filename, "utf8")).toBe(original);
});

test("original schema models retain reserved names and inherited required constraints", async ({
  onTestFinished,
}) => {
  const config = await generationFixture(onTestFinished, {
    ...schema,
    components: {
      schemas: {
        class: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
        },
        Child: {
          type: "object",
          nullable: true,
          allOf: [{ $ref: "#/components/schemas/class" }],
          required: ["id", "name"],
          properties: { extra: { type: "string" } },
        },
        NullableEnum: { type: "string", nullable: true, enum: ["yes", null] },
      },
    },
    paths: {
      "/edge": {
        post: {
          operationId: "saveInherited",
          tags: ["edge"],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Child" } } },
          },
          responses: { "204": { description: "empty" } },
        },
      },
      "/class": {
        get: {
          operationId: "readClass",
          tags: ["edge"],
          responses: {
            "200": {
              description: "reserved class",
              content: { "application/json": { schema: { $ref: "#/components/schemas/class" } } },
            },
          },
        },
      },
    },
  });
  await generateService({ ...config, enumStyle: "enum" });
  await compileGeneratedConsumer(
    join(config.serversPath, "api"),
    `import { saveInherited, readClass } from './edge'; const yes: API.NullableEnum = 'yes'; const nil: API.NullableEnum = null; saveInherited({ id: 'id', name: 'required inherited name' }); const output: Promise<API.__openAPI__class> = readClass();\n// @ts-expect-error required property defined in allOf must remain required\nsaveInherited({ id: 'id', extra: 'missing name' });\nsaveInherited(null);\nconst nullable: API.Child = null;`,
  );
});

test("normalization collisions retain distinct schemas and explicit interface declarations", async ({
  onTestFinished,
}) => {
  const response = (name: string) => ({
    "200": {
      description: name,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
    },
  });
  const config = await generationFixture(onTestFinished, {
    ...schema,
    components: {
      schemas: {
        "Foo-Bar": { type: "string", enum: ["dash"] },
        Foo_Bar: { type: "integer", enum: [7] },
        sameParams: { type: "string" },
        "a.User": { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        "b.User": { type: "object", required: ["b"], properties: { b: { type: "number" } } },
        Wrapper: {
          type: "object",
          required: ["alpha", "beta"],
          properties: {
            alpha: { $ref: "#/components/schemas/a.User" },
            beta: { $ref: "#/components/schemas/b.User" },
          },
        },
        "---": { type: "boolean" },
        NamedAdditional: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" }, optional: { type: "boolean" } },
          additionalProperties: { type: "string" },
        },
      },
    },
    paths: {
      "/dash": {
        get: {
          operationId: "readDash",
          tags: ["names"],
          parameters: [
            {
              name: "value",
              in: "query",
              required: true,
              schema: { $ref: "#/components/schemas/Foo-Bar" },
            },
          ],
          responses: response("Foo-Bar"),
        },
      },
      "/underscore": {
        get: {
          operationId: "readUnderscore",
          tags: ["names"],
          parameters: [
            {
              name: "value",
              in: "query",
              required: true,
              schema: { $ref: "#/components/schemas/Foo_Bar" },
            },
          ],
          responses: response("Foo_Bar"),
        },
      },
    },
  });
  await generateService({
    ...config,
    declareType: "interface",
    hook: {
      customTypeName: () => "same",
      customType: (value, namespace, origin) => origin(value, namespace),
    },
  });
  const outputPath = join(config.serversPath, "api");
  const program = await compileGeneratedConsumer(
    outputPath,
    `import { readDash, readUnderscore } from './names'; const dash: Promise<'dash'> = readDash({ value: 'dash' }); const underscore: Promise<7> = readUnderscore({ value: 7 }); const original: API.sameParams = 'original'; const fallback: API.Schema = true; const wrapper: API.Wrapper = { alpha: { a: 'a' }, beta: { b: 2 } }; const indexed: API.NamedAdditional = { id: 1, label: 'x' };\n// @ts-expect-error normalized schema references must retain distinct types\nreadDash({ value: 7 });\n// @ts-expect-error second normalized reference is numeric\nreadUnderscore({ value: 'dash' });\n// @ts-expect-error fixed dictionary properties retain their declared types\nconst invalidIndex: API.NamedAdditional = { id: 'wrong' };\n// @ts-expect-error nested dotted-name references must not be mixed\nconst invalidWrapper: API.Wrapper = { alpha: { b: 1 }, beta: { b: 2 } };`,
  );
  const declarations = program.getSourceFile(join(outputPath, "typings.d.ts"))!;
  const kinds = new Map<string, ts.SyntaxKind>();
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      kinds.set(node.name.text, node.kind);
    ts.forEachChild(node, visit);
  };
  visit(declarations);
  expect(kinds.get("Wrapper")).toBe(ts.SyntaxKind.InterfaceDeclaration);
  expect(kinds.get("FooBar")).toBe(ts.SyntaxKind.TypeAliasDeclaration);
});

test("non-JSON content parameters require caller-serialized strings", async ({
  onTestFinished,
}) => {
  const content = {
    "application/xml": { schema: { type: "object", properties: { value: { type: "string" } } } },
  };
  const config = await generationFixture(onTestFinished, {
    ...schema,
    paths: {
      "/content": {
        get: {
          operationId: "readContent",
          tags: ["content"],
          parameters: [
            { name: "document", in: "query", required: true, content },
            { name: "X-Document", in: "header", required: true, content },
          ],
          responses: { "204": { description: "empty" } },
        },
      },
    },
  });
  await generateService(config);
  const outputPath = join(config.serversPath, "api");
  await compileGeneratedConsumer(
    outputPath,
    `import { readContent } from './content'; readContent({ document: '<value/>', 'X-Document': '<value/>' });\n// @ts-expect-error non-JSON content must be serialized by the caller\nreadContent({ document: { value: 'x' }, 'X-Document': '<value/>' });`,
  );
});
