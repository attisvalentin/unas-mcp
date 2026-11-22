import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { parseBanUntil, parseSubscription, UnasClient } from "../src/unas/client.js";
import { completePrice } from "../src/tools/products.js";
import { buildXml, parseXml } from "../src/unas/xml.js";
import { toUnix } from "../src/util/dates.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocsStore, fold } from "../src/docs/store.js";
import { extractArticle } from "../src/docs/html.js";
import { jsonResult } from "../src/util/result.js";

// ------------------------------------------------------------- mock UNAS

interface Call { endpoint: string; body: string; auth?: string }

function mockUnas(opts: { failWith?: (ep: string, n: number) => { status: number; body: string } | undefined } = {}) {
  const calls: Call[] = [];
  let tokenN = 0;
  const counts = new Map<string, number>();
  const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8" ?>\n${s}`;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const endpoint = String(url).split("/").pop()!;
    const body = String(init?.body ?? "");
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    calls.push({ endpoint, body, auth });
    const n = (counts.get(endpoint) ?? 0) + 1;
    counts.set(endpoint, n);

    const fail = opts.failWith?.(endpoint, n);
    if (fail) return new Response(xml(fail.body), { status: fail.status });

    switch (endpoint) {
      case "login":
        tokenN++;
        return new Response(
          xml(`<Login><Token>tok${tokenN}</Token><Expire>2099.01.01 00:00:00</Expire><ExpireTime>${Math.floor(Date.now() / 1000) + 7200}</ExpireTime>
          <ShopId>12345</ShopId><Subscription>premium</Subscription>
          <Permissions><Permission>getOrder</Permission><Permission>setStock</Permission></Permissions></Login>`)
        );
      case "getOrder":
        return new Response(
          xml(`<Orders><Order><Key>1000-1000001</Key><Date>2026.11.19 10:00:00</Date><Status>Feldolgozás alatt</Status>
          <Customer><Email>a@b.hu</Email><Contact><Name><![CDATA[Kis János]]></Name></Contact></Customer>
          <Currency>HUF</Currency><SumPriceGross>12700</SumPriceGross>
          <Payment><Name>Utalás</Name><Status>unpaid</Status></Payment>
          <Items><Item><Id>1</Id><Sku>00123</Sku><Name>Bögre</Name><Quantity>2</Quantity><PriceGross>5000</PriceGross></Item>
          <Item><Id>shipping-cost</Id><Sku>shipping-cost</Sku><Name>Szállítás</Name><Quantity>1</Quantity><PriceGross>2700</PriceGross></Item></Items>
          </Order></Orders>`)
        );
      case "getCategory":
        return new Response(xml(`<Categories><Category><Id>1</Id><Name>Bögrék</Name></Category></Categories>`));
      case "setStock":
      case "setOrder":
      case "setProduct":
        return new Response(xml(`<Products><Product><Sku>x</Sku><Status>ok</Status></Product></Products>`));
      case "setCategory":
        return new Response(xml(`<Categories><Category><Id>1</Id><Action>modify</Action><Status>ok</Status></Category></Categories>`));
      case "getPage":
        return new Response(
          xml(`<Pages><Page><Id>500</Id><Name>Rólunk</Name><Type>landing</Type><Contents><Content><Id>700</Id></Content></Contents></Page></Pages>`)
        );
      case "setPage":
        return new Response(xml(`<Pages><Page><Action>add</Action><Id>501</Id><Status>ok</Status></Page></Pages>`));
      case "getPageContent":
        return new Response(
          xml(`<PageContents><PageContent><Id>700</Id><Title>T</Title><Pages><Page><Id>500</Id></Page></Pages></PageContent></PageContents>`)
        );
      case "setPageContent":
        return new Response(xml(`<PageContents><PageContent><Action>add</Action><Id>701</Id><Status>ok</Status></PageContent></PageContents>`));
      case "getScriptTag":
        return new Response(xml(`<ScriptTags><ScriptTag><Id>9</Id><Title>GA</Title></ScriptTag></ScriptTags>`));
      case "setScriptTag":
        return new Response(xml(`<ScriptTags><ScriptTag><Id>9</Id><Status>ok</Status></ScriptTag></ScriptTags>`));
      default:
        return new Response(xml(`<Error>Unknown endpoint</Error>`), { status: 400 });
    }
  }) as typeof fetch;

  return { fetchImpl, calls };
}

