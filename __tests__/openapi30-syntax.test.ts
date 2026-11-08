import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { transform } from "esbuild";
import * as ts from "typescript";
import type { TestContext } from "vitest";
import { describe, expect, test } from "vitest";

import type * as Core from "../src/core";

const require = createRequire(import.meta.url);
const { generateService } = require("umi-plugin-openapi/core") as typeof Core;
const fixturePath = fileURLToPath(new URL("./fixtures/openapi30-complete.json", import.meta.url));

/* OpenAPI 3.0.3 syntax inventory (JSON pointers into the fixture):
 * Document, Info, Contact, License, Server/Variable, ExternalDocs, Tag:
 *   /openapi, /info, /servers/0, /externalDocs, /tags/0.
 * Paths, Path Item ($ref, summary, description, servers, parameters, eight methods):
 *   /paths, /paths/~1items~1{id}, /paths/~1alias -> /x-reusable-path.
 * Operation (tags, summary, description, externalDocs, operationId, parameters,
 *   requestBody, responses, callbacks, deprecated, security, servers):
 *   /paths/~1items~1{id}/get, post, put.
 * Parameter (name, in, description, required, deprecated, allowEmptyValue,
 *   style, explode, allowReserved, schema/content, example/examples):
 *   /paths/~1items~1{id}/get/parameters, /paths/~1styled~1{label}~1{matrix}~1{simple}.
 *   All seven styles: form/spaceDelimited/pipeDelimited/deepObject there;
 *   label/matrix/simple in /styled. All four locations: path/query/header/cookie.
 * RequestBody, MediaType, Encoding (contentType, headers, style, explode,
 *   allowReserved): /components/requestBodies/ItemBody, /paths/~1upload,
 *   /paths/~1form. MediaType schema/example/examples/encoding all occur.
 * Responses (status, range, default), Response, Header:
 *   /paths/~1items~1{id}/get/responses, /components/responses/ItemResponse,
 *   /components/headers/ETag. HEAD intentionally has no response body.
 * Example (summary, description, value/externalValue): /components/examples.
 * Link (operationRef/operationId, parameters, requestBody, description, server),
 *   runtime expressions, Callback: /components/links/ReadAgain,
 *   /components/responses/ItemResponse/links/operationReference,
 *   /components/callbacks/OnChange. These are retained metadata, not execution.
 * All nine Components maps and Reference Objects: /components; references
 *   appear in schemas/responses/parameters/examples/requestBodies/headers/links/
 *   callbacks and /paths/~1alias. Reference Objects have no ignored siblings.
 * Schema annotations/type/format/required/properties/additionalProperties,
 *   nullable/default/example/deprecated/readOnly/writeOnly: /components/schemas/Item.
 * Schema numeric/string/array/object constraints, enum, not, formats:
 *   /components/schemas/Constraints (all numeric/string/array constraints),
 *   /components/schemas/Item (minProperties/maxProperties/additionalProperties:false).
 * items/ref, allOf, oneOf/discriminator/mapping, anyOf:
 *   /components/schemas/ItemList, Combined, Pet, SearchResult.
 * XML (name, namespace, prefix, attribute, wrapped), schema externalDocs:
 *   /components/schemas/Item and /components/schemas/Constraints/properties.
 * SecurityScheme (apiKey locations, HTTP basic/bearer/bearerFormat, oauth2,
 *   openIdConnect), OAuthFlows (all four) and OAuthFlow URLs/scopes:
 *   /components/securitySchemes. Security Requirement OR/AND/anonymous:
 *   /security; operation replacement/disable: /paths/~1items~1{id}/post and get.
 * Specification extensions: /x-fixture-purpose, /info/x-audience,
 *   /components/x-component-owner, /paths/x-purpose, get/x-client-note.
 * Deliberate boundary: constraints, XML, auth flows, callbacks, links and examples
 *   are descriptive input, NOT runtime validation/auth/notification/XML encoding.
 */

