import { asArray, type XmlObject } from "../unas/xml.js";

const o = (v: unknown): XmlObject => (v && typeof v === "object" && !Array.isArray(v) ? (v as XmlObject) : {});
const s = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));
const n = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const x = Number(String(v).replace(",", "."));
  return Number.isFinite(x) ? x : undefined;
};

/** Compact, token-friendly view of an order. */
export function summarizeOrder(order: XmlObject) {
  const customer = o(order.Customer);
  const contact = o(customer.Contact);
  const shippingAddr = o(o(customer.Addresses).Shipping);
  const payment = o(order.Payment);
  const shipping = o(order.Shipping);
  const invoice = o(order.Invoice);
  const items = asArray(o(order.Items).Item);
  const products = items.filter((i) => !String(i.Id ?? "").includes("-cost") && !String(i.Id ?? "").startsWith("discount"));
  return {
    key: s(order.Key),
    date: s(order.Date),
    modified: s(order.DateMod),
    status: s(order.Status),
    statusId: s(order.StatusID),
    statusType: s(order.StatusType),
    customer: {
      name: s(contact.Name),
      email: s(customer.Email),
      phone: s(contact.Mobile) ?? s(contact.Phone),
    },
    shipTo: [s(shippingAddr.ZIP), s(shippingAddr.City), s(shippingAddr.Street)].filter(Boolean).join(" ") || undefined,
    total: n(order.SumPriceGross),
    currency: s(order.Currency),
    payment: { method: s(payment.Name), status: s(payment.Status) },
    shipping: { method: s(shipping.Name), packageNumber: s(shipping.PackageNumber) },
    invoiceStatus: s(invoice.StatusText) ?? s(invoice.Status),
    items: products.map((i) => ({
      sku: s(i.Sku),
      name: s(i.Name),
      qty: n(i.Quantity),
      unitGross: n(i.PriceGross),
    })),
  };
}

function pick(list: XmlObject[], type: string): XmlObject | undefined {
  return list.find((x) => s(x.Type) === type);
}

/** Compact, token-friendly view of a product. */
export function summarizeProduct(p: XmlObject) {
  const statuses = asArray(o(p.Statuses).Status);
  const prices = asArray(o(p.Prices).Price);
  const categories = asArray(o(p.Categories).Category);
  const stocks = asArray(o(p.Stocks).Stock);
  const normal = pick(prices, "normal") ?? prices[0];
  const sale = pick(prices, "sale");
  const baseCat = pick(categories, "base") ?? categories[0];
  const stockActive = s(o(o(p.Stocks).Status).Active);
  return {
    id: s(p.Id),
    sku: s(p.Sku),
    name: s(p.Name),
    state: s(p.State),
    status: s(pick(statuses, "base")?.Value),
    unit: s(p.Unit),
    price: normal ? { net: n(normal.Net), gross: n(normal.Gross) } : undefined,
    salePrice: sale ? { net: n(sale.Net), gross: n(sale.Gross) } : undefined,
    category: baseCat ? { id: s(baseCat.Id), name: s(baseCat.Name) } : undefined,
    stock:
      stocks.length > 0
        ? stocks.reduce((sum, st) => sum + (n(st.Qty) ?? 0), 0)
        : undefined,
    stockManaged: stockActive,
    url: s(p.Url),
    lastModified: s(p.LastModTime),
  };
}

export const PRODUCT_STATUS_LABELS: Record<string, string> = {
  "0": "inactive",
  "1": "active",
  "2": "active, new",
  "3": "active, not buyable",
};
