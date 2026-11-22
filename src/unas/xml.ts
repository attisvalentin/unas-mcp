import { XMLParser } from "fast-xml-parser";

export type XmlValue = string | number | boolean | null | undefined | XmlObject | XmlValue[];
export interface XmlObject {
  [key: string]: XmlValue;
}

/**
 * UNAS uses the "plural container / singular item" pattern everywhere
 * (Orders>Order, Items>Item, Statuses>Status, Categories>Category, PlusStatuses>Status, ...).
 * Any child whose parent is a plural of it is always parsed as an array, so a list with
 * one element has the same shape as a list with many.
 */
export function isListChild(tag: string, parent: string | undefined): boolean {
  if (!parent) return false;
  if (parent.endsWith(tag + "s") || parent.endsWith(tag + "es")) return true;
  if (tag.endsWith("y") && parent.endsWith(tag.slice(0, -1) + "ies")) return true;
  return false;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  // Keep everything as strings: SKUs like "00123" or keys like "1000-1000000" must not be mangled.
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (tagName, jPath) => {
    const parts = String(jPath).split(".");
    return isListChild(tagName, parts[parts.length - 2]);
  },
});

export function parseXml(xml: string): XmlObject {
  const parsed = parser.parse(xml) as XmlObject;
  delete parsed["?xml"];
  return parsed;
}

const XML_SPECIAL = /[<>&]/;

function escapeText(value: string): string {
  if (!XML_SPECIAL.test(value)) return value;
  // CDATA cannot contain "]]>", split it if present.
  return "<![CDATA[" + value.replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
}

function assertTagName(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`Invalid XML element name: "${name}"`);
}

function serialize(name: string, value: XmlValue, indent: string, out: string[]) {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) serialize(name, item, indent, out);
    return;
  }
  assertTagName(name);
  if (value === null || value === "") {
    // Explicit empty node: in UNAS this clears the stored value.
    out.push(`${indent}<${name}></${name}>`);
    return;
  }
  if (typeof value === "object") {
    out.push(`${indent}<${name}>`);
    for (const [k, v] of Object.entries(value)) serialize(k, v, indent + "  ", out);
    out.push(`${indent}</${name}>`);
    return;
  }
  out.push(`${indent}<${name}>${escapeText(String(value))}</${name}>`);
}

/** Build a UNAS request document. `root` is e.g. "Params", "Orders", "Products". */
export function buildXml(root: string, body: XmlObject): string {
  const out = ['<?xml version="1.0" encoding="UTF-8" ?>'];
  serialize(root, body, "", out);
  return out.join("\n");
}

/** Helper: always get an array from a possibly missing list node. */
export function asArray<T = XmlObject>(v: unknown): T[] {
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

/** Recursively drop undefined values so optional tool inputs do not produce nodes. */
export function compact<T extends XmlObject>(obj: T): T {
  const result: XmlObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = compact(v as XmlObject);
      if (Object.keys(inner).length > 0) result[k] = inner;
    } else if (Array.isArray(v)) {
      result[k] = v.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? compact(x as XmlObject) : x));
    } else {
      result[k] = v;
    }
  }
  return result as T;
}
