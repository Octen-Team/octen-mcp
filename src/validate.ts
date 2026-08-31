/**
 * Validation of tool arguments against the tool's own advertised schema.
 *
 * The MCP SDK does not enforce `inputSchema` — measured: `count: 999999`
 * against a schema declaring `maximum: 100`, a 5000-character `query` against
 * `maxLength: 500`, and a 5000-entry array against `maxItems: 1000` were all
 * forwarded to the upstream API verbatim. So every constraint we publish was
 * advertising, not a contract. Two costs. An agent that reads the schema and
 * respects it gets no benefit over one that ignores it, and when it does get
 * something wrong the answer comes back as an opaque upstream 400 instead of a
 * sentence naming the field. And whatever the caller sends is relayed onward,
 * which makes this server a pass-through for arbitrary JSON.
 *
 * The validator reads the same `inputSchema` object that is sent to clients,
 * never a copy of its rules. A duplicated rule set drifts the first time
 * someone edits a schema, and drifts silently — the failure would be a limit
 * that is enforced at a value nobody advertised.
 *
 * It implements exactly the vocabulary those schemas use and nothing else, and
 * {@link unsupportedKeywords} exists so a test can assert that stays true: a
 * keyword the validator does not know would otherwise be ignored, turning a
 * published constraint back into advertising without anyone noticing.
 */

/** JSON Schema keywords this validator enforces. */
const ENFORCED = new Set([
  "type", "enum", "minimum", "maximum", "maxLength", "minLength",
  "minItems", "maxItems", "required", "properties", "items",
]);

/** Keywords that carry no constraint — safe to ignore. */
const ANNOTATIONS = new Set(["description", "default", "title", "examples"]);

/**
 * Every keyword in `schema` that this validator neither enforces nor knows to
 * be an annotation. Used by the suite to fail when a schema starts declaring
 * something the validator would silently skip.
 */
export function unsupportedKeywords(schema: unknown): string[] {
  const found = new Set<string>();
  const walk = (s: unknown): void => {
    if (!s || typeof s !== "object") return;
    const o = s as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!ENFORCED.has(k) && !ANNOTATIONS.has(k)) found.add(k);
    }
    if (o.properties && typeof o.properties === "object") {
      for (const v of Object.values(o.properties as Record<string, unknown>)) walk(v);
    }
    if (o.items) walk(o.items);
  };
  walk(schema);
  return [...found];
}

interface Schema {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
}

/** How a value reads back in an error message, without pasting a huge payload. */
function show(v: unknown): string {
  if (typeof v === "string") {
    return v.length > 40 ? `a ${v.length}-character string` : JSON.stringify(v);
  }
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (v === null) return "null";
  if (typeof v === "object") return "an object";
  return JSON.stringify(v);
}

function typeMatches(type: string, v: unknown): boolean {
  switch (type) {
    case "string": return typeof v === "string";
    // `integer` is not `number`: a fractional count is a caller bug worth
    // naming, not something to round on the way past.
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    default: return true;
  }
}

/**
 * Check `value` against `schema`. Returns a message naming the first problem,
 * or null when it passes.
 *
 * One problem rather than all of them: the message goes to a model deciding
 * what to do next, and the first concrete thing to fix beats a list.
 */
export function validateArgs(schema: unknown, value: unknown, path = ""): string | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Schema;
  const at = path === "" ? "" : ` for \`${path}\``;

  if (s.type && !typeMatches(s.type, value)) {
    return `Expected ${s.type}${at}, got ${show(value)}.`;
  }
  if (s.enum && !s.enum.includes(value as never)) {
    return `Invalid value${at}: ${show(value)}. Allowed: ${s.enum.map((e) => JSON.stringify(e)).join(", ")}.`;
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) {
      return `Value${at} must be at least ${s.minimum}, got ${value}.`;
    }
    if (s.maximum !== undefined && value > s.maximum) {
      return `Value${at} must be at most ${s.maximum}, got ${value}.`;
    }
  }
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) {
      return `Value${at} must be at least ${s.minLength} characters, got ${value.length}.`;
    }
    if (s.maxLength !== undefined && value.length > s.maxLength) {
      return `Value${at} must be at most ${s.maxLength} characters, got ${value.length}.`;
    }
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) {
      return `Array${at} must have at least ${s.minItems} item(s), got ${value.length}.`;
    }
    if (s.maxItems !== undefined && value.length > s.maxItems) {
      return `Array${at} must have at most ${s.maxItems} item(s), got ${value.length}.`;
    }
    if (s.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateArgs(s.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
    }
  }
  if (s.properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const name of s.required ?? []) {
      if (obj[name] === undefined) return `Missing required parameter \`${path ? `${path}.` : ""}${name}\`.`;
    }
    // Undeclared parameters are refused rather than relayed. The properties
    // list *is* the published interface, and anything outside it would
    // otherwise be forwarded to the upstream API unexamined — a pass-through
    // for arbitrary JSON. Naming the accepted parameters turns a typo into one
    // round trip instead of a silently ignored argument.
    for (const name of Object.keys(obj)) {
      // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so
      // `toString`, `valueOf`, `hasOwnProperty` and `constructor` all read as
      // declared parameters of any schema. Measured against the first version
      // of this check — three of them sailed through and were relayed upstream,
      // which is the exact hole this function exists to close.
      if (!Object.hasOwn(s.properties, name)) {
        return `Unknown parameter \`${path ? `${path}.` : ""}${name}\`. ` +
          `Accepted: ${Object.keys(s.properties).join(", ")}.`;
      }
    }
    for (const [name, sub] of Object.entries(s.properties)) {
      if (obj[name] === undefined) continue;
      const err = validateArgs(sub, obj[name], path ? `${path}.${name}` : name);
      if (err) return err;
    }
  }
  return null;
}
