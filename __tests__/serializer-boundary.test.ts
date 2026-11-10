import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { transform } from "esbuild";
import type { TestContext } from "vitest";
import { describe, expect, test } from "vitest";

import type * as Core from "../src/core";

const require = createRequire(import.meta.url);
const { generateService } = require("umi-plugin-openapi/core") as typeof Core;
type RequestCall = { url: string; options: Record<string, unknown> };

async function client(
  onTestFinished: TestContext["onTestFinished"],
  mediaType = "multipart/form-data",
  reservedParameters = false,
  optionalBody = false,
  optionsDefaultValue?: Record<string, unknown>,
) {
  const directory = await mkdtemp(join(tmpdir(), "serializer-boundary-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const schemaPath = join(directory, "schema.json");
  await writeFile(
    schemaPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Multipart boundary", version: "1" },
      paths: {
        [reservedParameters ? "/upload/{id}" : "/upload"]: {
          post: {
            operationId: "submit",
            tags: ["boundary"],
            parameters: reservedParameters
              ? [
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    allowReserved: true,
                    schema: { type: "string" },
                  },
                  {
                    name: "session",
                    in: "cookie",
                    allowReserved: true,
                    schema: { type: "string" },
                  },
                  {
                    name: "X-Trace",
                    in: "header",
                    schema: { type: "array", items: { type: "string" } },
                  },
                ]
              : [],
            requestBody: {
              required: !optionalBody,
              content: {
                [mediaType]: {
                  schema: {
                    type: "object",
                    properties: {
                      payload: { type: "object", additionalProperties: true },
                      note: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { "204": { description: "Uploaded" } },
          },
        },
      },
    }),
  );
  await generateService({
    schemaPath,
    serversPath: directory,
    projectName: "api",
    requestLibPath: "test-request",
    formatter: "none",
    hook: { customOptionsDefaultValue: () => optionsDefaultValue },
  });
  const filename = join(directory, "api", "boundary.ts");
  const { code } = await transform(await readFile(filename, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2022",
    sourcefile: filename,
  });
  const module = { exports: {} };
  const calls: RequestCall[] = [];
  runInNewContext(code, {
    module,
    exports: module.exports,
    require(name: string) {
      if (name !== "test-request") throw new Error(`Unexpected dependency: ${name}`);
      return async (url: string, options: Record<string, unknown>) => {
        calls.push({ url, options });
      };
    },
  });
  const generated = module.exports as { submit: (...args: unknown[]) => Promise<unknown> };
  return { submit: generated.submit, calls };
}

describe("generated request safety boundaries", () => {
  for (const mediaType of ["multipart/form-data", "application/x-www-form-urlencoded"]) {
    test(`omitted optional ${mediaType} bodies remain undefined and distinct from empty bodies`, async ({
      onTestFinished,
    }) => {
      const { submit, calls } = await client(onTestFinished, mediaType, false, true);
      await submit();
      expect(calls[0].options.data).toBeUndefined();
      await submit(mediaType === "multipart/form-data" ? new FormData() : {});
      if (mediaType === "multipart/form-data") {
        expect(calls[1].options.data).toBeInstanceOf(FormData);
        expect([...(calls[1].options.data as FormData).keys()]).toEqual([]);
      } else {
        expect(calls[1].options.data).toEqual({});
      }
    });
  }
});

describe("generated request header precedence", () => {
  for (const mediaType of ["application/json", "multipart/form-data"]) {
    test(`${mediaType} options.headers replaces all generated headers, including with an empty object`, async ({
      onTestFinished,
    }) => {
      const { submit, calls } = await client(onTestFinished, mediaType, true, true);
      const params = { id: "one", session: "a%2Fb", "X-Trace": ["one", "two"] };
      const body = mediaType === "multipart/form-data" ? new FormData() : {};
      const generatedHeaders = {
        ...(mediaType === "multipart/form-data" ? {} : { "Content-Type": mediaType }),
        "X-Trace": ["one", "two"],
        Cookie: "session=a%2Fb",
      };

      await submit(params, body);
      expect(calls.at(-1)!.options.headers).toEqual(generatedHeaders);

      await submit(params, body, { headers: { Authorization: "Bearer caller" } });
      expect(calls.at(-1)!.options.headers).toEqual({ Authorization: "Bearer caller" });

      await submit(params, body, { headers: {} });
      expect(calls.at(-1)!.options.headers).toEqual({});

      await submit(params, body, { timeout: 123 });
      expect(calls.at(-1)!.options.headers).toEqual(generatedHeaders);
    });
  }

  test("custom options defaults apply only when caller options are absent, without merging headers or defaults", async ({
    onTestFinished,
  }) => {
    const { submit, calls } = await client(onTestFinished, "application/json", true, true, {
      headers: { "X-Default": "hook" },
      timeout: 123,
    });
    const params = { id: "one", session: "cookie", "X-Trace": ["one", "two"] };

    await submit(params, {});
    expect(calls.at(-1)!.options.headers).toEqual({ "X-Default": "hook" });
    expect(calls.at(-1)!.options.timeout).toBe(123);

    await submit(params, {}, {});
    expect(calls.at(-1)!.options.headers).toEqual({
      "Content-Type": "application/json",
      "X-Trace": ["one", "two"],
      Cookie: "session=cookie",
    });
    expect(calls.at(-1)!.options).not.toHaveProperty("timeout");

    await submit(params, {}, { headers: {}, timeout: 456 });
    expect(calls.at(-1)!.options.headers).toEqual({});
    expect(calls.at(-1)!.options.timeout).toBe(456);
  });
});
