/* PLATEAU Viewer - CesiumJSベースの3D都市モデルビューア */
"use strict";

// ============================================================
// 状態
// ============================================================
const state = {
  layers: [],        // {id, dataset, tileset, visible, style, opacity, heightProp, heightRange, heightFilter, pending}
  sse: 16,           // maximumScreenSpaceError（小=高品質、大=高速）
  basemap: "photo",
  shadows: false,
};

const STORAGE_KEY = "plateau-viewer-state";
const BOOKMARK_KEY = "plateau-viewer-bookmarks";

// 高さ属性の候補（PLATEAU仕様バージョンにより名前が異なる）
const HEIGHT_PROPS = ["bldg:measuredHeight", "計測高さ", "measuredHeight", "高さ"];

// 高さ色分けのランプ（下から: 低層→超高層）
const HEIGHT_RAMP = [
  [180, "#e0452f"],
  [120, "#f2913e"],
  [60, "#f2d13e"],
  [31, "#9ecf63"],
  [12, "#5fb0a5"],
  [-Infinity, "#3d7dc8"],
];

// min>0のタイルは日本域のrectangleを指定する（Cesiumの制約 + 低ズームの404回避）
const JAPAN_RECT = [122, 20, 154, 46];
const BASEMAPS = {
  photo: { url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", min: 2, max: 18, rect: JAPAN_RECT, credit: "地理院タイル（シームレス空中写真）" },
  std:   { url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", min: 0, max: 18, credit: "地理院タイル（標準地図）" },
  pale:  { url: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", min: 2, max: 18, rect: JAPAN_RECT, credit: "地理院タイル（淡色地図）" },
  dark:  { url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", min: 0, max: 19, credit: "© OpenStreetMap contributors © CARTO" },
};

const $ = (id) => document.getElementById(id);

// ============================================================
// Cesium Viewer 初期化
// ============================================================
const viewer = new Cesium.Viewer("cesiumContainer", {
  baseLayer: makeBasemapLayer("photo"),
  geocoder: false,
  baseLayerPicker: false,
  sceneModePicker: true,
  animation: false,
  timeline: false,
  homeButton: false,
  fullscreenButton: false,
  navigationHelpButton: false,
  infoBox: false,
  selectionIndicator: false,
  requestRenderMode: true,
  maximumRenderTimeChange: Infinity,
});
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#1b1e24");
viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
// ダブルクリックで地物を追尾するデフォルト動作を無効化（計測終了に使うため）
viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

function makeBasemapLayer(key) {
  const bm = BASEMAPS[key];
  const options = {
    url: bm.url,
    minimumLevel: bm.min,
    maximumLevel: bm.max,
    credit: new Cesium.Credit(bm.credit),
  };
  if (bm.rect) {
    options.rectangle = Cesium.Rectangle.fromDegrees(...bm.rect);
  }
  return new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider(options));
}

function requestRender() {
  viewer.scene.requestRender();
}

function flyToJapan(duration = 1.5) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(138.5, 36.0, 2200000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration,
  });
}

// ============================================================
// API
// ============================================================
async function api(path, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, v);
  }
  const qs = q.toString();
  const resp = await fetch(`/api/${path}${qs ? "?" + qs : ""}`);
  if (!resp.ok) throw new Error(`API ${path} failed: ${resp.status}`);
  return resp.json();
}

// ============================================================
// トースト・ステータス
// ============================================================
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

