/* 敷地条件調査（確認申請・都市計画関連の基礎資料づくり）
 *
 * 地点をクリックすると、
 *  1. 国土地理院の逆ジオコーダで市区町村コード・所在を取得
 *  2. その自治体のPLATEAU都市計画決定情報（MVT）を直接取得して
 *     用途地域・建蔽率・容積率・防火指定・高度地区・区域区分を点で判定
 *  3. 敷地面積（作図済みヤード内なら自動、なければ入力）から
 *     最大建築面積・最大延床面積・参考階数のボリューム試算
 * を行い、帳票「敷地条件調査書」として出力できる。
 *
 * ※本機能は参考情報。申請にあたっては行政窓口・都市計画図での確認が必要。
 */
"use strict";

const SITECHECK_TARGETS = [
  { layer: "UseDistrict", label: "用途地域" },
  { layer: "FirePreventionDistrict", label: "防火・準防火地域" },
  { layer: "HeightControlDistrict", label: "高度地区" },
  { layer: "AreaClassification", label: "区域区分" },
  { layer: "DistrictPlan", label: "地区計画" },
];
const sitecheckState = { arming: false, marker: null };
let lastSiteCheck = null;

$("sitecheckBtn").onclick = () => {
  sitecheckState.arming = !sitecheckState.arming;
  $("sitecheckBtn").classList.toggle("active", sitecheckState.arming);
  if (sitecheckState.arming) {
    closeDrawer();
    showHint("調査する敷地の地点をクリックしてください（Escで中止）");
  } else {
    hideHint();
  }
};

