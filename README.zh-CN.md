# umi-plugin-openapi

[English](./README.md) | 简体中文

一个 Umi 4 插件，根据 Swagger 2.0 或 OpenAPI 3.0 文档生成 TypeScript API 请求函数和类型声明，并支持可选的 Mock 生成及开发环境 Swagger UI。

## 功能

- 从本地 JSON 文件或远程 URL 加载 API 定义。
- 生成带类型的请求函数，默认使用 Umi 的 `request`。
- 按需在项目的 `mock/` 目录下生成 Mock 文件。
- 在开发环境通过 `/umi/plugin/openapi` 浏览 API 文档。
- 支持多个 API 定义，以及自定义名称、类型、请求导入语句和 API 路径前缀。

## 快速开始

兼容 Umi `>=4.0.57 <5` 和 Node.js `18`、`20` 或 `>=22`。

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

将 `schemaPath` 替换为本地 API 定义文件路径或远程 URL，然后生成服务：

```sh
npx umi openapi
```

此示例将请求函数和类型声明写入 `src/services/api/`，将 Mock 文件写入 `mock/`。运行 `npx umi dev` 后，可访问 `/umi/plugin/openapi` 查看 Swagger UI。

> **每次生成都会替换目标服务目录中的文件，请勿手动修改生成产物。** 生成的服务默认从 `umi` 导入 `request`。标准 Umi 项目需要安装并启用兼容版本 `@umijs/plugins` 中的 [request 插件](https://umijs.org/docs/max/request)，或通过 `requestLibPath` 配置自己的请求实现。

## 常用配置

| 配置项           | 说明                                                        |
| ---------------- | ----------------------------------------------------------- |
| `schemaPath`     | 必填，Swagger 2.0 / OpenAPI 3.0 JSON 文档的本地路径或 URL。 |
| `projectName`    | 服务子目录名称，默认使用项目包名（不含 scope）。            |
| `mock`           | 是否生成 Mock 文件。                                        |
| `namespace`      | 生成的 TypeScript 类型命名空间，默认为 `API`。              |
| `requestLibPath` | 自定义请求导入语句，替换默认的 Umi request 导入。           |
| `apiPrefix`      | 请求路径前缀，支持字符串或函数。                            |
| `hook`           | 自定义 API 定义、生成名称、类型和请求选项。                 |

`openAPI` 也支持配置对象数组。为各项设置不同的 `projectName`，避免生成的服务相互覆盖。

远程 HTTPS 文档需要可信证书。使用内部 CA 时，请配置 `NODE_EXTRA_CA_CERTS`，不要关闭证书校验。
