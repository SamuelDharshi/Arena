/**
 * Minimal JSON-schema check for the subset our decision schemas use (object, array, string, boolean, enum, required,
 * additionalProperties:false). Used when a provider cannot enforce a schema itself and we ask for plain JSON instead.
 */
export function validateAgainstSchema(schema: Record<string, unknown>, data: unknown, path = "$"): string | null {
  const type = schema.type as string | undefined;
  const enumVals = schema.enum as unknown[] | undefined;
  if (enumVals && !enumVals.includes(data)) return `${path}: ${JSON.stringify(data)} is not one of ${enumVals.join(", ")}`;
  switch (type) {
    case "object": {
      if (!data || typeof data !== "object" || Array.isArray(data)) return `${path}: expected an object`;
      const obj = data as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (!(key in obj)) return `${path}.${key}: missing`;
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) if (!(key in props)) return `${path}.${key}: not allowed`;
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) {
          const err = validateAgainstSchema(sub, obj[key], `${path}.${key}`);
          if (err) return err;
        }
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(data)) return `${path}: expected an array`;
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) {
        for (let i = 0; i < data.length; i++) {
          const err = validateAgainstSchema(items, data[i], `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }
    case "string":
      return typeof data === "string" ? null : `${path}: expected a string`;
    case "boolean":
      return typeof data === "boolean" ? null : `${path}: expected a boolean`;
    default:
      return null;
  }
}

/** Models sometimes wrap JSON in code fences or a reasoning preamble: pull out the JSON object. */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : stripped;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SyntaxError("no JSON object in response");
  return JSON.parse(candidate.slice(start, end + 1));
}
