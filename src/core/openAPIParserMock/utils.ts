import type { OperationObject } from "openapi3-ts/oas30";

function isObject(obj: unknown): obj is Record<string, unknown> {
  return !!obj && typeof obj === "object";
}

function get<T = unknown>(entity: unknown, path: (string | number)[]): T | undefined {
  let current: unknown = entity;

  for (const key of path) {
    if (current === null || current === undefined) {
      return undefined;
    }

    current = (current as Record<string | number, unknown>)[key];
  }

  return current as T | undefined;
}

function isOperationObject(thing: unknown): thing is OperationObject {
  return isObject(thing) && isObject(thing.responses);
}

const httpMethods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

function selectResponse(responses: OperationObject["responses"]): { code: string; status: string } {
  const codes = Object.keys(responses || {});
  const code =
    codes.filter((item) => /^2\d\d$/.test(item)).sort()[0] ||
    (codes.includes("2XX") ? "2XX" : undefined) ||
    codes.filter((item) => /^[1-5]\d\d$/.test(item)).sort()[0] ||
    (codes.includes("default") ? "default" : undefined) ||
    codes.find((item) => /^[1-5]XX$/.test(item));
  if (!code) throw new Error("[openAPI mock]: No usable response");
  return { code, status: code === "default" ? "500" : code.replace("XX", "00") };
}

function resolveLocalRef<T extends object>(document: unknown, value: T): T {
  let current = value;
  const seen = new Set<string>();
  while ("$ref" in current) {
    const ref = current.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) {
      throw new Error(`[openAPI mock]: Only local JSON pointer refs are supported: ${String(ref)}`);
    }
    if (seen.has(ref)) throw new Error(`[openAPI mock]: Cyclic ref: ${ref}`);
    seen.add(ref);
    const parts = decodeURIComponent(ref.slice(2))
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let target: unknown = document;
    for (const part of parts) {
      if (!isObject(target) || !Object.prototype.hasOwnProperty.call(target, part)) {
        throw new Error(`[openAPI mock]: Missing ref: ${ref}`);
      }
      target = target[part];
    }
    if (!isObject(target) || Array.isArray(target))
      throw new Error(`[openAPI mock]: Invalid ref target: ${ref}`);
    current = target as T;
  }
  return current;
}

export { isObject, get, isOperationObject, httpMethods, resolveLocalRef, selectResponse };
