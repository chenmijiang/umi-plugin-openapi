# umi-plugin-openapi

English | [简体中文](./README.zh-CN.md)

A Umi 4 plugin that generates TypeScript API services and type declarations from Swagger 2.0 or OpenAPI 3.0 documents, with optional mocks and a development Swagger UI.

## Features

- Load API definitions from a local JSON file or a remote URL.
- Generate typed request functions using Umi's `request` by default.
- Generate mock files in the project's `mock/` directory when enabled.
- Browse API documentation at `/umi/plugin/openapi` during development.
- Configure multiple API definitions and customize generated names, types, request imports, and API prefixes.

## Quick start

Compatible with Umi `>=4.0.57 <5` and Node.js `18`, `20`, or `>=22`.

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

Replace `schemaPath` with your local API definition or its URL, then generate services:

```sh
npx umi openapi
```

This example writes services and type declarations to `src/services/api/` and mocks to `mock/`. Run `npx umi dev` to access the Swagger UI at `/umi/plugin/openapi`.

> **Generated service files are replaced on each run. Do not edit the generated output manually.** Generated services import `request` from `umi` by default. In standard Umi projects, install and enable the [request plugin](https://umijs.org/docs/max/request) from a compatible `@umijs/plugins` version, or configure `requestLibPath` to use your own request implementation.

## Common options

| Option           | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| `schemaPath`     | Required. Local path or URL of a Swagger 2.0 / OpenAPI 3.0 JSON document.  |
| `projectName`    | Service subdirectory name; defaults to the unscoped project package name.  |
| `mock`           | Enable mock generation.                                                    |
| `namespace`      | Generated TypeScript namespace; defaults to `API`.                         |
| `requestLibPath` | Custom request import statement, replacing the default Umi request import. |
| `apiPrefix`      | Request path prefix, as a string or function.                              |
| `hook`           | Customize the schema, generated names, types, and request options.         |

`openAPI` also accepts an array of configuration objects. Use distinct `projectName` values to keep generated services separate.

Remote HTTPS schemas require a trusted certificate. For an internal CA, configure `NODE_EXTRA_CA_CERTS` rather than disabling certificate verification.
