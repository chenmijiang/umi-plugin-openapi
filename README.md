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

**Each run replaces the generated service directory.** Services import `request` from `umi`; enable the [request plugin](https://umijs.org/docs/max/request) or set `requestLibPath`. In development, browse `/umi/plugin/openapi`.

## Common options

| Option           | Description                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `projectName`    | Service subdirectory; defaults to the unscoped package name.                                      |
| `mock`           | Generate mocks.                                                                                   |
| `namespace`      | Type namespace; defaults to `API`.                                                                |
| `requestLibPath` | Import statement replacing the default Umi request import.                                        |
| `apiPrefix`      | Request path prefix: string or function.                                                          |
| `hook`           | Customize the schema, names, types, and request options.                                          |
| `formatter`      | `"auto"` (default), `"oxfmt"`, `"prettier"`, `"none"`, or `{ external: { command, arguments } }`. |

`auto` prefers project Oxfmt dependencies/config, otherwise Prettier. External formatters read stdin and return stdout; `{buffer_path}` expands to the absolute output path. Formatting failures warn and preserve unformatted output without changing the exit code.

Use an `openAPI` array with distinct `projectName` values for multiple schemas. For HTTPS schemas with an internal CA, set `NODE_EXTRA_CA_CERTS`.

See [configuration](./src/config.ts) and [generator types](./src/core/types.ts) for all options and hook signatures; [AGENTS.md](./AGENTS.md) covers repository maintenance.