async function generateFixture(onTestFinished: TestContext["onTestFinished"]) {
  const directory = await mkdtemp(join(tmpdir(), "openapi30-syntax-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await generateService({
    schemaPath: fixturePath,
    serversPath: directory,
    projectName: "api",
    requestLibPath: "test-request",
    formatter: "none",
  });
  return join(directory, "api");
}

async function compileConsumer(outputPath: string) {
  await writeFile(
    join(outputPath, "request.d.ts"),
    `declare module "test-request" {
    export default function request<T>(url: string, options: Record<string, unknown>): Promise<T>;
  }`,
  );
  await writeFile(
    join(outputPath, "consumer.ts"),
    `import * as syntax from "./syntax";
    const pet: API.Pet = { kind: "cat", lives: 9 };
    function describePet(pet: API.Pet): string {
      return pet.kind === "cat" ? pet.lives.toFixed() : String(pet.barks);
    }
    // @ts-expect-error discriminator branches must carry the matching payload
    const invalidPet: API.Pet = { kind: "cat", barks: true };
    const constraints: API.Constraints = { score: 4.5, labels: ["red"], optionalChoice: null,
      dictionary: { key: "value" }, free: { anything: 1 } };
    // @ts-expect-error schema enums must not collapse to unconstrained string
    const invalidLabels: API.Constraints = { labels: ["green"] };
    // @ts-expect-error additionalProperties retains its value type
    const invalidDictionary: API.Constraints = { dictionary: { key: 1 } };
    const result: API.SearchResult = { message: "not found" };
    const list: API.ItemList = [{ id: "item-7", name: "Milo", secret: "token" }];
    // @ts-expect-error array references retain the referenced property types
    const invalidList: API.ItemList = [{ id: 7, name: "Milo", secret: "token" }];
    const read = syntax.readItem({ id: "item-7", locale: "en" });
    const written = syntax.replaceItem({ id: "item-7", locale: "en" },
      { name: "Milo", secret: "token", nickname: null });
    syntax.headItem({ id: "item-7", locale: "en" });
    syntax.optionsItem({ id: "item-7", locale: "en" });
    syntax.deleteItem({ id: "item-7", locale: "en" });
    syntax.traceItem({ id: "item-7", locale: "en" });
    syntax.patchItem({ id: "item-7", locale: "en" }, { nickname: "new" });
    syntax.createItem({ id: "item-7", locale: "en" }, { name: "Milo", secret: "token" });
    syntax.styledPath({ label: ["a", "b"], matrix: { role: "admin" }, simple: [1, 2] });
    syntax.submitForm({ names: ["a", "b"], note: "hello world" });
    syntax.readAlias();
    read.then(item => {
      if (item !== undefined) {
        const id: string = item.id;
        const name: string = item.name;
        // @ts-expect-error response-direction models omit writeOnly fields
        item.secret;
      }
    });
    // @ts-expect-error inherited path parameters remain required
    syntax.readItem({ locale: "en" });
    // @ts-expect-error operation-level parameters override inherited optionality
    syntax.readItem({ id: "item-7" });
    // @ts-expect-error request-direction required writeOnly secret must be supplied
    syntax.replaceItem({ id: "item-7", locale: "en" }, { name: "Milo" });
  `,
  );
  const program = ts.createProgram({
    rootNames: (await readdir(outputPath, { recursive: true }))
      .filter((filename) => filename.endsWith(".ts"))
      .map((filename) => join(outputPath, filename)),
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

type RequestCall = { url: string; options: Record<string, unknown> };

async function loadClient(outputPath: string, calls: RequestCall[]) {
  const filename = join(outputPath, "syntax.ts");
  const { code } = await transform(await readFile(filename, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2022",
    sourcefile: filename,
  });
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    URLSearchParams,
    FormData,
    Blob,
    require(name: string) {
      if (name !== "test-request") throw new Error(`Unexpected client dependency: ${name}`);
      return async (url: string, options: Record<string, unknown>) => {
        calls.push({ url, options });
        return { id: "item-7", name: "Milo" };
      };
    },
  });
  // The module was generated in-process; this is its request-boundary test seam.
  return module.exports as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

describe("OpenAPI 3.0 client behavior beside descriptive syntax", () => {
  test("a strict TypeScript consumer uses generated methods, refs, unions, enums and directional models", async ({
    onTestFinished,
  }) => {
    await compileConsumer(await generateFixture(onTestFinished));
  });

  test("ordinary clients still send inherited parameters, styles, JSON and form bodies beside descriptive features", async ({
    onTestFinished,
  }) => {
    const calls: RequestCall[] = [];
    const client = await loadClient(await generateFixture(onTestFinished), calls);
    await client.readItem({ id: "item/7", locale: "en" }, { timeout: 123 });
    expect(calls[0]).toMatchObject({
      url: "https://read.example.com/items/item%2F7",
      options: { method: "GET", params: { locale: "en" }, timeout: 123 },
    });
    await client.replaceItem({ id: "item-7", locale: "en" }, { name: "Milo", secret: "token" });
    expect(calls[1]).toMatchObject({
      url: "https://items.example.com/items/item-7",
      options: {
        method: "PUT",
        params: { locale: "en" },
        data: { name: "Milo", secret: "token" },
        headers: { "Content-Type": "application/json" },
      },
    });
    await client.styledPath({ label: ["a", "b"], matrix: { role: "admin" }, simple: [1, 2] });
    expect(calls[2].url).toBe("https://eu.example.com/v1/styled/.a.b/;role=admin/1,2");
    await client.submitForm({ names: ["a", "b"], note: "hello world" });
    expect(calls[3].url).toBe("https://eu.example.com/v1/form");
    expect(calls[3].options.method).toBe("POST");
    expect(new URLSearchParams(String(calls[3].options.data)).get("names")).toBe("a,b");
    expect(new URLSearchParams(String(calls[3].options.data)).get("note")).toBe("hello world");
    for (const [operation, method] of [
      ["headItem", "HEAD"],
      ["optionsItem", "OPTIONS"],
      ["deleteItem", "DELETE"],
      ["traceItem", "TRACE"],
    ]) {
      await client[operation]({ id: "item-7", locale: "en" });
      expect(calls.at(-1)).toMatchObject({
        url: "https://items.example.com/items/item-7",
        options: { method },
      });
    }
    await client.readAlias();
    expect(calls.at(-1)).toMatchObject({
      url: "https://eu.example.com/v1/alias",
      options: { method: "GET" },
    });
    await client.readItem(
      {
        id: "item-7",
        locale: "en",
        q: "a/b",
        colors: ["red", "blue"],
        spaces: ["a", "b"],
        pipes: ["x", "y"],
        filter: { name: "Milo" },
        "X-Trace": ["one", "two"],
        session: "cookie",
        json: { active: true },
      },
      { headers: { Authorization: "Bearer supplied-by-caller" } },
    );
    const styledRequest = calls.at(-1)!;
    const query = new URL(styledRequest.url).searchParams;
    expect(query.get("q")).toBe("a/b");
    // Decoding alone would also accept an incorrectly percent-encoded reserved slash.
    expect(styledRequest.url).toContain("q=a/b");
    expect(query.get("colors")).toBe("red,blue");
    expect(query.get("spaces")).toBe("a b");
    expect(query.get("pipes")).toBe("x|y");
    expect(query.get("filter[name]")).toBe("Milo");
    expect(query.get("json")).toBe('{"active":true}');
    expect(styledRequest.options.headers).toMatchObject({
      "X-Trace": "one,two",
      Cookie: "session=cookie",
      Authorization: "Bearer supplied-by-caller",
    });
  });
});
