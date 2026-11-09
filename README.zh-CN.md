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

请求函数默认从 `umi` 导入 `request`；需启用 [request 插件](https://umijs.org/docs/max/request)，或设置 `requestLibPath`。开发环境可访问 `/umi/plugin/openapi`。

**每次生成都会替换目标服务目录。** 渲染失败不会改变已有产物；发布失败不提供跨服务与 Mock 的事务保障。

## 全部配置

`openAPI` 支持单个配置对象或配置对象数组。以下为 [Umi 插件配置](./src/config.ts)；独立生成器还提供其他选项。

| 配置项                              | 说明                                        |
| ----------------------------------- | ------------------------------------------- |
| [`requestLibPath`](#requestlibpath) | 自定义 request 导入语句。                   |
| [`formatter`](#formatter)           | 选择服务和 Mock 文件的格式化方式。          |
| [`schemaPath`](#schemapath)         | 必填，Swagger 2.0 或 OpenAPI 3.0 文档位置。 |
| [`mock`](#mock)                     | 启用 Mock 生成。                            |
| [`projectName`](#projectname)       | 设置服务子目录和 Swagger UI 入口名称。      |
| [`apiPrefix`](#apiprefix)           | 自定义请求路径前缀。                        |
| [`namespace`](#namespace)           | 设置生成类型的命名空间。                    |
| [`nullable`](#nullable)             | 使用可空属性代替可选属性。                  |
| [`dataFields`](#datafields)         | 从指定数据字段提取响应类型。                |
| [`isCamelCase`](#iscamelcase)       | 文件名和请求函数名使用小驼峰命名。          |
| [`hook`](#hook)                     | 自定义客户端 schema、名称、类型和请求选项。 |

### `requestLibPath`

类型：`string`。可选，默认为 `import { request } from "umi"`。

填写完整导入语句，例如 `requestLibPath: "import { request } from '@/utils/request'"`。导入后的绑定必须命名为 `request`，供生成的请求函数调用。也支持直接填写模块路径，此时会生成名为 `request` 的默认导入。

### `formatter`

类型：`"auto" | "oxfmt" | "prettier" | "none" | { external: { command: string; arguments: string[] } }`。可选，默认为 `"auto"`。

用于格式化生成的服务和 Mock 文件；`"none"` 禁用格式化。`"auto"` 在项目有 Oxfmt 依赖或配置时优先使用，否则使用 Prettier。外部格式化命令通过 stdin 接收内容、stdout 返回结果；`command` 不得为空，`arguments` 中的 `{buffer_path}` 会替换为输出文件的绝对路径。格式化失败会告警并保留未格式化内容，不改变退出码。

### `schemaPath`

类型：`string`。必填，无默认值。

Swagger 2.0 或 OpenAPI 3.0 文档的本地 JSON 文件路径或 URL。HTTPS 需要可信证书；使用内部 CA 时，设置 `NODE_EXTRA_CA_CERTS`。

### `mock`

类型：`boolean`。可选，省略或设为 `false` 时不生成 Mock。

设为 `true` 时，在项目的 `mock/` 目录生成 Mock。已有的无关 Mock 文件会保留。

### `projectName`

类型：`string`。可选，默认使用不含 scope 的项目包名。

服务输出到 `src/services/<projectName>/`。该配置也用于开发环境 Swagger UI 的入口名称（未设置时 UI 使用 `"openapi"`）。多个 schema 的[输出路径约束见下文](#多个-schema)。

### `apiPrefix`

类型：

```ts
string |
  ((params: { path: string; method: string; namespace: string; functionName: string }) => string);
```

可选；省略或设为空字符串时，生成器使用接口首个有效 server URL（代入 server 变量默认值），再拼接接口路径。

非空字符串或回调返回值会去除首尾空白，作为 JavaScript 表达式插入生成的模板字符串中，位于路径之前。字面量前缀应写成 `apiPrefix: "'/api'"`，也可使用引用生成服务中可用变量的表达式。回调返回空字符串时，仅使用接口路径，不添加 server 前缀。

回调参数包括：`path` 为生成路径，其中路径参数已改写为模板插值；`method` 为 HTTP 方法；`namespace` 为生成文件的 tag 分组名，并非类型命名空间；`functionName` 为最终请求函数名。完整契约见[生成器类型](./src/core/types.ts)。

### `namespace`

类型：`string`。可选，默认为 `"API"`。

用于生成声明及服务中类型引用，需使用合法的 TypeScript 命名空间名称。

### `nullable`

类型：`boolean`。可选，默认为 `false`。

为 `false` 时，声明中非必需属性使用 `?`；为 `true` 时，这些属性改为必需，但类型增加 `| null`。此配置只影响生成类型，不改变运行时响应值。

### `dataFields`

类型：`string[]`。可选，默认不提取字段。

对于 schema 为 `$ref` 的 JSON 响应，按数组顺序查找被引用 schema 的属性，以第一个匹配属性的类型作为生成的响应类型；没有匹配时保留原响应 schema。例如 `['result', 'res']` 优先选择 `result`，其次选择 `res`。此配置只影响类型生成，不会在运行时拆包响应。

### `isCamelCase`

类型：`boolean`。可选，默认为 `true`。

控制文件/分组名和请求函数名的小驼峰转换。设为 `false` 时仍会进行标识符清理和名称冲突处理。

### `hook`

类型：包含下列可选同步回调的对象。未配置的回调使用生成器内置行为，完整签名见[生成器类型](./src/core/types.ts)。

| 回调                        | 作用                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `afterOpenApiDataInited`    | 在生成前变换独立的客户端文档；可原地修改并返回 `undefined`，或返回新文档。                                    |
| `customFunctionName`        | 根据接口数据自定义请求函数名。                                                                                |
| `customTypeName`            | 自定义接口参数类型名称，生成器会追加 `Params`。                                                               |
| `customOptionsDefaultValue` | 设置接口的默认请求选项；返回 `undefined` 时使用默认的空选项对象。                                             |
| `customClassName`           | 根据 tag/分组名自定义服务分组的导出名称。                                                                     |
| `customType`                | 自定义 schema 类型解析；可调用 `originGetType` 使用原解析器，或返回 `undefined` 使用默认类型。                |
| `customFileNames`           | 根据接口定义、路径和 HTTP 方法选择文件分组；返回多个名称会将接口放入多个文件，返回 `undefined` 使用默认分组。 |

Hook 只影响客户端服务和类型，不改变 Mock；如需同时改变两者，请修改源 schema。

## 多个 schema

多个 schema 使用 `openAPI` 数组配置，并指定不同且互不嵌套的 `projectName` 路径。服务目录重叠、路径规范化后的 Mock 文件冲突都会在发布前被拒绝；同名 Mock 不合并。

这些检查仅适用于单次 `umi openapi` 命令。请避免并发命令或独立的 `generateService()` 调用共享输出目标。
