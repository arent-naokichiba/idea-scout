/* PLATEAU Viewer - CesiumJSベースの3D都市モデルビューア */
"use strict";

// ============================================================
// 状態
// ============================================================
const state = {
  layers: [],        // {id, dataset, kind, tileset|imageryLayer, visible, style, opacity, split, ...}
  sse: 16,           // maximumScreenSpaceError（小=高品質、大=高速）
  basemap: "photo",
  shadows: false,
  terrain: false,    // 地理院標高タイルによる地形
  compare: false,    // 左右比較モード
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
  if (state.layers.some((l) => l.id === dataset.id)) {
    toast("すでに追加されています: " + dataset.name);
    return state.layers.find((l) => l.id === dataset.id);
  }
  if (dataset.format === "MVT") {
    return addMvtLayer(dataset, options);
  }
  if (dataset.format !== "3D Tiles") {
    toast("このデータセットの形式（" + dataset.format + "）は3D表示に未対応です");
    return null;
  }

  const layer = {
    id: dataset.id,
    dataset,
    kind: "tiles",
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
    applySplit(layer);

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

// MVT（都市計画決定情報・土地利用など）をイメージレイヤーとして追加する
async function addMvtLayer(dataset, options = {}) {
  const layer = {
    id: dataset.id,
    dataset,
    kind: "mvt",
    imageryLayer: null,
    provider: null,
    visible: options.visible !== false,
    opacity: options.opacity != null ? options.opacity : 0.8,
    home: null,
    legendCount: 0,
    loading: false,
  };

  const provider = new MvtImageryProvider({
    urlTemplate: dataset.url,
    onLegend: (legend) => {
      // 凡例のカテゴリが増えたときだけレイヤーパネルを再描画
      if (legend.size !== layer.legendCount) {
        layer.legendCount = legend.size;
        renderLayerList();
      }
    },
  });
  layer.provider = provider;
  layer.imageryLayer = new Cesium.ImageryLayer(provider, {
    alpha: layer.opacity,
    show: layer.visible,
  });
  viewer.imageryLayers.add(layer.imageryLayer);
  applySplit(layer);

  state.layers.push(layer);
  renderLayerList();
  saveState();
  requestRender();
  toast("追加しました: " + dataset.name);

  // 対象自治体へ移動（MVTはズーム10以上で表示されるため）
  resolveMvtHome(layer).then(() => {
    if (options.fly !== false && layer.home) flyToMvtHome(layer);
  });
  return layer;
}

async function resolveMvtHome(layer) {
  const d = layer.dataset;
  const query = (d.pref || "") + (d.ward || d.city || "");
  if (!query) return;
  try {
    const results = await api("geocode", { q: query });
    if (Array.isArray(results) && results.length > 0) {
      const [lon, lat] = results[0].geometry.coordinates;
      layer.home = { lon, lat };
    }
  } catch (e) { /* ジオコーダ不通時はズーム移動なし */ }
}

function flyToMvtHome(layer) {
  if (!layer.home) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(layer.home.lon, layer.home.lat - 0.05, 9000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
    duration: 1.8,
  });
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
  if (layer.imageryLayer) viewer.imageryLayers.remove(layer.imageryLayer);
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
      if (layer.imageryLayer) layer.imageryLayer.show = layer.visible;
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
      else if (layer.kind === "mvt") flyToMvtHome(layer);
    });
    const infoBtn = iconBtn("ℹ️", "詳細", () => showDetail(layer.dataset));
    const delBtn = iconBtn("🗑", "削除", () => removeLayer(layer));
    delBtn.classList.add("danger");

    head.append(eye, name, zoomBtn);
    if (layer.kind === "tiles" && layer.dataset.type_en === "bldg" && layer.tileset) {
      head.appendChild(iconBtn("📊", "表示中の建物を集計", () => showStats(layer)));
    }
    head.append(infoBtn, delBtn);
    li.appendChild(head);

    // 比較モード時の表示側指定
    if (state.compare && !layer.loading) {
      const splitRow = document.createElement("div");
      splitRow.className = "layer-row";
      const splitSel = document.createElement("select");
      for (const [v, label] of [["both", "両側に表示"], ["left", "左側のみ"], ["right", "右側のみ"]]) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = label;
        if ((layer.split || "both") === v) opt.selected = true;
        splitSel.appendChild(opt);
      }
      splitSel.onchange = () => {
        layer.split = splitSel.value;
        applySplit(layer);
        saveState();
        requestRender();
      };
      splitRow.append("比較", splitSel);
      li.appendChild(splitRow);
    }

    if (layer.loading) {
      const loading = document.createElement("div");
      loading.className = "layer-loading";
      loading.textContent = "読み込み中...";
      li.appendChild(loading);
      list.appendChild(li);
      continue;
    }

    // 色分けスタイル（3D Tilesのみ）
    if (layer.kind !== "mvt") {
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
    }

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
      if (layer.kind === "mvt") {
        layer.imageryLayer.alpha = layer.opacity;
        requestRender();
      } else {
        applyLayerStyle(layer);
      }
    };
    opSlider.onchange = saveState;
    opRow.append("透明度", opSlider);
    li.appendChild(opRow);

    // 凡例（MVTのみ・描画済みカテゴリから動的生成）
    if (layer.kind === "mvt" && layer.provider && layer.provider.legend.size > 0) {
      const legend = document.createElement("div");
      legend.className = "legend";
      for (const [label, color] of layer.provider.legend) {
        const item = document.createElement("div");
        item.className = "legend-item";
        const chip = document.createElement("span");
        chip.className = "legend-chip";
        chip.style.background = color;
        item.append(chip, label);
        legend.appendChild(item);
      }
      li.appendChild(legend);
    }

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
    if (d.format !== "3D Tiles" && d.format !== "MVT") {
      addBtn.textContent = "表示未対応";
      addBtn.disabled = true;
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

    // 防災セット: 洪水浸水想定区域を半透明で重ねる
    if ($("qsFlood").checked) {
      const floods = await api("datasets", {
        city: cityName, type: "洪水浸水想定区域モデル", format: "3D Tiles", limit: 500,
      });
      if (floods.length === 0) {
        toast(`${label}の洪水浸水想定区域モデルが見つかりません`);
        return;
      }
      // 国管理河川・想定最大規模（l2）を優先し、最も範囲が広い（=サイズが大きい）ものを選ぶ
      const natl = floods.filter((d) => d.id.includes("_natl_"));
      const pool = natl.length > 0 ? natl : floods;
      const l2 = pool.filter((d) => /_l2(_|$)/.test(d.id));
      const flood = (l2.length > 0 ? l2 : pool)
        .sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
      await addDataset(flood, { opacity: 0.55, fly: false });
    }

    // 都市計画セット: 用途地域を重ねる
    if ($("qsUrf").checked) {
      const urfs = await api("datasets", {
        city: cityName, type: "都市計画決定情報モデル", format: "MVT", limit: 500,
      });
      const useDistrict = urfs.find((d) => (d.layers || []).includes("UseDistrict"));
      if (useDistrict) {
        await addDataset(useDistrict, { fly: false });
      } else {
        toast(`${label}の用途地域データが見つかりません`);
      }
    }
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
  const displayable = dataset.format === "3D Tiles" || dataset.format === "MVT";
  addBtn.disabled = added || !displayable;
  addBtn.textContent = added ? "追加済み" : !displayable ? "表示未対応" : "マップに追加";
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
  if (walkState.arming) {
    startWalkAt(movement.position);
    return;
  }
  const picked = viewer.scene.pick(movement.position);
  clearSelection();
  if (picked instanceof Cesium.Cesium3DTileFeature) {
    selectedFeature = picked;
    selectedOriginalColor = Cesium.Color.clone(picked.color);
    picked.color = Cesium.Color.fromCssColorString("#ffd166");
    showAttributes(picked);
    requestRender();
    return;
  }
  // 3D地物がなければMVTレイヤー（都市計画情報等）の属性を拾う
  if (state.layers.some((l) => l.kind === "mvt" && l.visible)) {
    const ray = viewer.camera.getPickRay(movement.position);
    const promise = ray && viewer.imageryLayers.pickImageryLayerFeatures(ray, viewer.scene);
    if (promise) {
      promise.then((features) => {
        if (features && features.length > 0) {
          showRawAttributes(features[0].properties, features[0].name);
        } else {
          $("attrPanel").classList.add("hidden");
        }
        requestRender();
      });
      return;
    }
  }
  $("attrPanel").classList.add("hidden");
  requestRender();
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

function showAttributes(feature) {
  const attrs = {};
  for (const key of feature.getPropertyIds()) {
    let value = feature.getProperty(key);
    if (value === undefined || value === null || value === "") continue;
    attrs[key] = value;
  }
  showRawAttributes(attrs, "地物の属性");
}

function showRawAttributes(attrs, title) {
  currentAttrs = attrs;
  $("attrTitle").textContent = title || "地物の属性";
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
// 計測（距離・面積）
// ============================================================
const MEASURE_COLOR = Cesium.Color.fromCssColorString("#ffd166");
const measureState = { active: false, mode: "distance", positions: [], entities: [] };

function measureClear() {
  for (const e of measureState.entities) viewer.entities.remove(e);
  measureState.entities = [];
  measureState.positions = [];
  requestRender();
}

function startMeasure(mode) {
  measureClear();
  measureState.active = true;
  measureState.mode = mode;
  updateMeasureUI();
}

function stopMeasure(commit) {
  if (commit && measureState.mode === "area" && measureState.positions.length >= 3) {
    const area = polygonArea(measureState.positions);
    const text = area >= 10000 ? (area / 10000).toFixed(2) + " ha" : area.toFixed(1) + " m²";
    const centroid = Cesium.Cartesian3.midpoint(
      measureState.positions[0],
      measureState.positions[Math.floor(measureState.positions.length / 2)],
      new Cesium.Cartesian3()
    );
    measureState.entities.push(viewer.entities.add({
      position: centroid,
      label: measureLabel(text),
    }));
  }
  if (!commit) measureClear();
  measureState.active = false;
  measureState.positions = [];
  updateMeasureUI();
  requestRender();
}

function updateMeasureUI() {
  $("measureBtn").classList.toggle("active", measureState.active && measureState.mode === "distance");
  $("areaBtn").classList.toggle("active", measureState.active && measureState.mode === "area");
  const hint = $("measureHint");
  if (measureState.active) {
    hint.textContent = measureState.mode === "distance"
      ? "クリックで測点を追加 / ダブルクリックで確定 / Escで中止"
      : "クリックで頂点を追加（3点以上） / ダブルクリックで面積確定 / Escで中止";
    hint.classList.remove("hidden");
  } else {
    hint.classList.add("hidden");
  }
}

function measureLabel(text) {
  return {
    text,
    font: "13px sans-serif",
    fillColor: Cesium.Color.WHITE,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString("#14181e").withAlpha(0.85),
    pixelOffset: new Cesium.Cartesian2(0, -18),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
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
    point: { pixelSize: 7, color: MEASURE_COLOR, disableDepthTestDistance: Number.POSITIVE_INFINITY },
  }));

  const n = measureState.positions.length;
  if (n >= 2) {
    const a = measureState.positions[n - 2];
    const b = measureState.positions[n - 1];
    measureState.entities.push(viewer.entities.add({
      polyline: { positions: [a, b], width: 2.5, material: MEASURE_COLOR },
    }));
  }

  if (measureState.mode === "distance" && n >= 2) {
    let total = 0;
    for (let i = 1; i < n; i++) {
      total += Cesium.Cartesian3.distance(measureState.positions[i - 1], measureState.positions[i]);
    }
    const text = total >= 1000 ? (total / 1000).toFixed(2) + " km" : total.toFixed(1) + " m";
    measureState.entities.push(viewer.entities.add({
      position: measureState.positions[n - 1],
      label: measureLabel(text),
    }));
  }

  if (measureState.mode === "area" && n === 3) {
    // 3点そろったらプレビューポリゴンを表示（頂点追加に自動追従）
    measureState.entities.push(viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.CallbackProperty(
          () => new Cesium.PolygonHierarchy(measureState.positions.slice()), false),
        material: MEASURE_COLOR.withAlpha(0.25),
        perPositionHeight: true,
        outline: false,
      },
    }));
  }
  requestRender();
}

