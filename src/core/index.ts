import type { OpenAPIObject } from "openapi3-ts/oas30";
import converter from "swagger2openapi";

import { mockGenerator } from "./mockGenerator";
import { ServiceGenerator } from "./serviceGenerator";
import type { GenerateServiceProps } from "./types";

export async function getSchema(schemaPath: string, authorization?: string): Promise<unknown> {
  if (schemaPath.startsWith("http")) {
    try {
      // 使用 Node 原生 fetch，保留 TLS 证书校验；内部 CA 通过启动进程前设置
      // NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem 加入信任，运行中设置不生效。
      const json = await fetch(schemaPath, {
        headers: authorization ? { authorization } : {},
      }).then((rest) => rest.json());
      return json;
    } catch (error) {
      console.log("fetch openapi error:", error);
    }
    return null;
  }
  // Node caches modules by resolved filename, which may differ for symlinked paths.
  const resolvedPath = require.resolve(schemaPath);
  delete require.cache[resolvedPath];
  const schema: unknown = require(resolvedPath);
  return schema;
}

const getImportStatement = (requestLibPath?: string) => {
  if (requestLibPath && requestLibPath.startsWith("import")) {
    return requestLibPath;
  }
  if (requestLibPath) {
    return `import request from '${requestLibPath}'`;
  }
  return `import { request } from "umi"`;
};

async function getOpenAPIConfig(
  schemaPath: string,
  authorization?: string,
): Promise<OpenAPIObject> {
  const schema = await getSchema(schemaPath, authorization);
  if (
    !schema ||
    typeof schema !== "object" ||
    !("info" in schema) ||
    !schema.info ||
    typeof schema.info !== "object" ||
    !("version" in schema.info) ||
    typeof schema.info.version !== "string" ||
    !("paths" in schema) ||
    !schema.paths ||
    typeof schema.paths !== "object"
  ) {
    throw new Error(`[openAPI]: Invalid schema: ${schemaPath}`);
  }
  if (!("swagger" in schema) || !schema.swagger) {
    return schema as OpenAPIObject;
  }
  const options = await converter.convertObj(
    schema as Parameters<typeof converter.convertObj>[0],
    {},
  );
  console.log("[openAPI]: 💺 将 Swagger 转化为 openAPI");
  // Both libraries describe OpenAPI 3.0; openapi3-ts also declares extension index signatures.
  const openAPI = options.openapi as unknown as OpenAPIObject;
  return openAPI;
}

export async function generateService({
  authorization,
  requestLibPath,
  schemaPath,
  mockFolder,
  nullable = false,
  requestOptionsType = "{[key: string]: any}",
  ...rest
}: Omit<GenerateServiceProps, "schemaPath"> & { schemaPath: string }): Promise<void> {
  const openAPI = await getOpenAPIConfig(schemaPath, authorization);
  const requestImportStatement = getImportStatement(requestLibPath);

  const serviceGenerator = new ServiceGenerator(
    {
      namespace: "API",
      requestOptionsType,
      requestImportStatement,
      enumStyle: "string-literal",
      nullable,
      isCamelCase: true,
      mockConfig: {},
      ...rest,
    },
    openAPI,
  );
  serviceGenerator.genFile();

  if (mockFolder) {
    await mockGenerator({
      openAPI,
      mockFolder: mockFolder || "./mocks/",
      mockConfig: rest.mockConfig || {},
    });
  }
}
