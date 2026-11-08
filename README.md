# umi-plugin-openapi

English | [简体中文](./README.zh-CN.md)

A Umi 4 plugin that generates TypeScript API services and type declarations from Swagger 2.0 or OpenAPI 3.0 documents, with optional mocks and a development Swagger UI.

## Quick start

Compatible with Umi `>=4.0.57 <5` and Node.js `>=22.17.0`.

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

Services import `request` from `umi`; enable the [request plugin](https://umijs.org/docs/max/request) or set `requestLibPath`. In development, browse `/umi/plugin/openapi`.

**Each run replaces the generated service directory.** Rendering failures leave existing output unchanged; publication failures do not provide a transaction across services and mocks.

## All options

Set `openAPI` to one configuration object or an array of objects. The options below are [Umi plugin configuration](./src/config.ts); the standalone generator exposes additional options.

| Option                              | Description                                                  |
| ----------------------------------- | ------------------------------------------------------------ |
| [`requestLibPath`](#requestlibpath) | Customize the request import statement.                      |
| [`formatter`](#formatter)           | Choose formatting for generated services and mocks.          |
| [`schemaPath`](#schemapath)         | Required Swagger 2.0 or OpenAPI 3.0 document location.       |
| [`mock`](#mock)                     | Enable mock generation.                                      |
| [`projectName`](#projectname)       | Set the service subdirectory and Swagger UI entry name.      |
| [`apiPrefix`](#apiprefix)           | Customize the request path prefix.                           |
| [`namespace`](#namespace)           | Set the generated type namespace.                            |
| [`nullable`](#nullable)             | Use nullable properties instead of optional properties.      |
| [`dataFields`](#datafields)         | Extract response types from selected data fields.            |
| [`isCamelCase`](#iscamelcase)       | Use camelCase file and request function names.               |
| [`hook`](#hook)                     | Customize client schemas, names, types, and request options. |

### `requestLibPath`

Type: `string`. Optional; defaults to `import { request } from "umi"`.

Provide a complete import statement, for example `requestLibPath: "import { request } from '@/utils/request'"`. The imported binding must be named `request`, as generated services call it. A bare module path is also accepted and becomes a default `request` import.

### `formatter`

Type: `"auto" | "oxfmt" | "prettier" | "none" | { external: { command: string; arguments: string[] } }`. Optional; defaults to `"auto"`.

Formats generated service and mock files; `"none"` disables formatting. `"auto"` prefers project Oxfmt dependencies/config, otherwise Prettier. External formatters read stdin and return stdout; `command` must be non-empty, and `{buffer_path}` in `arguments` expands to the absolute output path. Formatting failures warn and preserve unformatted output without changing the exit code.

### `schemaPath`

Type: `string`. Required; no default.

A local JSON file path or URL to a Swagger 2.0 or OpenAPI 3.0 document. HTTPS requires a trusted certificate; for an internal CA, set `NODE_EXTRA_CA_CERTS`.

### `mock`

Type: `boolean`. Optional; omitted or `false` disables mock generation.

Set to `true` to generate mocks in the project's `mock/` directory. Unrelated mock files are preserved.

### `projectName`

Type: `string`. Optional; defaults to the project package name without its scope.

Services are written to `src/services/<projectName>/`. This value also names the development Swagger UI entry (which uses `"openapi"` when the option is omitted). For multiple schemas, see the [output path constraints](#multiple-schemas).

### `apiPrefix`

Type:

```ts
string |
  ((params: { path: string; method: string; namespace: string; functionName: string }) => string);
```

Optional; when omitted or an empty string, the generator uses the operation's first effective server URL (with server variable defaults) followed by the operation path.

A non-empty string or callback result is trimmed and inserted as a JavaScript expression before the path in the generated template literal. Use `apiPrefix: "'/api'"` for a literal prefix, or an expression referencing a variable available to the generated service. Returning an empty string from the callback uses the operation path without a server prefix.

The callback receives `path` (the generated path, with path parameters rewritten as template interpolations), `method` (HTTP method), `namespace` (the generated file/tag group, not the type namespace), and `functionName` (the final request function name). See [generator types](./src/core/types.ts) for the full contract.

### `namespace`

Type: `string`. Optional; defaults to `"API"`.

Use a valid TypeScript namespace name for generated declarations and their references in services.

### `nullable`

Type: `boolean`. Optional; defaults to `false`.

With `false`, non-required declaration properties use `?`. With `true`, those properties are required but their types include `| null` instead. This controls generated types, not runtime response values.

### `dataFields`

Type: `string[]`. Optional; no field extraction by default.

For a JSON response whose schema is a `$ref`, look up these property names on the referenced schema in order and use the first matching property's type as the generated response type. If none matches, keep the original response schema. For example, `['result', 'res']` selects `result` before `res`. This only changes type generation; it does not unwrap runtime responses.

### `isCamelCase`

Type: `boolean`. Optional; defaults to `true`.

Controls camelCase conversion of file/group names and request function names. Identifier sanitization and name collision handling apply even when `false`.

### `hook`

Type: an object containing the optional synchronous callbacks below. Omitted callbacks use the generator's built-in behavior. See [generator types](./src/core/types.ts) for full signatures.

| Callback                    | Purpose                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afterOpenApiDataInited`    | Transform the isolated client document before generation. Mutate it and return `undefined`, or return a replacement document.                                     |
| `customFunctionName`        | Customize the request function name from operation data.                                                                                                          |
| `customTypeName`            | Customize the operation's parameter type name; the generator adds `Params`.                                                                                       |
| `customOptionsDefaultValue` | Set default request options for an operation; `undefined` uses the default empty options object.                                                                  |
| `customClassName`           | Customize the service group's exported name from its tag/group name.                                                                                              |
| `customType`                | Override schema type resolution. Use `originGetType` for the original resolver, or return `undefined` to keep the default type.                                   |
| `customFileNames`           | Choose file groups from the operation definition, path, and HTTP method. Multiple names place the operation in multiple files; `undefined` uses default grouping. |

Hooks affect client services and types, not mocks. To customize both, update the source schema.

## Multiple schemas

Use an `openAPI` array with distinct, non-overlapping `projectName` paths. Service directory overlaps and mock file conflicts after path normalization are rejected before publication; same-name mocks are not merged.

These checks apply only within one `umi openapi` command. Avoid concurrent commands or independent `generateService()` calls sharing output targets.
