import type { OperationObject, ReferenceObject, SchemaObject } from "openapi3-ts/oas30";

function isObject(obj: unknown): obj is Record<string, unknown> {
  return !!obj && typeof obj === "object";
}

function objectify<T extends object>(thing: T | null | undefined): T | Record<string, never> {
  if (!isObject(thing)) return {};
  return thing;
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

function normalizeArray<T>(arr: T | T[]): T[] {
  if (Array.isArray(arr)) return arr;
  return [arr];
}

function isFunc(thing: unknown): thing is (...args: unknown[]) => unknown {
  return typeof thing === "function";
}

function inferSchema(thing: unknown): SchemaObject | ReferenceObject | undefined {
  if (!isObject(thing)) return undefined;
  if (thing.schema) {
    return thing.schema as SchemaObject | ReferenceObject;
  }

  if (thing.properties) {
    return {
      ...thing,
      type: "object",
    } as SchemaObject;
  }

  return thing as SchemaObject | ReferenceObject;
}

function getRandomInt(min: number, max: number): number {
  const minCeiled = Math.ceil(min);
  const maxFloored = Math.floor(max);
  return Math.floor(Math.random() * (maxFloored - minCeiled) + minCeiled);
}

function isOperationObject(thing: unknown): thing is OperationObject {
  return isObject(thing) && isObject(thing.responses);
}

export {
  isObject,
  get,
  objectify,
  isFunc,
  inferSchema,
  normalizeArray,
  getRandomInt,
  isOperationObject,
};
