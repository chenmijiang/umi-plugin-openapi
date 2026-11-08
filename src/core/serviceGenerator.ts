import { existsSync, readFileSync } from "node:fs";
import { join } from "path";

import { camelCase } from "lodash";
import numberToWords from "number-to-words";
import * as nunjucks from "nunjucks";
import type {
  ContentObject,
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SchemaObject,
} from "openapi3-ts/oas30";

import type { GeneratedFile } from "./generatedFiles";
import { httpMethods, normalizeOperations } from "./operations";
import type { GenerateServiceProps } from "./types";
import { stripDot } from "./util";

const reservedWords = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const generatedType = Symbol("generatedType");

interface LegacySchema {
  $ref?: string;
  [generatedType]?: string;
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  required?: string[] | boolean;
  enum?: unknown[];
  items?: LegacySchema | LegacySchema[];
  schema?: LegacySchema;
  properties?: Record<string, LegacySchema>;
  oneOf?: LegacySchema[];
  anyOf?: LegacySchema[];
  allOf?: LegacySchema[];
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  additionalProperties?: boolean | LegacySchema;
}

interface TemplateProperty {
  name?: string;
  desc?: string;
  type?: string;
  required?: boolean | string[];
  format?: string;
  items?: LegacySchema | LegacySchema[];
  $ref?: string;
  isType?: boolean;
}

interface ResolvedSchema {
  type?: string | LegacySchema;
  props?: TemplateProperty[][];
  parent?: unknown;
  isEnum?: boolean;
}

interface InterfaceTemplate {
  typeName: string;
  type: string | boolean | LegacySchema;
  parent?: unknown;
  props: TemplateProperty[][];
  isEnum?: boolean;
  nullable?: boolean;
}

interface BodyTemplate {
  mediaType: string;
  required: boolean;
  type?: string;
  propertiesList?: { key: string; schema: LegacySchema & { type: string; required: boolean } }[];
}

interface FileTemplate {
  title?: string;
  multiple: boolean;
}

interface ResponseTemplate {
  mediaType: string;
  type: string;
  responseType?: "text" | "blob";
}

interface OperationTemplate extends APIDataType {
  parameterDefinitions: (Pick<
    TemplateParameter,
    "name" | "inputName" | "in" | "style" | "explode" | "allowReserved"
  > & { contentType?: string })[];
  encoding: NonNullable<RequestBodyObject["content"][string]["encoding"]>;
  functionName: string;
  typeName: string;
  pathInComment: string;
  hasPathVariables: boolean;
  hasApiPrefix: boolean;
  desc: string;
  hasHeader: boolean;
  params: Record<string, TemplateParameter[]>;
  hasParams: boolean;
  options: Record<string, unknown>;
  body: BodyTemplate | null;
  file: FileTemplate[] | null;
  hasFormData: boolean;
  response: ResponseTemplate;
}

interface ServiceTemplate {
  genType: string;
  className: string;
  instanceName: string;
  hasParameters: boolean;
  hasFormBody: boolean;
  list: OperationTemplate[];
}

interface TemplateContexts {
  interface: {
    namespace?: string;
    nullable?: boolean;
    list: InterfaceTemplate[];
    disableTypeCheck?: boolean;
    declareType: "type" | "interface";
    equalSymbol: "=" | "";
  };
  serviceController: ServiceTemplate & {
    namespace?: string;
    requestOptionsType?: string;
    requestImportStatement?: string;
    disableTypeCheck: boolean;
  };
  serviceIndex: {
    list: ControllerType[];
    disableTypeCheck: boolean;
  };
}

interface TemplateParameter extends Omit<ParameterObject, "schema"> {
  schema?: SchemaObject | ReferenceObject;
  type?: string;
  isObject?: boolean;
  isComplexType?: boolean;
  alias?: string;
  inputName?: string;
  $ref?: string;
}

export type TypescriptFileType = keyof TemplateContexts;

export interface APIDataType extends OperationObject {
  path: string;
  method: string;
  antTechVersion?: string;
  extensions?: {
    "x-antTech-description"?: {
      apiName: string;
      antTechVersion: string;
      productCode: string;
      antTechApiName?: string;
    };
  };
}

export type TagAPIDataType = Record<string, APIDataType[]>;

export interface ControllerType {
  fileName: string;
  controllerName: string;
}

// 兼容C#泛型的typeLastName取法
function getTypeLastName(typeName: string): string {
  const tempTypeName = typeName || "";

  const childrenTypeName = tempTypeName?.match(/\[\[.+\]\]/g)?.[0];
  if (!childrenTypeName) {
    let publicKeyToken = (tempTypeName.split("PublicKeyToken=")?.[1] ?? "").replace("null", "");
    const firstTempTypeName = tempTypeName.split(",")?.[0] ?? tempTypeName;
    let typeLastName = firstTempTypeName.split("/").pop()!.split(".").pop()!;
    if (typeLastName.endsWith("[]")) {
      typeLastName = typeLastName.substring(0, typeLastName.length - 2) + "Array";
    }
    // 特殊处理C#默认系统类型，不追加publicKeyToken
    const isCsharpSystemType = firstTempTypeName.startsWith("System.");
    if (!publicKeyToken || isCsharpSystemType) {
      return typeLastName;
    }
    return `${typeLastName}_${publicKeyToken}`;
  }
  const currentTypeName = getTypeLastName(tempTypeName.replace(childrenTypeName, ""));
  const childrenTypeNameLastName = getTypeLastName(
    childrenTypeName.substring(2, childrenTypeName.length - 2),
  );
  return `${currentTypeName}_${childrenTypeNameLastName}`;
}

// 类型声明过滤关键字
const resolveTypeName = (typeName: string): string => {
  if (reservedWords.has(typeName)) {
    return `__openAPI__${typeName}`;
  }
  const typeLastName = getTypeLastName(typeName);

  let name = typeLastName
    .replace(/[-_ ](\w)/g, (_all, letter) => letter.toUpperCase())
    .replace(/[^\w^\s^\u4e00-\u9fa5]/gi, "");

  // 保留纯数字和下划线名称的历史前缀，避免生成非法标识符。
  if (name === "_" || /^\d+$/.test(name)) {
    console.log(`[openAPI]: Renamed type "${name}" to "Pinyin_${name}" for a valid identifier`);
    return `Pinyin_${name}`;
  }
  // 前面的解析可能会吧类似"2.0"之类的tag文字解析成首字母带数字的key
  // 后面要是再带点别的字符在生成ts className的时候会由于首字符带数字导致非法变量报错
  // 这里做一个统一处理
  if (/^\d/.test(name)) {
    const firstChar = parseInt(name[0]);
    name = `${numberToWords.toWords(firstChar)}${name.substring(1)}`;
  }

  return name.replace(/ +/g, "");
};