// ============================================================
// レイヤー管理
// ============================================================
async function addDataset(dataset, options = {}) {
  if (dataset.format !== "3D Tiles") {
    toast("このデータセットの形式（" + dataset.format + "）は3D表示に未対応です");
    return null;
  }
  if (state.layers.some((l) => l.id === dataset.id)) {
    toast("すでに追加されています: " + dataset.name);
    return state.layers.find((l) => l.id === dataset.id);
  }

  const layer = {
    id: dataset.id,
    dataset,
    tileset: null,
    visible: options.visible !== false,
    style: options.style || "default",
    opacity: options.opacity != null ? options.opacity : 1,
    heightProp: null,
    heightRange: null,
    heightFilter: null,
    pending: 0,
    loading: true,
  };
  state.layers.push(layer);
  renderLayerList();
  toast("読み込み中: " + dataset.name);

  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(dataset.url, {
      maximumScreenSpaceError: state.sse,
      skipLevelOfDetail: true,
      baseScreenSpaceError: 1024,
      skipScreenSpaceErrorFactor: 16,
      skipLevels: 1,
      cullWithChildrenBounds: true,
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 0.00278,
      dynamicScreenSpaceErrorFactor: 4.0,
    });
    layer.tileset = tileset;
    layer.loading = false;
    tileset.show = layer.visible;
    viewer.scene.primitives.add(tileset);

    // 高さ属性の検出（tileset.jsonのproperties由来）
    const props = tileset.properties;
    if (props) {
      for (const cand of HEIGHT_PROPS) {
        if (props[cand] !== undefined) {
          layer.heightProp = cand;
          const p = props[cand];
          if (p && p.minimum !== undefined) layer.heightRange = [p.minimum, p.maximum];
          break;
        }
      }
    }

    // タイル読み込み進捗
    tileset.loadProgress.addEventListener((pending, processing) => {
      layer.pending = pending + processing;
      updateTileProgress();
      requestRender();
    });

    applyLayerStyle(layer);
    renderLayerList();
    saveState();
    if (options.fly !== false) viewer.flyTo(tileset, { duration: 1.8 });
    return layer;
  } catch (e) {
    console.error(e);
    state.layers = state.layers.filter((l) => l.id !== dataset.id);
    renderLayerList();
    toast("読み込みに失敗しました: " + dataset.name);
    return null;
  }
}

async function addDatasetById(id, options = {}) {
  try {
    const dataset = await api("dataset", { id });
    return addDataset(dataset, options);
  } catch (e) {
    toast("データセットが見つかりません: " + id);
    return null;
  }
}

function removeLayer(layer) {
  if (layer.tileset) viewer.scene.primitives.remove(layer.tileset);
  state.layers = state.layers.filter((l) => l !== layer);
  clearSelection();
  renderLayerList();
  updateTileProgress();
  saveState();
  requestRender();
}

function updateTileProgress() {
  const total = state.layers.reduce((n, l) => n + (l.pending || 0), 0);
  const el = $("tileProgress");
  if (total > 0) {
    el.classList.remove("hidden");
    $("tileProgressCount").textContent = `(${total})`;
  } else {
    el.classList.add("hidden");
  }
}

// スタイル（色分け・不透明度・高さフィルタ）をまとめて適用する
function applyLayerStyle(layer) {
  const tileset = layer.tileset;
  if (!tileset) return;
  clearSelection();

  const alpha = layer.opacity;
  let showExpr = null;
  if (layer.heightProp && layer.heightFilter) {
    const p = `Number(\${feature['${layer.heightProp}']})`;
    const conds = [];
    if (layer.heightFilter.min != null) conds.push(`${p} >= ${layer.heightFilter.min}`);
    if (layer.heightFilter.max != null) conds.push(`${p} <= ${layer.heightFilter.max}`);
    if (conds.length) showExpr = conds.join(" && ");
  }

  let styleDef = null;
  if (layer.style === "white") {
    styleDef = { color: `color('#e8e8e8', ${alpha})` };
    tileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.REPLACE;
  } else if (layer.style === "height" && layer.heightProp) {
    const p = `Number(\${feature['${layer.heightProp}']})`;
    const conditions = HEIGHT_RAMP.map(([threshold, color]) => [
      threshold === -Infinity ? "true" : `${p} >= ${threshold}`,
      `color('${color}', ${alpha})`,
    ]);
    styleDef = { color: { conditions } };
    tileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.REPLACE;
  } else {
    tileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.HIGHLIGHT;
    if (alpha < 1) styleDef = { color: `color('#ffffff', ${alpha})` };
  }

  if (showExpr) {
    styleDef = styleDef || {};
    styleDef.show = showExpr;
  }

  tileset.style = styleDef ? new Cesium.Cesium3DTileStyle(styleDef) : undefined;
  requestRender();
}