async function connect(env: Record<string, string> = {}, mock = mockUnas()) {
  const config = loadConfig({ UNAS_API_KEY: "k", ...env });
  const unas = new UnasClient(config, mock.fetchImpl);
  const server = createServer(config, unas, new DocsStore(mkdtempSync(join(tmpdir(), "unas-docs-")), mock.fetchImpl));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0].text;
    return { isError: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
  };
  return { client, call, mock, unas };
}

// ------------------------------------------------------------------ tests

test("xml: lists normalised, strings preserved, special chars wrapped in CDATA", () => {
  const doc = parseXml("<Orders><Order><Key>007</Key><Items><Item><Sku>0012</Sku></Item></Items></Order></Orders>");
  assert.ok(Array.isArray((doc.Orders as any).Order));
  assert.ok(Array.isArray((doc.Orders as any).Order[0].Items.Item));
  assert.equal((doc.Orders as any).Order[0].Key, "007");
  const xml = buildXml("Products", { Product: [{ Name: "A & B <c>", Sku: "x" }, { Sku: "y", Unit: "" }] });
  assert.match(xml, /<Name><!\[CDATA\[A & B <c>\]\]><\/Name>/);
  assert.match(xml, /<Unit><\/Unit>/);
  assert.equal((xml.match(/<Product>/g) ?? []).length, 2);
  assert.throws(() => buildXml("Params", { "bad tag": 1 }));
});

test("dates: date-only uses shop time zone, end of day inclusive", () => {
  assert.equal(toUnix("2026-11-19", "Europe/Budapest"), Date.UTC(2026, 10, 18, 23, 0, 0) / 1000);
  assert.equal(toUnix("2026-07-01", "Europe/Budapest", true), Date.UTC(2026, 5, 30, 22, 0, 0) / 1000 + 86399);
  assert.equal(toUnix("2026-11-19T10:00:00Z", "Europe/Budapest"), Date.UTC(2026, 10, 19, 10) / 1000);
  assert.equal(toUnix("1763535600", "Europe/Budapest"), 1763535600);
});

test("tools are listed with annotations; read-only mode hides write tools", async () => {
  const rw = await connect();
  const names = (await rw.client.listTools()).tools.map((t) => t.name);
  for (const n of ["unas_list_orders", "unas_update_order", "unas_set_stock", "unas_raw_set", "unas_delete_products"]) {
    assert.ok(names.includes(n), n);
  }
  const del = (await rw.client.listTools()).tools.find((t) => t.name === "unas_delete_products")!;
  assert.equal(del.annotations?.destructiveHint, true);

  const ro = await connect({ UNAS_READ_ONLY: "true" });
  const roNames = (await ro.client.listTools()).tools.map((t) => t.name);
  assert.ok(roNames.includes("unas_get_order"));
  assert.ok(!roNames.some((n) => /update|upsert|set_stock|create|delete|raw_set/.test(n)));
  assert.ok(roNames.includes("unas_list_pages") && roNames.includes("unas_list_script_tags"));
});