function getRefName(refObject: LegacySchema): string {
  const refPaths = refObject.$ref!.split("/");
  return resolveTypeName(
    decodeURIComponent(refPaths[refPaths.length - 1])
      .replace(/~1/g, "/")
      .replace(/~0/g, "~"),
  );
}

const escapeComment = (text: string): string =>
  text.replace(/\*\//g, "*\\/").replace(/\r\n?|\n/g, "\n * ");

const escapeTemplateText = (text: string): string =>
  text.replace(/[\\`$]/g, (character) => `\\${character}`);
const selectMedia = (content: ContentObject = {}): string => {
  const keys = Object.keys(content);
  return (
    keys.find((key) => key === "application/json") ||
    keys.find((key) => /\+json(?:;|$)/i.test(key)) ||
    keys[0] ||
    ""
  );
};
const defaultGetType = (
  input: unknown,
  namespace: string = "",
  describe?: (schema: LegacySchema) => string,
  refName?: (schema: LegacySchema) => string,
): string => {
  const schema = input as LegacySchema | undefined;
  const type = getNonNullableType(input, namespace, describe, refName);
  return schema?.nullable &&
    schema.type &&
    !schema.$ref &&
    !schema.allOf?.length &&
    !schema.oneOf?.length &&
    !schema.anyOf?.length &&
    (!schema.enum || schema.enum.includes(null)) &&
    type !== "null"
    ? `(${type}) | null`
    : type;
};

const numberEnum = ["integer", "long", "float", "double", "number", "int", "int32", "int64"];
const dateEnum = ["Date", "date", "dateTime", "date-time", "datetime"];
const stringEnum = ["string", "email", "password", "url", "byte", "binary"];

const getNonNullableType = (
  input: unknown,
  namespace: string,
  describe?: (schema: LegacySchema) => string,
  refName?: (schema: LegacySchema) => string,
): string => {
  const schemaObject = input as LegacySchema | undefined;
  const typeOf = (schema: unknown): string => defaultGetType(schema, namespace, describe, refName);
  if (schemaObject === undefined || schemaObject === null) {
    return "any";
  }
  if (typeof schemaObject !== "object") {
    return String(schemaObject);
  }
  if (schemaObject[generatedType])
    return [namespace, schemaObject[generatedType]].filter(Boolean).join(".");
  if (schemaObject.$ref) {
    return [namespace, refName ? refName(schemaObject) : getRefName(schemaObject)]
      .filter(Boolean)
      .join(".");
  }
  const composition = [schemaObject.allOf, schemaObject.oneOf, schemaObject.anyOf];
  if (composition.some((items) => items?.length)) {
    const { allOf, oneOf, anyOf, nullable: _nullable, ...own } = schemaObject;
    if (Array.isArray(own.required) && own.required.length)
      own.properties = {
        ...Object.fromEntries(own.required.map((key) => [key, {}])),
        ...own.properties,
      };
    const parts: string[] = [];
    if (allOf?.length) parts.push(...allOf.map((item) => `(${typeOf(item)})`));
    if (oneOf?.length) parts.push(`(${oneOf.map((item) => `(${typeOf(item)})`).join(" | ")})`);
    if (anyOf?.length) parts.push(`(${anyOf.map((item) => `(${typeOf(item)})`).join(" | ")})`);
    if (own.type || own.properties || own.additionalProperties !== undefined || own.enum)
      parts.push(`(${typeOf({ ...own, nullable: schemaObject.nullable })})`);
    return parts.join(" & ");
  }

  let type = schemaObject.type;

  if (type === "null") {
    return "null";
  }

  if (schemaObject.enum) {
    type = "enum";
  }

  if (numberEnum.includes(type || "")) {
    return "number";
  }

  if (dateEnum.includes(type || "")) {
    return "Date";
  }

  if (stringEnum.includes(type || "")) {
    return "string";
  }

  if (type === "boolean") {
    return "boolean";
  }

  if (type === "array") {
    let { items } = schemaObject;
    if (schemaObject.schema) {
      items = schemaObject.schema.items;
    }

    if (Array.isArray(items)) {
      const arrayItemType = items.map((subType) => typeOf(subType.schema || subType)).toString();
      return `[${arrayItemType}]`;
    }
    const arrayType = typeOf(items);
    return / [|&] /.test(arrayType) ? `(${arrayType})[]` : `${arrayType}[]`;
  }

  if (type === "enum") {
    return Array.isArray(schemaObject.enum)
      ? Array.from(new Set(schemaObject.enum.map((v) => JSON.stringify(v)))).join(" | ")
      : "string";
  }

  if (
    schemaObject.type === "object" ||
    schemaObject.properties ||
    schemaObject.additionalProperties !== undefined
  ) {
    const additional = schemaObject.additionalProperties;
    const valueType = additional && typeof additional === "object" ? typeOf(additional) : "unknown";
    const dictionaryType = valueType === "any" ? "unknown" : valueType;
    const properties = schemaObject.properties || {};
    const propertyKeys = Object.keys(properties);
    if (!propertyKeys.length) {
      return `Record<string, ${additional === false ? "never" : dictionaryType}>`;
    }
    const requiredKeys = Array.isArray(schemaObject.required)
      ? new Set(schemaObject.required)
      : undefined;
    const propertyTypes = additional
      ? propertyKeys.map((key) => typeOf(properties[key]))
      : undefined;
    let indexSignature = "";
    if (propertyTypes) {
      const hasOptional = propertyKeys.some(
        (key) => !requiredKeys?.has(key) || properties[key].readOnly || properties[key].writeOnly,
      );
      const indexTypes = [
        ...new Set([dictionaryType, ...propertyTypes, ...(hasOptional ? ["undefined"] : [])]),
      ];
      indexSignature = `[key: string]: ${indexTypes.join(" | ")}; `;
    }
    return `{\n${propertyKeys
      .map((key, index) => {
        let required = schemaObject.required === true || !!requiredKeys?.has(key);
        if (schemaObject.properties?.[key]?.readOnly || schemaObject.properties?.[key]?.writeOnly)
          required = false;
        /**
         * 将类型属性变为字符串，兼容错误格式如：
         * 3d_tile(数字开头)等错误命名，
         * 在后面进行格式化的时候会将正确的字符串转换为正常形式，
         * 错误的继续保留字符串。
         * */
        const property = properties[key];
        const description = describe
          ? describe(property)
          : escapeComment([property.title, property.description].filter(Boolean).join(" "));
        const propertyType = propertyTypes ? propertyTypes[index] : typeOf(property);
        return `${description ? `/** ${description} */\n` : ""}${JSON.stringify(key)}${required ? "" : "?"}: ${propertyType};\n`;
      })
      .join("")}${indexSignature}}`;
  }
  return "unknown";
};

const DEFAULT_SCHEMA: LegacySchema = {
  type: "object",
  properties: { id: { type: "number" } },
};

const DEFAULT_PATH_PARAM: TemplateParameter = {
  in: "path",
  name: "",
  schema: {
    type: "string",
  },
  required: true,
  isObject: false,
  type: "string",
};

function defaultGetFileTag(
  operationObject: OperationObject,
  apiPath: string,
  _apiMethod: string,
): string[] {
  return operationObject["x-swagger-router-controller"]
    ? [operationObject["x-swagger-router-controller"]]
    : operationObject.tags || [operationObject.operationId!] || [
        apiPath.replace("/", "").split("/")[1],
      ];
}
class ServiceGenerator {
  protected apiData: TagAPIDataType = Object.create(null);

  protected classNameList: ControllerType[] = [];

  private directionNames = new Map<string, string>();
  private schemaNames = new Map<string, string>();
  private parameterNames = new Map<string, string>();
  private namesAllocated = false;
  private pathBasePrefix: string;

  protected config: GenerateServiceProps & { projectName: string; templatesFolder: string };
  protected openAPIData: OpenAPIObject;

  constructor(config: GenerateServiceProps, openAPIData: OpenAPIObject) {
    this.config = {
      projectName: "api",
      templatesFolder: existsSync(join(__dirname, "templates"))
        ? join(__dirname, "templates")
        : join(__dirname, "../templates"),
      dedupeApiPrefix: true,
      ...config,
    };
    const initialize = this.config.hook?.afterOpenApiDataInited;
    const hasClientHook =
      typeof initialize === "function" ||
      typeof this.config.hook?.customFunctionName === "function" ||
      typeof this.config.hook?.customTypeName === "function" ||
      typeof this.config.hook?.customOptionsDefaultValue === "function" ||
      typeof this.config.hook?.customClassName === "function" ||
      typeof this.config.hook?.customType === "function" ||
      typeof this.config.hook?.customFileNames === "function";
    const hookDocument = hasClientHook ? structuredClone(openAPIData) : openAPIData;
    this.openAPIData = normalizeOperations(
      initialize?.call(this.config.hook, hookDocument) || hookDocument,
    );
    const hookCustomFileNames = this.config.hook?.customFileNames || defaultGetFileTag;
    Object.keys(this.openAPIData.paths || {}).forEach((p) => {
      if (!p.startsWith("/")) return;
      const pathItem = this.openAPIData.paths[p];
      httpMethods.forEach((method) => {
        const operationObject = pathItem[method];
        if (operationObject) {
          operationObject.parameters = operationObject.parameters?.filter((item) => {
            const parameter = this.resolveRefObject<ParameterObject>(item);
            return !(
              parameter.in === "header" &&
              /^(accept|content-type|authorization)$/i.test(parameter.name)
            );
          });
        }
        if (!operationObject) {
          return;
        }

        let tags = hookCustomFileNames(operationObject, p, method);
        if (!tags) {
          tags = defaultGetFileTag(operationObject, p, method);
        }

        tags.forEach((tagString) => {
          const tag = this.config.isCamelCase
            ? camelCase(resolveTypeName(tagString))
            : resolveTypeName(tagString);

          if (!this.apiData[tag]) {
            this.apiData[tag] = [];
          }
          this.apiData[tag].push({
            path: p,
            method,
            ...operationObject,
          });
        });
      });
    });
    this.pathBasePrefix = this.getBasePrefix(
      Object.keys(this.openAPIData.paths || {}).filter((path) => path.startsWith("/")),
    );
  }

  public renderFiles(): GeneratedFile[] {
    const declarations = this.getInterfaceTP();
    this.classNameList = [];
    const services = this.getServiceTP().map((service) => ({
      fileName: this.getFinalFileName(`${service.className}.ts`),
      context: {
        namespace: this.config.namespace,
        requestOptionsType: this.config.requestOptionsType,
        requestImportStatement: this.config.requestImportStatement,
        disableTypeCheck: false,
        ...service,
      } satisfies TemplateContexts["serviceController"],
    }));
    const index: TemplateContexts["serviceIndex"] = {
      list: [...this.classNameList].sort((a, b) =>
        a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0,
      ),
      disableTypeCheck: false,
    };

    const files = this.config.splitDeclare
      ? this.genTypeFilesByTag(declarations)
      : [
          this.genFileFromTemplate("typings.d.ts", "interface", {
            namespace: this.config.namespace,
            nullable: this.config.nullable,
            list: declarations,
            disableTypeCheck: false,
            declareType: this.config.declareType || "type",
            equalSymbol: (this.config.declareType || "type") === "type" ? "=" : "",
          }),
        ];
    for (const service of services) {
      files.push(this.genFileFromTemplate(service.fileName, "serviceController", service.context));
    }
    files.push(this.genFileFromTemplate("index.ts", "serviceIndex", index));
    return files;
  }

  public getFuncationName(data: APIDataType): string {
    return this.config.hook && this.config.hook.customFunctionName
      ? this.config.hook.customFunctionName(data)
      : data.operationId
        ? this.resolveFunctionName(stripDot(data.operationId), data.method)
        : data.method + this.genDefaultFunctionName(data.path, this.pathBasePrefix);
  }

  public getTypeName(data: APIDataType): string {
    this.allocateTypeNames();
    return this.parameterNames.get(JSON.stringify([data.path, data.method]))!;
  }

  public getServiceTP(): ServiceTemplate[] {
    return Object.keys(this.apiData)
      .map((tag, index) => {
        // functionName tag 级别防重
        const tmpFunctionRD = new Set([
          "encodeParameter",
          "parameterPairs",
          "serializeParameter",
          "serializeParameters",
          "appendQuery",
          "serializeFormBody",
          "OpenAPIParameter",
          "OpenAPIEncoding",
        ]);

        const genParams = this.apiData[tag]
          .map((api) => {
            const newApi = api;
            try {
              const allParams = this.getParamsTP(newApi.parameters, newApi.path);
              const body = this.getBodyTP(newApi.requestBody);
              const response = this.getResponseTP(newApi.responses);
              const requestBody = newApi.requestBody
                ? this.resolveRefObject<RequestBodyObject>(newApi.requestBody)
                : undefined;
              const encoding = requestBody?.content?.[body?.mediaType || ""]?.encoding || {};
              for (const [name, settings] of Object.entries(encoding)) {
                if (
                  settings.headers &&
                  Object.keys(settings.headers).some((header) => !/^content-type$/i.test(header))
                )
                  console.warn(
                    `[openAPI]: Request encoding.headers for ${name} cannot be supplied by the standard request transport; use a custom request implementation for per-part headers`,
                  );
              }
              const parameterDefinitions = Object.values(allParams)
                .flat()
                .map((parameter) => ({
                  name: parameter.name,
                  inputName: parameter.inputName,
                  in: parameter.in,
                  style: parameter.style,
                  explode: parameter.explode,
                  allowReserved: parameter.allowReserved,
                  contentType: parameter.content ? selectMedia(parameter.content) : undefined,
                }));

              const params = allParams || {};
              const file = this.getFileTP(newApi.requestBody);

              let formData = false;
              if ((body && (body.mediaType || "").includes("form-data")) || file) {
                formData = true;
              }

              let functionName = this.getFuncationName(newApi);
              if (this.config.isCamelCase) functionName = camelCase(functionName);
              const baseName = functionName;
              let suffix = 2;
              while (tmpFunctionRD.has(functionName)) functionName = `${baseName}_${suffix++}`;
              tmpFunctionRD.add(functionName);

              let formattedPath = newApi.path
                .split(/(\{[^{}]+\})/g)
                .map((part) => {
                  if (!part.startsWith("{") || !part.endsWith("}")) return escapeTemplateText(part);
                  const index = (params.path || []).findIndex(
                    (parameter) => parameter.name === part.slice(1, -1),
                  );
                  return "${param" + index + "}";
                })
                .join("");
              if (newApi.extensions && newApi.extensions["x-antTech-description"]) {
                const { extensions } = newApi;
                const { antTechVersion, antTechApiName } = extensions["x-antTech-description"]!;
                formattedPath = antTechApiName || formattedPath;
                newApi.antTechVersion = antTechVersion;
              }

              // 为 path 中的 params 添加 alias
              const escapedPathParams = ((params || {}).path || []).map((ele, index) => ({
                ...ele,
                alias: `param${index}`,
              }));

              const finalParams: Record<string, TemplateParameter[]> =
                escapedPathParams && escapedPathParams.length
                  ? { ...params, path: escapedPathParams }
                  : params;

              // 处理 query 中的复杂对象
              if (finalParams && finalParams.query) {
                finalParams.query = finalParams.query.map((ele) => ({
                  ...ele,
                  isComplexType: ele.isObject,
                }));
              }

              const getPrefixPath = () => {
                if (!this.config.apiPrefix) {
                  const server = newApi.servers?.[0];
                  const base =
                    server?.url.replace(/\{([^{}]+)\}/g, (_match, name: string) =>
                      String(server.variables?.[name]?.default ?? ""),
                    ) || "";
                  return `${escapeTemplateText(base.replace(/\/$/, ""))}${formattedPath}`;
                }
                // 静态 apiPrefix
                const prefix =
                  typeof this.config.apiPrefix === "function"
                    ? `${this.config.apiPrefix({
                        path: formattedPath,
                        method: newApi.method,
                        namespace: tag,
                        functionName,
                      })}`.trim()
                    : this.config.apiPrefix.trim();

                if (!prefix) {
                  return formattedPath;
                }

                if (
                  this.config.dedupeApiPrefix &&
                  (prefix.startsWith("'") || prefix.startsWith('"') || prefix.startsWith("`"))
                ) {
                  const finalPrefix = escapeTemplateText(prefix.slice(1, prefix.length - 1));
                  if (
                    formattedPath.startsWith(finalPrefix) ||
                    formattedPath.startsWith(`/${finalPrefix}`)
                  ) {
                    return formattedPath;
                  }
                  return `${finalPrefix}${formattedPath}`;
                }
                // prefix 变量
                return `$\{${prefix}}${formattedPath}`;
              };

              return {
                ...newApi,
                parameterDefinitions,
                encoding,
                functionName,
                typeName: this.getTypeName(newApi),
                path: getPrefixPath(),
                pathInComment: escapeComment(formattedPath.replace(/\*/g, "&#42;")),
                hasPathVariables: formattedPath.includes("{"),
                hasApiPrefix: !!this.config.apiPrefix,
                method: newApi.method,
                // 如果 functionName 和 summary 相同，则不显示 summary
                desc: escapeComment(
                  (functionName === newApi.summary
                    ? newApi.description
                    : [
                        newApi.summary,
                        newApi.description,
                        (newApi.responses?.default as ResponseObject)?.description
                          ? `返回值: ${(newApi.responses?.default as ResponseObject)?.description}`
                          : "",
                      ]
                        .filter((s) => s)
                        .join(" ")) || "",
                ),
                hasHeader: !!(params && params.header) || !!(body && body.mediaType),
                params: finalParams,
                hasParams: Boolean(Object.keys(finalParams || {}).length),
                options: this.config.hook?.customOptionsDefaultValue?.(newApi) || {},
                body,
                file,
                hasFormData: formData,
                response,
              };
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error("[openAPI]: Failed to generate service parameters:", error);
              throw error;
            }
          })
          // 排序下，要不每次git都乱了
          .sort((a, b) => a.path.localeCompare(b.path));

        const fileName = this.replaceDot(tag) || `api${index}`;

        let className = fileName;
        if (this.config.hook && this.config.hook.customClassName) {
          className = this.config.hook.customClassName(tag);
        }
        if (genParams.length) {
          this.classNameList.push({
            fileName: className,
            controllerName: className,
          });
        }
        return {
          genType: "ts",
          className,
          instanceName: `${fileName[0]?.toLowerCase()}${fileName.substr(1)}`,
          hasParameters: genParams.some((api) => api.hasParams),
          hasFormBody: genParams.some(
            (api) => api.hasFormData || api.body?.mediaType === "application/x-www-form-urlencoded",
          ),
          list: genParams,
        };
      })
      .filter((ele) => !!ele?.list?.length);
  }

  public getBodyTP(
    requestBody: RequestBodyObject | ReferenceObject | Record<string, never> = {},
  ): BodyTemplate | null {
    const reqBody = this.resolveRefObject<RequestBodyObject>(
      requestBody as RequestBodyObject | ReferenceObject,
    );
    if (!reqBody) {
      return null;
    }
    const reqContent: ContentObject = reqBody.content;
    if (typeof reqContent !== "object" || (reqContent && Object.keys(reqContent).length === 0)) {
      return null;
    }
    let mediaType = selectMedia(reqContent);
    const sourceSchema = (reqContent[mediaType].schema || {}) as LegacySchema;
    const resolvedSchema =
      sourceSchema.$ref && mediaType === "multipart/form-data"
        ? this.resolveRefObject<LegacySchema>(sourceSchema)
        : sourceSchema;
    const schema = this.directionalSchema(resolvedSchema, "Input");

    if (mediaType === "*/*") {
      mediaType = "";
    }
    // 如果 requestBody 有 required 属性，则正常展示；如果没有，默认非必填
    const required = reqBody.required === true;
    if (
      mediaType &&
      !/(?:\/|\+)json(?:;|$)/i.test(mediaType) &&
      !["multipart/form-data", "application/x-www-form-urlencoded"].includes(mediaType)
    ) {
      return {
        mediaType,
        required,
        type: /^(?:text\/)|xml(?:;|$)/i.test(mediaType) ? "string" : "Blob | ArrayBuffer | string",
      };
    }
    if (schema.type === "object" && schema.properties && !schema.nullable) {
      const propertiesList = Object.keys(schema.properties)
        .map((p) => {
          if (
            schema.properties &&
            schema.properties[p] &&
            !(
              mediaType === "multipart/form-data" &&
              (["binary", "base64"].includes(schema.properties[p].format || "") ||
                (schema.properties[p].type === "array" &&
                  ["binary", "base64"].includes(
                    (schema.properties[p].items as LegacySchema)?.format || "",
                  )))
            )
          ) {
            return {
              key: JSON.stringify(p),
              schema: {
                ...schema.properties[p],
                type: this.getType(schema.properties[p], this.config.namespace),
                description: this.getDescription(schema.properties[p]),
                required: Array.isArray(schema.required) ? schema.required.includes(p) : false,
              },
            };
          }
          return undefined;
        })
        .filter((p) => p !== undefined);
      return {
        mediaType,
        ...schema,
        required,
        propertiesList,
      };
    }
    return {
      mediaType,
      required,
      type: this.getType(schema, this.config.namespace),
    };
  }
  public getFileTP(
    requestBody: RequestBodyObject | ReferenceObject | Record<string, never> = {},
  ): FileTemplate[] | null {
    const reqBody = this.resolveRefObject<RequestBodyObject>(
      requestBody as RequestBodyObject | ReferenceObject,
    );
    if (reqBody?.content && selectMedia(reqBody.content) === "multipart/form-data") {
      const ret = this.resolveFileTP(reqBody.content["multipart/form-data"].schema);
      return ret.length > 0 ? ret : null;
    }
    return null;
  }
  public resolveFileTP(obj: unknown): FileTemplate[] {
    let ret: FileTemplate[] = [];
    const schema = obj as LegacySchema | undefined;
    const result = this.resolveObject(
      schema?.$ref ? this.resolveRefObject<LegacySchema>(schema) : obj,
    );
    const resolved = typeof result === "string" ? {} : result;
    const props =
      (resolved.props &&
        resolved.props.length > 0 &&
        resolved.props[0].filter(
          (p) =>
            p.format === "binary" ||
            p.format === "base64" ||
            ((p.type === "string[]" || p.type === "array") &&
              ((p.items as LegacySchema).format === "binary" ||
                (p.items as LegacySchema).format === "base64")),
        )) ||
      [];
    if (props.length > 0) {
      ret = props.map((p) => {
        return {
          title: p.name,
          multiple: p.type === "string[]" || p.type === "array",
        };
      });
    }
    if (resolved.type) ret = [...ret, ...this.resolveFileTP(resolved.type)];
    return ret;
  }

  public getResponseTP(responses: ResponsesObject = {}): ResponseTemplate {
    const successes = Object.keys(responses).filter((key) => /^2(?:\d\d|XX)$/i.test(key));
    const keys = successes.length ? successes : responses.default ? ["default"] : [];
    let mediaType = "*/*";
    const types = keys.map((key) => {
      const response = this.resolveRefObject<ResponseObject>(responses[key]);
      const media = selectMedia(response.content);
      if (!media || key === "204") return "void";
      mediaType = media;
      if (!/(?:\/|\+)json(?:;|$)/i.test(media))
        return /^(?:text\/)|xml(?:;|$)/i.test(media) ? "string" : "Blob";
      let schema = response.content![media].schema as LegacySchema | undefined;
      if (!schema) return "unknown";
      if (schema.$ref && this.config.dataFields) {
        const resolved = this.resolveRefObject<LegacySchema>(schema);
        schema =
          this.config.dataFields.map((field) => resolved.properties?.[field]).find(Boolean) ||
          schema;
      }
      return `(${this.getType(this.directionalSchema(schema, "Output"), this.config.namespace)})`;
    });
    return {
      mediaType,
      type: [...new Set(types)].join(" | ") || "unknown",
      responseType:
        types.every((type) => type === "string" || type === "void") && types.includes("string")
          ? "text"
          : types.every((type) => type === "Blob" || type === "void") && types.includes("Blob")
            ? "blob"
            : undefined,
    };
  }

  public getParamsTP(
    parameters: (ParameterObject | ReferenceObject)[] = [],
    path: string | null = null,
  ): Record<string, TemplateParameter[]> {
    const templateParams: Record<string, TemplateParameter[]> = {};

    if (parameters && parameters.length) {
      ["query", "path", "cookie", "header"].forEach((source) => {
        // Possible values are "query", "header", "path" or "cookie". (https://swagger.io/specification/)
        const params = parameters
          .map((p) => this.resolveRefObject<TemplateParameter>(p))
          .filter((p) => p.in === source)
          .map((p) => {
            const isDirectObject =
              ((p.schema as SchemaObject | undefined)?.type || p.type) === "object";
            const refList = ((p.schema as ReferenceObject | undefined)?.$ref || p.$ref || "").split(
              "/",
            );
            const ref = refList[refList.length - 1];
            const deRefObj = Object.entries(
              (this.openAPIData.components && this.openAPIData.components.schemas) || {},
            ).find(([k]) => k === ref);
            const isRefObject = (deRefObj?.[1] as SchemaObject | undefined)?.type === "object";
            return {
              ...p,
              isObject: isDirectObject || isRefObject,
              description: escapeComment(p.description ?? ""),
              type: this.getType(this.parameterSchema(p), this.config.namespace),
            };
          });

        if (params.length) {
          templateParams[source] = params;
        }
      });
    }

    if (path && path.length > 0) {
      const regex = /\{([^{}]+)\}/g;
      templateParams.path = templateParams.path || [];
      let match = null;
      while ((match = regex.exec(path))) {
        const name = match[1];
        if (!templateParams.path.some((p) => p.name === name)) {
          templateParams.path.push({
            ...DEFAULT_PATH_PARAM,
            name: match[1],
          });
        }
      }

      // 如果 path 没有内容，则将删除 path 参数，避免影响后续的 hasParams 判断
      if (!templateParams.path.length) delete templateParams.path;
    }

    const all = Object.values(templateParams).flat();
    const used = new Set(
      all
        .filter(
          (parameter) =>
            !all.some((other) => other.name === parameter.name && other.in !== parameter.in),
        )
        .map((parameter) => parameter.name),
    );
    all.forEach((parameter) => {
      if (!all.some((other) => other.name === parameter.name && other.in !== parameter.in)) {
        parameter.inputName = parameter.name;
        return;
      }
      const base = `${parameter.in}.${parameter.name}`;
      let inputName = base;
      let suffix = 2;
      while (used.has(inputName)) inputName = `${base}_${suffix++}`;
      used.add(inputName);
      parameter.inputName = inputName;
    });
    return templateParams;
  }

  public getInterfaceTP(): InterfaceTemplate[] {
    const result: InterfaceTemplate[] = [];
    for (const [name, schema] of Object.entries(this.openAPIData.components?.schemas || {})) {
      for (const direction of ["", "Input", "Output"] as const) {
        const value = direction
          ? this.directionalSchema(schema as LegacySchema, direction)
          : schema;
        const resolved: ResolvedSchema =
          !direction &&
          (schema as LegacySchema).enum &&
          !(schema as LegacySchema).enum!.some(
            (value) => typeof value === "boolean" || value === null,
          ) &&
          this.config.enumStyle === "enum"
            ? this.resolveEnumObject(schema as LegacySchema)
            : (this.config.declareType === "interface" || this.config.nullable) &&
                !(value as LegacySchema).$ref &&
                !(value as LegacySchema).nullable &&
                !(value as LegacySchema).allOf?.length &&
                !(value as LegacySchema).oneOf?.length &&
                !(value as LegacySchema).anyOf?.length &&
                !(value as LegacySchema).enum &&
                (value as LegacySchema).additionalProperties === undefined &&
                Object.keys((value as LegacySchema).properties || {}).length > 0 &&
                [undefined, "object"].includes((value as LegacySchema).type)
              ? this.resolveProperties(value as LegacySchema)
              : { type: this.getType(value) };
        result.push({
          typeName: direction
            ? this.directionName(this.schemaTypeName(name), direction)
            : this.schemaTypeName(name),
          type: resolved.type || "unknown",
          props: resolved.props || [],
          isEnum: resolved.isEnum,
        });
      }
    }
    const seen = new Set<string>();
    for (const api of Object.values(this.apiData).flat()) {
      const typeName = this.getTypeName(api);
      if (seen.has(typeName)) continue;
      seen.add(typeName);
      const parameters = Object.values(this.getParamsTP(api.parameters, api.path)).flat();
      if (!parameters.length) continue;
      result.push({
        typeName,
        type: "Record<string, unknown>",
        props: [
          parameters.map((p) => ({
            name: p.inputName,
            desc: p.description,
            required: p.required,
            type: this.getType(this.parameterSchema(p)),
          })),
        ],
      });
    }
    return result.sort((a, b) => a.typeName.localeCompare(b.typeName));
  }

  private parameterSchema(parameter: ParameterObject): unknown {
    const media = selectMedia(parameter.content);
    if (media && !/(?:\/|\+)json(?:;|$)/i.test(media)) return { type: "string" };
    return parameter.schema || parameter.content?.[media]?.schema || {};
  }

  private allocateTypeNames(): void {
    if (this.namesAllocated) return;
    this.namesAllocated = true;
    const originals = Object.keys(this.openAPIData.components?.schemas || {}).sort();
    const owners = new Map<string, string>();
    for (const original of originals) {
      const base = resolveTypeName(original) || "Schema";
      if (!owners.has(base) || original === base) owners.set(base, original);
    }
    const used = new Set(owners.keys());
    const unique = (base: string): string => {
      let name = base;
      let suffix = 2;
      while (used.has(name)) name = `${base}${suffix++}`;
      used.add(name);
      return name;
    };
    for (const original of originals) {
      const base = resolveTypeName(original) || "Schema";
      this.schemaNames.set(original, owners.get(base) === original ? base : unique(base));
    }
    const operations = Object.values(this.apiData)
      .flat()
      .sort((a, b) =>
        JSON.stringify([a.path, a.method]).localeCompare(JSON.stringify([b.path, b.method])),
      );
    for (const operation of operations) {
      const key = JSON.stringify([operation.path, operation.method]);
      if (this.parameterNames.has(key)) continue;
      const requested =
        this.config.hook?.customTypeName?.(operation) || this.getFuncationName(operation);
      this.parameterNames.set(key, unique(resolveTypeName(`${requested}Params`) || "Params"));
    }
    for (const name of this.schemaNames.values())
      for (const direction of ["Input", "Output"] as const)
        this.directionNames.set(JSON.stringify([name, direction]), unique(name + direction));
  }

  private schemaTypeName(rawName: string): string {
    this.allocateTypeNames();
    return this.schemaNames.get(rawName) || resolveTypeName(rawName) || "Schema";
  }

  private referenceTypeName(schema: LegacySchema): string {
    const token = schema.$ref!.split("/").pop()!;
    return this.schemaTypeName(decodeURIComponent(token).replace(/~1/g, "/").replace(/~0/g, "~"));
  }

  private directionName(name: string, direction: "Input" | "Output"): string {
    this.allocateTypeNames();
    return this.directionNames.get(JSON.stringify([name, direction])) || name;
  }

  private directionalOmissions(
    schema: LegacySchema,
    direction: "Input" | "Output",
    seen = new Set<string>(),
  ): Set<string> {
    if (schema.$ref) {
      if (seen.has(schema.$ref)) return new Set();
      seen.add(schema.$ref);
      return this.directionalOmissions(
        this.resolveRefObject<LegacySchema>(schema),
        direction,
        seen,
      );
    }
    const omitted = new Set<string>();
    for (const [key, property] of Object.entries(schema.properties || {})) {
      const actual = property.$ref ? this.resolveRefObject<LegacySchema>(property) : property;
      if (direction === "Input" ? actual.readOnly : actual.writeOnly) omitted.add(key);
    }
    for (const branch of schema.allOf || [])
      for (const key of this.directionalOmissions(branch, direction, seen)) omitted.add(key);
    return omitted;
  }

  private directionalSchema(schema: LegacySchema, direction: "Input" | "Output"): LegacySchema {
    if (schema.$ref) {
      const name = this.referenceTypeName(schema);
      return { [generatedType]: this.directionName(name, direction) };
    }
    const result = { ...schema };
    delete result.readOnly;
    delete result.writeOnly;
    if (Array.isArray(schema.required)) {
      const omitted = this.directionalOmissions(schema, direction);
      result.required = schema.required.filter((key) => !omitted.has(key));
    }
    if (schema.properties) {
      const properties: Record<string, LegacySchema> = Object.create(null);
      result.properties = properties;
      for (const [key, property] of Object.entries(schema.properties)) {
        const actual = property.$ref ? this.resolveRefObject<LegacySchema>(property) : property;
        if (direction === "Input" ? actual.readOnly : actual.writeOnly) continue;
        properties[key] = this.directionalSchema(property, direction);
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const)
      if (schema[key])
        result[key] = schema[key]!.map((item) => this.directionalSchema(item, direction));
    if (schema.items && !Array.isArray(schema.items))
      result.items = this.directionalSchema(schema.items, direction);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object")
      result.additionalProperties = this.directionalSchema(schema.additionalProperties, direction);
    return result;
  }

  private genFileFromTemplate<T extends TypescriptFileType>(
    fileName: string,
    type: T,
    params: TemplateContexts[T],
  ): GeneratedFile {
    try {
      const template = this.getTemplate(type);
      // 设置输出不转义
      nunjucks.configure({
        autoescape: false,
      });
      return {
        relativePath: fileName,
        content: nunjucks.renderString(template, params),
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[openAPI]: Failed to generate ${fileName} from template "${type}"`);
      throw error;
    }
  }

  private getTemplate(type: TypescriptFileType): string {
    return readFileSync(join(this.config.templatesFolder, `${type}.njk`), "utf8");
  }

  // 获取 TS 类型的属性列表
  getProps(schemaObject: LegacySchema): TemplateProperty[] {
    const requiredPropKeys = schemaObject?.required ?? false;
    return schemaObject.properties
      ? Object.keys(schemaObject.properties).map((propName) => {
          const schema: LegacySchema =
            (schemaObject.properties && schemaObject.properties[propName]) || DEFAULT_SCHEMA;
          return {
            ...schema,
            name: propName,
            type: this.getType(schema),
            desc: this.getDescription(schema),
            // 如果没有 required 信息，默认全部是非必填
            required: Array.isArray(requiredPropKeys)
              ? requiredPropKeys.some((key) => key === propName)
              : false,
          };
        })
      : [];
  }

  getType(schemaObject: unknown, namespace?: string): string {
    const originGetType = (schema: unknown, targetNamespace = namespace || ""): string =>
      defaultGetType(
        schema,
        targetNamespace,
        (value) => this.getDescription(value),
        (reference) => this.referenceTypeName(reference),
      );
    const hookFunc = this.config.hook?.customType;
    if (hookFunc) {
      const type = hookFunc(schemaObject as SchemaObject | undefined, namespace, originGetType);
      if (typeof type === "string") return type;
    }
    return originGetType(schemaObject);
  }

  private getDescription(schema: LegacySchema): string {
    const seen = new Set<string>();
    let current = schema;
    while (!current.title && !current.description && current.$ref && !seen.has(current.$ref)) {
      seen.add(current.$ref);
      const path = current.$ref.split("/");
      if (path.shift() !== "#") break;
      let resolved: unknown = this.openAPIData;
      for (const key of path) {
        resolved = (resolved as Record<string, unknown> | undefined)?.[
          key.replace(/~1/g, "/").replace(/~0/g, "~")
        ];
      }
      if (!resolved || typeof resolved !== "object") break;
      current = resolved as LegacySchema;
    }
    return escapeComment([current.title, current.description].filter(Boolean).join(" "));
  }

  resolveObject(input: unknown): ResolvedSchema | string {
    if (typeof input === "string") return input;
    const schemaObject = (input ?? {}) as LegacySchema;
    // 引用类型
    if (schemaObject.$ref) {
      return { type: this.getType(schemaObject) };
    }
    // 枚举类型
    if (schemaObject.enum) {
      return this.resolveEnumObject(schemaObject);
    }
    if (schemaObject.oneOf?.length || schemaObject.anyOf?.length) {
      return { type: this.getType(schemaObject) };
    }
    // 继承类型
    if (schemaObject.allOf && schemaObject.allOf.length) {
      return this.resolveAllOfObject(schemaObject);
    }
    // 对象类型
    if (schemaObject.properties && Object.keys(schemaObject.properties).length) {
      return this.resolveProperties(schemaObject);
    }
    // 数组类型
    if (schemaObject.items && schemaObject.type === "array") {
      return this.resolveArray(schemaObject);
    }
    return { type: this.getType(schemaObject) };
  }

  resolveArray(schemaObject: LegacySchema): ResolvedSchema | string {
    return { type: this.getType(schemaObject) };
  }

  resolveProperties(schemaObject: LegacySchema): ResolvedSchema {
    return {
      props: [this.getProps(schemaObject)],
    };
  }

  resolveEnumObject(schemaObject: LegacySchema): ResolvedSchema {
    const enumArray = schemaObject.enum!;

    let enumStr;
    switch (this.config.enumStyle) {
      case "enum":
        enumStr = `{${enumArray.map((v, index) => `${JSON.stringify(typeof v === "string" ? v : `Value${index}`)}=${JSON.stringify(typeof v === "boolean" ? String(v) : v)}`).join(",")}}`;
        break;
      case "string-literal":
        enumStr = Array.from(new Set(enumArray.map((v) => JSON.stringify(v)))).join(" | ");
        if (schemaObject.nullable) enumStr += " | null";
        break;
      default:
        break;
    }

    return {
      isEnum: this.config.enumStyle == "enum",
      type: Array.isArray(enumArray) ? enumStr : "string",
    };
  }

  resolveAllOfObject(schemaObject: LegacySchema): ResolvedSchema {
    const props = (schemaObject.allOf || []).map((item) => {
      if (!item.$ref && !item.nullable && !item.oneOf && !item.anyOf && !item.allOf) {
        return this.getProps(item);
      }
      const type = this.getType(item);
      return [{ ...item, isType: true, type: type.includes(" | ") ? `(${type})` : type }];
    });

    if (schemaObject.properties) {
      const extProps = this.getProps(schemaObject);
      return { props: [...props, extProps] };
    }

    return { props };
  }

  // 将地址path路径转为大驼峰
  private genDefaultFunctionName(path: string, pathBasePrefix: string): string {
    // 首字母转大写
    function toUpperFirstLetter(text: string) {
      return text.charAt(0).toUpperCase() + text.slice(1);
    }

    return path
      ?.replace(pathBasePrefix, "")
      .split("/")
      .map((str) => {
        /**
         * 兼容错误命名如 /user/:id/:name
         * 因为是typeName，所以直接进行转换
         * */
        let s = resolveTypeName(str);
        if (s.includes("-")) {
          s = s.replace(/(-\w)+/g, (_match: string, p1) => p1?.slice(1).toUpperCase());
        }

        if (s.match(/^{.+}$/gim)) {
          return `By${toUpperFirstLetter(s.slice(1, s.length - 1))}`;
        }
        return toUpperFirstLetter(s);
      })
      .join("");
  }
  // 检测所有path重复区域（prefix）
  private getBasePrefix(paths: string[]): string {
    const arr: string[][] = [];
    paths
      .map((item) => item.split("/"))
      .forEach((pathItem) => {
        pathItem.forEach((item, key) => {
          if (arr.length <= key) {
            arr[key] = [];
          }
          arr[key].push(item);
        });
      });

    const res: string[][] = [];
    arr
      .map((item) => Array.from(new Set(item)))
      .every((item) => {
        const b = item.length === 1;
        if (b) {
          res.push(item);
        }
        return b;
      });

    return `${res.join("/")}/`;
  }

  private resolveRefObject<T>(refObject: T | ReferenceObject, seen = new Set<string>()): T {
    const reference = refObject as ReferenceObject | undefined;
    if (!reference?.$ref) return refObject as T;
    if (!reference.$ref.startsWith("#/"))
      throw new Error(`[openAPI]: Unresolved reference ${reference.$ref}`);
    if (seen.has(reference.$ref))
      throw new Error(`[openAPI]: Circular reference ${reference.$ref}`);
    seen.add(reference.$ref);
    let value: unknown = this.openAPIData;
    for (const key of reference.$ref.slice(2).split("/")) {
      value = (value as Record<string, unknown> | undefined)?.[
        decodeURIComponent(key).replace(/~1/g, "/").replace(/~0/g, "~")
      ];
    }
    if (!value || typeof value !== "object")
      throw new Error(`[openAPI]: Missing reference ${reference.$ref}`);
    return this.resolveRefObject<T>(value as T, seen);
  }

  private getFinalFileName(s: string): string {
    // 支持下划线、中划线和空格分隔符，注意分隔符枚举值的顺序不能改变，否则正则匹配会报错
    return s.replace(/[-_ ](\w)/g, (_all, letter) => letter.toUpperCase());
  }

  private replaceDot(s: string): string {
    return s.replace(/\./g, "_").replace(/[-_ ](\w)/g, (_all, letter) => letter.toUpperCase());
  }

  private resolveFunctionName(functionName: string, methodName: string): string {
    // async 函数名还需要避开严格模式禁止的绑定名称。
    if (
      reservedWords.has(functionName) ||
      functionName === "eval" ||
      functionName === "arguments"
    ) {
      return `${functionName}Using${methodName.toUpperCase()}`;
    }
    return functionName;
  }
  // 按tag生成类型文件
  private genTypeFilesByTag(declarations: InterfaceTemplate[]): GeneratedFile[] {
    const remaining = new Map(declarations.map((type) => [type.typeName, type]));
    const tags = Object.keys(this.apiData);
    const templates: { fileName: string; context: TemplateContexts["interface"] }[] = [];
    tags.forEach((tag, index) => {
      const names = new Set(
        this.apiData[tag].map((api) =>
          this.parameterNames.get(JSON.stringify([api.path, api.method]))!,
        ),
      );
      const list = declarations.filter(
        (type) =>
          remaining.has(type.typeName) && (names.has(type.typeName) || index === tags.length - 1),
      );
      list.forEach((type) => remaining.delete(type.typeName));
      templates.push({
        fileName: `types/${this.replaceDot(tag)}.d.ts`,
        context: {
          namespace: this.config.namespace,
          nullable: this.config.nullable,
          list,
          disableTypeCheck: false,
          declareType: this.config.declareType || "type",
          equalSymbol: (this.config.declareType || "type") === "type" ? "=" : "",
        },
      });
    });
    if (!tags.length && declarations.length)
      templates.push({
        fileName: "types/common.d.ts",
        context: {
          namespace: this.config.namespace,
          list: declarations,
          declareType: "type",
          equalSymbol: "=",
        },
      });
    return templates.map(({ fileName, context }) =>
      this.genFileFromTemplate(fileName, "interface", context),
    );
  }
}

export { ServiceGenerator };
