/**
 * Minimal Zod → JSON Schema converter for tool input schemas.
 *
 * Zod 3 has no built-in JSON-schema export, and we keep the dependency
 * surface to just `zod`. This covers the shapes tool inputs actually use:
 * object, string, number, boolean, array, enum, literal, optional, nullable,
 * default, and `.describe()` annotations. Unknown nodes fall back to `{}`.
 */

import type { ZodTypeAny } from "zod";

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean;
}

function def(schema: ZodTypeAny): any {
  return (schema as unknown as { _def: any })._def;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const d = def(schema);
  const typeName: string = d?.typeName ?? "";
  const description: string | undefined = schema.description ?? d?.description;
  const withDesc = (s: JsonSchema): JsonSchema =>
    description ? { description, ...s } : s;

  switch (typeName) {
    case "ZodObject": {
      const shape = typeof d.shape === "function" ? d.shape() : d.shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape) as [
        string,
        ZodTypeAny,
      ][]) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: JsonSchema = {
        type: "object",
        properties,
        additionalProperties: false,
      };
      if (required.length) out.required = required;
      return withDesc(out);
    }
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber":
      return withDesc({ type: "number" });
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodArray":
      return withDesc({ type: "array", items: zodToJsonSchema(d.type) });
    case "ZodEnum":
      return withDesc({ type: "string", enum: d.values });
    case "ZodLiteral":
      return withDesc({ const: d.value });
    case "ZodOptional":
    case "ZodNullable":
      return withDesc(zodToJsonSchema(d.innerType));
    case "ZodDefault": {
      const inner = zodToJsonSchema(d.innerType);
      try {
        inner.default = d.defaultValue();
      } catch {
        /* ignore */
      }
      return withDesc(inner);
    }
    default:
      return withDesc({});
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const typeName = def(schema)?.typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}
