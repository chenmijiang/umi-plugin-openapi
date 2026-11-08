import type {
  ExampleObject,
  OpenAPIObject,
  ReferenceObject,
  SchemaObject,
} from "openapi3-ts/oas30";

import {
  httpMethods,
  isOperationObject,
  normalizeOperations,
  resolveLocalRef,
} from "../operations";
import primitives from "./primitives";
import * as utils from "./utils";

export type MockValue = string | number | boolean | null | undefined | MockValue[] | MockObject;
type MockObject = { [key: string]: MockValue };

const getDateByName = (name?: string[] | string, parentsKey: string[] = []): string => {
  if (!name || name.length < 1) {
    return "string";
  }
  if (Array.isArray(name)) {
    return getDateByName([...name].pop(), name);
  }
  if (["nickname", "name"].includes(name)) {
    return "cname";
  }
  if (["owner", "firstName", "lastName", "username"].includes(name)) {
    return "name";
  }
  if (["avatar"].includes(name)) {
    return "avatar";
  }

  if (["group"].includes(name)) {
    return "group";
  }

  if (name.toLocaleLowerCase().endsWith("id")) {
    return "uuid";
  }

  if (
    name.toLocaleLowerCase().endsWith("type") ||
    name.toLocaleLowerCase().endsWith("key") ||
    ["key"].includes(name)
  ) {
    return "id";
  }

  if (name.toLocaleLowerCase().endsWith("label") || ["label"].includes(name)) {
    const newParents = [...parentsKey];
    newParents.pop();
    const newType = getDateByName(newParents);
    if (newType !== "string" && newType !== "csentence") {
      return newType;
    }

    return "label";
  }

  if (["email"].includes(name)) {
    return "email";
  }
  if (["password"].includes(name)) {
    return "string(16)";
  }
  if (["phone"].includes(name)) {
    return "phone";
  }
  if (["province"].includes(name)) {
    return "province";
  }
  if (["city"].includes(name)) {
    return "city";
  }
  if (["addr", "address"].includes(name)) {
    return "county";
  }

  if (["country"].includes(name)) {
    return "country";
  }

  if (
    ["url", "imageUrl", "href"].includes(name) ||
    name.toLocaleLowerCase().endsWith("url") ||
    name.toLocaleLowerCase().endsWith("urls") ||
    name.toLocaleLowerCase().endsWith("image") ||
    name.toLocaleLowerCase().endsWith("link")
  ) {
    return "href";
  }

  if (name.toLocaleLowerCase().endsWith("errorcode")) {
    return "errorCode";
  }

  if (
    ["type", "status"].includes(name) ||
    name.toLocaleLowerCase().endsWith("status") ||
    name.toLocaleLowerCase().endsWith("type")
  ) {
    return "status";
  }

  if (name.toLocaleLowerCase().endsWith("authority")) {
    return "authority";
  }

  return "csentence";
};

function primitive(schema: SchemaObject, propsName?: string[]): MockValue {
  const { type, format } = schema;
  const value =
    primitives[`${String(type)}_${format || getDateByName(propsName)}`] || primitives[String(type)];

  if (typeof schema.example === "undefined") {
    return value || `Unknown Type: ${String(schema.type)}`;
  }
  return schema.example as MockValue;
}

class RecursiveSampleError extends Error {}

class OpenAPIGeneratorMockJs {
  protected openAPI: OpenAPIObject;
  constructor(openAPI: OpenAPIObject) {
    this.openAPI = openAPI;
  }