// 面積（局所平面に投影してシューレース法。都市スケールでは十分な精度）
function polygonArea(positions) {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(positions[0]);
  const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
  const pts = positions.map((p) => Cesium.Matrix4.multiplyByPoint(inv, p, new Cesium.Cartesian3()));
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

pickHandler.setInputAction(() => {
  if (measureState.active) {
    stopMeasure(true);
    toast("計測を確定しました（📏/⬠ボタンでクリア）");
  }
}, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

$("measureBtn").onclick = () => {
  if (measureState.active && measureState.mode === "distance") stopMeasure(false);
  else startMeasure("distance");
};
$("areaBtn").onclick = () => {
  if (measureState.active && measureState.mode === "area") stopMeasure(false);
  else startMeasure("area");
};

// ============================================================
// 歩行者視点モード
// ============================================================
const walkState = { active: false, arming: false, prevCamera: null };

$("walkBtn").onclick = () => {
  if (walkState.active || walkState.arming) {
    exitWalk();
  } else {
    walkState.arming = true;
    $("walkBtn").classList.add("active");
    const hint = $("measureHint");
    hint.textContent = "立ちたい地点をクリックしてください（Escで中止）";
    hint.classList.remove("hidden");
  }
};

function startWalkAt(windowPos) {
  const pos = pickPosition(windowPos);
  walkState.arming = false;
  if (!Cesium.defined(pos)) {
    exitWalk();
    return;
  }
  walkState.prevCamera = getCameraState();
  walkState.active = true;
  const carto = Cesium.Cartographic.fromCartesian(pos);
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height + 1.7),
    orientation: { heading: viewer.camera.heading, pitch: 0, roll: 0 },
  });
  const hint = $("measureHint");
  hint.textContent = "歩行者視点: W/S=前後 A/D=左右 ←/→=旋回 Q/E=高さ Shift=速く Esc=終了";
  hint.classList.remove("hidden");
  requestRender();
}