test("list orders: summary, login reused, request params built correctly", async () => {
  const { call, mock } = await connect();
  const r = await call("unas_list_orders", { placedFrom: "2026-11-19", placedTo: "2026-11-19", limit: 50 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.count, 1);
  const o = r.json.orders[0];
  assert.equal(o.key, "1000-1000001");
  assert.equal(o.customer.name, "Kis János");
  assert.equal(o.items.length, 1, "shipping-cost line filtered from summary");
  assert.equal(o.items[0].sku, "00123");

  await call("unas_get_order", { key: "1000-1000001" });
  assert.equal(mock.calls.filter((c) => c.endpoint === "login").length, 1);
  const req = mock.calls.find((c) => c.endpoint === "getOrder")!;
  assert.match(req.body, /<TimeStart>1795042800<\/TimeStart>/);
  assert.match(req.body, /<LimitNum>50<\/LimitNum>/);
  assert.equal(req.auth, "Bearer tok1");
});

test("expired token triggers one re-login and retry", async () => {
  const mock = mockUnas({
    failWith: (ep, n) => (ep === "getOrder" && n === 1 ? { status: 400, body: "<Error>Invalid token</Error>" } : undefined),
  });
  const { call } = await connect({}, mock);
  const r = await call("unas_get_order", { key: "1" });
  assert.equal(r.isError, false, r.text);
  assert.equal(mock.calls.filter((c) => c.endpoint === "login").length, 2);
  assert.equal(mock.calls.at(-1)!.auth, "Bearer tok2");
});

test("local rate guard stops bulk list calls before the UNAS limit", async () => {
  const { call, mock } = await connect(); // premium: 30/h * 0.9 = 27
  for (let i = 0; i < 27; i++) assert.equal((await call("unas_list_orders", {})).isError, false);
  const r = await call("unas_list_orders", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /Local rate guard/);
  assert.equal(mock.calls.filter((c) => c.endpoint === "getOrder").length, 27);
  // single lookups still work
  assert.equal((await call("unas_get_order", { key: "1" })).isError, false);
});

test("ban response is detected and the endpoint is not called again", async () => {
  const mock = mockUnas({
    failWith: (ep) =>
      ep === "getOrder" ? { status: 400, body: "<Error>Too much getOrder query, IP is banned till 02.28.2099 10:00:00</Error>" } : undefined,
  });
  const { call } = await connect({}, mock);
  assert.match((await call("unas_get_order", { key: "1" })).text, /banned/);
  const before = mock.calls.length;
  assert.match((await call("unas_get_order", { key: "1" })).text, /banned/);
  assert.equal(mock.calls.length, before, "no network call while banned");
});

test("failure guard blocks an endpoint after repeated errors", async () => {
  const mock = mockUnas({ failWith: (ep) => (ep === "getOrder" ? { status: 400, body: "<Error>Bad param</Error>" } : undefined) });
  const { call } = await connect({ UNAS_FAILURE_GUARD: "3" }, mock);
  for (let i = 0; i < 3; i++) assert.match((await call("unas_get_order", { key: "1" })).text, /Bad param/);
  assert.match((await call("unas_get_order", { key: "1" })).text, /Local safety stop/);
  assert.equal(mock.calls.filter((c) => c.endpoint === "getOrder").length, 3);
});

test("set stock: dry run chunks by 100, real run sends correct XML", async () => {
  const { call, mock } = await connect();
  const items = Array.from({ length: 250 }, (_, i) => ({ sku: `S${i}`, action: "modify", qty: i }));
  const dry = await call("unas_set_stock", { items, dryRun: true });
  assert.equal(dry.json.calls, 3);
  assert.equal(mock.calls.length, 0, "dry run makes no network calls");

  const r = await call("unas_set_stock", {
    items: [{ sku: "A1", action: "in", qty: 10, purchasePrice: 1000, variants: ["Kék", "XL"], comment: "Bevét" }],
  });
  assert.equal(r.isError, false, r.text);
  const body = mock.calls.find((c) => c.endpoint === "setStock")!.body;
  assert.match(body, /<Action>in<\/Action>/);
  assert.match(body, /<Variant>Kék<\/Variant>\s*<Variant>XL<\/Variant>/);
  assert.match(body, /<Price>1000<\/Price>/);
});

test("update order builds a modify request; empty update rejected", async () => {
  const { call, mock } = await connect();
  const empty = await call("unas_update_order", { key: "1" });
  assert.equal(empty.isError, true);
  const r = await call("unas_update_order", { key: "1", status: "Postázva", sendStatusEmail: true, packageNumber: "PKG1", adminComment: "ok" });
  assert.equal(r.isError, false, r.text);
  const body = mock.calls.find((c) => c.endpoint === "setOrder")!.body;
  assert.match(body, /<Action>modify<\/Action>[\s\S]*<Key>1<\/Key>/);
  assert.match(body, /<StatusEmail>yes<\/StatusEmail>/);
  assert.match(body, /<Shipping>\s*<PackageNumber>PKG1<\/PackageNumber>\s*<\/Shipping>/);
  assert.match(body, /<Type>admin<\/Type>/);
});

test("raw set without confirm does not send", async () => {
  const { call, mock } = await connect();
  const r = await call("unas_raw_set", { endpoint: "setCoupon", root: "Coupons", body: { Coupon: [{ Action: "delete", Id: "5" }] } });
  assert.equal(r.json.dryRun, true);
  assert.equal(mock.calls.length, 0);
});

test("resources and prompts are exposed", async () => {
  const { client } = await connect();
  const res = await client.readResource({ uri: "unas://limits" });
  assert.match((res.contents[0] as { text: string }).text, /2000 calls\/hour/);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts.sort(), ["customer_lookup", "daily_order_report", "stock_check"]);
});

