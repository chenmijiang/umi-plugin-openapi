# umi-plugin-openapi

[![npm version](https://img.shields.io/npm/v/umi-plugin-openapi)](https://www.npmjs.com/package/umi-plugin-openapi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Node.js: >=22.17.0](https://img.shields.io/badge/node-%3E%3D22.17.0-green)](https://nodejs.org/)
[![Umi: >=4.0.57 <5](https://img.shields.io/badge/umi-%3E%3D4.0.57%20%3C5-blue)](https://umijs.org/)
[![npm downloads](https://img.shields.io/npm/dm/umi-plugin-openapi)](https://www.npmjs.com/package/umi-plugin-openapi)

English | [简体中文](./README.zh-CN.md)

A Umi 4 plugin that generates TypeScript API services and type declarations from Swagger 2.0 or OpenAPI 3.0 documents, with optional mocks and a development Swagger UI.

## Quick start

```sh
npm install --save-dev umi-plugin-openapi
```

Register the plugin in `.umirc.ts` or `config/config.ts`:

```ts
export default {
  plugins: ["umi-plugin-openapi"],
  openAPI: {
    schemaPath: "./openapi.json",
    projectName: "api",
    mock: true,
  },
};
```

Set `schemaPath` to a local JSON file or URL, then generate services and types in `src/services/api/`, and mocks in `mock/`:

```sh
npx umi openapi
```

In development, browse `/umi/plugin/openapi`.

**Keep handwritten code outside the generated service directory: each run replaces its contents.** Unrelated files in `mock/` are preserved.

## Request behavior

- Query parameters are passed as `params`, and request bodies as `data`. Your request implementation handles query and URL-encoded form serialization, including OpenAPI `style`, `explode`, and `content`. Supply appropriately encoded path and cookie values; generated methods add no URI encoding.
- Multipart methods accept a complete `FormData` body. Build fields, files, and part MIME types in the caller; the body is optional unless the schema requires it.
- Per-call `options` override generated request options. In particular, `options.headers` replaces the whole generated headers object, including `Content-Type`.

## Configuration

`openAPI` accepts one configuration object or an [array for multiple schemas](#multiple-schemas). The table covers [Umi plugin options](./src/config.ts); [generator types](./src/core/types.ts) define callback signatures and additional standalone options.

| Option                              | Default                    | Purpose                                         |
| ----------------------------------- | -------------------------- | ----------------------------------------------- |
| `schemaPath`                        | Required                   | Local JSON file or URL for the API document.    |
| `projectName`                       | Package name without scope | Service subdirectory under `src/services/`.     |
| `mock`                              | `false`                    | Generate mocks in `mock/`.                      |
| [`requestLibPath`](#requestlibpath) | Umi `request` import       | Request implementation.                         |
| [`formatter`](#formatter)           | `"auto"`                   | Format generated service and mock files.        |
| [`apiPrefix`](#apiprefix)           | First effective server URL | Request URL prefix.                             |
| `namespace`                         | `"API"`                    | TypeScript namespace for generated types.       |
| [`nullable`](#nullable)             | `false`                    | Use nullable properties in declarations.        |
| [`dataFields`](#datafields)         | None                       | Select a response property for the return type. |
| `isCamelCase`                       | `true`                     | Use camelCase file and request function names.  |
| [`hook`](#hook)                     | None                       | Customize client generation.                    |

For HTTPS schema URLs, Node.js must trust the certificate. Set `NODE_EXTRA_CA_CERTS` for an internal CA.

`projectName` also names the Swagger UI entry; without an explicit value, the UI uses `"openapi"`.

### `requestLibPath`

Generated services call a binding named `request`. Enable the [Umi request plugin](https://umijs.org/docs/max/request), or provide a complete import such as `requestLibPath: "import { request } from '@/utils/request'"`. A bare module path produces a default `request` import.

### `formatter`

`"auto"` prefers Oxfmt installed or configured in the consuming project, otherwise Prettier. Use `"oxfmt"`, `"prettier"`, or `"none"` to choose explicitly or disable formatting.

External formatters read stdin and return formatted content on stdout. For example, with Prettier installed in the project:

```ts
const formatter = {
  external: {
    command: "npx",
    arguments: ["--no-install", "prettier", "--stdin-filepath", "{buffer_path}"],
  },
};
```

`{buffer_path}` expands to the absolute output file path. Formatting failures warn and leave the affected files unformatted; generation continues.

### `apiPrefix`

Use a JavaScript expression string, or a synchronous callback returning one. A literal prefix needs quotes inside the expression: `apiPrefix: "'/api'"`. Variable expressions must reference names available in the generated service.

The callback receives `{ path, method, namespace, functionName }`. Here, `path` has path parameters rewritten as template interpolations, and `namespace` is the service's tag/group name.

When the option is omitted or an empty string, server variables use their declared defaults. Returning an empty string from the callback uses only the operation path, without a server prefix.

### `nullable`

With `true`, optional properties in plain model and parameter declarations become required `T | null` properties. Nested and composed schema types follow their own `required` and `nullable` definitions. This option does not change runtime values.

### `dataFields`

For a JSON response schema that is a `$ref`, use the first matching property in this list as the return type. For example, `["result", "res"]` tries `result` before `res`; no match keeps the original response type. Runtime responses are not unwrapped.

### `hook`

All callbacks are optional and synchronous. They affect client services and types, not mocks; change the source schema to affect both.

| Callback                    | Purpose                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `afterOpenApiDataInited`    | Mutate the client document or return a replacement before generation.                                        |
| `customFunctionName`        | Choose a request function name.                                                                              |
| `customTypeName`            | Choose an operation's parameter type name; `Params` is appended.                                             |
| `customOptionsDefaultValue` | Set default request options; `undefined` uses an empty object.                                               |
| `customClassName`           | Choose the service group's exported name.                                                                    |
| `customType`                | Resolve a schema type; use `originGetType` for the built-in resolver, or return `undefined` for the default. |
| `customFileNames`           | Return one or more file group names, or `undefined` for default grouping.                                    |

## Multiple schemas

Use an `openAPI` array with distinct, non-overlapping `projectName` paths. Mock file names must also be distinct. Avoid concurrent generation commands or standalone calls that write to the same output directories.
