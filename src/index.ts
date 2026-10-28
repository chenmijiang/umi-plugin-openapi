import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import serveStatic from "serve-static";
import { type IApi } from "umi";

import { configSchema, type ConfigItem } from "./config";
import { generateService, getSchema } from "./core";

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
      schema() {
        return configSchema;
      },
    },
    enableBy: api.EnableBy.config,
  });
  const { absNodeModulesPath, absTmpPath } = api.paths;
  const openAPIFilesPath = join(absNodeModulesPath!, "umi_open_api");

  try {
    if (existsSync(openAPIFilesPath)) {
      rmSync(openAPIFilesPath, { recursive: true, force: true });
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
    const serversFolder = join(api.paths.absSrcPath!, "services");

    if (mockFolder && !existsSync(mockFolder)) {
      mkdirSync(mockFolder);
    }
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
      await genAllFiles(openAPIConfig);
    },
  });
}