test("product extra cannot override Action/Sku (no delete without confirm)", async () => {
  const { call, mock } = await connect();
  for (const extra of [{ Action: "delete" }, { sku: "OTHER" }, { Id: "1" }]) {
    const r = await call("unas_update_product", { sku: "A1", extra, dryRun: true });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.text, /extra must not contain/);
  }
  const c = await call("unas_create_product", {
    sku: "N1", name: "x", categoryId: "1", price: { net: 1, gross: 1.27 }, extra: { Action: "delete" }, dryRun: true,
  });
  assert.equal(c.isError, true);
  const ok = await call("unas_update_product", { sku: "A1", extra: { Weight: 1.2 }, dryRun: true });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.json.xml, /<Action>modify<\/Action>[\s\S]*<Sku>A1<\/Sku>[\s\S]*<Weight>1.2<\/Weight>/);
  assert.equal(mock.calls.length, 0);
});

test("concurrent list calls cannot overshoot the local rate guard", async () => {
  const { call, mock } = await connect(); // premium: 27 allowed
  const results = await Promise.all(Array.from({ length: 35 }, () => call("unas_list_orders", {})));
  assert.equal(results.filter((r) => !r.isError).length, 27);
  assert.equal(results.filter((r) => /Local rate guard/.test(r.text)).length, 8);
  assert.equal(mock.calls.filter((c) => c.endpoint === "getOrder").length, 27);
});

test("ban with unreadable expiry lasts one hour, then the endpoint is retried", async () => {
  let now = Date.UTC(2026, 10, 22, 12);
  let banned = true;
  const mock = mockUnas({
    failWith: (ep) =>
      ep === "getOrder" && banned ? { status: 400, body: "<Error>IP is banned, try again later</Error>" } : undefined,
  });
  const unas = new UnasClient(loadConfig({ UNAS_API_KEY: "k" }), mock.fetchImpl, () => now);
  const get = () => unas.call("getOrder", "Params", { Key: "1" }, { kind: "single" });
  await assert.rejects(get, /banned/);
  banned = false;
  now += 59 * 60 * 1000;
  const before = mock.calls.length;
  await assert.rejects(get, /banned/);
  assert.equal(mock.calls.length, before, "still blocked locally within the hour");
  now += 2 * 60 * 1000;
  await get();
  assert.equal(mock.calls.filter((c) => c.endpoint === "getOrder").length, 2);
});

test("ban expiry is parsed in the shop time zone", () => {
  const tz = "Europe/Budapest";
  assert.equal(parseBanUntil("IP is banned till 02.28.2099 10:00:00", tz), Date.UTC(2099, 1, 28, 9));
  assert.equal(parseBanUntil("IP is banned till 28.02.2099 10:00:00", tz), Date.UTC(2099, 1, 28, 9));
  assert.equal(parseBanUntil("IP is banned", tz), undefined);
});

test("truncated output stays valid JSON and says how many items are shown", () => {
  const data = { count: 500, orders: Array.from({ length: 500 }, (_, i) => ({ key: `K${i}`, name: "x".repeat(100) })) };
  const text = (jsonResult(data, 5000).content[0] as { text: string }).text;
  assert.ok(text.length <= 5000);
  const parsed = JSON.parse(text);
  assert.equal(parsed.truncated.total, 500);
  assert.equal(parsed.orders.length, parsed.truncated.shown);
  assert.ok(parsed.truncated.shown > 10 && parsed.truncated.shown < 500);
  assert.equal(parsed.count, 500);

  // Nested raw UNAS structure
  const raw = { Orders: { Order: data.orders } };
  const rawParsed = JSON.parse((jsonResult(raw, 3000).content[0] as { text: string }).text);
  assert.equal(rawParsed.Orders.Order.length, rawParsed.Orders.truncated.shown);

  // No list to shorten: wrapped partial text, still valid JSON
  const blob = JSON.parse((jsonResult({ html: "<p>\"é\"</p>".repeat(2000) }, 2000).content[0] as { text: string }).text);
  assert.equal(typeof blob.partialJson, "string");
  assert.ok(blob.truncated.totalChars > 2000);
});

