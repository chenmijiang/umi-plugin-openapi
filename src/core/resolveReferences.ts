import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { OpenAPIObject } from "openapi3-ts/oas30";

type ObjectValue = Record<string, unknown>;
type ObjectKind =
  | "schema"
  | "pathItem"
  | "operation"
  | "parameter"
  | "header"
  | "requestBody"
  | "response"
  | "mediaType"
  | "encoding"
  | "example"
  | "link"
  | "callback"
  | "securityScheme";

const objectValue = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointerToken = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const componentKinds: Record<string, ObjectKind> = {
  schemas: "schema",
  responses: "response",
  parameters: "parameter",
  examples: "example",
  requestBodies: "requestBody",
  headers: "header",
  securitySchemes: "securityScheme",
  links: "link",
  callbacks: "callback",
};

/** Resolve only OAS object positions: examples, defaults and extension payloads are data. */
export async function resolveReferences(
  document: OpenAPIObject,
  schemaPath: string,
  authorization?: string,
  authorizationSource = schemaPath,
): Promise<OpenAPIObject> {
  const rootURL = /^https?:\/\//i.test(schemaPath)
    ? new URL(schemaPath)
    : pathToFileURL(resolve(schemaPath));
  rootURL.hash = "";
  const rootLocation = rootURL.href;
  const rootOrigin = /^https?:\/\//i.test(authorizationSource)
    ? new URL(authorizationSource).origin
    : undefined;
  const documents = new Map<string, Promise<unknown>>([[rootLocation, Promise.resolve(document)]]);
  const effectiveLocations = new Map<string, string>();
  const schemaNames = new Map<string, string>();
  const checkedSchemaAliases = new Set<string>();
  const schemas: ObjectValue = { ...document.components?.schemas };
  const occupiedNames = Object.keys(schemas).map((name) =>
    name.replace(/[^a-z0-9]/gi, "").toLowerCase(),
  );
  let schemaNumber = 0;
  const resolvedObjects = new Map<string, ObjectValue>();
  const resolvingObjects = new Set<string>();

  for (const name of Object.keys(schemas)) {
    schemaNames.set(`${rootLocation}#/components/schemas/${pointerToken(name)}`, name);
  }

  async function loadDocument(location: string) {
    let pending = documents.get(location);
    if (!pending) {
      pending = (async () => {
        const url = new URL(location);
        if (url.protocol === "file:") {
          return JSON.parse(await readFile(fileURLToPath(url), "utf8")) as unknown;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error(`[openAPI]: Unsupported reference protocol: ${url.protocol}`);
        }
        const response = await fetch(url, {
          headers: authorization && url.origin === rootOrigin ? { authorization } : {},
        });
        if (!response.ok) {
          throw new Error(
            `[openAPI]: Failed to load reference ${location}: HTTP ${response.status}`,
          );
        }
        const schema: unknown = await response.json();
        effectiveLocations.set(location, response.url);
        documents.set(response.url, Promise.resolve(schema));
        return schema;
      })();
      documents.set(location, pending);
    }
    return pending;
  }

  async function targetOf(reference: string, base: string) {
    const url = new URL(reference, base);
    if (/^https?:$/.test(new URL(base).protocol) && url.protocol === "file:") {
      throw new Error(`[openAPI]: Remote documents cannot reference local files: ${reference}`);
    }
    const pointer = decodeURIComponent(url.hash.slice(1));
    url.hash = "";
    const location = url.href;
    if (pointer && !pointer.startsWith("/")) {
      throw new Error(`[openAPI]: Invalid JSON pointer in reference: ${reference}`);
    }
    const tokens = pointer
      ? pointer
          .slice(1)
          .split("/")
          .map((token) => {
            if (/~(?:[^01]|$)/.test(token)) {
              throw new Error(`[openAPI]: Invalid JSON pointer token in reference: ${reference}`);
            }
            return token.replace(/~1/g, "/").replace(/~0/g, "~");
          })
      : [];
    let target = await loadDocument(location);
    for (const token of tokens) {
      if ((!objectValue(target) && !Array.isArray(target)) || !Object.hasOwn(target, token)) {
        throw new Error(`[openAPI]: Unresolved reference: ${reference} in ${base}`);
      }
      target = (target as ObjectValue)[token];
    }
    if (!objectValue(target)) {
      throw new Error(`[openAPI]: Reference must resolve to an object: ${reference} in ${base}`);
    }
    const effectiveLocation = effectiveLocations.get(location) || location;
    const key = `${effectiveLocation}#${tokens.length ? `/${tokens.map(pointerToken).join("/")}` : ""}`;
    return { target, location: effectiveLocation, key };
  }

  async function schemaReference(reference: string, base: string) {
    const { target, location, key } = await targetOf(reference, base);
    if (typeof target.$ref === "string" && !checkedSchemaAliases.has(key)) {
      const aliases = new Set<string>();
      let current = { target, location, key };
      while (typeof current.target.$ref === "string") {
        if (checkedSchemaAliases.has(current.key)) break;
        if (aliases.has(current.key)) {
          throw new Error(`[openAPI]: Circular schema alias reference: ${reference} in ${base}`);
        }
        aliases.add(current.key);
        current = await targetOf(current.target.$ref, current.location);
      }
      for (const alias of aliases) checkedSchemaAliases.add(alias);
    }
    let name = schemaNames.get(key);
    if (!name) {
      do {
        name = `OpenAPIExternalReference${++schemaNumber}`;
      } while (occupiedNames.some((existing) => existing.includes(name!.toLowerCase())));
      occupiedNames.push(name.toLowerCase());
      // Register before descending so recursive schema edges remain named references.
      schemaNames.set(key, name);
      schemas[name] = await visit(target, "schema", location);
    }
    return { $ref: `#/components/schemas/${pointerToken(name)}` };
  }

  async function inlineReference(reference: string, kind: ObjectKind, base: string) {
    const { target, location, key } = await targetOf(reference, base);
    const identity = `${kind}:${key}`;
    const cached = resolvedObjects.get(identity);
    if (cached) return cached;
    if (resolvingObjects.has(identity)) {
      if (kind === "callback") {
        const aliases = new Set<string>();
        let current = { target, location, key };
        while (typeof current.target.$ref === "string") {
          if (aliases.has(current.key)) {
            throw new Error(
              `[openAPI]: Circular callback alias reference: ${reference} in ${base}`,
            );
          }
          aliases.add(current.key);
          current = await targetOf(current.target.$ref, current.location);
        }
        // Callback structure can recurse; keep a reference edge, never a JS object cycle.
        return { $ref: location === rootLocation ? key.slice(rootLocation.length) : key };
      }
      throw new Error(`[openAPI]: Circular ${kind} reference: ${reference} in ${base}`);
    }
    resolvingObjects.add(identity);
    try {
      const result = await visit(target, kind, location);
      resolvedObjects.set(identity, result);
      return result;
    } finally {
      resolvingObjects.delete(identity);
    }
  }

  async function visitMap(value: unknown, kind: ObjectKind, base: string, extensions = false) {
    if (!objectValue(value)) return value;
    const result = { ...value };
    for (const [name, child] of Object.entries(value)) {
      if (!extensions || !name.startsWith("x-")) result[name] = await visit(child, kind, base);
    }
    return result;
  }

  async function visit(value: unknown, kind: ObjectKind, base: string): Promise<ObjectValue> {
    if (!objectValue(value)) return value as ObjectValue;
    if (typeof value.$ref === "string") {
      if (kind === "schema") return schemaReference(value.$ref, base);
      const referenced = await inlineReference(value.$ref, kind, base);
      if (kind !== "pathItem") return referenced;
      // Path Item siblings are fields, unlike Reference Object siblings. Conflicts are undefined by OAS.
      const { $ref: _reference, ...siblings } = value;
      return { ...(await visit(siblings, kind, base)), ...referenced };
    }
    const result = { ...value };
    const source = value;
    async function field(name: string, childKind: ObjectKind) {
      if (source[name] !== undefined) result[name] = await visit(source[name], childKind, base);
    }
    async function map(name: string, childKind: ObjectKind) {
      if (source[name] !== undefined) result[name] = await visitMap(source[name], childKind, base);
    }
    async function array(name: string, childKind: ObjectKind) {
      const entries = source[name];
      if (Array.isArray(entries)) {
        const children = [];
        for (const child of entries) children.push(await visit(child, childKind, base));
        result[name] = children;
      }
    }
    switch (kind) {
      case "schema":
        await map("properties", "schema");
        await field("items", "schema");
        await field("not", "schema");
        if (objectValue(value.additionalProperties)) await field("additionalProperties", "schema");
        for (const name of ["allOf", "anyOf", "oneOf"]) await array(name, "schema");
        if (objectValue(value.discriminator) && objectValue(value.discriminator.mapping)) {
          const mapping = { ...value.discriminator.mapping };
          const owner = await loadDocument(base);
          const ownerSchemas =
            objectValue(owner) &&
            objectValue(owner.components) &&
            objectValue(owner.components.schemas)
              ? owner.components.schemas
              : {};
          for (const [name, reference] of Object.entries(mapping)) {
            if (typeof reference !== "string") continue;
            const target = Object.hasOwn(ownerSchemas, reference)
              ? `#/components/schemas/${pointerToken(reference)}`
              : reference;
            mapping[name] = (await schemaReference(target, base)).$ref;
          }
          result.discriminator = { ...value.discriminator, mapping };
        }
        break;
      case "pathItem":
        for (const method of methods) await field(method, "operation");
        await array("parameters", "parameter");
        break;
      case "operation":
        await array("parameters", "parameter");
        await field("requestBody", "requestBody");
        if (value.responses !== undefined)
          result.responses = await visitMap(value.responses, "response", base, true);
        await map("callbacks", "callback");
        break;
      case "parameter":
      case "header":
        await field("schema", "schema");
        await map("content", "mediaType");
        await map("examples", "example");
        break;
      case "requestBody":
        await map("content", "mediaType");
        break;
      case "response":
        await map("content", "mediaType");
        await map("headers", "header");
        await map("links", "link");
        break;
      case "mediaType":
        await field("schema", "schema");
        await map("examples", "example");
        await map("encoding", "encoding");
        break;
      case "encoding":
        await map("headers", "header");
        break;
      case "callback":
        return (await visitMap(value, "pathItem", base, true)) as ObjectValue;
      // Example.value and Link expression values are payloads, not OAS object positions.
      case "example":
      case "link":
      case "securityScheme":
        break;
    }
    return result;
  }

  const components: ObjectValue = { ...document.components };
  for (const [name, kind] of Object.entries(componentKinds)) {
    if (kind === "schema") {
      for (const [schemaName, schema] of Object.entries(document.components?.schemas || {})) {
        schemas[schemaName] = await visit(schema, "schema", rootLocation);
      }
    } else if (components[name] !== undefined) {
      components[name] = await visitMap(components[name], kind, rootLocation);
    }
  }
  const paths = await visitMap(document.paths, "pathItem", rootLocation, true);
  if (Object.keys(schemas).length) components.schemas = schemas;
  return {
    ...document,
    paths,
    ...(Object.keys(components).length ? { components } : {}),
  } as OpenAPIObject;
}
