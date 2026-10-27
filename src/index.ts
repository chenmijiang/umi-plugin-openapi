import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { generateService } from "@umijs/openapi";
import { rimraf } from "rimraf";
import serveStatic from "serve-static";
import { type IApi } from "umi";

import { getSchema } from "./core";

type ConfigItem = {
  requestLibPath?: string;
  schemaPath: string;
  mock?: boolean;
  projectName?: string;
  apiPrefix?: Parameters<typeof generateService>[0]["apiPrefix"];
  namespace?: string;
  serversPath?: string;
  nullable?: boolean;
  dataFields?: string[];
  isCamelCase?: boolean;
  hook?: Parameters<typeof generateService>[0]["hook"];
};

function winPath(path: string): string {
  const isExtendedLengthPath = path.startsWith("\\\\?\\");
  if (isExtendedLengthPath) {
    return path;
  }
  return path.replace(/\\/g, "/");
}

export default function (api: IApi): void {
  api.onStart(() => {
    console.log("Using openapi Plugin");
  });
  api.describe({
    key: "openAPI",
    config: {
      schema({ zod }) {
        const itemSchema = zod.object({
          requestLibPath: zod.string().optional().describe("Custom request method import path."),
          schemaPath: zod
            .string()
            .describe("URL or local file path to a Swagger 2.0 or OpenAPI 3.0 document."),
          mock: zod
            .boolean()
            .optional()
            .describe("Generate mock files in the project's mock directory."),
          projectName: zod
            .string()
            .optional()
            .describe(
              "Project name used for the generated service subdirectory and Swagger UI entry.",
            ),
          apiPrefix: zod
            .union([zod.string(), zod.function()])
            .optional()
            .describe("API request path prefix, provided as a string or a function."),
          namespace: zod
            .string()
            .optional()
            .describe("Namespace for generated TypeScript types. Defaults to API."),
          serversPath: zod
            .string()
            .optional()
            .describe(
              "Service output directory. This plugin overrides it with <cwd>/src/services.",
            ),
          nullable: zod
            .boolean()
            .optional()
            .describe(
              "Use null instead of optional properties in generated types. Defaults to false.",
            ),
          dataFields: zod
            .array(zod.string())
            .optional()
            .describe(
              "Response data field names to use when extracting the generated response type.",
            ),
          isCamelCase: zod
            .boolean()
            .optional()
            .describe(
              "Use camelCase for generated file and request function names. Defaults to true.",
            ),
          hook: zod
            .object({
              afterOpenApiDataInited: zod
                .function()
                .optional()
                .describe(
                  "Transform the OpenAPI document after initialization and return the updated document.",
                ),
              customFunctionName: zod
                .function()
                .optional()
                .describe("Customize the generated request function name from operation data."),
              customTypeName: zod
                .function()
                .optional()
                .describe("Customize the generated type name from operation data."),
              customClassName: zod
                .function()
                .optional()
                .describe("Customize the generated class name from a tag name."),
              customFileNames: zod
                .function()
                .optional()
                .describe(
                  "Return custom file names for an operation based on its definition, API path, and HTTP method.",
                ),
            })
            .optional()
            .describe(
              "Hooks for transforming the OpenAPI document and customizing generated names.",
            ),
        });
        return zod.union([zod.array(itemSchema), itemSchema]);
      },
    },
    enableBy: api.EnableBy.config,
  });
  const { absNodeModulesPath, absTmpPath } = api.paths;
  const openAPIFilesPath = join(absNodeModulesPath!, "umi_open_api");

  try {
    if (existsSync(openAPIFilesPath)) {
      rimraf.sync(openAPIFilesPath);
    }
    mkdirSync(join(openAPIFilesPath));
  } catch (error) {
    console.log(error);
  }

  // 增加中间件
  api.addBeforeMiddlewares(() => {
    return [serveStatic(openAPIFilesPath)];
  });

  api.onGenerateFiles(() => {
    if (api.env !== "development") return;
    const openAPIConfig = api.config.openAPI;
    const swaggerPath = winPath(dirname(require.resolve("swagger-ui-dist/package.json")));
    const swaggerCssPath = winPath(join(swaggerPath, "swagger-ui.css"));

    const arrayConfig = [openAPIConfig].flat() as ConfigItem[];
    const config = arrayConfig?.[0]?.projectName || "openapi";
    api.writeTmpFile({
      path: join("plugin-openapi", "openapi.tsx"),
      noPluginDir: true,
      content: `
import { useEffect, useState } from 'react';
import { SwaggerUIBundle } from '${swaggerPath}';
import '${swaggerCssPath}';
const App = () => {
  const [value, setValue] = useState("${config || "openapi"}" );
  useEffect(() => {
    SwaggerUIBundle({
      url: \`/umi-plugins_$\{value}.json\`,
      dom_id: '#swagger-ui',
    });
  }, [value]);

  return (
    <div
      style={{
        padding: 24,
      }}
    >
      <select
        style={{
          position: "fixed",
          right: "16px",
          top: "8px",
        }}
        onChange={(e) => setValue(e.target.value)}
      >
        ${arrayConfig
          .map((item) => {
            return `<option value="${item.projectName || "openapi"}">${
              item.projectName || "openapi"
            }</option>`;
          })
          .join("\n")}
      </select>
      <div id="swagger-ui" />
    </div>
  );
};
export default App;
`,
    });
  });

  if (api.env === "development") {
    api.modifyRoutes((routes) => {
      routes["umi/plugin/openapi"] = {
        path: "/umi/plugin/openapi",
        absPath: "/umi/plugin/openapi",
        id: "umi/plugin/openapi",
        file: winPath(join(absTmpPath!, "plugin-openapi", "openapi.tsx")),
      };
      return routes;
    });
  }

  const genOpenAPIFiles = async (openAPIConfig: ConfigItem) => {
    if (api.env !== "development") return;
    const openAPIJson = await getSchema(openAPIConfig.schemaPath);
    writeFileSync(
      join(openAPIFilesPath, `umi-plugins_${openAPIConfig.projectName || "openapi"}.json`),
      JSON.stringify(openAPIJson, null, 2),
    );
  };
  api.onDevCompileDone(async () => {
    if (api.env !== "development") return;
    try {
      const openAPIConfig = api.config.openAPI;
      if (Array.isArray(openAPIConfig)) {
        await Promise.all(openAPIConfig.map((item) => genOpenAPIFiles(item)));
        return;
      }
      await genOpenAPIFiles(openAPIConfig);
    } catch (error) {
      console.error(error);
    }
  });
  const genAllFiles = async (openAPIConfig: ConfigItem) => {
    const pageConfig = require(join(api.cwd, "package.json"));
    const mockFolder = openAPIConfig.mock ? join(api.cwd, "mock") : undefined;
    const serversFolder = join(api.cwd, "src", "services");
    // 如果mock 文件不存在，创建一下
    if (mockFolder && !existsSync(mockFolder)) {
      mkdirSync(mockFolder);
    }
    // 如果mock 文件不存在，创建一下
    if (serversFolder && !existsSync(serversFolder)) {
      mkdirSync(serversFolder);
    }

    await generateService({
      projectName: pageConfig.name.split("/").pop(),
      ...openAPIConfig,
      serversPath: serversFolder,
      mockFolder,
    });
    api.logger.info("[openAPI]: execution complete");
  };
  api.registerCommand({
    name: "openapi",
    fn: async () => {
      const openAPIConfig = api.config.openAPI;
      if (Array.isArray(openAPIConfig)) {
        await Promise.all(openAPIConfig.map((item) => genAllFiles(item)));
        return;
      }
      // TODO: 用户没有 src/services 会报错
      await genAllFiles(openAPIConfig);
    },
  });
}
