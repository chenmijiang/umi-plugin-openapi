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

将 `schemaPath` 设为本地 JSON 文件或 URL，然后生成请求函数和类型声明到 `src/services/api/`，Mock 到 `mock/`：

```sh
npx umi openapi
```

**每次生成都会替换目标服务目录。** 请求函数默认从 `umi` 导入 `request`；需启用 [request 插件](https://umijs.org/docs/max/request)，或设置 `requestLibPath`。开发环境可访问 `/umi/plugin/openapi`。

## 常用配置

| 配置项           | 说明                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `projectName`    | 服务子目录名称，默认使用不含 scope 的项目包名。                                                 |
| `mock`           | 生成 Mock。                                                                                     |
| `namespace`      | 类型命名空间，默认为 `API`。                                                                    |
| `requestLibPath` | 替换默认 Umi request 导入的完整语句。                                                           |
| `apiPrefix`      | 请求路径前缀，支持字符串或函数。                                                                |
| `hook`           | 自定义 schema、名称、类型和请求选项。                                                           |
| `formatter`      | `"auto"`（默认）、`"oxfmt"`、`"prettier"`、`"none"` 或 `{ external: { command, arguments } }`。 |

`auto` 在项目有 Oxfmt 依赖或配置时优先使用，否则使用 Prettier。外部格式化命令通过 stdin 接收内容、stdout 返回结果；`{buffer_path}` 为输出文件的绝对路径。格式化失败会告警并保留未格式化内容，不改变退出码。

多个 schema 使用 `openAPI` 数组配置，并指定不同的 `projectName`。HTTPS schema 使用内部 CA 时，设置 `NODE_EXTRA_CA_CERTS`。

完整选项和 hook 签名见[配置定义](./src/config.ts)与[生成器类型](./src/core/types.ts)；仓库维护说明见 [AGENTS.md](./AGENTS.md)。