function exitWalk() {
  const wasActive = walkState.active;
  walkState.active = false;
  walkState.arming = false;
  $("walkBtn").classList.remove("active");
  $("measureHint").classList.add("hidden");
  if (wasActive && walkState.prevCamera) {
    setCameraState(walkState.prevCamera, 1.2);
    walkState.prevCamera = null;
  }
  if (measureState.active) updateMeasureUI(); // 計測中のヒント表示を復元
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (walkState.active || walkState.arming) exitWalk();
    else if (measureState.active) stopMeasure(false);
    return;
  }
  if (!walkState.active) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  const step = e.shiftKey ? 6 : 1.5;
  const camera = viewer.camera;
  const key = e.key.toLowerCase();
  let handled = true;
  if (key === "w" || e.key === "ArrowUp") camera.moveForward(step);
  else if (key === "s" || e.key === "ArrowDown") camera.moveBackward(step);
  else if (key === "a") camera.moveLeft(step);
  else if (key === "d") camera.moveRight(step);
  else if (e.key === "ArrowLeft") camera.setView({ orientation: { heading: camera.heading - Cesium.Math.toRadians(4), pitch: camera.pitch, roll: 0 } });
  else if (e.key === "ArrowRight") camera.setView({ orientation: { heading: camera.heading + Cesium.Math.toRadians(4), pitch: camera.pitch, roll: 0 } });
  else if (key === "q") camera.moveUp(step);
  else if (key === "e") camera.moveDown(step);
  else handled = false;
  if (handled) {
    e.preventDefault();
    requestRender();
  }
});

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
      split: l.split,
    })),
    basemap: state.basemap,
    sse: state.sse,
    terrain: state.terrain,
    compare: state.compare,
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
  if (saved.terrain) setTerrain(true);
  if (saved.camera) setCameraState(saved.camera, fly ? 1.2 : 0);
  if (Array.isArray(saved.layers)) {
    for (const ls of saved.layers) {
      const layer = await addDatasetById(ls.id, {
        visible: ls.visible,
        style: ls.style,
        opacity: ls.opacity,
        fly: false,
      });
      if (!layer) continue;
      if (ls.split) layer.split = ls.split;
      if (ls.heightFilter) {
        layer.heightFilter = ls.heightFilter;
        applyLayerStyle(layer);
      }
    }
    renderLayerList();
  }
  if (saved.compare) setCompare(true);
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

