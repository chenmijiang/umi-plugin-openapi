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

Set `schemaPath` to a local JSON file or URL, then generate:

```sh
npx umi openapi
```

Services and types are written to `src/services/api/`, mocks to `mock/`. **Each run replaces the generated service directory.**

Services import `request` from `umi` by default. Standard Umi projects must enable the [request plugin](https://umijs.org/docs/max/request) or set `requestLibPath`. Run `npx umi dev` to browse `/umi/plugin/openapi`.

## Common options

| Option           | Description                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaPath`     | Required. Local path or URL of a Swagger 2.0 / OpenAPI 3.0 JSON document.                                                                                                         |
| `projectName`    | Service subdirectory name; defaults to the unscoped project package name.                                                                                                         |
| `mock`           | Enable mock generation.                                                                                                                                                           |
| `namespace`      | Generated TypeScript namespace; defaults to `API`.                                                                                                                                |
| `requestLibPath` | Custom request import statement, replacing the default Umi request import.                                                                                                        |
| `apiPrefix`      | Request path prefix, as a string or function.                                                                                                                                     |
| `hook`           | Customize the schema, generated names, types, and request options.                                                                                                                |
| `formatter`      | `"auto"` (default: prefer project Oxfmt dependencies/config, otherwise Prettier), `"oxfmt"`, `"prettier"`, `"none"` (skip formatting), or `{ external: { command, arguments } }`. |

External formatters read stdin and return stdout; `{buffer_path}` is the absolute output path. Example: `{ external: { command: "prettier", arguments: ["--stdin-filepath", "{buffer_path}"] } }`.

Formatting failures produce warnings and preserve unformatted output without changing the exit code.

For multiple schemas, pass an array to `openAPI` with distinct `projectName` values.

For HTTPS schemas using an internal CA, set `NODE_EXTRA_CA_CERTS`.
