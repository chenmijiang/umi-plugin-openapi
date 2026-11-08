import type { OpenAPIObject, OperationObject, ParameterObject } from "openapi3-ts/oas30";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

export const httpMethods = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export function isOperationObject(value: unknown): value is OperationObject {
  return isObject(value) && isObject(value.responses);
}

export function resolveLocalRef<T extends object>(document: unknown, value: T): T {
  let current = value;
  const seen = new Set<string>();
  while ("$ref" in current) {
    const ref = current.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) {
      throw new Error(`[openAPI]: Only local JSON pointer refs are supported: ${String(ref)}`);
    }
    if (seen.has(ref)) throw new Error(`[openAPI]: Cyclic ref: ${ref}`);
    seen.add(ref);
    const parts = decodeURIComponent(ref.slice(2))
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let target: unknown = document;
    for (const part of parts) {
      if (!isObject(target) || !Object.prototype.hasOwnProperty.call(target, part)) {
        throw new Error(`[openAPI]: Missing ref: ${ref}`);
      }
      target = target[part];
    }
    if (!isObject(target) || Array.isArray(target))
      throw new Error(`[openAPI]: Invalid ref target: ${ref}`);
    current = target as T;
  }
  return current;
}

/** Share operation inheritance without interpreting schemas, media, or response selection. */
export function normalizeOperations(document: OpenAPIObject): OpenAPIObject {
  const paths = { ...document.paths };
  for (const path of Object.keys(paths).filter((key) => key.startsWith("/"))) {
    const original = paths[path];
    const resolved = resolveLocalRef(document, original);
    const pathItem = { ...original, ...resolved };
    delete pathItem.$ref;
    paths[path] = pathItem;
    const inherited = (pathItem.parameters || []).map(
      (parameter) => ({ ...resolveLocalRef(document, parameter) }) as ParameterObject,
    );
    if (pathItem.parameters) pathItem.parameters = inherited;
    for (const method of httpMethods) {
      const value = pathItem[method];
      if (!value || typeof value !== "object") continue;
      const operation = resolveLocalRef(document, value);
      if (!isOperationObject(operation)) continue;
      const parameters = new Map<string, ParameterObject>();
      for (const parameter of [...inherited, ...(operation.parameters || [])]) {
        const resolvedParameter = resolveLocalRef(document, parameter) as ParameterObject;
        parameters.set(`${resolvedParameter.in}:${resolvedParameter.name}`, {
          ...resolvedParameter,
        });
      }
      pathItem[method] = {
        ...operation,
        parameters: [...parameters.values()],
        servers: operation.servers ?? pathItem.servers ?? document.servers,
      };
    }
  }
  return { ...document, paths };
}