async function runSiteCheckAt(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;
  sitecheckState.arming = false;
  $("sitecheckBtn").classList.remove("active");
  hideHint();

  const carto = Cesium.Cartographic.fromCartesian(pos);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  toast("敷地条件を調査しています...");

  // マーカー表示
  if (sitecheckState.marker) viewer.entities.remove(sitecheckState.marker);
  sitecheckState.marker = viewer.entities.add({
    position: pos,
    point: { pixelSize: 12, color: Cesium.Color.fromCssColorString("#e0a03d"), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
  });
  requestRender();

  try {
    // 1. 市区町村コード（地理院 逆ジオコーダ）
    let muniCd = null, placeName = "";
    try {
      const resp = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`);
      const rg = (await resp.json()).results || {};
      muniCd = rg.muniCd;
      placeName = rg.lv01Nm || "";
    } catch (e) { /* 逆ジオコーダ不通 */ }
    if (!muniCd) {
      toast("市区町村を特定できませんでした（日本国内の地点をクリックしてください）");
      return;
    }

    // 2. 該当自治体の都市計画MVTを点で判定
    const all = await api("datasets", { type: "都市計画決定情報モデル", format: "MVT", limit: 3000 });
    const cityDatasets = all.filter((d) => d.city_code === muniCd);
    const rows = [];
    const found = {};
    for (const target of SITECHECK_TARGETS) {
      const ds = cityDatasets.find((d) => (d.layers || []).includes(target.layer));
      if (!ds) continue;
      const props = await sitecheckQueryMvt(ds.url, lon, lat);
      if (props) {
        found[target.layer] = props;
        const name = props.urf_function || props.function || "指定あり";
        const extra = [];
        if (props.urf_buildingCoverageRate != null) extra.push(`建蔽率${props.urf_buildingCoverageRate}%`);
        if (props.urf_floorAreaRate != null) extra.push(`容積率${props.urf_floorAreaRate}%`);
        rows.push({ item: target.label, value: String(name), detail: extra.join(" / ") });
      } else {
        rows.push({ item: target.label, value: "該当なし（区域外）", detail: "" });
      }
    }
    if (rows.length === 0) {
      toast(`${placeName || muniCd} の都市計画決定情報（MVT）がPLATEAUに未整備です`);
      return;
    }

    // 3. ボリューム試算
    const ud = found.UseDistrict || {};
    const coverage = Number(ud.urf_buildingCoverageRate);
    const far = Number(ud.urf_floorAreaRate);
    let siteArea = null;
    // クリック地点が作図済みヤードの中なら面積を自動採用
    const zone = state.layers.find((l) => l.kind === "zone" && sitecheckPointInZone(l, pos));
    if (zone) siteArea = zone.zone.area;
    else {
      const input = window.prompt("敷地面積(m²)を入力してください（空欄で試算スキップ）:", "500");
      if (input) siteArea = parseFloat(input) || null;
    }
    let calc = null;
    if (siteArea && Number.isFinite(coverage) && Number.isFinite(far)) {
      calc = {
        siteArea: Math.round(siteArea),
        coverage, far,
        maxFootprint: Math.round(siteArea * coverage / 100),
        maxGfa: Math.round(siteArea * far / 100),
        refFloors: Math.max(1, Math.ceil(far / coverage)),
      };
    }

    lastSiteCheck = {
      lon: lon.toFixed(6), lat: lat.toFixed(6),
      muniCd, placeName,
      date: new Date().toLocaleDateString("ja-JP"),
      rows, calc,
      useDistrict: ud.urf_function || "-",
    };
    renderSiteCheckDialog();
  } catch (e) {
    console.error(e);
    toast("敷地条件の調査に失敗しました: " + e.message);
  }
}

// MVTタイルを直接取得して点判定（z16→15→14の順に試す）
async function sitecheckQueryMvt(urlTemplate, lon, lat) {
  const provider = new MvtImageryProvider({ urlTemplate });
  const lonRad = Cesium.Math.toRadians(lon);
  const latRad = Cesium.Math.toRadians(lat);
  const scheme = new Cesium.WebMercatorTilingScheme();
  for (const z of [16, 15, 14]) {
    const t = scheme.positionToTileXY(new Cesium.Cartographic(lonRad, latRad), z, new Cesium.Cartesian2());
    if (!t) continue;
    try {
      const infos = await provider.pickFeatures(t.x, t.y, z, lonRad, latRad);
      if (infos && infos.length > 0) return infos[0].properties;
    } catch (e) { /* タイルなし */ }
  }
  return null;
}

function sitecheckPointInZone(layer, pos) {
  const pts = layer.zone.points;
  const enu = Cesium.Matrix4.inverse(
    Cesium.Transforms.eastNorthUpToFixedFrame(pts[0]), new Cesium.Matrix4());
  const local = (c) => Cesium.Matrix4.multiplyByPoint(enu, c, new Cesium.Cartesian3());
  const p = local(pos);
  let inside = false;
  const ring = pts.map(local);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if ((ring[i].y > p.y) !== (ring[j].y > p.y) &&
        p.x < ((ring[j].x - ring[i].x) * (p.y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------- 結果ダイアログ ----------
function renderSiteCheckDialog() {
  const s = lastSiteCheck;
  $("sitecheckTitle").textContent = `敷地条件調査 — ${s.placeName || s.muniCd}`;
  const body = $("sitecheckBody");
  body.innerHTML = "";

  const table = document.createElement("table");
  table.className = "survey-table";
  const tbody = document.createElement("tbody");
  const addRow = (k, v, d) => {
    const tr = document.createElement("tr");
    for (const val of [k, v, d || ""]) {
      const td = document.createElement("td");
      td.textContent = val;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  };
  addRow("調査地点", `${s.placeName}（${s.lat}, ${s.lon}）`, "");
  for (const r of s.rows) addRow(r.item, r.value, r.detail);
  table.appendChild(tbody);
  body.appendChild(table);

  if (s.calc) {
    const h = document.createElement("div");
    h.className = "stats-heading";
    h.textContent = "ボリューム試算（参考）";
    body.appendChild(h);
    const t2 = document.createElement("table");
    t2.className = "survey-table";
    const tb2 = document.createElement("tbody");
    const add2 = (k, v) => {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td"); td1.textContent = k;
      const td2 = document.createElement("td"); td2.textContent = v;
      tr.append(td1, td2);
      tb2.appendChild(tr);
    };
    add2("敷地面積", `${s.calc.siteArea.toLocaleString()} m²`);
    add2("最大建築面積", `${s.calc.maxFootprint.toLocaleString()} m²（建蔽率 ${s.calc.coverage}%）`);
    add2("最大延床面積", `${s.calc.maxGfa.toLocaleString()} m²（容積率 ${s.calc.far}%）`);
    add2("参考階数", `約 ${s.calc.refFloors} 階（容積率÷建蔽率）`);
    t2.appendChild(tb2);
    body.appendChild(t2);
  }

  const note = document.createElement("div");
  note.className = "muted stats-note";
  note.textContent = "※ PLATEAU配信の都市計画データによる参考情報です。斜線制限・日影規制・地区計画の詳細等は含みません。申請にあたっては行政窓口・都市計画図で必ず確認してください。";
  body.appendChild(note);

  $("sitecheckDialog").showModal();
}

$("sitecheckCloseBtn").onclick = () => $("sitecheckDialog").close();

$("sitecheckDocBtn").onclick = async () => {
  if (!lastSiteCheck) return;
  const ctx = await buildDocContext(null);
  const html = ReportEngine.render(SITECHECK_TEMPLATE, ctx);
  const w = ReportEngine.openPrint(html);
  if (!w) toast("ポップアップがブロックされました");
};

// 帳票テンプレート「敷地条件調査書」
const SITECHECK_TEMPLATE = {
  id: "sitecheck",
  name: "敷地条件調査書",
  blocks: [
    { type: "title", text: "敷 地 条 件 調 査 書", subtitle: "{project}" },
    { type: "meta-table", rows: [
      ["調査地点", "{sitecheck.placeName}"],
      ["座標", "北緯 {sitecheck.lat} / 東経 {sitecheck.lon}"],
      ["市区町村コード", "{sitecheck.muniCd}"],
      ["調査日", "{sitecheck.date}"],
      ["出典", "国土交通省 Project PLATEAU 都市計画決定情報 / 国土地理院"],
    ]},
    { type: "table", title: "都市計画条件", source: "sitecheck.rows", columns: [
      { label: "項目", path: "item", width: "24%" },
      { label: "内容", path: "value", width: "38%" },
      { label: "詳細", path: "detail" },
    ]},
    { type: "meta-table", title: "ボリューム試算（参考）", rows: [
      ["敷地面積", "{sitecheck.calcSiteArea}"],
      ["最大建築面積", "{sitecheck.calcFootprint}"],
      ["最大延床面積", "{sitecheck.calcGfa}"],
      ["参考階数", "{sitecheck.calcFloors}"],
    ]},
    { type: "screenshot", caption: "位置図（3Dビュー）" },
    { type: "text", label: "備考",
      text: "本書はPLATEAU配信データによる参考情報であり、斜線制限・日影規制・地区計画の詳細等は含みません。確認申請・各種申請にあたっては行政窓口および都市計画図での確認を要します。" },
  ],
};
