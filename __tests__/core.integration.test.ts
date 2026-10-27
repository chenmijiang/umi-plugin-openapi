import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestContext } from "vitest";
import { describe, expect, test } from "vitest";

import type * as Core from "../src/core";

const require = createRequire(import.meta.url);
const { getSchema } = require("umi-plugin-openapi/core") as typeof Core;
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
