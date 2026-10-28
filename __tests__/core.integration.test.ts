import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { transform } from "esbuild";
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

type GeneratedPetService = {
  getPet: (
    params: { id: string; search: string },
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
};

describe("published core service generation", () => {
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

  test("resolves parameter and response refs while preserving naming and request-option hooks", async ({
    onTestFinished,
  }) => {
    const document = serviceDocument(false);
    const operation = document.paths["/pets/{id}"].get;
    const config = await generationFixture(onTestFinished, {
      ...document,
      components: {
        schemas: { Pet: petSchema },
        parameters: { PetId: operation.parameters[0] },
        responses: { PetResponse: operation.responses["200"] },
      },
      paths: {
        "/pets/{id}": {
          get: {
            ...operation,
            parameters: [{ $ref: "#/components/parameters/PetId" }, operation.parameters[1]],
            responses: { "200": { $ref: "#/components/responses/PetResponse" } },
          },
        },
      },
    });
    await generateService({
      ...config,
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
    const declaration = await readFile(join(config.serversPath, "api", "typings.d.ts"), "utf8");
    expect(declaration).toMatch(/type Pet\s*=\s*\{[\s\S]*id:\s*string;[\s\S]*name:\s*string;/);
  });
});
