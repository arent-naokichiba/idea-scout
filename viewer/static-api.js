/* 静的ホスティング用APIバックエンド
 *
 * plateau_viewer.py（ローカルサーバ）なしで動かすための実装。
 * PLATEAUデータカタログAPIと国土地理院ジオコーダはどちらもCORS開放されているため、
 * ブラウザから直接取得し、カタログ（約9MB）はCache APIに24時間キャッシュする。
 * GitHub Pages等の静的ホスティングやiPhone/AndroidのブラウザからPCなしで利用できる。
 */
"use strict";

const PlateauStaticApi = (() => {
  const CATALOG_URL = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets";
  const GEOCODE_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch";
  const CACHE_NAME = "plateau-catalog-v1";
  const CACHE_TTL_MS = 24 * 3600 * 1000;

  let catalogPromise = null;

  async function fetchCatalog() {
    // Cache APIが使える環境（https / localhost）ではキャッシュを併用
    try {
      if (typeof caches !== "undefined") {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(CATALOG_URL);
        if (hit) {
          const cachedAt = Number(hit.headers.get("x-cached-at") || 0);
          if (Date.now() - cachedAt < CACHE_TTL_MS) return hit.json();
        }
        const resp = await fetch(CATALOG_URL);
        if (!resp.ok) throw new Error(`catalog fetch failed: ${resp.status}`);
        const body = await resp.arrayBuffer();
        await cache.put(CATALOG_URL, new Response(body, {
          headers: { "content-type": "application/json", "x-cached-at": String(Date.now()) },
        }));
        return JSON.parse(new TextDecoder().decode(body));
      }
    } catch (e) {
      console.warn("catalog cache unavailable:", e);
    }
    const resp = await fetch(CATALOG_URL);
    if (!resp.ok) throw new Error(`catalog fetch failed: ${resp.status}`);
    return resp.json();
  }

  function loadCatalog() {
    if (!catalogPromise) catalogPromise = fetchCatalog();
    return catalogPromise;
  }

  // サーバ側（idea_scout/plateau.py）と同じ表示名補完
  function enrichComposite(c) {
    let tex = "";
    if (c.texture === true) tex = "・テクスチャ";
    else if (c.texture === false) tex = "・テクスチャなし";
    const yearLabel = c.year === "latest" ? "最新" : `${c.year}年度`;
    return {
      ...c,
      name: `${c.type} LOD${c.lod}${tex}（${c.pref}全域・${yearLabel}）`,
      format: "3D Tiles",
      city: null,
      ward: null,
      file_size: null,
      composite: true,
    };
  }

  function filterDatasets(datasets, p) {
    const results = [];
    const limit = parseInt(p.limit || "50", 10);
    for (const d of datasets) {
      if (p.q && !(d.name || "").includes(p.q) && !(d.id || "").includes(p.q)) continue;
      if (p.pref && !(d.pref || "").includes(p.pref)) continue;
      if (p.city && !(d.city || "").includes(p.city) && !(d.ward || "").includes(p.city)) continue;
      if (p.type && !(d.type || "").includes(p.type) && p.type !== (d.type_en || "")) continue;
      if (p.format && p.format.toLowerCase() !== (d.format || "").toLowerCase()) continue;
      results.push(d);
      if (results.length >= limit) break;
    }
    return results;
  }

  async function call(path, params = {}) {
    if (path === "geocode") {
      const resp = await fetch(`${GEOCODE_URL}?q=${encodeURIComponent(params.q || "")}`);
      if (!resp.ok) throw new Error(`geocode failed: ${resp.status}`);
      return resp.json();
    }

    const cat = await loadCatalog();

    switch (path) {
      case "prefs": {
        const prefs = new Map();
        for (const c of cat.citygml) prefs.set(c.pref_code, c.pref);
        return [...prefs.entries()].sort().map(([code, name]) => ({ code, name }));
      }
      case "cities": {
        let cities = cat.citygml;
        if (params.q) {
          cities = cities.filter((c) =>
            (c.pref || "").includes(params.q) ||
            (c.city || "").includes(params.q) ||
            (c.city_code || "").includes(params.q));
        }
        return [...cities].sort((a, b) => a.city_code.localeCompare(b.city_code));
      }
      case "types": {
        const counts = new Map();
        for (const d of cat.datasets) {
          const key = `${d.type || "不明"}\t${d.type_en || "-"}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts.entries()]
          .map(([key, count]) => {
            const [name, code] = key.split("\t");
            return { name, code, count };
          })
          .sort((a, b) => b.count - a.count);
      }
      case "datasets":
        return filterDatasets(cat.datasets, params);
      case "dataset": {
        const d = cat.datasets.find((x) => x.id === params.id);
        if (d) return d;
        const c = cat.composite_tilesets.find((x) => x.id === params.id);
        if (c) return enrichComposite(c);
        throw new Error("dataset not found: " + params.id);
      }
      case "composites": {
        let results = cat.composite_tilesets;
        if (params.pref) results = results.filter((c) => (c.pref || "").includes(params.pref));
        if (params.type) {
          results = results.filter((c) =>
            (c.type || "").includes(params.type) || params.type === (c.type_en || ""));
        }
        return results.map(enrichComposite);
      }
      case "citygml": {
        const c = cat.citygml.find((x) => x.city_code === params.code);
        if (!c) throw new Error("citygml not found: " + params.code);
        return c;
      }
      default:
        throw new Error("unknown api path: " + path);
    }
  }

  return { call };
})();
