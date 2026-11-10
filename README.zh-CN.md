# umi-plugin-openapi

[![npm version](https://img.shields.io/npm/v/umi-plugin-openapi)](https://www.npmjs.com/package/umi-plugin-openapi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Node.js: >=22.17.0](https://img.shields.io/badge/node-%3E%3D22.17.0-green)](https://nodejs.org/)
[![Umi: >=4.0.57 <5](https://img.shields.io/badge/umi-%3E%3D4.0.57%20%3C5-blue)](https://umijs.org/)
[![npm downloads](https://img.shields.io/npm/dm/umi-plugin-openapi)](https://www.npmjs.com/package/umi-plugin-openapi)

[English](./README.md) | 简体中文

Umi 4 插件，根据 Swagger 2.0 / OpenAPI 3.0 文档生成 TypeScript 请求函数、类型声明和可选 Mock，提供开发环境 Swagger UI。

## 快速开始

```sh
npm install --save-dev umi-plugin-openapi
```

在 `.umirc.ts` 或 `config/config.ts` 中注册插件：

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

将 `schemaPath` 设为本地 JSON 文件或 URL，然后生成请求函数和类型声明到 `src/services/api/`，Mock 到 `mock/`：

```sh
npx umi openapi
```

开发环境可访问 `/umi/plugin/openapi`。

**生成命令会替换目标服务目录的内容，请将手写代码放在目录外。** `mock/` 中的无关文件会保留。

## 请求行为

- Query 参数作为 `params`、请求体作为 `data` 传入。Query 和 URLencoded 表单的序列化由 request 实现负责，包括 OpenAPI 的 `style`、`explode` 和 `content`。Path 和 cookie 值需由调用方按协议编码，生成方法不额外做 URI 编码。
- Multipart 方法接收完整的 `FormData`，由调用方构造字段、文件及各 part 的 MIME 类型；仅当 schema 要求请求体必填时，body 才必填。
- 调用时的 `options` 覆盖生成的请求选项。其中 `options.headers` 会整体替换生成的 headers，包括 `Content-Type`。

## 配置

`openAPI` 支持单个配置对象或[多个 schema 的配置数组](#多个-schema)。下表为 [Umi 插件配置](./src/config.ts)；回调签名和独立生成器的其他选项见[生成器类型](./src/core/types.ts)。

| 配置项                              | 默认值                  | 用途                                 |
| ----------------------------------- | ----------------------- | ------------------------------------ |
| `schemaPath`                        | 必填                    | API 文档的本地 JSON 文件路径或 URL。 |
| `projectName`                       | 不含 scope 的项目包名   | `src/services/` 下的服务子目录。     |
| `mock`                              | `false`                 | 在 `mock/` 中生成 Mock。             |
| [`requestLibPath`](#requestlibpath) | 导入 Umi `request`      | 请求实现。                           |
| [`formatter`](#formatter)           | `"auto"`                | 格式化生成的服务和 Mock 文件。       |
| [`apiPrefix`](#apiprefix)           | 接口首个有效 server URL | 请求 URL 前缀。                      |
| `namespace`                         | `"API"`                 | 生成类型的 TypeScript 命名空间。     |
| [`nullable`](#nullable)             | `false`                 | 声明属性的可空策略。                 |
| [`dataFields`](#datafields)         | 无                      | 选择响应字段作为返回类型。           |
| `isCamelCase`                       | `true`                  | 文件名和请求函数名使用小驼峰。       |
| [`hook`](#hook)                     | 无                      | 自定义客户端代码生成。               |

HTTPS schema URL 的证书需受 Node.js 信任；内部 CA 可通过 `NODE_EXTRA_CA_CERTS` 配置。

`projectName` 也用于 Swagger UI 入口名；未显式设置时，UI 使用 `"openapi"`。

### `requestLibPath`

生成的服务调用名为 `request` 的绑定。可启用 [Umi request 插件](https://umijs.org/docs/max/request)，或填写完整导入语句，例如 `requestLibPath: "import { request } from '@/utils/request'"`。直接填写模块路径时，会生成名为 `request` 的默认导入。

### `formatter`

`"auto"` 优先使用消费项目中已安装或配置的 Oxfmt，否则使用 Prettier。也可显式设置 `"oxfmt"`、`"prettier"` 或 `"none"`，分别指定格式化器或禁用格式化。

外部格式化器通过 stdin 接收内容，通过 stdout 返回格式化结果。例如，项目已安装 Prettier 时：

```ts
const formatter = {
  external: {
    command: "npx",
    arguments: ["--no-install", "prettier", "--stdin-filepath", "{buffer_path}"],
  },
};
```

`{buffer_path}` 会替换为输出文件的绝对路径。格式化失败时告警并保留对应文件的未格式化内容，生成继续执行。

### `apiPrefix`

接受 JavaScript 表达式字符串，或返回该表达式的同步回调。字面量前缀需包含表达式内部的引号，例如 `apiPrefix: "'/api'"`；变量表达式引用的名称需在生成的服务中可用。

回调接收 `{ path, method, namespace, functionName }`：`path` 中的路径参数已改写为模板插值，`namespace` 是服务的 tag/分组名。

省略配置或设为空字符串时，server 变量使用声明的默认值。回调返回空字符串时，仅使用接口路径，不添加 server 前缀。

### `nullable`

设为 `true` 时，普通模型及参数声明的可选属性改为必填的 `T | null` 属性。嵌套和组合 schema 类型仍遵循各自的 `required`、`nullable` 定义。该选项不改变运行时值。

### `dataFields`

对于 schema 为 `$ref` 的 JSON 响应，按数组顺序选择第一个匹配的属性作为返回类型。例如，`["result", "res"]` 先尝试 `result`，再尝试 `res`；没有匹配时保留原响应类型。运行时响应不会拆包。

### `hook`

所有回调均可选且同步执行，只影响客户端服务和类型，不改变 Mock；如需同时改变两者，请修改源 schema。

| 回调                        | 用途                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `afterOpenApiDataInited`    | 生成前修改客户端文档，或返回替代文档。                                                       |
| `customFunctionName`        | 自定义请求函数名。                                                                           |
| `customTypeName`            | 自定义接口参数类型名，生成器会追加 `Params`。                                                |
| `customOptionsDefaultValue` | 设置默认请求选项；返回 `undefined` 时使用空对象。                                            |
| `customClassName`           | 自定义服务分组的导出名称。                                                                   |
| `customType`                | 自定义 schema 类型；可调用 `originGetType` 使用内置解析器，或返回 `undefined` 使用默认类型。 |
| `customFileNames`           | 返回一个或多个文件分组名，或返回 `undefined` 使用默认分组。                                  |

## 多个 schema

使用 `openAPI` 数组，并指定不同且互不嵌套的 `projectName` 路径；Mock 文件名也需互不冲突。避免并发生成命令或独立生成调用写入相同的输出目录。
