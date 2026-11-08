import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import * as ts from "typescript";
import type { TestContext } from "vitest";
import { describe, expect, test } from "vitest";

import type * as Core from "../src/core";

const require = createRequire(import.meta.url);
const { getSchema, generateService } = require("umi-plugin-openapi/core") as typeof Core;
const document = {
  openapi: "3.0.3",
  info: { title: "Document boundary API", version: "1.0.0" },
  paths: {},
};

async function fixture(onTestFinished: TestContext["onTestFinished"], schema: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "openapi-document-"));
  const schemaPath = join(directory, "schema.json");
  onTestFinished(async () => {
    delete require.cache[schemaPath];
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(schemaPath, JSON.stringify(schema));
  return {
    schemaPath,
    serversPath: join(directory, "services"),
    requestLibPath: "test-request",
  };
}

async function compileConsumer(outputPath: string, consumer: string) {
  await writeFile(join(outputPath, "consumer.ts"), consumer);
  await writeFile(
    join(outputPath, "request.d.ts"),
    `
    declare module "test-request" {
      export default function request<T>(url: string, options: Record<string, unknown>): Promise<T>;
    }
  `,
  );
  const program = ts.createProgram({
    rootNames: (await readdir(outputPath))
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
  expect(
    ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), {
      getCanonicalFileName: (filename) => filename,
      getCurrentDirectory: () => outputPath,
      getNewLine: () => "\n",
    }),
  ).toBe("");
}

async function serve(onTestFinished: TestContext["onTestFinished"], listener: RequestListener) {
  const server = createServer(listener);
  onTestFinished(async () => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
    await promise;
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("published core document boundary", () => {
  test("loads and reloads local JSON relative to the caller's cwd", async ({ onTestFinished }) => {
    const config = await fixture(onTestFinished, document);
    const schemaPath = relative(process.cwd(), config.schemaPath);
    await expect(getSchema(schemaPath)).resolves.toEqual(document);
    const updated = { ...document, info: { ...document.info, version: "2.0.0" } };
    await writeFile(config.schemaPath, JSON.stringify(updated));
    await expect(getSchema(schemaPath)).resolves.toEqual(updated);
    await generateService({ ...config, schemaPath });
    expect(await readdir(join(config.serversPath, "api"))).toEqual(
      expect.arrayContaining(["index.ts", "typings.d.ts"]),
    );
  });

  test("does not treat non-HTTP protocols beginning with http as remote schemas", async () => {
    await expect(getSchema("httpx://invalid.example/schema.json")).rejects.toThrow();
  });

  test("rejects JavaScript schema files without executing their contents", async ({
    onTestFinished,
  }) => {
    const config = await fixture(onTestFinished, document);
    const directory = join(config.schemaPath, "..");
    const schemaPath = join(directory, "schema.js");
    const markerPath = join(directory, "executed.txt");
    await writeFile(
      schemaPath,
      `
      require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");
      module.exports = ${JSON.stringify(document)};
    `,
    );

    await expect(getSchema(schemaPath)).rejects.toThrow();
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("returns null for a non-2xx root document and rejects generation without replacing output", async ({
    onTestFinished,
  }) => {
    const server = createServer((_request, response) => {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify(document));
    });
    onTestFinished(async () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
      await promise;
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Schema server did not bind a TCP port");
    }
    const schemaPath = `http://127.0.0.1:${address.port}/schema.json`;
    const config = await fixture(onTestFinished, document);
    const outputPath = join(config.serversPath, "api");
    await mkdir(outputPath, { recursive: true });
    const existingOutput = "export const existing = true;\n";
    await writeFile(join(outputPath, "existing.ts"), existingOutput);

    await expect(getSchema(schemaPath)).resolves.toBeNull();
    await expect(generateService({ ...config, schemaPath })).rejects.toThrow();
    expect(await readdir(outputPath)).toEqual(["existing.ts"]);
    expect(await readFile(join(outputPath, "existing.ts"), "utf8")).toBe(existingOutput);
  });

  for (const openapi of ["3.0.0", "3.0.99"]) {
    test(`accepts OpenAPI ${openapi} with empty paths`, async ({ onTestFinished }) => {
      const config = await fixture(onTestFinished, { ...document, openapi });
      await generateService(config);
      expect(await readdir(join(config.serversPath, "api"))).toEqual(
        expect.arrayContaining(["index.ts", "typings.d.ts"]),
      );
    });
  }

  const withoutVersion = { info: document.info, paths: document.paths };
  const invalidDocuments: [string, unknown][] = [
    ["null document", null],
    ["array document", []],
    ["string document", "not an API document"],
    ["missing format version", withoutVersion],
    ["OpenAPI 3.1", { ...document, openapi: "3.1.0" }],
    ["OpenAPI 2", { ...document, openapi: "2.0" }],
    ["non-string OpenAPI version", { ...document, openapi: 3 }],
    ["incomplete OpenAPI version", { ...document, openapi: "3.0" }],
    ["OpenAPI prerelease", { ...document, openapi: "3.0.3-rc.1" }],
    ["OpenAPI patch with leading zero", { ...document, openapi: "3.0.03" }],
    ["Swagger 1.2", { ...withoutVersion, swagger: "1.2" }],
    ["Swagger 3", { ...withoutVersion, swagger: "3.0" }],
    ["empty Swagger version", { ...withoutVersion, swagger: "" }],
    ["conflicting document versions", { ...document, swagger: "2.0" }],
    ["missing info", { openapi: "3.0.3", paths: {} }],
    ["null info", { ...document, info: null }],
    ["array info", { ...document, info: [] }],
    ["missing info title", { ...document, info: { version: "1" } }],
    ["non-string info title", { ...document, info: { title: 7, version: "1" } }],
    ["missing info version", { ...document, info: { title: "API" } }],
    ["non-string info version", { ...document, info: { title: "API", version: 1 } }],
    ["missing paths", { openapi: "3.0.3", info: document.info }],
    ["null paths", { ...document, paths: null }],
    ["array paths", { ...document, paths: [] }],
    ["string paths", { ...document, paths: "paths" }],
  ];

  for (const [name, schema] of invalidDocuments) {
    test(`rejects ${name} without changing existing output`, async ({ onTestFinished }) => {
      const config = await fixture(onTestFinished, schema);
      const outputPath = join(config.serversPath, "api");
      await mkdir(outputPath, { recursive: true });
      const existingOutput = "export const existing = true;\n";
      await writeFile(join(outputPath, "existing.ts"), existingOutput);

      await expect(generateService(config)).rejects.toThrow();
      expect(await readdir(outputPath)).toEqual(["existing.ts"]);
      expect(await readFile(join(outputPath, "existing.ts"), "utf8")).toBe(existingOutput);
    });
  }

  test("converts Swagger 2.0 and generates its operation and response type", async ({
    onTestFinished,
  }) => {
    const config = await fixture(onTestFinished, {
      swagger: "2.0",
      info: document.info,
      produces: ["application/json"],
      definitions: { Pet: { type: "object", properties: { name: { type: "string" } } } },
      paths: {
        "/pets": {
          get: {
            tags: ["pets"],
            operationId: "listPets",
            responses: {
              "200": { description: "Pets", schema: { $ref: "#/definitions/Pet" } },
            },
          },
        },
      },
    });
    await generateService(config);
    const outputPath = join(config.serversPath, "api");
    await compileConsumer(
      outputPath,
      `
      import { listPets } from "./pets";
      async function consume() {
        const pet = await listPets();
        const name: string | undefined = pet.name;
        // @ts-expect-error the converted response property is not numeric
        const invalid: number = pet.name;
        void [name, invalid];
      }
      void consume;
    `,
    );
  });
});

describe("published core reference documents", () => {
  test("resolves relative schema references against the redirected root document URL", async ({
    onTestFinished,
  }) => {
    const requests: (string | undefined)[] = [];
    const baseURL = await serve(onTestFinished, (request, response) => {
      requests.push(request.url);
      if (request.url === "/openapi") {
        response.writeHead(302, { Location: "/v1/openapi.json" });
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/openapi.json") {
        response.end(
          JSON.stringify({
            ...document,
            paths: {
              "/pets": {
                get: {
                  tags: ["pets"],
                  operationId: "getPet",
                  responses: {
                    "200": {
                      description: "Pet",
                      content: { "application/json": { schema: { $ref: "./models.json" } } },
                    },
                  },
                },
              },
            },
          }),
        );
      } else if (request.url === "/v1/models.json") {
        response.end(JSON.stringify({ type: "string" }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    const config = await fixture(onTestFinished, document);
    await generateService({ ...config, schemaPath: `${baseURL}/openapi` });
    expect(requests).toEqual(["/openapi", "/v1/openapi.json", "/v1/models.json"]);
    await compileConsumer(
      join(config.serversPath, "api"),
      `
      import { getPet } from "./pets";
      async function consume() {
        const pet: string = await getPet();
        // @ts-expect-error redirected references retain the response type
        const invalid: number = await getPet();
        void [pet, invalid];
      }
      void consume;
    `,
    );
  });

  test("resolves nested references against a redirected external document URL", async ({
    onTestFinished,
  }) => {
    const requests: (string | undefined)[] = [];
    const baseURL = await serve(onTestFinished, (request, response) => {
      requests.push(request.url);
      if (request.url === "/parts/alias.json") {
        response.writeHead(302, { Location: "/v2/path.json" });
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/schema.json") {
        response.end(
          JSON.stringify({ ...document, paths: { "/pets": { $ref: "./parts/alias.json" } } }),
        );
      } else if (request.url === "/v2/path.json") {
        response.end(
          JSON.stringify({
            get: {
              tags: ["pets"],
              operationId: "getPet",
              responses: {
                "200": {
                  description: "Pet",
                  content: { "application/json": { schema: { $ref: "./models.json" } } },
                },
              },
            },
          }),
        );
      } else if (request.url === "/v2/models.json") {
        response.end(JSON.stringify({ type: "string" }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    const config = await fixture(onTestFinished, document);
    await generateService({ ...config, schemaPath: `${baseURL}/schema.json` });
    expect(requests).toEqual([
      "/schema.json",
      "/parts/alias.json",
      "/v2/path.json",
      "/v2/models.json",
    ]);
    await compileConsumer(
      join(config.serversPath, "api"),
      `
      import { getPet } from "./pets";
      async function consume() {
        const pet: string = await getPet();
        // @ts-expect-error redirected external references retain the response type
        const invalid: number = await getPet();
        void [pet, invalid];
      }
      void consume;
    `,
    );
  });

  test("does not forward authorization across redirects or to references on the redirected origin", async ({
    onTestFinished,
  }) => {
    const requests: {
      origin: string;
      path: string | undefined;
      authorization: string | undefined;
    }[] = [];
    const externalURL = await serve(onTestFinished, (request, response) => {
      requests.push({
        origin: "external",
        path: request.url,
        authorization: request.headers.authorization,
      });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/openapi.json") {
        response.end(
          JSON.stringify({
            ...document,
            paths: {
              "/pets": {
                get: {
                  tags: ["pets"],
                  operationId: "getPet",
                  responses: {
                    "200": {
                      description: "Pet",
                      content: { "application/json": { schema: { $ref: "./models.json" } } },
                    },
                  },
                },
              },
            },
          }),
        );
      } else if (request.url === "/v1/models.json") {
        response.end(JSON.stringify({ type: "string" }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    const originURL = await serve(onTestFinished, (request, response) => {
      requests.push({
        origin: "original",
        path: request.url,
        authorization: request.headers.authorization,
      });
      response.writeHead(302, { Location: `${externalURL}/v1/openapi.json` });
      response.end();
    });
    const config = await fixture(onTestFinished, document);
    await generateService({
      ...config,
      schemaPath: `${originURL}/openapi`,
      authorization: "Bearer private",
    });
    expect(requests).toEqual([
      { origin: "original", path: "/openapi", authorization: "Bearer private" },
      { origin: "external", path: "/v1/openapi.json", authorization: undefined },
      { origin: "external", path: "/v1/models.json", authorization: undefined },
    ]);
  });

  for (const referenced of [true, false]) {
    test(`accepts ${referenced ? "referenced" : "unused"} component callbacks with object recursion`, async ({
      onTestFinished,
    }) => {
      const config = await fixture(onTestFinished, {
        ...document,
        components: {
          callbacks: {
            Event: {
              "{$request.body#/callbackUrl}": {
                post: {
                  callbacks: { again: { $ref: "#/components/callbacks/Event" } },
                  responses: { "204": { description: "Accepted" } },
                },
              },
            },
          },
        },
        paths: {
          "/pets": {
            post: {
              tags: ["pets"],
              operationId: "createPet",
              ...(referenced
                ? { callbacks: { event: { $ref: "#/components/callbacks/Event" } } }
                : {}),
              responses: {
                "200": {
                  description: "Pet",
                  content: { "application/json": { schema: { type: "string" } } },
                },
              },
            },
          },
        },
      });
      await generateService(config);
      await compileConsumer(
        join(config.serversPath, "api"),
        `
        import { createPet } from "./pets";
        async function consume() {
          const pet: string = await createPet();
          // @ts-expect-error callback recursion must not erase the operation response type
          const invalid: number = await createPet();
          void [pet, invalid];
        }
        void consume;
      `,
      );
    });
  }

  test("rejects callback alias cycles without replacing output", async ({ onTestFinished }) => {
    const config = await fixture(onTestFinished, {
      ...document,
      components: {
        callbacks: {
          A: { $ref: "#/components/callbacks/B" },
          B: { $ref: "#/components/callbacks/A" },
        },
      },
      paths: {
        "/pets": {
          post: {
            tags: ["pets"],
            operationId: "createPet",
            callbacks: { event: { $ref: "#/components/callbacks/A" } },
            responses: { "204": { description: "Accepted" } },
          },
        },
      },
    });
    const outputPath = join(config.serversPath, "api");
    await mkdir(outputPath, { recursive: true });
    const existingOutput = "export const existing = true;\n";
    await writeFile(join(outputPath, "existing.ts"), existingOutput);
    await expect(generateService(config)).rejects.toThrow();
    expect(await readdir(outputPath)).toEqual(["existing.ts"]);
    expect(await readFile(join(outputPath, "existing.ts"), "utf8")).toBe(existingOutput);
  });

  test("resolves document-relative structural references and recursive escaped schema pointers", async ({
    onTestFinished,
  }) => {
    const config = await fixture(onTestFinished, {
      ...document,
      components: {
        schemas: { Node: { type: "string" }, OpenAPIExternalReference1: { type: "string" } },
      },
      paths: {
        "/pets": { $ref: "./parts/path.json#/pet" },
        "/local": {
          get: {
            tags: ["pets"],
            operationId: "getLocal",
            responses: {
              "200": {
                description: "Local schema",
                content: { "application/json": { schema: { $ref: "#/x-schema" } } },
              },
            },
          },
        },
      },
      "x-schema": { type: "string" },
      "x-payload": { $ref: "./must-not-load.json" },
    });
    const directory = join(config.schemaPath, "..");
    await mkdir(join(directory, "parts"));
    await writeFile(
      join(directory, "parts/path.json"),
      JSON.stringify({
        pet: {
          post: {
            tags: ["pets"],
            operationId: "createPet",
            parameters: [{ $ref: "../objects.json#/parameter", name: "ignoredSibling" }],
            requestBody: { $ref: "../objects.json#/body" },
            responses: { "200": { $ref: "../objects.json#/response" } },
            callbacks: {
              notification: {
                "{$request.body#/callbackUrl}": { $ref: "../objects.json#/callback" },
              },
            },
          },
        },
      }),
    );
    await writeFile(
      join(directory, "objects.json"),
      JSON.stringify({
        parameter: { name: "id", in: "query", schema: { type: "string" } },
        body: { content: { "application/json": { schema: { $ref: "./schemas.json#/A~1B~0C" } } } },
        response: {
          description: "Pet",
          content: {
            "application/json": {
              schema: { $ref: "./schemas.json#/A~1B~0C", type: "number" },
              examples: { sample: { value: { $ref: "./must-not-load.json" } } },
            },
          },
          links: {
            next: {
              operationId: "createPet",
              parameters: { id: { $ref: "./must-not-load.json" } },
            },
          },
        },
        callback: { post: { responses: { "204": { description: "Accepted" } } } },
      }),
    );
    await writeFile(
      join(directory, "schemas.json"),
      JSON.stringify({
        "A/B~C": {
          type: "object",
          required: ["name"],
          discriminator: { propertyName: "name", mapping: { node: "#/A~1B~0C" } },
          properties: {
            name: { type: "string" },
            child: { $ref: "#/A~1B~0C" },
            tags: { type: "array", items: { $ref: "#/tag" } },
          },
          example: { $ref: "./must-not-load.json" },
          default: { $ref: "./must-not-load.json" },
          "x-payload": { $ref: "./must-not-load.json" },
        },
        tag: { type: "string" },
      }),
    );

    await generateService(config);
    const outputPath = join(config.serversPath, "api");
    await compileConsumer(
      outputPath,
      `
      import { createPet, getLocal } from "./pets";
      type Pet = Awaited<ReturnType<typeof createPet>>;
      const pet: Pet = { name: "parent", child: { name: "child" }, tags: ["tag"] };
      // @ts-expect-error referenced schema must retain its string property
      const invalid: Pet = { name: 7 };
      const existingComponent: API.OpenAPIExternalReference1 = "not overwritten";
      async function consume() {
        const result: Pet = await createPet({ id: "pet-7" }, pet);
        // @ts-expect-error the referenced parameter retains its string type
        await createPet({ id: 7 }, pet);
        // @ts-expect-error Reference Object siblings must not become parameters
        await createPet({ ignoredSibling: "ignored" }, pet);
        const local: string = await getLocal();
        // @ts-expect-error internal schemas outside components retain their type
        const invalidLocal: number = await getLocal();
        void [result, local, invalidLocal];
      }
      void [pet, invalid, existingComponent, consume];
    `,
    );
  });

  test("resolves HTTP document bases and never forwards authorization to another origin", async ({
    onTestFinished,
  }) => {
    const requests: { path: string | undefined; authorization: string | undefined }[] = [];
    const external = createServer((request, response) => {
      requests.push({ path: request.url, authorization: request.headers.authorization });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ type: "string" }));
    });
    const origin = createServer((request, response) => {
      requests.push({ path: request.url, authorization: request.headers.authorization });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/api/schema.json"
            ? {
                ...document,
                paths: { "/pets": { $ref: "./parts/path.json" } },
              }
            : {
                get: {
                  tags: ["pets"],
                  operationId: "getPet",
                  responses: {
                    "200": {
                      description: "Pet",
                      content: { "application/json": { schema: { $ref: externalURL } } },
                    },
                  },
                },
              },
        ),
      );
    });
    onTestFinished(async () => {
      for (const server of [origin, external]) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
        await promise;
      }
    });
    await once(external.listen(0, "127.0.0.1"), "listening");
    await once(origin.listen(0, "127.0.0.1"), "listening");
    const externalAddress = external.address();
    const originAddress = origin.address();
    if (
      !externalAddress ||
      typeof externalAddress === "string" ||
      !originAddress ||
      typeof originAddress === "string"
    ) {
      throw new Error("Reference servers did not bind TCP ports");
    }
    const externalURL = `http://127.0.0.1:${externalAddress.port}/schema.json`;
    const config = await fixture(onTestFinished, document);
    await generateService({
      ...config,
      schemaPath: `http://127.0.0.1:${originAddress.port}/api/schema.json`,
      authorization: "Bearer private",
    });
    expect(requests).toEqual([
      { path: "/api/schema.json", authorization: "Bearer private" },
      { path: "/api/parts/path.json", authorization: "Bearer private" },
      { path: "/schema.json", authorization: undefined },
    ]);
    await compileConsumer(
      join(config.serversPath, "api"),
      `
      import { getPet } from "./pets";
      async function consume() {
        const pet: string = await getPet();
        // @ts-expect-error the HTTP-referenced response is not numeric
        const invalid: number = await getPet();
        void [pet, invalid];
      }
      void consume;
    `,
    );
  });

  test("rejects non-2xx referenced documents even when their body is a valid schema without replacing output", async ({
    onTestFinished,
  }) => {
    const requests: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ type: "string" }));
    });
    onTestFinished(async () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
      await promise;
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Reference server did not bind a TCP port");
    }
    const config = await fixture(onTestFinished, {
      ...document,
      paths: {
        "/pets": {
          get: {
            tags: ["pets"],
            operationId: "getPet",
            responses: {
              "200": {
                description: "Pet",
                content: {
                  "application/json": {
                    schema: { $ref: `http://127.0.0.1:${address.port}/schema.json` },
                  },
                },
              },
            },
          },
        },
      },
    });
    const outputPath = join(config.serversPath, "api");
    await mkdir(outputPath, { recursive: true });
    const existingOutput = "export const existing = true;\n";
    await writeFile(join(outputPath, "existing.ts"), existingOutput);

    await expect(generateService(config)).rejects.toThrow();
    expect(requests).toEqual(["/schema.json"]);
    expect(await readdir(outputPath)).toEqual(["existing.ts"]);
    expect(await readFile(join(outputPath, "existing.ts"), "utf8")).toBe(existingOutput);
  });

  for (const root of ["remote", "local"]) {
    test(`rejects file URL references reached through HTTP from a ${root} root without replacing output`, async ({
      onTestFinished,
    }) => {
      const config = await fixture(onTestFinished, document);
      const secretPath = join(config.schemaPath, "..", "secret.json");
      await writeFile(secretPath, JSON.stringify({ type: "string" }));
      const remoteDocument = {
        ...document,
        components: { schemas: { Secret: { $ref: pathToFileURL(secretPath).href } } },
        paths: {
          "/pets": {
            get: {
              tags: ["pets"],
              operationId: "getPet",
              responses: {
                "200": {
                  description: "Pet",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Secret" },
                    },
                  },
                },
              },
            },
          },
        },
      };
      const requests: (string | undefined)[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(remoteDocument));
      });
      onTestFinished(async () => {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
        await promise;
      });
      await once(server.listen(0, "127.0.0.1"), "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Reference server did not bind a TCP port");
      }
      const remoteURL = `http://127.0.0.1:${address.port}/schema.json`;
      await writeFile(
        config.schemaPath,
        JSON.stringify({
          ...document,
          paths: {
            "/pets": {
              get: {
                tags: ["pets"],
                operationId: "getPet",
                responses: {
                  "200": {
                    description: "Pet",
                    content: {
                      "application/json": {
                        schema: { $ref: `${remoteURL}#/components/schemas/Secret` },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );
      const outputPath = join(config.serversPath, "api");
      await mkdir(outputPath, { recursive: true });
      const existingOutput = "export const existing = true;\n";
      await writeFile(join(outputPath, "existing.ts"), existingOutput);

      await expect(
        generateService({
          ...config,
          schemaPath: root === "remote" ? remoteURL : config.schemaPath,
        }),
      ).rejects.toThrow();
      expect(requests).toEqual(["/schema.json"]);
      expect(await readdir(outputPath)).toEqual(["existing.ts"]);
      expect(await readFile(join(outputPath, "existing.ts"), "utf8")).toBe(existingOutput);
    });
  }

  test("allows a local root to reference a local file URL", async ({ onTestFinished }) => {
    const config = await fixture(onTestFinished, document);
    const referencedPath = join(config.schemaPath, "..", "referenced.json");
    await writeFile(referencedPath, JSON.stringify({ type: "string" }));
    await writeFile(
      config.schemaPath,
      JSON.stringify({
        ...document,
        paths: {
          "/pets": {
            get: {
              tags: ["pets"],
              operationId: "getPet",
              responses: {
                "200": {
                  description: "Pet",
                  content: {
                    "application/json": {
                      schema: { $ref: pathToFileURL(referencedPath).href },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    await generateService(config);
    await compileConsumer(
      join(config.serversPath, "api"),
      `
      import { getPet } from "./pets";
      async function consume() {
        const pet: string = await getPet();
        // @ts-expect-error a local file URL retains the referenced response type
        const invalid: number = await getPet();
        void [pet, invalid];
      }
      void consume;
    `,
    );
  });

  test("rejects schema alias cycles without replacing output", async ({ onTestFinished }) => {
    const config = await fixture(onTestFinished, {
      ...document,
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { $ref: "#/components/schemas/A" },
        },
      },
      paths: {
        "/pets": {
          get: {
            tags: ["pets"],
            operationId: "getPet",
            responses: {
              "200": {
                description: "Pet",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/A" },
                  },
                },
              },
            },
          },
        },
      },
    });
    const outputPath = join(config.serversPath, "api");
    await mkdir(outputPath, { recursive: true });
    const existingOutput = "export const existing = true;\n";
    await writeFile(join(outputPath, "existing.ts"), existingOutput);

    await expect(generateService(config)).rejects.toThrow();
    expect(await readdir(outputPath)).toEqual(["existing.ts"]);
    expect(await readFile(join(outputPath, "existing.ts"), "utf8")).toBe(existingOutput);
  });

  for (const ref of ["./missing.json#/Pet", "#/components/schemas/Missing"]) {
    for (const kind of ["schema reference", "discriminator mapping"]) {
      test(`rejects unresolved ${kind} ${ref} before replacing output`, async ({
        onTestFinished,
      }) => {
        const schema =
          kind === "schema reference"
            ? { $ref: ref }
            : {
                type: "object",
                properties: { kind: { type: "string" } },
                discriminator: { propertyName: "kind", mapping: { missing: ref } },
              };
        const config = await fixture(onTestFinished, {
          ...document,
          paths: {
            "/pets": {
              get: {
                tags: ["pets"],
                operationId: "getPet",
                responses: {
                  "200": { description: "Pet", content: { "application/json": { schema } } },
                },
              },
            },
          },
        });
        const outputPath = join(config.serversPath, "api");
        await mkdir(outputPath, { recursive: true });
        await writeFile(join(outputPath, "existing.ts"), "keep existing output");
        await expect(generateService(config)).rejects.toThrow();
        expect(await readFile(join(outputPath, "existing.ts"), "utf8")).toBe(
          "keep existing output",
        );
        expect(await readdir(outputPath)).toEqual(["existing.ts"]);
      });
    }
  }
});