// ============================================================
// レイヤーパネルUI
// ============================================================
function renderLayerList() {
  const list = $("layerList");
  list.innerHTML = "";
  $("layerEmpty").classList.toggle("hidden", state.layers.length > 0);
  const badge = $("layerCount");
  badge.textContent = state.layers.length;
  badge.classList.toggle("hidden", state.layers.length === 0);

  for (const layer of state.layers) {
    const li = document.createElement("li");

    const head = document.createElement("div");
    head.className = "layer-head";

    const eye = iconBtn(layer.visible ? "👁" : "🚫", "表示/非表示", () => {
      layer.visible = !layer.visible;
      if (layer.tileset) layer.tileset.show = layer.visible;
      renderLayerList();
      saveState();
      requestRender();
    });

    const name = document.createElement("div");
    name.className = "layer-name";
    name.textContent = layer.dataset.name;
    name.title = layer.dataset.id;

    const zoomBtn = iconBtn("🎯", "このレイヤーに移動", () => {
      if (layer.tileset) viewer.flyTo(layer.tileset, { duration: 1.2 });
    });
    const infoBtn = iconBtn("ℹ️", "詳細", () => showDetail(layer.dataset));
    const delBtn = iconBtn("🗑", "削除", () => removeLayer(layer));
    delBtn.classList.add("danger");

    head.append(eye, name, zoomBtn, infoBtn, delBtn);
    li.appendChild(head);

    if (layer.loading) {
      const loading = document.createElement("div");
      loading.className = "layer-loading";
      loading.textContent = "読み込み中...";
      li.appendChild(loading);
      list.appendChild(li);
      continue;
    }

    // 色分けスタイル
    const styleRow = document.createElement("div");
    styleRow.className = "layer-row";
    const styleSel = document.createElement("select");
    const styles = [["default", "標準（テクスチャ）"], ["white", "単色（白）"]];
    if (layer.heightProp) styles.push(["height", "高さで色分け"]);
    for (const [v, label] of styles) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = label;
      if (layer.style === v) opt.selected = true;
      styleSel.appendChild(opt);
    }
    styleSel.onchange = () => {
      layer.style = styleSel.value;
      applyLayerStyle(layer);
      saveState();
    };
    styleRow.append("表示", styleSel);
    li.appendChild(styleRow);

    // 不透明度
    const opRow = document.createElement("div");
    opRow.className = "layer-row";
    const opSlider = document.createElement("input");
    opSlider.type = "range";
    opSlider.min = "0.1";
    opSlider.max = "1";
    opSlider.step = "0.05";
    opSlider.value = layer.opacity;
    opSlider.oninput = () => {
      layer.opacity = parseFloat(opSlider.value);
      applyLayerStyle(layer);
    };
    opSlider.onchange = saveState;
    opRow.append("透明度", opSlider);
    li.appendChild(opRow);

    // 高さフィルタ
    if (layer.heightProp) {
      const fRow = document.createElement("div");
      fRow.className = "layer-row";
      const minIn = document.createElement("input");
      const maxIn = document.createElement("input");
      minIn.type = maxIn.type = "number";
      minIn.placeholder = layer.heightRange ? String(Math.floor(layer.heightRange[0])) : "最小";
      maxIn.placeholder = layer.heightRange ? String(Math.ceil(layer.heightRange[1])) : "最大";
      if (layer.heightFilter) {
        if (layer.heightFilter.min != null) minIn.value = layer.heightFilter.min;
        if (layer.heightFilter.max != null) maxIn.value = layer.heightFilter.max;
      }
      const apply = () => {
        const min = minIn.value === "" ? null : parseFloat(minIn.value);
        const max = maxIn.value === "" ? null : parseFloat(maxIn.value);
        layer.heightFilter = min == null && max == null ? null : { min, max };
        applyLayerStyle(layer);
        saveState();
      };
      minIn.onchange = maxIn.onchange = apply;
      fRow.append("高さ(m)", minIn, "〜", maxIn);
      li.appendChild(fRow);
    }

    list.appendChild(li);
  }
}