test("category cache: only the unfiltered tree is cached, product writes invalidate it", async () => {
  const { call, mock } = await connect();
  const catCalls = () => mock.calls.filter((c) => c.endpoint === "getCategory").length;
  await call("unas_list_categories", {});
  await call("unas_list_categories", {});
  assert.equal(catCalls(), 1, "unfiltered tree served from cache");
  await call("unas_list_categories", { modifiedSince: "2026-11-01" });
  await call("unas_list_categories", { modifiedSince: "2026-11-01" });
  assert.equal(catCalls(), 3, "filtered queries are not cached");
  const r = await call("unas_create_product", { sku: "N1", name: "x", categoryName: "Új|Al", price: { net: 1, gross: 1.27 } });
  assert.equal(r.isError, false, r.text);
  await call("unas_list_categories", {});
  assert.equal(catCalls(), 4, "cache invalidated after setProduct");
});

test("bad API key: login pauses after 3 failed authentications (UNAS bans all shops at 10)", async () => {
  const mock = mockUnas({
    failWith: (ep) => (ep === "login" ? { status: 400, body: "<Error>Invalid ApiKey</Error>" } : undefined),
  });
  const { call } = await connect({}, mock);
  for (let i = 0; i < 3; i++) assert.match((await call("unas_get_order", { key: "1" })).text, /Invalid ApiKey/);
  for (let i = 0; i < 5; i++) assert.match((await call("unas_get_order", { key: "1" })).text, /failed authentications/);
  assert.equal(mock.calls.filter((c) => c.endpoint === "login").length, 3);
  assert.equal(mock.calls.filter((c) => c.endpoint === "getOrder").length, 0);
});

test("never more than 4 parallel requests to UNAS", async () => {
  const base = mockUnas();
  let active = 0;
  let peak = 0;
  const slow = (async (url: string | URL, init?: RequestInit) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    try {
      return await base.fetchImpl(url, init);
    } finally {
      active--;
    }
  }) as typeof fetch;
  const { call } = await connect({}, { ...base, fetchImpl: slow });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call("unas_get_order", { key: String(i) })));
  assert.ok(results.every((r) => !r.isError));
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.ok(peak >= 2, "requests still run in parallel");
});

test("set call with a failed item is reported as an error", async () => {
  const mock = mockUnas({
    failWith: (ep) =>
      ep === "setOrder"
        ? { status: 200, body: "<Orders><Order><Action>modify</Action><Key>1</Key><Status>error</Status><Error>Unknown status</Error></Order></Orders>" }
        : undefined,
  });
  const { call } = await connect({}, mock);
  const r = await call("unas_update_order", { key: "1", status: "Nincs ilyen" });
  assert.equal(r.isError, true);
  assert.equal(r.json.failedCount, 1);
  assert.equal(r.json.failed[0].Error, "Unknown status");
});

test("raw get refuses getOrder with InvoiceAutoSet (hidden write)", async () => {
  const { call, mock } = await connect({ UNAS_READ_ONLY: "true" });
  const r = await call("unas_raw_get", { endpoint: "getOrder", params: { InvoiceAutoSet: 1 } });
  assert.equal(r.isError, true);
  assert.match(r.text, /InvoiceAutoSet/);
  assert.equal(mock.calls.length, 0);
});

test("rate limits follow the shop's subscription from login, not a wrong UNAS_SUBSCRIPTION", async () => {
  // Mock login reports "premium"; configuring vip must not raise the bulk limit above 27 (30 * 0.9).
  const { call, mock, unas } = await connect({ UNAS_SUBSCRIPTION: "vip" });
  for (let i = 0; i < 27; i++) assert.equal((await call("unas_list_orders", {})).isError, false);
  const r = await call("unas_list_orders", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /Local rate guard/);
  assert.equal(mock.calls.filter((c) => c.endpoint === "getOrder").length, 27);
  assert.equal(unas.subscription, "premium");
  assert.equal(unas.status().subscriptionSource, "login");
});

test("parseSubscription maps UNAS package names to limit tiers", () => {
  assert.equal(parseSubscription("premium-20000"), "premium");
  assert.equal(parseSubscription("VIP-50000"), "vip");
  assert.equal(parseSubscription("something-else"), undefined);
  assert.equal(parseSubscription(undefined), undefined);
});

test("create product: vat, computed net price and stock management in the XML", async () => {
  const { call } = await connect();
  const r = await call("unas_create_product", {
    sku: "t1", name: "Teszt", price: { gross: 12700 }, vat: "27", stockManaged: true, categoryId: "1", dryRun: true,
  });
  assert.equal(r.isError, false, r.text);
  const xml: string = r.json.xml;
  assert.match(xml, /<Prices>\s*<Vat>27%<\/Vat>\s*<Price>\s*<Type>normal<\/Type>\s*<Net>10000<\/Net>\s*<Gross>12700<\/Gross>/);
  assert.match(xml, /<Stocks>\s*<Status>\s*<Active>1<\/Active>/);
});