// ---------- 地形（地理院標高タイル） ----------
$("terrainBtn").onclick = () => setTerrain(!state.terrain);

function setTerrain(on) {
  state.terrain = on;
  $("terrainBtn").classList.toggle("active", on);
  viewer.terrainProvider = on ? new GsiTerrainProvider() : new Cesium.EllipsoidTerrainProvider();
  viewer.scene.globe.depthTestAgainstTerrain = on;
  saveState();
  requestRender();
}

// ---------- 左右比較モード ----------
$("compareBtn").onclick = () => setCompare(!state.compare);

function setCompare(on) {
  state.compare = on;
  $("compareBtn").classList.toggle("active", on);
  $("splitSlider").classList.toggle("hidden", !on);
  if (on) {
    viewer.scene.splitPosition = 0.5;
    $("splitSlider").style.left = "50%";
  }
  for (const l of state.layers) applySplit(l);
  renderLayerList();
  saveState();
  requestRender();
}

function applySplit(layer) {
  const dir =
    !state.compare || !layer.split || layer.split === "both"
      ? Cesium.SplitDirection.NONE
      : layer.split === "left"
        ? Cesium.SplitDirection.LEFT
        : Cesium.SplitDirection.RIGHT;
  if (layer.tileset) layer.tileset.splitDirection = dir;
  if (layer.imageryLayer) layer.imageryLayer.splitDirection = dir;
}

