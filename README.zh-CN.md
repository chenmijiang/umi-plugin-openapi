# umi-plugin-openapi

[English](./README.md) | 简体中文

Umi 4 插件，根据 Swagger 2.0 / OpenAPI 3.0 文档生成 TypeScript 请求函数、类型声明和可选 Mock，提供开发环境 Swagger UI。

## 快速开始

兼容 Umi `>=4.0.57 <5` 和 Node.js `>=22.17.0`。

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

将 `schemaPath` 设为本地 JSON 文件或 URL，然后生成：

```sh
npx umi openapi
```

请求函数和类型声明输出到 `src/services/api/`，Mock 输出到 `mock/`。**每次生成都会替换目标服务目录。**

请求函数默认从 `umi` 导入 `request`。标准 Umi 项目需启用 [request 插件](https://umijs.org/docs/max/request)，或设置 `requestLibPath`。运行 `npx umi dev` 后可访问 `/umi/plugin/openapi`。

## 常用配置

| 配置项           | 说明                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaPath`     | 必填，Swagger 2.0 / OpenAPI 3.0 JSON 文档的本地路径或 URL。                                                                                                        |
| `projectName`    | 服务子目录名称，默认使用项目包名（不含 scope）。                                                                                                                   |
| `mock`           | 是否生成 Mock 文件。                                                                                                                                               |
| `namespace`      | 生成的 TypeScript 类型命名空间，默认为 `API`。                                                                                                                     |
| `requestLibPath` | 自定义请求导入语句，替换默认的 Umi request 导入。                                                                                                                  |
| `apiPrefix`      | 请求路径前缀，支持字符串或函数。                                                                                                                                   |
| `hook`           | 自定义 API 定义、生成名称、类型和请求选项。                                                                                                                        |
| `formatter`      | `"auto"`（默认：项目有 Oxfmt 依赖或配置时优先使用，否则使用 Prettier）、`"oxfmt"`、`"prettier"`、`"none"`（跳过格式化）或 `{ external: { command, arguments } }`。 |

外部格式化命令通过 stdin 接收内容、stdout 返回结果；`{buffer_path}` 为输出文件的绝对路径。示例：`{ external: { command: "prettier", arguments: ["--stdin-filepath", "{buffer_path}"] } }`。

格式化失败会告警并保留未格式化内容，不改变退出码。

多个 schema 可通过 `openAPI` 数组配置，各项使用不同的 `projectName`。

HTTPS schema 使用内部 CA 时，设置 `NODE_EXTRA_CA_CERTS`。