function iconBtn(text, title, onclick) {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.textContent = text;
  b.title = title;
  b.onclick = onclick;
  return b;
}

// ============================================================
// 検索UI
// ============================================================
async function initSearchForm() {
  const [prefs, types] = await Promise.all([api("prefs"), api("types")]);
  for (const p of prefs) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    $("searchPref").appendChild(opt);
  }
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.textContent = `${t.name} (${t.count})`;
    $("searchType").appendChild(opt);
  }
}

async function doSearch() {
  const status = $("searchStatus");
  status.textContent = "検索中...";
  $("searchResults").innerHTML = "";
  try {
    const results = await api("datasets", {
      q: $("searchQuery").value.trim(),
      pref: $("searchPref").value,
      city: $("searchCity").value.trim(),
      type: $("searchType").value,
      format: $("search3dOnly").checked ? "3D Tiles" : "",
      limit: 60,
    });
    status.textContent = results.length === 0
      ? "該当するデータセットがありません。"
      : `${results.length}件ヒット${results.length >= 60 ? "（上位60件を表示）" : ""}`;
    renderSearchResults(results);
  } catch (e) {
    status.textContent = "検索に失敗しました: " + e.message;
  }
}

function renderSearchResults(results) {
  const ul = $("searchResults");
  ul.innerHTML = "";
  for (const d of results) {
    const li = document.createElement("li");

    const name = document.createElement("div");
    name.className = "result-name";
    name.textContent = d.name;

    const meta = document.createElement("div");
    meta.className = "result-meta";
    const chip = document.createElement("span");
    chip.className = "chip" + (d.format === "MVT" ? " mvt" : "");
    chip.textContent = d.format + (d.lod != null ? ` LOD${d.lod}` : "");
    meta.appendChild(chip);
    meta.append(` ${d.pref} ${d.ward || d.city || ""} / ${d.year}年度 / ${formatSize(d.file_size)}`);

    const actions = document.createElement("div");
    actions.className = "result-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "tbtn";
    if (d.format !== "3D Tiles") {
      addBtn.textContent = "表示未対応";
      addBtn.disabled = true;
      addBtn.title = "MVT等の形式は現在3D表示に未対応です";
    } else if (state.layers.some((l) => l.id === d.id)) {
      addBtn.textContent = "追加済み";
      addBtn.disabled = true;
    } else {
      addBtn.textContent = "＋ 追加";
      addBtn.onclick = async () => {
        addBtn.disabled = true;
        await addDataset(d);
        renderSearchResults(results);
      };
    }
    const detailBtn = document.createElement("button");
    detailBtn.className = "tbtn";
    detailBtn.textContent = "詳細";
    detailBtn.onclick = () => showDetail(d);
    actions.append(addBtn, detailBtn);

    li.append(name, meta, actions);
    ul.appendChild(li);
  }
}

function formatSize(bytes) {
  if (!bytes) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  for (const u of units) {
    if (size < 1024) return `${size.toFixed(1)} ${u}`;
    size /= 1024;
  }
  return `${size.toFixed(1)} TB`;
}

// クイックスタート: 都市名から建築物モデル（LOD2優先）を自動追加
async function quickStart(cityName, label) {
  toast(`${label}の建築物モデルを検索中...`);
  try {
    const results = await api("datasets", { city: cityName, type: "建築物モデル", format: "3D Tiles", limit: 200 });
    if (results.length === 0) {
      toast(`${label}の建築物モデルが見つかりません`);
      return;
    }
    const pick =
      results.find((d) => /lod2(?!.*no_texture)/.test(d.id) && !d.id.includes("no_texture")) ||
      results.find((d) => d.id.includes("lod2")) ||
      results.find((d) => d.id.includes("lod1")) ||
      results[0];
    await addDataset(pick);
  } catch (e) {
    toast("クイックスタートに失敗しました: " + e.message);
  }
}