  sampleFromSchema = (
    schema: SchemaObject | ReferenceObject | undefined,
    propsName?: string[],
    schemaSet: Set<string> = new Set(),
    requiredNames: ReadonlySet<string> = new Set(),
  ): MockValue => {
    if (!schema) return undefined;
    const schemaRef = "$ref" in schema ? schema.$ref : undefined;
    const localSchema = resolveLocalRef(this.openAPI, schema) as SchemaObject;
    if (localSchema.example !== undefined) return localSchema.example as MockValue;
    if (localSchema.default !== undefined) return localSchema.default as MockValue;
    if (localSchema.enum?.length) return localSchema.enum[0] as MockValue;
    if (schemaRef && schemaSet.has(schemaRef)) {
      if (localSchema.nullable && localSchema.type) return null;
      if (localSchema.type === "array" && !localSchema.minItems) return [];
      throw new RecursiveSampleError(
        `[openAPI mock]: Recursive schema ref cannot produce a finite sample: ${schemaRef}`,
      );
    }
    const nextSet = new Set(schemaSet);
    if (schemaRef) nextSet.add(schemaRef);
    if (localSchema.not)
      throw new Error(
        "[openAPI mock]: Cannot synthesize a sample for a not schema; provide an example",
      );

    const { properties, additionalProperties, items, anyOf, oneOf, allOf } = localSchema;
    if (allOf?.length) {
      const { allOf: _allOf, ...ownSchema } = localSchema;
      const composedRequired = new Set([
        ...requiredNames,
        ...(localSchema.required || []),
        ...allOf.flatMap(
          (item) => (resolveLocalRef(this.openAPI, item) as SchemaObject).required || [],
        ),
      ]);
      const samples = allOf.map((item) =>
        this.sampleFromSchema(item, propsName, nextSet, composedRequired),
      );
      if (ownSchema.type || ownSchema.properties)
        samples.push(this.sampleFromSchema(ownSchema, propsName, nextSet, composedRequired));
      if (samples.every((item) => utils.isObject(item) && !Array.isArray(item))) {
        return Object.assign(Object.create(null), ...samples) as MockObject;
      }
      if (samples.every((item) => item === samples[0])) return samples[0];
      throw new Error(
        "[openAPI mock]: Cannot synthesize incompatible allOf samples; provide an example",
      );
    }
    const alternatives = oneOf || anyOf;
    if (alternatives?.length) {
      let selected: MockValue;
      let recursiveError: RecursiveSampleError | undefined;
      for (const alternative of alternatives) {
        try {
          selected = this.sampleFromSchema(alternative, propsName, nextSet);
          recursiveError = undefined;
          break;
        } catch (error) {
          if (!(error instanceof RecursiveSampleError)) throw error;
          recursiveError = error;
        }
      }
      if (recursiveError) throw recursiveError;
      if (properties) {
        const { oneOf: _oneOf, anyOf: _anyOf, ...ownSchema } = localSchema;
        const own = this.sampleFromSchema(ownSchema, propsName, nextSet);
        if (utils.isObject(selected) && utils.isObject(own))
          return { ...own, ...selected } as MockObject;
      }
      return selected;
    }
    const type =
      localSchema.type ||
      (properties || additionalProperties ? "object" : items ? "array" : undefined);
    if (type === "object") {
      const obj: MockObject = Object.create(null);
      for (const [name, property] of Object.entries(properties || {})) {
        const resolved = resolveLocalRef(this.openAPI, property) as SchemaObject;
        // writeOnly applies to requests, even when the name occurs in required.
        if (resolved.writeOnly) continue;
        try {
          obj[name] = this.sampleFromSchema(property, [...(propsName || []), name], nextSet);
        } catch (error) {
          if (
            !(error instanceof RecursiveSampleError) ||
            localSchema.required?.includes(name) ||
            requiredNames.has(name)
          )
            throw error;
          // Optional recursion can terminate by omitting the property, not by inventing null.
        }
      }
      if (additionalProperties && typeof additionalProperties === "object") {
        try {
          obj.additionalProp1 = this.sampleFromSchema(additionalProperties, propsName, nextSet);
        } catch (error) {
          if (!(error instanceof RecursiveSampleError)) throw error;
        }
      }
      return obj;
    }
    if (type === "array") {
      const length = localSchema.minItems ?? (localSchema.maxItems === 0 ? 0 : 1);
      if (length === 0) return [];
      try {
        const item = this.sampleFromSchema(items, propsName, nextSet);
        return Array.from({ length }, () => item);
      } catch (error) {
        if (!(error instanceof RecursiveSampleError) || localSchema.minItems) throw error;
        return [];
      }
    }
    if (!type) return localSchema.nullable ? null : {};
    return primitive(localSchema, propsName);
  };

  parser = (): OpenAPIObject => {
    const openAPI = normalizeOperations(this.openAPI);
    for (const path of Object.keys(openAPI.paths).filter((key) => key.startsWith("/"))) {
      const pathConfig = openAPI.paths[path];
      openAPI.paths[path] = { ...pathConfig };
      for (const method of httpMethods) {
        const original = pathConfig[method];
        if (!isOperationObject(original)) continue;
        const api = { ...original, responses: { ...original.responses } };
        openAPI.paths[path][method] = api;
        const { code } = utils.selectResponse(api.responses);
        const response = { ...resolveLocalRef(this.openAPI, api.responses[code]) };
        api.responses[code] = response;
        const content = response.content || {};
        const keys = Object.keys(content);
        const media =
          content[
            keys.includes("application/json")
              ? "application/json"
              : keys.includes("*/*")
                ? "*/*"
                : keys[0]
          ];
        if (!media) continue;
        let example: MockValue;
        if (media.example !== undefined) {
          example = media.example as MockValue;
        } else if (media.examples && Object.keys(media.examples).length) {
          const candidate = Object.values(media.examples)[0];
          if (!utils.isObject(candidate)) throw new Error("[openAPI mock]: Invalid media example");
          const first = resolveLocalRef(this.openAPI, candidate) as ExampleObject;
          if (first.externalValue)
            throw new Error(
              "[openAPI mock]: externalValue examples are not fetched; provide a value",
            );
          example = first.value as MockValue;
        } else {
          example = this.sampleFromSchema(media.schema);
        }
        Object.assign(response, { example });
      }
    }
    return openAPI;
  };
}

export default OpenAPIGeneratorMockJs;
