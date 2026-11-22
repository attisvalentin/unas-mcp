# unas-mcp

MCP szerver az [UNAS](https://unas.hu) webáruház API-hoz. Claude-ból (vagy bármely MCP kliensből) kezelhetők vele a rendelések, termékek, készlet, kategóriák és vásárlók.

Az UNAS API XML-alapú, és a limitjei szigorúak. Ha egy listázó hívást túl sokszor futtatsz, vagy egy végpont 20-szor egymás után hibára fut, az IP címed 1 órára le lesz tiltva. A szerver ezért magától kezeli ezeket a dolgokat:

- **Token kezelés:** csak egyszer jelentkezik be. A token 2 óráig érvényes, lejárat előtt 5 perccel frissíti, és ha a token hibás, egyszer automatikusan újra bejelentkezik.
- **Helyi rate limit:** minden végponthoz külön számolja a hívásokat egy órás csúszó ablakban, külön az egyedi (`single`) és a listázó (`bulk`) hívásokat, plusz egy globális számlálót. Az előfizetéshez dokumentált limitnek alapból csak a 90%-áig enged elmenni.
- **Hibavédelem:** ha egy végpont 15-ször egymás után hibára fut, a szerver leállítja a hívásait, mielőtt az UNAS 20 hibánál letiltaná az IP-t.
- **Hibás API kulcs védelem:** 10 perc alatt 3 sikertelen azonosítás után a szerver szünetelteti a bejelentkezést. Az UNAS 10 ilyen hívás után 2 órára az összes webáruház API-ját letiltja az adott IP-ről.
- **Párhuzamosság:** egyszerre legfeljebb 4 kérést küld (az UNAS 5-öt enged).
- **Részleges hibák:** ha egy set hívásban valamelyik tétel `Status=error` választ kap, az eszköz hibaként jelzi, és felsorolja a hibás tételeket.
- **Tiltás felismerése:** ha jön egy `IP is banned till …` válasz, a végpontot a tiltás lejártáig nem hívja újra.
- **Cache:** a ritkán változó törzsadatokat (státuszok, fizetési és szállítási módok, kategóriák) 10 percig tárolja.
- **Tömörített kimenet:** a listák alapból rövid összefoglalót adnak, hogy kevesebb tokent használjanak. A teljes UNAS struktúrához add meg a `detail="full"` paramétert.
- **Biztonságos írás:** minden írásnál van `dryRun` (megmutatja a küldendő XML-t). Törléshez és a nyers set híváshoz kötelező a `confirm`. Van teljes read-only mód is.
- **Dátumok:** elfogad `2026-11-19`, `2026-11-19T08:30`, ISO vagy unix formátumot. Az időzóna nélküli dátumokat a bolt időzónájában értelmezi, és a csak dátumot tartalmazó záró érték a nap végét jelenti.

## Eszközök

| Eszköz | Mit csinál |
|---|---|
| `unas_shop_info` | Bolt adatai, előfizetés, az API kulcs jogosultságai és lejárata |
| `unas_rate_limit_status` | Elhasznált keret, hibaszámlálók, aktív tiltások |
| `unas_list_orders` | Rendelések szűrése státusz, dátum, módosítás, státuszváltás, e-mail vagy számlázási állapot szerint |
| `unas_get_order` | Egy rendelés minden adattal (ez az olcsó, egyedi limitet használja) |
| `unas_list_order_statuses` | A boltban beállított rendelés státuszok |
| `unas_update_order` ✎ | Státusz és értesítő e-mail, csomagszám, követési URL, számla adatok, admin megjegyzés |
| `unas_list_products` / `unas_get_product` | Termékek keresése és lekérése (SKU, kategória, státusz, módosítás alapján) |
| `unas_update_product` ✎ / `unas_create_product` ✎ | Név, ár, ÁFA-kulcs (`vat`, a hiányzó nettó/bruttó árat kiszámolja), készletkezelés (`stockManaged`), SEO (`seo`: meta cím, leírás, kulcsszavak, robots, SEO URL, kép ALT), státusz, kategória, leírás, plusz bármilyen nyers mező az `extra` paraméterben |
| `unas_delete_products` ⚠ | Termékek törlése (`confirm: true` kell hozzá) |
| `unas_get_stock` / `unas_set_stock` ✎ | Készlet lekérdezése és módosítása (`modify`/`in`/`out`, változatok, további raktárak). A 100-nál nagyobb kéréseket automatikusan feldarabolja. |
| `unas_list_categories`, `unas_list_customers`, `unas_list_methods` | Kategóriák, vásárlók, fizetési és szállítási módok |
| `unas_update_category` ✎ | Kategória neve, SEO, a lista feletti/alatti szöveg, menü- és oldalmegjelenés, szülő, egyedi kinézet sablon (`pageLayout`) |
| `unas_list_pages` / `unas_get_page` | Saját oldalak és menüpontok, a `get_page` a HTML tartalmakkal együtt |
| `unas_upsert_page` ✎ / `unas_delete_page` ⚠ | Oldal létrehozása vagy módosítása tartalommal és SEO-val; törlés a csak ehhez tartozó tartalmakkal. A `getPage`/`setPage` óránként csak 30 hívást enged (PREMIUM). |
| `unas_list_script_tags`, `unas_upsert_script_tag` ✎ / `unas_delete_script_tag` ⚠ | Egyedi scriptek (követő- és konverziós kódok) a head/body részbe, oldaltípus és nyelv szerinti szűréssel. Az új script inaktívan jön létre. |
| `unas_raw_get` / `unas_raw_set` ⚠ | Bármely más végpont (kupon, termékparaméter, vásárlócsoport, raktár, matrica, oldal, beállítás…) |

A ✎ és ⚠ jelű eszközök read-only módban nem jelennek meg.

A bolt sablonja, CSS-e és designja API-n keresztül nem szerkeszthető; kategóriához csak egy, az adminban már elkészített egyedi sablon rendelhető.

**Resource-ok:** `unas://limits` (a limitek táblázata), `unas://endpoints`
**Promptok:** `daily_order_report`, `customer_lookup`, `stock_check`

## Telepítés

```bash
npm install
npm run build
npm test        # 22 teszt egy mock UNAS API ellen
```

API kulcsot az UNAS adminban a **Beállítások → Külső kapcsolatok → API kapcsolat** menüben tudsz létrehozni. Ott azt is beállíthatod, hogy a kulcs mely végpontokat érheti el. Az API csak PREMIUM és VIP csomaggal használható.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "unas": {
      "command": "node",
      "args": ["/ABSZOLUT/UT/unas-mcp/dist/index.js"],
      "env": {
        "UNAS_API_KEY": "ide-az-api-kulcs",
        "UNAS_SUBSCRIPTION": "premium",
        "UNAS_READ_ONLY": "true"
      }
    }
  }
}
```

Claude Code-ban:
`claude mcp add unas -e UNAS_API_KEY=... -e UNAS_SUBSCRIPTION=premium -- node /ut/unas-mcp/dist/index.js`

Érdemes `UNAS_READ_ONLY=true` beállítással kezdeni, és csak akkor átállni írható módra, ha a lekérdezések már rendben működnek.

Kipróbálni MCP Inspectorral tudod: `UNAS_API_KEY=... npm run inspect`

## Konfiguráció (környezeti változók)

| Változó | Alapérték | Leírás |
|---|---|---|
| `UNAS_API_KEY` | – (kötelező) | API kulcs |
| `UNAS_SUBSCRIPTION` | `premium` | `premium` vagy `vip`. Csak tartalék: a limiteket a szerver a bejelentkezéskor kapott csomagból állítja be, ez az érték akkor számít, ha a csomag nem ismerhető fel |
| `UNAS_READ_ONLY` | `false` | `true` esetén nem jelennek meg az író eszközök |
| `UNAS_TIMEZONE` | `Europe/Budapest` | Az időzóna nélküli dátumok értelmezéséhez |
| `UNAS_RATE_SAFETY` | `0.9` | A dokumentált limit mekkora részét használhatja a szerver |
| `UNAS_FAILURE_GUARD` | `15` | Ennyi egymás utáni hiba után áll le az adott végpont |
| `UNAS_CACHE_TTL_SECONDS` | `600` | Cache idő a törzsadatokhoz |
| `UNAS_TIMEOUT_MS` | `60000` | HTTP timeout |
| `UNAS_MAX_OUTPUT_CHARS` | `80000` | Efölött az eszköz levágja a választ |
| `UNAS_MAX_CONCURRENCY` | `4` | Párhuzamos kérések száma (1–5) |
| `UNAS_BASE_URL` | `https://api.unas.eu/shop/` | Az API alap URL-je |

