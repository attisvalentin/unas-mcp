# unas-mcp

**MCP szerver az [UNAS](https://unas.hu) webáruházakhoz.** Ezzel a szerverrel Claude (vagy bármelyik másik MCP-képes AI asszisztens) hozzáfér a boltod adataihoz az UNAS API-n keresztül. Elég magyarul megírnod, mit szeretnél:

> „Milyen rendelések jöttek tegnap, és melyik vár még feldolgozásra?”
> „Az 12345-000123 rendelést állítsd *Visszaigazolva* státuszra, és küldj róla e-mailt a vásárlónak.”
> „Melyik termékből van 5 darabnál kevesebb raktáron?”
> „Írj SEO meta leírást a cipők kategóriának, és mutasd meg, mi menne ki, mielőtt elmented.”
> „Tegyél be egy Google Analytics kódot a head részbe, de egyelőre kikapcsolva.”
> „Hol tudom bekapcsolni a státuszváltozásról szóló e-mail értesítést?” *(ezt a beépített UNAS tudástárból válaszolja meg, internet nélkül)*

Az asszisztens a kérést a megfelelő UNAS API hívásokká alakítja. Közben vigyáz a szigorú UNAS limitekre, és ha módosítana valamit a boltban, előbb megkérdez.

> [!NOTE]
> Ez egy független, nem hivatalos projekt. Az UNAS Online Kft. nem fejleszti, nem támogatja és nem felel érte.

---

## Tartalom

- [Mire jó?](#mire-jó)
- [Követelmények](#követelmények)
- [Telepítés](#telepítés)
- [Bekötés az AI kliensbe](#bekötés-az-ai-kliensbe)
- [A UNAS tudástár offline használata](#a-unas-tudástár-offline-használata)
- [Eszközök](#eszközök)
- [Biztonság és limitek](#biztonság-és-limitek)
- [Konfiguráció](#konfiguráció-környezeti-változók)
- [Hibaelhárítás](#hibaelhárítás)
- [Fejlesztés](#fejlesztés)
- [Licenc](#licenc)

---

## Mire jó?

| Terület | Mit tudsz csinálni |
|---|---|
| **Rendelések** | Szűrés státusz, dátum, e-mail cím, módosítás vagy számlázási állapot szerint. Egy rendelés minden adata. Státusz váltása értesítő e-maillel, csomagszám és követési link megadása, számlaadatok, admin megjegyzés. |
| **Termékek** | Keresés és lekérés. Új termék létrehozása, meglévő módosítása: név, ár, ÁFA (a hiányzó nettó vagy bruttó árat kiszámolja), kategória, leírás, státusz, készletkezelés. Törlés. |
| **Készlet** | Lekérdezés és módosítás (beállítás, bevételezés, kivét), változatokkal és több raktárral. A nagy tételszámú kéréseket magától feldarabolja. |
| **SEO** | Meta cím, leírás, kulcsszavak, robots, SEO-barát URL, termékkép ALT szöveg. Termékekre, kategóriákra és saját oldalakra. |
| **Kategóriák** | Név, SEO, a lista feletti és alatti szöveg, menü- és oldalmegjelenés, szülő kategória, egyedi kinézet sablon hozzárendelése. |
| **Saját oldalak** | Oldalak és menüpontok listázása, létrehozása és módosítása HTML tartalommal és SEO-val, törlése. |
| **Scriptek** | Követő- és konverziós kódok (Analytics, Pixel stb.) a head vagy a body részbe, oldaltípus és nyelv szerinti szűréssel. |
| **Vásárlók, törzsadatok** | Vásárlók keresése, fizetési és szállítási módok, rendelés státuszok. |
| **Bármi más** | A nyers `unas_raw_get` / `unas_raw_set` eszközzel minden más UNAS végpont elérhető, például kuponok, termékparaméterek, vásárlócsoportok vagy raktárak. |
| **UNAS tudástár** | A teljes [UNAS tudástár](https://unas.hu/tudastar) (~590 oldal) a gépeden, kereshetően. Megmondja, hol van egy beállítás, hogyan működik egy funkció, mi egy API mező neve. |

**Amit nem tud:** a bolt sablonja, CSS-e és designja az UNAS API-n keresztül nem szerkeszthető. Kategóriához csak olyan egyedi kinézet sablon rendelhető, amelyet előtte az adminban elkészítettél. Az admin egyes beállításaihoz (például az e-mail értesítések be- és kikapcsolásához) sincs API, ezeket az adminban kell átállítani. A tudástár ebben is segít.

---

## Követelmények

- **Node.js 22** vagy újabb (`node -v`)
- **UNAS PREMIUM vagy VIP** előfizetés, mert az API csak ezekkel érhető el
- **UNAS API kulcs**
- Egy **MCP kliens**, például [Claude Desktop](https://claude.ai/download), [Claude Code](https://claude.com/claude-code), [OpenAI Codex](https://developers.openai.com/codex), Cursor vagy VS Code

### API kulcs létrehozása

1. Lépj be az UNAS adminba.
2. Nyisd meg a **Beállítások → Külső kapcsolatok → API kapcsolat** menüt.
3. Hozz létre egy új kulcsot, és jelöld be, mely végpontokat érheti el. Ha csak olvasni szeretnél, elég a `get…` jogosultság.
4. Másold ki a kulcsot. Kezeld jelszóként, és ne tedd be a git repóba.

> [!TIP]
> Ha van **teszt webáruházad**, először azon próbáld ki a szervert.

---

## Telepítés

```bash
git clone https://github.com/attisvalentin/unas-mcp.git
cd unas-mcp
npm install
npm run build
```

Ellenőrzés (nem kell hozzá API kulcs, egy szimulált UNAS API ellen fut):

```bash
npm test
```

A szerver a `dist/index.js` fájl, ezt indítja el az AI kliens. A teljes útvonalát kérdezd le a `pwd` paranccsal a projekt mappájában, mert a következő lépésekben szükség lesz rá.

Opcionálisan, de erősen ajánlott letölteni a UNAS tudástárat (pár perc, ehhez sem kell API kulcs):

```bash
npm run docs:sync
```

---

## Bekötés az AI kliensbe

> [!IMPORTANT]
> Kezdj **read-only módban** (`UNAS_READ_ONLY=true`). Ilyenkor az asszisztens csak olvasni tud, módosítani semmit. Ha a lekérdezések rendben mennek, kapcsold ki.

### Claude Desktop

Nyisd meg a **Settings → Developer → Edit Config** menüt, vagy szerkeszd közvetlenül a konfigurációs fájlt:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "unas": {
      "command": "node",
      "args": ["/teljes/ut/unas-mcp/dist/index.js"],
      "env": {
        "UNAS_API_KEY": "ide-az-api-kulcs",
        "UNAS_READ_ONLY": "true"
      }
    }
  }
}
```

Windows alatt az útvonalban dupla perjel kell: `"C:\\Users\\nev\\unas-mcp\\dist\\index.js"`.

Mentés után indítsd újra a Claude Desktopot. A beszélgetés ablakban az eszközök ikonja alatt megjelennek az `unas_…` eszközök.

### Claude Code

```bash
claude mcp add unas \
  -e UNAS_API_KEY=ide-az-api-kulcs \
  -e UNAS_READ_ONLY=true \
  -- node /teljes/ut/unas-mcp/dist/index.js
```

Ellenőrzés: `claude mcp list`, illetve a Claude Code-on belül a `/mcp` parancs. Ha minden projektben elérhetővé szeretnéd tenni, add hozzá a `--scope user` kapcsolót.

### OpenAI Codex (CLI, IDE bővítmény, ChatGPT desktop)

Parancssorból:

```bash
codex mcp add unas \
  --env UNAS_API_KEY=ide-az-api-kulcs \
  --env UNAS_READ_ONLY=true \
  -- node /teljes/ut/unas-mcp/dist/index.js
```

Vagy kézzel, a `~/.codex/config.toml` fájlban (Windows alatt `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.unas]
command = "node"
args = ["/teljes/ut/unas-mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 120

[mcp_servers.unas.env]
UNAS_API_KEY = "ide-az-api-kulcs"
UNAS_READ_ONLY = "true"
```

- Ellenőrzés: `codex mcp list`, illetve a Codexen belül a `/mcp` parancs.
- A Codex CLI, az IDE bővítmény és a ChatGPT desktop alkalmazás ugyanezt a konfigurációt használja, ezért elég egyszer beállítani.
- A `tool_timeout_sec` emelését ajánlom. A Codex alapból 60 másodperc után megszakítja az eszközhívást, és ennyi a szerver HTTP timeoutja (`UNAS_TIMEOUT_MS`) is. Egy lassú, nagy UNAS lista emiatt félbeszakadhat.
- Projektre szóló beállítás is lehetséges a projekt `.codex/config.toml` fájljában. Ezt a Codex csak megbízhatónak jelölt projektben tölti be. Ilyenkor ne commitold az API kulcsot.

### Más MCP kliensek (Cursor, VS Code, …)

Bármelyik kliens működik, amely stdio-n indít MCP szervert. A parancs `node /teljes/ut/unas-mcp/dist/index.js`, a környezeti változók ugyanazok, mint fent.

### Kipróbálás AI nélkül

Az [MCP Inspector](https://github.com/modelcontextprotocol/inspector) böngészőben megmutatja az eszközöket, és kézzel is meghívhatod őket:

```bash
UNAS_API_KEY=ide-az-api-kulcs UNAS_READ_ONLY=true npm run inspect
```

### Írható mód

Ha a read-only mód már rendben működik, állítsd át az `UNAS_READ_ONLY` értékét `false`-ra, vagy töröld a sort, majd indítsd újra a klienst. Ezután megjelennek az író eszközök is. Az asszisztens minden módosítás előtt összefoglalja, mit készül csinálni, és megvárja a jóváhagyásodat. A `dryRun` móddal azt is megnézheted, pontosan milyen XML menne ki az UNAS felé.

---

## A UNAS tudástár offline használata

A szerver le tudja tölteni a [UNAS tudástárat](https://unas.hu/tudastar) a gépedre: az admin segédletet, az API dokumentációt, valamint a kinézet, hosting, integráció, rendelés és ügyfélfiók részeket. Így az asszisztens **internetes keresés nélkül**, a hivatalos leírásból válaszol, és nem találgat.

```bash
npm run docs:sync              # első letöltés vagy frissítés (a 30 napnál frissebb oldalakat kihagyja)
npm run docs:sync -- --force   # mindent újra letölt
npm run docs:sync -- api admin # csak ezeket a szekciókat
```

- A letöltés a `unas_docs_sync` eszközzel a beszélgetésből is elindítható, ilyenkor a háttérben fut.
- A keresés ékezettel és anélkül is működik, és a magyar ragozott alakokat is felismeri („értesítéseket” → „Értesítések”).
- A tartalom az UNAS-é, ezért **nem kerül a projektbe**. Csak a saját gépeden tárolódik a `~/.cache/unas-mcp/docs.json` fájlban, ami kb. 2,5 MB. A helye az `UNAS_DOCS_DIR` változóval módosítható.
- Ha egy oldal még nincs a helyi másolatban, a `unas_docs_read` első olvasáskor letölti.

---

## Eszközök

| Eszköz | Mit csinál |
|---|---|
| `unas_shop_info` | A bolt adatai, az előfizetés, az API kulcs jogosultságai és lejárata |
| `unas_rate_limit_status` | Elhasznált keret, hibaszámlálók, aktív tiltások |
| `unas_list_orders` | Rendelések szűrése státusz, dátum, módosítás, státuszváltás, e-mail vagy számlázási állapot szerint |
| `unas_get_order` | Egy rendelés minden adattal (olcsó, az egyedi limitet használja) |
| `unas_list_order_statuses` | A boltban beállított rendelés státuszok |
| `unas_update_order` ✎ | Státusz és értesítő e-mail, csomagszám, követési URL, számla adatok, admin megjegyzés |
| `unas_list_products` / `unas_get_product` | Termékek keresése és lekérése SKU, kategória, státusz vagy módosítás alapján |
| `unas_create_product` ✎ / `unas_update_product` ✎ | Név, ár, ÁFA (`vat`), készletkezelés (`stockManaged`), SEO (`seo`), státusz, kategória, leírás, plusz bármilyen nyers mező az `extra` paraméterben |
| `unas_delete_products` ⚠ | Termékek törlése (`confirm: true` kell hozzá) |
| `unas_get_stock` / `unas_set_stock` ✎ | Készlet lekérdezése és módosítása (`modify`/`in`/`out`, változatok, raktárak) |
| `unas_list_categories` / `unas_update_category` ✎ | Kategóriák listája; név, SEO, felső és alsó szöveg, megjelenés, szülő, egyedi sablon (`pageLayout`) |
| `unas_list_customers`, `unas_list_methods` | Vásárlók; fizetési és szállítási módok |
| `unas_list_pages` / `unas_get_page` | Saját oldalak és menüpontok, a `get_page` a HTML tartalommal együtt |
| `unas_upsert_page` ✎ / `unas_delete_page` ⚠ | Oldal létrehozása vagy módosítása tartalommal és SEO-val; törlés a csak hozzá tartozó tartalmakkal együtt |
| `unas_list_script_tags` / `unas_upsert_script_tag` ✎ / `unas_delete_script_tag` ⚠ | Egyedi scriptek a head vagy body részbe. Az új script kikapcsolva jön létre. |
| `unas_raw_get` / `unas_raw_set` ⚠ | Bármelyik más UNAS végpont nyers hívása |
| `unas_docs_search` / `unas_docs_read` | Keresés a UNAS tudástár helyi másolatában; egy oldal teljes szövege |
| `unas_docs_sync` | A tudástár letöltése vagy frissítése a háttérben |

A ✎ (író) és ⚠ (törlő vagy nyers író) eszközök read-only módban meg sem jelennek.

**Resource-ok:** `unas://limits` (a limitek táblázata), `unas://endpoints` (a végpontok listája)
**Promptok (kész feladatsablonok):** `daily_order_report` (napi rendelésösszesítő), `customer_lookup` (vásárló keresése), `stock_check` (készletellenőrzés)

---

## Biztonság és limitek

Az UNAS API limitjei szigorúak. Ha egy listázó hívást túl sokszor futtatsz, vagy egy végpont 20-szor egymás után hibára fut, az **IP címedet 1 órára letiltják**. Ismétlődő sértésnél a tiltás egyre hosszabb: 1 nap, 1 hónap, végül 1 év. A szerver ezért magától vigyáz:

- **Helyi rate limit:** végpontonként, egy órás csúszó ablakban számolja a hívásokat, külön az egyedi és külön a listázó hívásokat. A limitet a bejelentkezéskor kapott előfizetésből (PREMIUM vagy VIP) állítja be, és alapból csak 90%-ig engedi elhasználni.
- **Hibavédelem:** ha egy végpont 15-ször egymás után hibára fut, a szerver megállítja, mielőtt az UNAS letiltaná az IP-t.
- **Hibás API kulcs elleni védelem:** 3 sikertelen bejelentkezés után 10 percig szünetel. Az UNAS 10 ilyen próbálkozás után az összes bolt API-ját letiltaná az adott IP-ről.
- **Tiltás felismerése:** ha az UNAS tiltást jelez, a szerver a tiltás lejártáig nem hívja újra az adott végpontot.
- **Párhuzamosság:** egyszerre legfeljebb 4 kérést küld (az UNAS 5-öt enged).
- **Token kezelés:** egyszer jelentkezik be, és a tokent a lejárata előtt megújítja.
- **Cache:** a ritkán változó törzsadatokat (státuszok, fizetési és szállítási módok, kategóriák) 10 percig tárolja.
- **Biztonságos írás:** minden író eszköznek van `dryRun` módja. Törléshez és nyers íráshoz kötelező a `confirm`. A részben sikertelen írásoknál felsorolja a hibás tételeket.
- **Tömör kimenet:** a listák alapból rövid összefoglalót adnak, hogy kevesebb tokent használjanak. A teljes UNAS adatszerkezethez add meg a `detail="full"` paramétert.

### Amit érdemes tudni

- A **listázó** lekérések keretei szűkösek. A getOrder, getProduct, getStock, getCategory és getCustomer hívásokból PREMIUM csomagban **30 jut óránként**, VIP-ben 90. Az egyedi lekérésekből (egy rendelés vagy egy SKU) 1000, illetve 3000.
- Ezért jobb egy szűk időszakot egy nagyobb oldalon lekérni, mint sok kicsi oldalt lapozni.
- A `getPage`/`setPage` (saját oldalak) PREMIUM csomagban óránként csak 30 hívást enged, olvasásra és írásra együtt.
- A limitek **IP címre és boltra** vonatkoznak. Ha ugyanarról az IP-ről más integráció (könyvelő program, piactér-szinkron stb.) is hívja az API-t, azt a szerver nem látja.
- Éjfél körül (±10 perc) az UNAS karbantartást végezhet, ilyenkor ne fusson hívás.
- Az UNAS írási logikája szerint a kihagyott mező változatlan marad, az üresen küldött mező viszont törli a tárolt értéket.
- A dátumokat `2026-11-19`, `2026-11-19T08:30`, ISO vagy unix formátumban is elfogadja. Az időzóna nélküli dátumokat a bolt időzónájában értelmezi.

---

## Konfiguráció (környezeti változók)

| Változó | Alapérték | Leírás |
|---|---|---|
| `UNAS_API_KEY` | – (kötelező) | Az UNAS API kulcs |
| `UNAS_READ_ONLY` | `false` | `true` esetén nem jelennek meg az író eszközök |
| `UNAS_SUBSCRIPTION` | `premium` | `premium` vagy `vip`. Csak tartalék: a limiteket a szerver a bejelentkezéskor kapott előfizetésből állítja be |
| `UNAS_TIMEZONE` | `Europe/Budapest` | Az időzóna nélküli dátumok értelmezéséhez |
| `UNAS_RATE_SAFETY` | `0.9` | A dokumentált limit mekkora részét használhatja a szerver |
| `UNAS_FAILURE_GUARD` | `15` | Ennyi egymás utáni hiba után áll meg az adott végpont |
| `UNAS_CACHE_TTL_SECONDS` | `600` | A törzsadatok cache ideje másodpercben |
| `UNAS_TIMEOUT_MS` | `60000` | HTTP timeout |
| `UNAS_MAX_OUTPUT_CHARS` | `80000` | Efölött az eszköz levágja a választ |
| `UNAS_MAX_CONCURRENCY` | `4` | Párhuzamos kérések száma (1–5) |
| `UNAS_BASE_URL` | `https://api.unas.eu/shop/` | Az API alap URL-je |
| `UNAS_DOCS_DIR` | `~/.cache/unas-mcp` | A tudástár helyi másolatának mappája |

---

## Hibaelhárítás

| Jelenség | Megoldás |
|---|---|
| Nem jelennek meg az `unas_…` eszközök | Ellenőrizd, hogy az útvonal a `dist/index.js` fájlra mutat, és lefutott az `npm run build`. Indítsd újra a klienst. Claude Code-ban és Codexben nézd meg a `/mcp` parancs kimenetét. |
| `UNAS_API_KEY is required` | Nincs megadva az API kulcs az `env` részben. |
| Azonosítási hiba | Rossz vagy lejárt a kulcs, vagy nincs jogosultsága az adott végponthoz. Nézd meg az UNAS adminban. Több hibás próbálkozás után a szerver 10 percig szünetel. |
| `IP is banned till …` | Az UNAS letiltotta az IP-t. Várd ki a jelzett időt, és ne próbálkozz közben, mert a tiltás meghosszabbodhat. |
| Nem lehet készletet módosítani | A terméken ki van kapcsolva a készletkezelés. Kapcsold be a `stockManaged: true` beállítással. |
| Nem megy ki a státusz e-mail | Két dolognak kell bekapcsolva lennie: az adminban a **Beállítások → Vásárlási folyamat → Értesítések** alatt a „Megrendelés státusz módosítás” értesítésnek, és a státusznál az e-mail értesítésnek. |
| Üres a tudástár keresés | Futtasd le az `npm run docs:sync` parancsot. |

---

## Fejlesztés

```bash
npm run dev       # futtatás TypeScriptből (tsx)
npm test          # tesztek egy szimulált UNAS API ellen
npm run build     # fordítás a dist/ mappába
npm run inspect   # MCP Inspector
```

```
src/
  index.ts            stdio belépési pont
  server.ts           eszközök, resource-ok és promptok regisztrációja, szerver utasítások
  config.ts           környezeti változók
  unas/client.ts      bejelentkezés, HTTP, rate limit, hibavédelem, tiltás, cache
  unas/xml.ts         XML <-> JSON átalakítás
  unas/limits.ts      a dokumentált limitek és a végpontlista
  tools/*.ts          eszközök területenként (rendelés, termék, készlet, tartalom, SEO, tudástár…)
  docs/               a tudástár letöltése, HTML → szöveg, keresés (BM25)
  util/               dátumok, összefoglalók, eredmény formázás
test/server.test.ts   szimulált UNAS API + MCP kliens tesztek
```

Hibát vagy ötletet az [Issues](https://github.com/attisvalentin/unas-mcp/issues) oldalon jelezhetsz, és pull requestet is szívesen fogadok.

Hivatalos UNAS API dokumentáció: https://unas.hu/tudastar/api

---

## Licenc

[PolyForm Noncommercial 1.0.0](LICENSE). A forráskód nyilvános, és **nem kereskedelmi célra** szabadon használható, módosítható és továbbadható.

- ✅ Szabad: saját célra, tanuláshoz, kutatáshoz, kipróbáláshoz, hobbi projektben, valamint nonprofit, oktatási vagy közintézményben.
- ❌ Nem szabad külön engedély nélkül: kereskedelmi célra. Ide tartozik például a fizetős termékbe vagy szolgáltatásba építés, az ügynökségi munka ügyfeleknek, vagy a saját cég webáruházának üzemeltetése vele.

Kereskedelmi licencért keress meg a GitHub profilomon keresztül.

A licenc nem OSI-minősítésű, azaz a szó szoros értelmében nem „open source”, hanem *source-available*. A forrás nyílt, de a kereskedelmi felhasználás tiltott.

A UNAS név és a tudástár tartalma az UNAS Online Kft. tulajdona.