test("update product: vat alone is sent without a price; named VAT keys are kept and not used for math", async () => {
  const { call } = await connect();
  const r1 = await call("unas_update_product", { sku: "t1", vat: "18%", dryRun: true });
  assert.match(r1.json.xml, /<Prices>\s*<Vat>18%<\/Vat>\s*<\/Prices>/);
  const r2 = await call("unas_update_product", { sku: "t1", vat: "AAM", price: { gross: 1000 }, dryRun: true });
  assert.match(r2.json.xml, /<Vat>AAM<\/Vat>/);
  assert.doesNotMatch(r2.json.xml, /<Net>/);
  assert.equal(completePrice({ net: 100 }, "5%")!.gross, 105);
});

test("set stock on a product without stock management is an error with a hint", async () => {
  const mock = mockUnas({
    failWith: (ep) =>
      ep === "setStock"
        ? {
            status: 400,
            body: "<Products><Product><Sku>t1</Sku><Status>error</Status><Error><![CDATA[Stock Management Off]]></Error></Product></Products>",
          }
        : undefined,
  });
  const { call } = await connect({}, mock);
  const r = await call("unas_set_stock", { items: [{ sku: "t1", action: "modify", qty: 5 }] });
  assert.equal(r.isError, true);
  assert.match(r.json.hint, /stockManaged: true/);
});

test("custom content type: requestedData is sent, and missing requestedData is rejected locally", async () => {
  const { call, mock } = await connect();
  const before = mock.calls.length;
  for (const tool of ["unas_get_product", "unas_list_products"]) {
    const r = await call(tool, { sku: "t1", skus: ["t1"], contentType: "custom" });
    assert.equal(r.isError, true);
    assert.match(r.text, /needs requestedData/);
  }
  assert.equal(mock.calls.length, before, "nothing may reach UNAS");
  await call("unas_get_product", { sku: "t1", requestedData: "Meta" });
  const body = mock.calls.at(-1)!.body;
  assert.match(body, /<ContentType>custom<\/ContentType>/);
  assert.match(body, /<RequestedData>Meta<\/RequestedData>/);
  // a list would come back empty from UNAS, so it is rejected before sending
  const n = mock.calls.length;
  assert.equal((await call("unas_get_product", { sku: "t1", requestedData: "Name,Meta" })).isError, true);
  assert.equal(mock.calls.length, n);
});

test("product seo maps to Meta, SefUrl and Images.DefaultAlt; clash with extra is rejected", async () => {
  const { call } = await connect();
  const r = await call("unas_update_product", {
    sku: "t1", seo: { title: "T", robots: "noindex, nofollow", url: "t-1", imageAlt: "Alt", description: "" }, dryRun: true,
  });
  const xml: string = r.json.xml;
  assert.match(xml, /<SefUrl>t-1<\/SefUrl>/);
  assert.match(xml, /<Meta>\s*<Title>T<\/Title>\s*<Description><\/Description>\s*<Robots>noindex, nofollow<\/Robots>/);
  assert.match(xml, /<Images>\s*<DefaultAlt>Alt<\/DefaultAlt>\s*<\/Images>/);
  const clash = await call("unas_update_product", { sku: "t1", seo: { title: "T" }, extra: { Meta: {} }, dryRun: true });
  assert.equal(clash.isError, true);
  assert.match(clash.text, /either through seo or through extra/);
});

test("update category: seo, texts, display and layout; lang inside the Category node; cache invalidated", async () => {
  const { call, mock } = await connect();
  await call("unas_list_categories", {});
  const r = await call("unas_update_category", {
    id: "10", lang: "hu", seo: { title: "Cipők" }, bottomText: "<p>SEO</p>", showInMenu: false,
    pageLayout: { productList: "3" },
  });
  assert.equal(r.isError, false, r.text);
  const body = mock.calls.at(-1)!.body;
  assert.match(body, /<Category>\s*<Action>modify<\/Action>\s*<Id>10<\/Id>\s*<Lang>hu<\/Lang>/);
  assert.match(body, /<Texts>\s*<Bottom><!\[CDATA\[<p>SEO<\/p>\]\]><\/Bottom>\s*<\/Texts>/);
  assert.match(body, /<Display>\s*<Menu>no<\/Menu>\s*<\/Display>/);
  assert.match(body, /<PageLayout>\s*<ProductList>3<\/ProductList>\s*<\/PageLayout>/);
  await call("unas_list_categories", {});
  assert.equal(mock.calls.filter((c) => c.endpoint === "getCategory").length, 2, "cache was invalidated");
});