## Fontos tudnivalók a limitekről

- Limitsértésnél a tiltás 1 óra, ismételt sértésnél egyre hosszabb (1 nap, 1 hónap, 1 év).
- Éjfél körül (±10 perc) az UNAS karbantartást végezhet, ekkor ne fusson hívás.
- A **listázó** lekérések szűkösek: getOrder, getProduct, getStock, getCategory és getCustomer esetén PREMIUM csomagban **30 hívás/óra**, VIP-ben 90. Az egyedi lekérések (Key, Id vagy egy SKU alapján) 1000, illetve 3000 hívás/óra.
- Ezért jobb egy szűk időablakot egy nagyobb `limit` értékkel lekérni (getOrder esetén legfeljebb 500), mint sok kis oldalt lapozni.
- A limitek **IP címre és boltra** vonatkoznak. Ha ugyanarról az IP-ről más integráció is hívja az API-t, azt a szerver nem látja.

## Szerkezet

```
src/
  index.ts            stdio belépési pont
  server.ts           tool/resource/prompt regisztráció, szerver utasítások
  config.ts           környezeti változók
  unas/client.ts      login/token, HTTP, rate limit, hibavédelem, tiltás, cache
  unas/xml.ts         XML <-> JSON (plural/singular listák normalizálása, CDATA)
  unas/limits.ts      dokumentált limitek, végpontlista
  tools/*.ts          eszközök domainenként
  util/               dátumok, összefoglalók, eredmény formázás
test/server.test.ts   mock UNAS API + MCP kliens tesztek
```

Dokumentáció: https://unas.hu/tudastar/api