// 分割バーのドラッグ
(() => {
  const slider = $("splitSlider");
  let dragging = false;
  slider.addEventListener("pointerdown", (e) => {
    dragging = true;
    slider.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  slider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = $("cesiumContainer").getBoundingClientRect();
    const frac = Math.min(0.95, Math.max(0.05, (e.clientX - rect.left) / rect.width));
    viewer.scene.splitPosition = frac;
    slider.style.left = `${frac * 100}%`;
    requestRender();
  });
  slider.addEventListener("pointerup", () => { dragging = false; saveState(); });
})();

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
// 建物統計（現在のビューに読み込まれている建物を集計）
// ============================================================
// ヒストグラムの色は地図の「高さで色分け」と同一（HEIGHT_RAMPと対応）
const STATS_BINS = [
  { label: "〜12m", max: 12, color: "#3d7dc8" },
  { label: "12〜31m", max: 31, color: "#5fb0a5" },
  { label: "31〜60m", max: 60, color: "#9ecf63" },
  { label: "60〜120m", max: 120, color: "#f2d13e" },
  { label: "120〜180m", max: 180, color: "#f2913e" },
  { label: "180m〜", max: Infinity, color: "#e0452f" },
];
const USAGE_PROPS = ["bldg:usage", "用途", "usage"];

function postRenderOnce() {
  return new Promise((resolve) => {
    const remove = viewer.scene.postRender.addEventListener(() => {
      remove();
      resolve();
    });
    viewer.scene.requestRender();
  });
}

function featureProp(feature, names) {
  for (const n of names) {
    try {
      const v = feature.getProperty(n);
      if (v !== undefined && v !== null && v !== "") return v;
    } catch (e) { /* 属性なし */ }
  }
  return undefined;
}

