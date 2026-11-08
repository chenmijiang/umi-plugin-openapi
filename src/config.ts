import { zod as z } from "umi/plugin-utils";

import type { GenerateServiceProps } from "./core/types";

export const configItemSchema = z.object({
  requestLibPath: z.string().optional().describe("Custom request method import path."),
  formatter: z
    .union([
      z.enum(["oxfmt", "prettier", "auto", "none"]),
      z.object({
        external: z.object({
          command: z.string().min(1),
          arguments: z.array(z.string()),
        }),
      }),
    ])
    .optional()
    .describe(
      "Format generated service and mock files. Defaults to auto: prefer project oxfmt dependencies/configuration, otherwise use Prettier. External commands read stdin and return stdout; {buffer_path} is the absolute output file path.",
    ),
  schemaPath: z
    .string()
    .describe(
      "URL or local file path to a Swagger 2.0 or OpenAPI 3.0 document, processed by the bundled generator. HTTPS requires a trusted certificate; use NODE_EXTRA_CA_CERTS for an internal CA.",
    ),
  mock: z.boolean().optional().describe("Generate mock files in the project's mock directory."),
  projectName: z
    .string()
    .optional()
    .describe("Project name used for the generated service subdirectory and Swagger UI entry."),
  apiPrefix: z
    .union([
      z.string(),
      z.custom<Exclude<NonNullable<GenerateServiceProps["apiPrefix"]>, string>>(
        (value) => typeof value === "function",
      ),
    ])
    .optional()
    .describe("API request path prefix, provided as a string or a function."),
  namespace: z
    .string()
    .optional()
    .describe("Namespace for generated TypeScript types. Defaults to API."),
  nullable: z
    .boolean()
    .optional()
    .describe("Use null instead of optional properties in generated types. Defaults to false."),
  dataFields: z
    .array(z.string())
    .optional()
    .describe("Response data field names to use when extracting the generated response type."),
  isCamelCase: z
    .boolean()
    .optional()
    .describe("Use camelCase for generated file and request function names. Defaults to true."),
  hook: z
    .object({
      afterOpenApiDataInited: z
        .custom<NonNullable<NonNullable<GenerateServiceProps["hook"]>["afterOpenApiDataInited"]>>(
          (value) => typeof value === "function",
        )
        .optional()
        .describe(
          "Transform the OpenAPI document for client services and types only; mock generation uses the original document. Return the updated document, or undefined to keep the transformed input.",
        ),
      customFunctionName: z
        .custom<NonNullable<NonNullable<GenerateServiceProps["hook"]>["customFunctionName"]>>(
          (value) => typeof value === "function",
        )
        .optional()
        .describe("Customize the generated request function name from operation data."),
      customTypeName: z
        .custom<NonNullable<NonNullable<GenerateServiceProps["hook"]>["customTypeName"]>>(
          (value) => typeof value === "function",
        )
        .optional()
        .describe("Customize the generated type name from operation data."),
      customOptionsDefaultValue: z
        .custom<
          NonNullable<NonNullable<GenerateServiceProps["hook"]>["customOptionsDefaultValue"]>
        >((value) => typeof value === "function")
        .optional()
        .describe(
          "Customize default request options from an operation, or return undefined to use defaults.",
        ),
      customClassName: z
        .custom<NonNullable<NonNullable<GenerateServiceProps["hook"]>["customClassName"]>>(
          (value) => typeof value === "function",
        )
        .optional()
        .describe("Customize the generated class name from a tag name."),
      customType: z
        .custom<NonNullable<NonNullable<GenerateServiceProps["hook"]>["customType"]>>(
          (value) => typeof value === "function",
        )
        .optional()
        .describe(
          "Customize a schema type using its schema, namespace, and original type resolver, or return undefined to use the default type.",
        ),
      customFileNames: z
        .custom<NonNullable<NonNullable<GenerateServiceProps["hook"]>["customFileNames"]>>(
          (value) => typeof value === "function",
        )
        .optional()
        .describe(
          "Return custom file names for an operation based on its definition, API path, and HTTP method.",
        ),
    })
    .optional()
    .describe(
      "Hooks for client service and type generation: transform the client OpenAPI document and customize generated names, types, and request options. These hooks do not change mock generation.",
    ),
});

export const configSchema = z.union([z.array(configItemSchema), configItemSchema]);

export type ConfigItem = z.infer<typeof configItemSchema>;
