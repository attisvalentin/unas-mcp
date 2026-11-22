import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { parseBanUntil, UnasClient } from "../src/unas/client.js";
import { buildXml, parseXml } from "../src/unas/xml.js";
import { toUnix } from "../src/util/dates.js";

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
      case "setStock":
      case "setOrder":
        return new Response(xml(`<Products><Product><Sku>x</Sku><Status>ok</Status></Product></Products>`));
      default:
        return new Response(xml(`<Error>Unknown endpoint</Error>`), { status: 400 });
    }
  }) as typeof fetch;

  return { fetchImpl, calls };
}

async function connect(env: Record<string, string> = {}, mock = mockUnas()) {
  const config = loadConfig({ UNAS_API_KEY: "k", ...env });
  const unas = new UnasClient(config, mock.fetchImpl);
  const server = createServer(config, unas);
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
  assert.ok(!roNames.some((n) => /update|set_stock|create|delete|raw_set/.test(n)));
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