// ============================================================
// データセット詳細ダイアログ
// ============================================================
const FIELD_LABELS = {
  id: "ID", name: "名称", pref: "都道府県", city: "市区町村", ward: "区",
  type: "種別", type_en: "種別コード", url: "URL", file_size: "サイズ",
  year: "データ年度", registration_year: "登録年度", spec: "PLATEAU仕様",
  format: "形式", format_version: "形式バージョン", lod: "LOD", texture: "テクスチャ",
};

function showDetail(dataset) {
  $("detailTitle").textContent = dataset.name;
  const table = $("detailTable");
  table.innerHTML = "";
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    let value = dataset[key];
    if (value === null || value === undefined || value === "") continue;
    if (key === "file_size") value = formatSize(value);
    if (typeof value === "boolean") value = value ? "あり" : "なし";
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    const td2 = document.createElement("td");
    td1.textContent = label;
    td2.textContent = value;
    tr.append(td1, td2);
    table.appendChild(tr);
  }
  $("detailCopyUrlBtn").onclick = () => copyText(dataset.url, "URLをコピーしました");
  const addBtn = $("detailAddBtn");
  const added = state.layers.some((l) => l.id === dataset.id);
  addBtn.disabled = added || dataset.format !== "3D Tiles";
  addBtn.textContent = added ? "追加済み" : dataset.format !== "3D Tiles" ? "表示未対応" : "マップに追加";
  addBtn.onclick = () => {
    $("detailDialog").close();
    addDataset(dataset);
  };
  $("detailDialog").showModal();
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch (e) {
    window.prompt("コピーしてください:", text);
  }
}

// ============================================================
// 地物クリック → 属性パネル
// ============================================================
let selectedFeature = null;
let selectedOriginalColor = null;
let currentAttrs = null;

function clearSelection() {
  if (selectedFeature) {
    try { selectedFeature.color = selectedOriginalColor; } catch (e) { /* タイル解放済み */ }
    selectedFeature = null;
    selectedOriginalColor = null;
  }
}

const pickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
pickHandler.setInputAction((movement) => {
  if (measureState.active) {
    measureAddPoint(movement.position);
    return;
  }
  const picked = viewer.scene.pick(movement.position);
  clearSelection();
  if (picked instanceof Cesium.Cesium3DTileFeature) {
    selectedFeature = picked;
    selectedOriginalColor = Cesium.Color.clone(picked.color);
    picked.color = Cesium.Color.fromCssColorString("#ffd166");
    showAttributes(picked);
  } else {
    $("attrPanel").classList.add("hidden");
  }
  requestRender();
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

function showAttributes(feature) {
  const attrs = {};
  for (const key of feature.getPropertyIds()) {
    let value = feature.getProperty(key);
    if (value === undefined || value === null || value === "") continue;
    attrs[key] = value;
  }
  currentAttrs = attrs;
  renderAttributes();
  $("attrPanel").classList.remove("hidden");
}

function renderAttributes() {
  if (!currentAttrs) return;
  const filter = $("attrFilter").value.trim().toLowerCase();
  const body = $("attrBody");
  body.innerHTML = "";
  for (const [key, rawValue] of Object.entries(currentAttrs)) {
    if (filter && !key.toLowerCase().includes(filter)) continue;
    let value = rawValue;
    // ネストされた属性（JSON文字列）は整形して表示
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try { value = JSON.stringify(JSON.parse(value), null, 1); } catch (e) { /* 文字列のまま */ }
    }
    const row = document.createElement("div");
    row.className = "attr-row";
    const k = document.createElement("div");
    k.className = "attr-key";
    k.textContent = key;
    const v = document.createElement("div");
    v.className = "attr-val";
    v.textContent = String(value);
    row.append(k, v);
    body.appendChild(row);
  }
}

// ============================================================
// 距離計測
// ============================================================
const measureState = { active: false, positions: [], entities: [] };

function toggleMeasure(on) {
  measureState.active = on !== undefined ? on : !measureState.active;
  $("measureBtn").classList.toggle("active", measureState.active);
  $("measureHint").classList.toggle("hidden", !measureState.active);
  if (!measureState.active) measureFinish(false);
}

function pickPosition(windowPos) {
  let pos;
  if (viewer.scene.pickPositionSupported) {
    pos = viewer.scene.pickPosition(windowPos);
  }
  if (!Cesium.defined(pos)) {
    pos = viewer.camera.pickEllipsoid(windowPos, viewer.scene.globe.ellipsoid);
  }
  return pos;
}

function measureAddPoint(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;
  measureState.positions.push(pos);

  measureState.entities.push(viewer.entities.add({
    position: pos,
    point: { pixelSize: 7, color: Cesium.Color.fromCssColorString("#ffd166"), disableDepthTestDistance: Number.POSITIVE_INFINITY },
  }));

  const n = measureState.positions.length;
  if (n >= 2) {
    const a = measureState.positions[n - 2];
    const b = measureState.positions[n - 1];
    measureState.entities.push(viewer.entities.add({
      polyline: { positions: [a, b], width: 2.5, material: Cesium.Color.fromCssColorString("#ffd166") },
    }));
    let total = 0;
    for (let i = 1; i < n; i++) {
      total += Cesium.Cartesian3.distance(measureState.positions[i - 1], measureState.positions[i]);
    }
    const label = total >= 1000 ? (total / 1000).toFixed(2) + " km" : total.toFixed(1) + " m";
    measureState.entities.push(viewer.entities.add({
      position: b,
      label: {
        text: label,
        font: "13px sans-serif",
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#14181e").withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));
  }
  requestRender();
}

function measureFinish(keepResult = true) {
  if (!keepResult) {
    for (const e of measureState.entities) viewer.entities.remove(e);
    measureState.entities = [];
  }
  measureState.positions = [];
  requestRender();
}

pickHandler.setInputAction(() => {
  if (measureState.active) {
    // 計測を確定して計測モードを抜ける（結果は残す）
    measureState.positions = [];
    toggleMeasure(false);
    toast("計測を終了しました（もう一度📏を押すと結果をクリア）");
  }
}, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && measureState.active) toggleMeasure(false);
});

$("measureBtn").onclick = () => {
  if (!measureState.active && measureState.entities.length > 0) {
    // 前回の結果が残っていればクリアしてから開始
    measureFinish(false);
  }
  toggleMeasure();
};

// ============================================================
// 住所検索（国土地理院ジオコーダ）
// ============================================================
let geocodeTimer = null;
$("geocodeInput").addEventListener("input", () => {
  clearTimeout(geocodeTimer);
  const q = $("geocodeInput").value.trim();
  if (q.length < 2) {
    $("geocodeResults").classList.add("hidden");
    return;
  }
  geocodeTimer = setTimeout(() => geocode(q), 400);
});

async function geocode(q) {
  try {
    const results = await api("geocode", { q });
    const box = $("geocodeResults");
    box.innerHTML = "";
    if (!Array.isArray(results) || results.length === 0) {
      box.classList.add("hidden");
      return;
    }
    for (const r of results.slice(0, 8)) {
      const [lon, lat] = r.geometry.coordinates;
      const div = document.createElement("div");
      div.textContent = r.properties.title;
      div.onclick = () => {
        box.classList.add("hidden");
        $("geocodeInput").value = r.properties.title;
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.012, 2000),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
          duration: 2.0,
        });
      };
      box.appendChild(div);
    }
    box.classList.remove("hidden");
  } catch (e) {
    console.error(e);
  }
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".geocode-box")) $("geocodeResults").classList.add("hidden");
});

// ============================================================
// ブックマーク
// ============================================================
function getCameraState() {
  const c = viewer.camera;
  const pos = c.positionCartographic;
  return {
    lon: Cesium.Math.toDegrees(pos.longitude),
    lat: Cesium.Math.toDegrees(pos.latitude),
    h: pos.height,
    hd: c.heading,
    p: c.pitch,
    r: c.roll,
  };
}

