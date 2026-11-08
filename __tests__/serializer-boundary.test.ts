import { File } from "node:buffer";
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
type Encoding = Record<
  string,
  { contentType?: string; style?: string; explode?: boolean; allowReserved?: boolean }
>;
type RequestCall = { url: string; options: Record<string, unknown> };

async function client(
  onTestFinished: TestContext["onTestFinished"],
  encoding: Encoding,
  mediaType = "multipart/form-data",
  reservedParameters = false,
  optionalBody = false,
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
                      ...(optionalBody ? {} : { upload: { type: "string", format: "binary" } }),
                    },
                  },
                  encoding,
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
    Blob,
    File,
    FormData,
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

function uploadedPart(calls: RequestCall[], name: string): Blob {
  const value = (calls[0].options.data as FormData).get(name);
  expect(value).toBeInstanceOf(Blob);
  return value as Blob;
}

describe("generated multipart wire boundaries", () => {
  test("multipart ignores URLencoded style, explode and allowReserved", async ({
    onTestFinished,
  }) => {
    const { submit, calls } = await client(onTestFinished, {
      payload: { style: "deepObject", explode: true, allowReserved: true },
    });
    await submit({ payload: { role: "a/b" } });
    const form = calls[0].options.data as FormData;
    expect([...form.keys()]).toEqual(["payload"]);
    const part = uploadedPart(calls, "payload");
    expect(part.type).toBe("application/json");
    expect(await part.text()).toBe('{"role":"a/b"}');
  });

  for (const contentType of ["image/*", "image/jpeg, image/png"]) {
    test(`matching ${contentType} preserves the file's concrete MIME and filename`, async ({
      onTestFinished,
    }) => {
      const { submit, calls } = await client(onTestFinished, { upload: { contentType } });
      await submit({}, new File(["pixels"], "photo.png", { type: "image/png" }));
      const part = uploadedPart(calls, "upload") as File;
      expect(part.type).toBe("image/png");
      expect(part.name).toBe("photo.png");
      expect(await part.text()).toBe("pixels");
    });
  }

  test("a nonmatching file selects the first concrete MIME instead of emitting a list", async ({
    onTestFinished,
  }) => {
    const { submit, calls } = await client(onTestFinished, {
      upload: { contentType: "image/*, application/pdf, text/plain" },
    });
    await submit({}, new File(["document"], "input.bin", { type: "application/octet-stream" }));
    const part = uploadedPart(calls, "upload") as File;
    expect(part.type).toBe("application/pdf");
    expect(part.name).toBe("input.bin");
    expect(await part.text()).toBe("document");
  });

  test("an unmatched wildcard rejects before making a request", async ({ onTestFinished }) => {
    const { submit, calls } = await client(onTestFinished, { upload: { contentType: "image/*" } });
    await expect(submit({}, new Blob(["document"], { type: "application/pdf" }))).rejects.toThrow(
      /concrete content type/,
    );
    expect(calls).toEqual([]);
  });

  test("object and scalar content type lists become concrete JSON and text parts", async ({
    onTestFinished,
  }) => {
    const { submit, calls } = await client(onTestFinished, {
      payload: { contentType: "application/json, application/xml" },
      note: { contentType: "text/plain, text/html" },
    });
    await submit({ payload: { active: false }, note: "hello" });
    const payload = uploadedPart(calls, "payload");
    const note = uploadedPart(calls, "note");
    expect([payload.type, await payload.text(), note.type, await note.text()]).toEqual([
      "application/json",
      '{"active":false}',
      "text/plain",
      "hello",
    ]);
  });

  test("nonmatching wildcard-only scalar encodings reject instead of sending a MIME range", async ({
    onTestFinished,
  }) => {
    const { submit, calls } = await client(onTestFinished, { note: { contentType: "image/*" } });
    await expect(submit({ note: "hello" })).rejects.toThrow(/concrete content type/);
    expect(calls).toEqual([]);
  });

  test("URLencoded binary content with a MIME list serializes file text without assigning the list as its type", async ({
    onTestFinished,
  }) => {
    const { submit, calls } = await client(
      onTestFinished,
      { upload: { contentType: "text/html, text/plain" } },
      "application/x-www-form-urlencoded",
    );
    const file = new File(["a/b & c"], "note.txt", { type: "text/plain" });
    await submit({ upload: file });
    expect(calls[0].options.data).toBe("upload=a%2Fb%20%26%20c");
    expect(file.type).toBe("text/plain");
  });
  test("allowReserved does not expose reserved characters in path or cookie parameters", async ({
    onTestFinished,
  }) => {
    const { submit, calls } = await client(onTestFinished, {}, "multipart/form-data", true);
    await submit({ id: "a/b", session: "a/b" }, {});
    expect(calls[0].url).toBe("/upload/a%2Fb");
    expect((calls[0].options.headers as Record<string, string>).Cookie).toBe("session=a%2Fb");
    expect(calls[0].options.params).toEqual({});
  });

  for (const mediaType of ["multipart/form-data", "application/x-www-form-urlencoded"]) {
    test(`omitted optional ${mediaType} bodies remain undefined while explicit empty bodies serialize`, async ({
      onTestFinished,
    }) => {
      const { submit, calls } = await client(onTestFinished, {}, mediaType, false, true);
      await submit();
      expect(calls[0].options.data).toBeUndefined();
      await submit({});
      if (mediaType === "multipart/form-data") {
        expect(calls[1].options.data).toBeInstanceOf(FormData);
        expect([...(calls[1].options.data as FormData).keys()]).toEqual([]);
      } else {
        expect(calls[1].options.data).toBe("");
      }
    });
  }
});
