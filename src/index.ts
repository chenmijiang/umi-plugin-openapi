import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

import serveStatic from "serve-static";
import { type IApi } from "umi";

import { configSchema, type ConfigItem } from "./config";
import { getSchema } from "./core";
import { generateServiceBatch } from "./core/generation";

function winPath(path: string): string {
  const isExtendedLengthPath = path.startsWith("\\\\?\\");
  if (isExtendedLengthPath) {
    return path;
  }
  return path.replace(/\\/g, "/");
}

export default function (api: IApi): void {
  api.onStart(() => {
    console.log("[openAPI]: Plugin enabled");
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
    console.log("[openAPI]: Failed to prepare schema directory:", error);
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
      console.error("[openAPI]: Failed to write development schemas:", error);
    }
  });
  const resolveConfig = (openAPIConfig: ConfigItem) => {
    const pageConfig: { name: string } = require(join(api.cwd, "package.json"));
    return {
      ...openAPIConfig,
      projectName: openAPIConfig.projectName ?? pageConfig.name.split("/").pop()!,
      serversPath: join(api.paths.absSrcPath!, "services"),
      mockFolder: openAPIConfig.mock ? join(api.cwd, "mock") : undefined,
    };
  };
  api.registerCommand({
    name: "openapi",
    fn: async () => {
      const configs = ([api.config.openAPI].flat() as ConfigItem[]).map(resolveConfig);
      const targets = configs.map((config) =>
        resolve(join(config.serversPath, config.projectName)),
      );
      const portableTargets = targets.map((target) => target.normalize("NFC").toLowerCase());
      const contains = (parent: string, child: string) => {
        const difference = relative(parent, child);
        return !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
      };
      for (let index = 0; index < targets.length; index += 1) {
        for (let previous = 0; previous < index; previous += 1) {
          if (
            contains(portableTargets[previous]!, portableTargets[index]!) ||
            contains(portableTargets[index]!, portableTargets[previous]!)
          ) {
            throw new Error(
              `[openAPI]: Conflicting service output directories: openAPI[${previous}] ` +
                `(${JSON.stringify(configs[previous]!.schemaPath)}) targets ${JSON.stringify(targets[previous])}; ` +
                `openAPI[${index}] (${JSON.stringify(configs[index]!.schemaPath)}) targets ${JSON.stringify(targets[index])}. ` +
                "Service directories must not be equal or overlap.",
            );
          }
        }
      }
      await generateServiceBatch(configs);
      api.logger.info("[openAPI]: Generation finished");
    },
  });
}