function setCameraState(cs, duration = 0) {
  const opts = {
    destination: Cesium.Cartesian3.fromDegrees(cs.lon, cs.lat, cs.h),
    orientation: { heading: cs.hd, pitch: cs.p, roll: cs.r },
  };
  if (duration > 0) viewer.camera.flyTo({ ...opts, duration });
  else viewer.camera.setView(opts);
}

function loadBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARK_KEY)) || []; } catch (e) { return []; }
}

function renderBookmarks() {
  const bookmarks = loadBookmarks();
  const ul = $("bookmarkList");
  ul.innerHTML = "";
  $("bookmarkEmpty").classList.toggle("hidden", bookmarks.length > 0);
  bookmarks.forEach((bm, i) => {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "layer-head";
    const name = document.createElement("div");
    name.className = "layer-name";
    name.textContent = bm.name;
    name.style.cursor = "pointer";
    name.onclick = () => setCameraState(bm.camera, 1.5);
    const flyBtn = iconBtn("🎯", "移動", () => setCameraState(bm.camera, 1.5));
    const delBtn = iconBtn("🗑", "削除", () => {
      const list = loadBookmarks();
      list.splice(i, 1);
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify(list));
      renderBookmarks();
    });
    delBtn.classList.add("danger");
    head.append(name, flyBtn, delBtn);
    li.appendChild(head);
    ul.appendChild(li);
  });
}

$("addBookmarkBtn").onclick = () => {
  const name = window.prompt("ブックマーク名:", `視点 ${loadBookmarks().length + 1}`);
  if (!name) return;
  const bookmarks = loadBookmarks();
  bookmarks.push({ name, camera: getCameraState() });
  localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmarks));
  renderBookmarks();
  toast("視点を保存しました");
};

// ============================================================
// 状態の保存・復元・共有
// ============================================================
function serializeState() {
  return {
    camera: getCameraState(),
    layers: state.layers.map((l) => ({
      id: l.id,
      visible: l.visible,
      style: l.style,
      opacity: l.opacity,
      heightFilter: l.heightFilter,
    })),
    basemap: state.basemap,
    sse: state.sse,
  };
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState())); } catch (e) { /* 容量超過等は無視 */ }
}

async function restoreState(saved, fly) {
  if (saved.basemap && BASEMAPS[saved.basemap]) {
    state.basemap = saved.basemap;
    $("basemapSelect").value = saved.basemap;
    switchBasemap(saved.basemap);
  }
  if (saved.sse) {
    state.sse = saved.sse;
    $("sseSlider").value = saved.sse;
  }
  if (saved.camera) setCameraState(saved.camera, fly ? 1.2 : 0);
  if (Array.isArray(saved.layers)) {
    for (const ls of saved.layers) {
      const layer = await addDatasetById(ls.id, {
        visible: ls.visible,
        style: ls.style,
        opacity: ls.opacity,
        fly: false,
      });
      if (layer && ls.heightFilter) {
        layer.heightFilter = ls.heightFilter;
        applyLayerStyle(layer);
        renderLayerList();
      }
    }
  }
}

$("shareBtn").onclick = () => {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(serializeState()))));
  const url = `${location.origin}${location.pathname}#s=${encoded}`;
  copyText(url, "共有リンクをコピーしました");
};

function parseHashState() {
  const m = location.hash.match(/#s=(.+)/);
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(m[1]))));
  } catch (e) {
    return null;
  }
}

// ============================================================
// ヘッダーの各コントロール
// ============================================================
$("basemapSelect").onchange = (e) => {
  state.basemap = e.target.value;
  switchBasemap(state.basemap);
  saveState();
};

function switchBasemap(key) {
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.add(makeBasemapLayer(key));
  requestRender();
}

$("sseSlider").oninput = (e) => {
  state.sse = parseInt(e.target.value, 10);
  for (const l of state.layers) {
    if (l.tileset) l.tileset.maximumScreenSpaceError = state.sse;
  }
  requestRender();
};
$("sseSlider").onchange = saveState;

