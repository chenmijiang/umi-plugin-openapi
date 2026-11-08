import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { OpenAPIObject } from "openapi3-ts/oas30";
import converter from "swagger2openapi";

import {
  type GeneratedFile,
  publishMockFiles,
  publishServiceFiles,
  validateGeneratedFiles,
} from "./generatedFiles";
import { renderMock } from "./mockGenerator";
import { resolveReferences } from "./resolveReferences";
import { ServiceGenerator } from "./serviceGenerator";
import type { GenerateServiceProps } from "./types";

type ServiceConfig = Omit<GenerateServiceProps, "schemaPath"> & { schemaPath: string };

interface LoadedSchema {
  schema: unknown;
  location: string;
}

interface RenderedProject {
  schemaPath: string;
  serviceDirectory: string;
  serviceFiles: GeneratedFile[];
  mockFolder?: string;
  mockFiles?: GeneratedFile[];
  formatter?: GenerateServiceProps["formatter"];
}

async function loadSchema(schemaPath: string, authorization?: string): Promise<LoadedSchema> {
  if (/^https?:\/\//i.test(schemaPath)) {
    try {
      // 使用 Node 原生 fetch，保留 TLS 证书校验；内部 CA 通过启动进程前设置
      // NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem 加入信任，运行中设置不生效。
      const response = await fetch(schemaPath, {
        headers: authorization ? { authorization } : {},
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const schema: unknown = await response.json();
      return { schema, location: response.url };
    } catch (error) {
      console.log(`[openAPI]: Failed to fetch schema from ${schemaPath}:`, error);
    }
    return { schema: null, location: schemaPath };
  }
  const location = resolve(schemaPath);
  const schema: unknown = JSON.parse(await readFile(location, "utf8"));
  return { schema, location };
}

export async function getSchema(schemaPath: string, authorization?: string): Promise<unknown> {
  return (await loadSchema(schemaPath, authorization)).schema;
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
  const { schema, location } = await loadSchema(schemaPath, authorization);
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    !("info" in schema) ||
    !schema.info ||
    typeof schema.info !== "object" ||
    Array.isArray(schema.info) ||
    !("title" in schema.info) ||
    typeof schema.info.title !== "string" ||
    !("version" in schema.info) ||
    typeof schema.info.version !== "string" ||
    !("paths" in schema) ||
    !schema.paths ||
    typeof schema.paths !== "object" ||
    Array.isArray(schema.paths)
  ) {
    throw new Error(`[openAPI]: Invalid schema: ${schemaPath}`);
  }
  // Validate the supported dialect and required root shapes, not every OAS constraint.
  if (
    "openapi" in schema &&
    typeof schema.openapi === "string" &&
    /^3\.0\.(0|[1-9]\d*)$/.test(schema.openapi) &&
    !("swagger" in schema)
  ) {
    return resolveReferences(schema as OpenAPIObject, location, authorization, schemaPath);
  }
  if (!("swagger" in schema) || schema.swagger !== "2.0" || "openapi" in schema) {
    throw new Error(
      `[openAPI]: Invalid schema: ${schemaPath}. Expected Swagger 2.0 or OpenAPI 3.0.x.`,
    );
  }
  const options = await converter.convertObj(
    schema as Parameters<typeof converter.convertObj>[0],
    {},
  );
  console.log("[openAPI]: Converted Swagger 2.0 to OpenAPI 3.0");
  // Both libraries describe OpenAPI 3.0; openapi3-ts also declares extension index signatures.
  const openAPI = options.openapi as unknown as OpenAPIObject;
  return resolveReferences(openAPI, location, authorization, schemaPath);
}

async function renderProject({
  authorization,
  requestLibPath,
  schemaPath,
  mockFolder,
  nullable = false,
  requestOptionsType = "Record<string, unknown>",
  ...rest
}: ServiceConfig): Promise<RenderedProject> {
  const openAPI = await getOpenAPIConfig(schemaPath, authorization);
  const requestImportStatement = getImportStatement(requestLibPath);
  const serversPath = rest.serversPath || "./src/service";
  const projectName = rest.projectName ?? "api";
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
      serversPath,
      projectName,
    },
    openAPI,
  );
  const serviceFiles = serviceGenerator.renderFiles();
  const mockFiles = mockFolder
    ? renderMock({ openAPI, mockConfig: rest.mockConfig || {} })
    : undefined;
  validateGeneratedFiles(serviceFiles);
  if (mockFiles) validateGeneratedFiles(mockFiles);
  return {
    schemaPath,
    serviceDirectory: join(serversPath, projectName),
    serviceFiles,
    mockFolder,
    mockFiles,
    formatter: rest.formatter,
  };
}

function publishProject(project: RenderedProject): void {
  publishServiceFiles(project.serviceDirectory, project.serviceFiles, project.formatter);
  if (project.mockFolder && project.mockFiles)
    publishMockFiles(project.mockFolder, project.mockFiles, project.formatter);
}

function validateMockTargets(projects: RenderedProject[]): void {
  const targets = new Map<string, { filename: string; project: number }>();
  const conflict = (
    first: { filename: string; project: number },
    second: { filename: string; project: number },
  ): never => {
    throw new Error(
      `[openAPI]: Conflicting mock output files: openAPI[${first.project}] ` +
        `(${JSON.stringify(projects[first.project]!.schemaPath)}) targets ${JSON.stringify(first.filename)}; ` +
        `openAPI[${second.project}] (${JSON.stringify(projects[second.project]!.schemaPath)}) ` +
        `targets ${JSON.stringify(second.filename)}. Mock files must not overlap across schemas.`,
    );
  };
  projects.forEach((project, index) => {
    if (!project.mockFolder) return;
    for (const file of project.mockFiles || []) {
      const filename = resolve(project.mockFolder, file.relativePath);
      const key = filename.normalize("NFC").toLowerCase();
      const target = { filename, project: index };
      const previous = targets.get(key);
      if (previous) conflict(previous, target);
      targets.set(key, target);
    }
  });
  for (const [key, target] of targets) {
    for (let parent = dirname(key); parent !== dirname(parent); parent = dirname(parent)) {
      const previous = targets.get(parent);
      if (previous) conflict(previous, target);
    }
  }
}

export async function generateService(config: ServiceConfig): Promise<void> {
  publishProject(await renderProject(config));
}

/** One CLI invocation owns one batch; independent core calls are not coordinated. */
export async function generateServiceBatch(configs: ServiceConfig[]): Promise<void> {
  const projects = await Promise.all(configs.map(renderProject));
  validateMockTargets(projects);
  for (const project of projects) publishProject(project);
}