test("upsert page: new page is created with its new content already attached (one setPage call)", async () => {
  const { call, mock } = await connect();
  const r = await call("unas_upsert_page", {
    name: "Szállítás", seo: { url: "szallitas" }, content: { title: "Szállítási infó", html: "<p>Hi</p>" },
  });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json, { ok: true, pageId: "501", contentId: "701", createdPage: true, createdContent: true });
  const eps = mock.calls.map((c) => c.endpoint).filter((e) => e !== "login");
  assert.deepEqual(eps, ["setPageContent", "setPage"]);
  const page = mock.calls.at(-1)!.body;
  assert.match(page, /<Action>add<\/Action>/);
  assert.match(page, /<Menu>no<\/Menu>/);
  assert.match(page, /<Type>normal<\/Type>/);
  assert.match(page, /<Contents>\s*<Content>\s*<Id>701<\/Id>/);
});

test("upsert page: modify reads Type and keeps existing contents when attaching a new one", async () => {
  const { call, mock } = await connect();
  const r = await call("unas_upsert_page", { id: "500", content: { title: "Új blokk", html: "<p>x</p>" } });
  assert.equal(r.isError, false, r.text);
  const page = mock.calls.at(-1)!.body;
  assert.match(page, /<Action>modify<\/Action>\s*<Id>500<\/Id>/);
  assert.match(page, /<Type>landing<\/Type>/);
  assert.match(page, /<Content>\s*<Id>700<\/Id>\s*<\/Content>\s*<Content>\s*<Id>701<\/Id>/);
  // modifying only an existing content item does not touch the page at all
  const before = mock.calls.length;
  await call("unas_upsert_page", { id: "500", content: { id: "700", html: "<p>y</p>" } });
  assert.deepEqual(mock.calls.slice(before).map((c) => c.endpoint), ["setPageContent"]);
});

