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

export { isObject, get, selectResponse };
