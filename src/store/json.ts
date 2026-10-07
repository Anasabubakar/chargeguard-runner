// Same wire encoding mppx's bundled stores use (ox Json): bigint <-> "<digits>#__bigint".
const SUFFIX = "#__bigint";

export function encodeValue(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v.toString()}${SUFFIX}` : v));
  if (text === undefined) throw new TypeError("value is not JSON-serialisable");
  return text;
}

export function decodeValue(text: string): unknown {
  return JSON.parse(text, (_key, v) => (typeof v === "string" && v.endsWith(SUFFIX) ? BigInt(v.slice(0, -SUFFIX.length)) : v));
}
