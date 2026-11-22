import { z } from "zod";
import { compact, type XmlObject } from "../unas/xml.js";

const metaFields = {
  title: z.string().optional().describe("Meta title (<title>)"),
  description: z.string().optional().describe("Meta description"),
  keywords: z.string().optional().describe("Meta keywords, comma separated"),
  robots: z
    .string()
    .optional()
    .describe("Meta robots, e.g. \"index, follow\" or \"noindex, nofollow\""),
  url: z
    .string()
    .optional()
    .describe("SEO-friendly URL path without the shop domain, e.g. \"noi-cipo\" (UNAS: SefUrl)"),
};

const SEO_NOTE =
  "Only the given fields change; an empty string clears a field so UNAS falls back to its automatic value.";

export const seoInput = z.object(metaFields).describe(`SEO data. ${SEO_NOTE}`);

export const productSeoInput = z
  .object({
    ...metaFields,
    imageAlt: z.string().optional().describe(
        "ALT/TITLE text of the product images (UNAS: Images.DefaultAlt). It overwrites the ALT of every image of " +
          "the product, including individually set ones, so check them first if they may differ. Only works once " +
          "the product has images; UNAS answers \"No modifiable data\" otherwise."
      ),
  })
  .describe(`SEO data. ${SEO_NOTE}`);

export type SeoInput = z.infer<typeof productSeoInput>;

/** UNAS nodes for the SEO fields: Meta, SefUrl and (products only) Images.DefaultAlt. */
export function seoNodes(seo: SeoInput | undefined): XmlObject {
  if (!seo) return {};
  return compact({
    SefUrl: seo.url,
    Meta: { Title: seo.title, Description: seo.description, Keywords: seo.keywords, Robots: seo.robots },
    Images: seo.imageAlt !== undefined ? { DefaultAlt: seo.imageAlt } : undefined,
  });
}

/** Refuse `extra` keys that the `seo` parameter also sets, so one silently overriding the other cannot happen. */
export function checkSeoOverlap(seoXml: XmlObject, extra: Record<string, unknown> | undefined) {
  const clash = Object.keys(extra ?? {}).filter((k) => k in seoXml);
  if (clash.length > 0) {
    throw new Error(`Set ${clash.join(", ")} either through seo or through extra, not both.`);
  }
}
