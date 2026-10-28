import memoizee from "memoizee";
import type { OpenAPIObject, ReferenceObject, SchemaObject } from "openapi3-ts/oas30";

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

class OpenAPIGeneratorMockJs {
  protected openAPI: OpenAPIObject;
  constructor(openAPI: OpenAPIObject) {
    this.openAPI = openAPI;
    this.sampleFromSchema = memoizee(this.sampleFromSchema);
  }

  sampleFromSchema = (
    schema: SchemaObject | ReferenceObject | undefined,
    propsName?: string[],
    schemaSet: Set<string> = new Set(),
  ): MockValue => {
    const schemaRef = schema && "$ref" in schema ? (schema.$ref as string) : undefined;

    if (schemaRef) {
      // 如果之前已经使用过该引用结构，直接返回null,不然会陷入无限递归的情况
      if (schemaSet.has(schemaRef)) {
        return null;
      } else {
        schemaSet.add(schemaRef);
      }
    }

    const localSchema = utils.objectify(
      schemaRef
        ? utils.get<SchemaObject>(this.openAPI, schemaRef.replace("#/", "").split("/"))
        : (schema as SchemaObject | undefined),
    );

    let type: string | string[] | undefined = localSchema.type;
    const { properties, additionalProperties, items, anyOf, oneOf, allOf } = localSchema;

    if (allOf) {
      let obj: MockObject = {};
      allOf.forEach((item) => {
        const newObj = this.sampleFromSchema(item, propsName, new Set(schemaSet));
        obj = {
          ...obj,
          ...(newObj as MockObject | null | undefined),
        };
      });
      return obj;
    }

    if (!type) {
      if (properties) {
        type = "object";
      } else if (items) {
        type = "array";
      } else if (anyOf || oneOf) {
        type = "union";
      } else {
        return null;
      }
    }

    if (type === "null") {
      return null;
    }

    if (type === "object") {
      const props = utils.objectify(properties);
      const obj: MockObject = {};
      for (const name in props) {
        obj[name] = this.sampleFromSchema(
          props[name],
          [...(propsName || []), name],
          new Set(schemaSet),
        );
      }

      if (additionalProperties === true) {
        obj.additionalProp1 = {};
        return obj;
      }
      if (additionalProperties) {
        const additionalPropVal = this.sampleFromSchema(
          additionalProperties,
          propsName,
          new Set(schemaSet),
        );

        for (let i = 1; i < 4; i += 1) {
          obj[`additionalProp${i}`] = additionalPropVal;
        }
      }
      return obj;
    }

    if (type === "array") {
      const item = this.sampleFromSchema(items, propsName, new Set(schemaSet));
      return Array.from({ length: parseInt((Math.random() * 20).toFixed(0), 10) }, () => item);
    }

    if (type === "union") {
      const subschemas = anyOf || oneOf || [];
      const subschemas_length = subschemas.length;
      if (subschemas_length) {
        const index = utils.getRandomInt(0, subschemas_length);
        const obj = this.sampleFromSchema(subschemas[index], propsName, new Set(schemaSet));
        return obj;
      }
    }

    if (localSchema.enum) {
      if (localSchema.default) return localSchema.default as MockValue;
      return utils.normalizeArray(localSchema.enum as MockValue[])[0];
    }

    if (type === "file") {
      return null;
    }
    return primitive(localSchema, propsName);
  };

  parser = (): OpenAPIObject => {
    const openAPI = {
      ...this.openAPI,
    };
    for (const path in openAPI.paths) {
      const pathConfig = openAPI.paths[path];
      for (const method in pathConfig) {
        const api: unknown = pathConfig[method as keyof typeof pathConfig];
        if (!utils.isOperationObject(api)) continue;
        for (const code in api.responses) {
          const response = api.responses[code];
          if ("$ref" in response) continue;

          const keys = Object.keys(response.content || {});
          if (keys.length) {
            let key: string;

            if (keys.includes("application/json")) {
              key = "application/json";
            } else if (keys.includes("*/*")) {
              key = "*/*";
            } else {
              key = keys[0];
            }

            const schema = utils.inferSchema(response.content[key]);

            if (schema) {
              Object.assign(response, { example: this.sampleFromSchema(schema) });
            }
          }
        }
        if (!api.parameters) continue;
        for (const parameter of api.parameters) {
          const schema = utils.inferSchema(parameter);
          Object.assign(parameter, { example: schema ? this.sampleFromSchema(schema) : null });
        }
      }
    }
    return openAPI;
  };
}

export default OpenAPIGeneratorMockJs;