test("delete page keeps content items that other pages still use", async () => {
  const mock = mockUnas();
  const { call } = await connect({}, mock);
  // content 700 belongs only to page 500 in the mock, so it is deleted together with the page
  const r = await call("unas_delete_page", { id: "500", deleteContents: true, confirm: true, dryRun: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.keptContents, []);
  assert.match(r.json.steps[1].xml, /<Action>delete<\/Action>\s*<Id>700<\/Id>/);
});

test("script tag: new scripts start inactive, required fields and page filter are checked", async () => {
  const { call, mock } = await connect();
  assert.equal((await call("unas_upsert_script_tag", { title: "x" })).isError, true);
  assert.equal(
    (await call("unas_upsert_script_tag", { title: "x", type: "head", content: "1", pages: ["cart"] })).isError,
    true
  );
  const r = await call("unas_upsert_script_tag", {
    title: "Konverzió", type: "body_end", content: "console.log(1)", pages: ["order_send"], pageFilter: "allow",
  });
  assert.equal(r.isError, false, r.text);
  const body = mock.calls.at(-1)!.body;
  assert.match(body, /<Action>add<\/Action>\s*<Status>inactive<\/Status>/);
  assert.match(body, /<Pages>\s*<Page>\s*<Id>order_send<\/Id>/);
  assert.match(body, /<PageFilterType>allow<\/PageFilterType>/);
});

// ------------------------------------------------------------ knowledge base

const kbPage = (title: string, body: string) =>
  `<html><head><title>${title} - UNAS</title></head><body><nav>Menü Hírlevél</nav>
  <article id="blog-item-0" class="blog-item col-12"><div class="blog-title"><h1 class='text-title-1'>${title}</h1></div>
  <div class="blog-text">${body}</div></article><div>Weboldalunk cookie-kat használ.</div></body></html>`;

function mockKb() {
  const urls: string[] = [];
  const pages: Record<string, string> = {
    "https://unas.hu/tudastar/admin":
      `<a href="https://unas.hu/tudastar/admin/ertesitesek">x</a><a href="https://unas.hu/tudastar/admin/hirlevel">y</a>`,
    "https://unas.hu/tudastar/api":
      `<a href="https://unas.hu/tudastar/api/termekek">t</a><a href="https://unas.hu/tudastar/api/termekek-adatszerkezet">t</a>`,
    "https://unas.hu/tudastar/admin/ertesitesek": kbPage(
      "Értesítések",
      "<p>A státusz módosítás értesítőket itt kapcsolhatod be.</p><ul><li>Admin</li><li>Vásárló</li></ul>"
    ),
    "https://unas.hu/tudastar/admin/hirlevel": kbPage("Hírlevél", "<p>Hírlevelet küldhetsz a feliratkozóknak.</p>"),
    "https://unas.hu/tudastar/api/termekek": kbPage("Termékek", "<p>A termékek kezelése az API-n.</p>"),
    "https://unas.hu/tudastar/api/termekek-adatszerkezet": kbPage(
      "Adatszerkezet",
      "<p>Meta.Title string</p><pre>&lt;Meta&gt;&lt;Title&gt;x&lt;/Title&gt;&lt;/Meta&gt;</pre>"
    ),
  };
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    const body = pages[String(url)];
    return body ? new Response(body) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

test("knowledge base: article text is extracted without navigation, cookie bar or tags", () => {
  const a = extractArticle(kbPage("Értesítések", "<p>Első&nbsp;bekezdés</p><pre>&lt;Meta&gt;</pre>"))!;
  assert.equal(a.title, "Értesítések");
  assert.match(a.text, /Első bekezdés/);
  assert.match(a.text, /<Meta>/);
  assert.doesNotMatch(a.text, /Menü|cookie|<p>/);
  assert.equal(fold("Értesítő ŐŰ"), "ertesito ou");
});

test("knowledge base: sync, Hungarian search with accents and word forms, subpage titles, read", async () => {
  const kb = mockKb();
  const store = new DocsStore(mkdtempSync(join(tmpdir(), "unas-docs-")), kb.fetchImpl, { delayMs: 0 });
  const status = await store.startSync({ sections: ["admin", "api"] });
  assert.equal(status.fetched, 4);
  assert.equal(status.failed.length, 0);

  // accents optional, inflected forms match ("ertesitest" ~ "értesítőket"/"Értesítések")
  const hits = await store.search("hol kapcsolom be a statusz ertesitest");
  assert.equal(hits[0].url, "https://unas.hu/tudastar/admin/ertesitesek");
  assert.match(hits[0].snippet, /státusz/);
  const api = await store.search("Meta Title", { section: "api" });
  assert.equal(api[0].title, "Termékek – Adatszerkezet");

  // a second store on the same dir loads the cache; a fresh sync downloads nothing
  const again = new DocsStore(store.dir, kb.fetchImpl, { delayMs: 0 });
  assert.equal(await again.count(), 4);
  const s2 = await again.startSync({ sections: ["admin"] });
  assert.equal(s2.fetched, 0);
  assert.equal(s2.skipped, 2);

  const page = await again.read("ertesitesek");
  assert.equal(page.title, "Értesítések");
  assert.throws(() => again.resolve("https://evil.example/tudastar/x"), /Only unas.hu/);
});

test("knowledge base tools: empty cache explains how to sync; read fetches a missing page", async () => {
  const kb = mockKb();
  const config = loadConfig({ UNAS_API_KEY: "k" });
  const store = new DocsStore(mkdtempSync(join(tmpdir(), "unas-docs-")), kb.fetchImpl, { delayMs: 0 });
  const server = createServer(config, new UnasClient(config, mockUnas().fetchImpl), store);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as Array<{ text: string }>)[0].text);
  };
  assert.match((await call("unas_docs_search", { query: "értesítés" })).note, /unas_docs_sync/);
  const page = await call("unas_docs_read", { page: "admin/hirlevel" });
  assert.equal(page.title, "Hírlevél");
  assert.deepEqual(kb.urls, ["https://unas.hu/tudastar/admin/hirlevel"]);
  const found = await call("unas_docs_search", { query: "hírlevelek" });
  assert.equal(found.results[0].url, "https://unas.hu/tudastar/admin/hirlevel");
  // docs tools stay available in read-only mode
  const ro = createServer(loadConfig({ UNAS_API_KEY: "k", UNAS_READ_ONLY: "true" }), undefined, store);
  assert.ok(ro);
});