async function showStats(layer) {
  if (!layer.tileset) return;
  toast("表示中の建物を集計しています...");

  // 次の描画フレームで可視タイルを収集する
  const tiles = new Set();
  const collect = (tile) => tiles.add(tile);
  layer.tileset.tileVisible.addEventListener(collect);
  await postRenderOnce();
  layer.tileset.tileVisible.removeEventListener(collect);

  const seen = new Set();
  let count = 0;
  let heightSum = 0, heightMax = 0, heightCount = 0;
  const bins = STATS_BINS.map(() => 0);
  const usage = new Map();

  for (const tile of tiles) {
    const content = tile.content;
    if (!content || !content.featuresLength) continue;
    for (let i = 0; i < content.featuresLength; i++) {
      const f = content.getFeature(i);
      const id = featureProp(f, ["gml_id"]);
      if (id !== undefined) {
        if (seen.has(id)) continue; // LOD間の重複を除外
        seen.add(id);
      }
      count++;

      const h = layer.heightProp ? Number(featureProp(f, [layer.heightProp])) : NaN;
      if (Number.isFinite(h)) {
        heightSum += h;
        heightMax = Math.max(heightMax, h);
        heightCount++;
        bins[STATS_BINS.findIndex((b) => h < b.max || b.max === Infinity)]++;
      }

      const u = featureProp(f, USAGE_PROPS) || "不明";
      usage.set(u, (usage.get(u) || 0) + 1);
    }
  }

  renderStats(layer, { count, heightSum, heightMax, heightCount, bins, usage });
}

function renderStats(layer, s) {
  $("statsTitle").textContent = `建物統計 — ${layer.dataset.name}`;
  const body = $("statsBody");
  body.innerHTML = "";

  if (s.count === 0) {
    const p = document.createElement("p");
    p.className = "muted center";
    p.textContent = "表示範囲に建物が読み込まれていません。建物にズームしてから再実行してください。";
    body.appendChild(p);
    $("statsDialog").showModal();
    return;
  }

  // サマリータイル
  const tiles = document.createElement("div");
  tiles.className = "stats-tiles";
  const avg = s.heightCount > 0 ? s.heightSum / s.heightCount : null;
  for (const [label, value] of [
    ["建物数", s.count.toLocaleString()],
    ["平均高さ", avg != null ? avg.toFixed(1) + " m" : "-"],
    ["最高", s.heightMax > 0 ? s.heightMax.toFixed(1) + " m" : "-"],
  ]) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const v = document.createElement("div");
    v.className = "stat-value";
    v.textContent = value;
    const l = document.createElement("div");
    l.className = "stat-label";
    l.textContent = label;
    tile.append(v, l);
    tiles.appendChild(tile);
  }
  body.appendChild(tiles);

  // 高さ分布（地図の高さ色分けと同じ色）
  if (s.heightCount > 0) {
    body.appendChild(statsSection("高さ分布", STATS_BINS.map((b, i) => ({
      label: b.label,
      count: s.bins[i],
      color: b.color,
    })), s.heightCount));
  }

  // 用途構成（上位8 + その他）
  const sorted = [...s.usage.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 8);
  const otherCount = sorted.slice(8).reduce((n, [, c]) => n + c, 0);
  const rows = top.map(([label, count]) => ({ label, count, color: "#4da3ff" }));
  if (otherCount > 0) rows.push({ label: `その他（${sorted.length - 8}種）`, count: otherCount, color: "#9aa1ac" });
  body.appendChild(statsSection("用途構成", rows, s.count));

  const note = document.createElement("div");
  note.className = "muted stats-note";
  note.textContent = "※ 現在のビューに読み込まれている建物の集計です（gml_idで重複除外）。";
  body.appendChild(note);

  $("statsDialog").showModal();
}

function statsSection(title, rows, total) {
  const section = document.createElement("div");
  section.className = "stats-section";
  const h = document.createElement("div");
  h.className = "stats-heading";
  h.textContent = title;
  section.appendChild(h);

  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  for (const row of rows) {
    const div = document.createElement("div");
    div.className = "bar-row";
    div.title = `${row.label}: ${row.count.toLocaleString()}件 (${((row.count / total) * 100).toFixed(1)}%)`;
    const label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = row.label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${(row.count / maxCount) * 100}%`;
    fill.style.background = row.color;
    track.appendChild(fill);
    const val = document.createElement("div");
    val.className = "bar-val";
    val.textContent = `${row.count.toLocaleString()} (${((row.count / total) * 100).toFixed(1)}%)`;
    div.append(label, track, val);
    section.appendChild(div);
  }
  return section;
}

$("statsCloseBtn").onclick = () => $("statsDialog").close();

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