$("shadowBtn").onclick = () => {
  state.shadows = !state.shadows;
  viewer.shadows = state.shadows;
  $("shadowBtn").classList.toggle("active", state.shadows);
  $("timeCtrl").classList.toggle("hidden", !state.shadows);
  if (state.shadows) applyTime(parseFloat($("timeSlider").value));
  requestRender();
};

$("timeSlider").oninput = (e) => applyTime(parseFloat(e.target.value));

function applyTime(hourJst) {
  const h = Math.floor(hourJst);
  const m = Math.round((hourJst - h) * 60);
  $("timeLabel").textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const now = new Date();
  // JSTの時刻をUTCに変換して設定
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h - 9, m));
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(date);
  requestRender();
}

$("screenshotBtn").onclick = () => {
  const remove = viewer.scene.postRender.addEventListener(() => {
    remove();
    viewer.canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `plateau-viewer-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("スクリーンショットを保存しました");
    });
  });
  requestRender();
};

$("fpsBtn").onclick = () => {
  const scene = viewer.scene;
  scene.debugShowFramesPerSecond = !scene.debugShowFramesPerSecond;
  $("fpsBtn").classList.toggle("active", scene.debugShowFramesPerSecond);
  requestRender();
};

$("homeBtn").onclick = () => flyToJapan();

// ============================================================
// サイドバーのタブ・属性パネル・ダイアログ
// ============================================================
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-body").forEach((b) => b.classList.add("hidden"));
    $(`tab-${tab.dataset.tab}`).classList.remove("hidden");
  };
});

$("attrCloseBtn").onclick = () => {
  $("attrPanel").classList.add("hidden");
  clearSelection();
  requestRender();
};
$("attrCopyBtn").onclick = () => {
  if (currentAttrs) copyText(JSON.stringify(currentAttrs, null, 2), "属性をコピーしました");
};
$("attrFilter").oninput = renderAttributes;

$("detailCloseBtn").onclick = () => $("detailDialog").close();

$("searchForm").onsubmit = (e) => {
  e.preventDefault();
  doSearch();
};

document.querySelectorAll(".qs").forEach((btn) => {
  btn.onclick = () => quickStart(btn.dataset.city, btn.dataset.label);
});

// ============================================================
// カメラ位置のステータス表示
// ============================================================
viewer.camera.changed.addEventListener(() => {
  const pos = viewer.camera.positionCartographic;
  const h = pos.height;
  const hLabel = h >= 10000 ? (h / 1000).toFixed(0) + " km" : h.toFixed(0) + " m";
  $("cameraStatus").textContent =
    `緯度 ${Cesium.Math.toDegrees(pos.latitude).toFixed(5)} / 経度 ${Cesium.Math.toDegrees(pos.longitude).toFixed(5)} / 高度 ${hLabel}`;
});
viewer.camera.percentageChanged = 0.01;

let cameraSaveTimer = null;
viewer.camera.moveEnd.addEventListener(() => {
  clearTimeout(cameraSaveTimer);
  cameraSaveTimer = setTimeout(saveState, 800);
});

// ============================================================
// 起動処理
// ============================================================
(async function init() {
  try {
    await initSearchForm();
  } catch (e) {
    toast("カタログの取得に失敗しました。サーバを確認してください。");
  }

  $("loadingOverlay").classList.add("hidden");

  const hashState = parseHashState();
  const savedState = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { return null; }
  })();

  if (hashState) {
    // 共有リンクからの復元
    history.replaceState(null, "", location.pathname);
    toast("共有リンクの状態を復元しています...");
    await restoreState(hashState, false);
  } else if (savedState && Array.isArray(savedState.layers) && savedState.layers.length > 0) {
    toast("前回のセッションを復元しています...");
    await restoreState(savedState, false);
  } else {
    flyToJapan(0);
  }

  renderBookmarks();
  requestRender();
})();
