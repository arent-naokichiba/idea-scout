/* 建物差し替え（建替えシミュレーション）
 *
 * PLATEAUの既存建物をクリックして選択し、
 *  - 非表示（撤去・解体の表現）
 *  - 計画ボリューム（高さ指定の箱）に差し替え
 *  - 自社CADモデル（glb/glTF）に差し替え
 * ができる。非表示はgml_id単位のスタイル制御なのでタイル再読込後も維持され、
 * セッション保存・共有リンクにも含まれる。
 */
"use strict";

let volumeCounter = 0;
const replaceState = { feature: null, layer: null, attrs: null };

// 属性パネルに差し替えアクションを表示（app.jsのshowAttributesから呼ばれる）
function replaceSetTarget(feature, attrs) {
  const box = $("attrActions");
  box.innerHTML = "";
  replaceState.feature = feature;
  replaceState.attrs = attrs;
  replaceState.layer = state.layers.find((l) => l.kind === "tiles" && l.tileset === feature.tileset);

  const gmlId = attrs.gml_id;
  if (!replaceState.layer || !gmlId) return;
  if (replaceState.layer.dataset.type_en !== "bldg") return;

  const mkBtn = (text, title, onclick) => {
    const b = document.createElement("button");
    b.className = "tbtn";
    b.textContent = text;
    b.title = title;
    b.onclick = onclick;
    box.appendChild(b);
  };
  mkBtn("🚫 非表示", "この建物を非表示にする（解体・撤去の表現）", () => {
    hideBuilding(replaceState.layer, gmlId);
    closeAttrForReplace();
  });
  mkBtn("⬜ ボリューム差替", "この建物を高さ指定の計画ボリュームに差し替える", () => replaceWithVolume());
  mkBtn("🏗 CADモデル差替", "この建物を自社モデル（glb/glTF）に差し替える", () => $("replGlbFile").click());
}

function replaceClearTarget() {
  $("attrActions").innerHTML = "";
  replaceState.feature = null;
  replaceState.attrs = null;
  replaceState.layer = null;
}

function closeAttrForReplace() {
  $("attrPanel").classList.add("hidden");
  clearSelection();
  requestRender();
}

// gml_id単位の非表示（applyLayerStyleがhiddenIdsをshow式に合成する）
function hideBuilding(layer, gmlId) {
  layer.hiddenIds = layer.hiddenIds || [];
  if (!layer.hiddenIds.includes(gmlId)) layer.hiddenIds.push(gmlId);
  applyLayerStyle(layer);
  renderLayerList();
  saveState();
  toast(`建物を非表示にしました（計${layer.hiddenIds.length}棟 / レイヤーパネルで解除可）`);
}

// 建物属性から足元位置とサイズを取り出す
function replaceFootprint(attrs) {
  const lon = Number(attrs._x), lat = Number(attrs._y);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const baseH = Number(attrs._zmin ?? 0);
  const topH = Number(attrs._zmax ?? attrs["bldg:measuredHeight"] ?? attrs["計測高さ"] ?? NaN);
  const height = Number.isFinite(topH) ? Math.max(3, topH - baseH) : 15;
  let width = 12, depth = 12;
  if (Number.isFinite(Number(attrs._xmin)) && Number.isFinite(Number(attrs._xmax))) {
    width = Math.max(3, (attrs._xmax - attrs._xmin) * 111320 * Math.cos(Cesium.Math.toRadians(lat)));
    depth = Math.max(3, (attrs._ymax - attrs._ymin) * 110950);
  }
  return { lon, lat, baseH, height, width, depth };
}

function replaceWithVolume() {
  const { layer, attrs } = replaceState;
  const fp = replaceFootprint(attrs);
  if (!fp) {
    toast("この建物には位置属性（_x/_y）がないためボリューム差替できません");
    return;
  }
  const input = window.prompt("計画ボリュームの高さ(m):", String(Math.round(fp.height)));
  if (input === null) return;
  const h = Math.max(1, parseFloat(input) || fp.height);
  hideBuilding(layer, attrs.gml_id);
  createVolumeLayer(fp, h, attrs.gml_id);
  closeAttrForReplace();
}

function createVolumeLayer(fp, h, sourceId) {
  const vol = {
    lon: fp.lon, lat: fp.lat, baseH: fp.baseH,
    width: fp.width, depth: fp.depth, height: h, heading: 0,
  };
  const layer = {
    id: `volume-${++volumeCounter}`,
    dataset: { name: `⬜ 計画ボリューム ${volumeCounter}`, format: "ボリューム", type: "建替え検討", type_en: "volume" },
    kind: "volume",
    visible: true,
    loading: false,
    entity: null,
    volume: vol,
    sourceGmlId: sourceId || null,
  };
  volumeAddEntity(layer);
  state.layers.push(layer);
  renderLayerList();
  requestRender();
  toast(`計画ボリューム（${vol.width.toFixed(0)}×${vol.depth.toFixed(0)}×${h.toFixed(0)}m）に差し替えました`);
  return layer;
}

function volumeAddEntity(layer) {
  const vol = layer.volume;
  layer.entity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(vol.lon, vol.lat, vol.baseH + vol.height / 2),
    box: {
      dimensions: new Cesium.Cartesian3(vol.width, vol.depth, vol.height),
      material: Cesium.Color.fromCssColorString("#4da3ff").withAlpha(0.65),
      outline: true,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
    },
  });
}

// 現場保存・パッケージからの復元（construction.jsのrestoreConstructionから呼ばれる）
function restoreVolumeLayer(v) {
  const n = parseInt(String(v.id || "").split("-")[1], 10);
  if (Number.isFinite(n)) volumeCounter = Math.max(volumeCounter, n);
  const layer = {
    id: v.id || `volume-${++volumeCounter}`,
    dataset: { name: v.name || `⬜ 計画ボリューム ${volumeCounter}`, format: "ボリューム", type: "建替え検討", type_en: "volume" },
    kind: "volume",
    visible: true,
    loading: false,
    entity: null,
    volume: { lon: v.lon, lat: v.lat, baseH: v.baseH || 0, width: v.width, depth: v.depth, height: v.height, heading: v.heading || 0 },
    sourceGmlId: v.sourceGmlId || null,
  };
  volumeAddEntity(layer);
  state.layers.push(layer);
  return layer;
}

function updateVolumeEntity(layer) {
  const v = layer.volume;
  layer.entity.position = Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.baseH + v.height / 2);
  layer.entity.box.dimensions = new Cesium.Cartesian3(v.width, v.depth, v.height);
  requestRender();
}

// レイヤーパネルのボリューム用コントロール
function renderVolumeRows(layer, li) {
  const v = layer.volume;
  const row = document.createElement("div");
  row.className = "layer-row";
  const hIn = document.createElement("input");
  hIn.type = "number";
  hIn.min = "1";
  hIn.step = "1";
  hIn.value = Math.round(v.height);
  hIn.onchange = () => {
    v.height = Math.max(1, parseFloat(hIn.value) || v.height);
    updateVolumeEntity(layer);
    renderLayerList();
  };
  const info = document.createElement("span");
  info.textContent = `底面 ${v.width.toFixed(0)}×${v.depth.toFixed(0)}m / 延床概算 ${Math.round(v.width * v.depth * Math.max(1, Math.floor(v.height / 3.1))).toLocaleString()}m²`;
  row.append("高さ(m)", hIn, info);
  li.appendChild(row);

  if (typeof renderShadowRow === "function") renderShadowRow(layer, li);
}

// CADモデル（glb）差替
$("replGlbFile").onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const { layer, attrs } = replaceState;
  const fp = replaceFootprint(attrs || {});
  if (!layer || !fp) {
    toast("差し替え対象の建物を先にクリックで選択してください");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    hideBuilding(layer, attrs.gml_id);
    const url = URL.createObjectURL(new Blob([reader.result], { type: "model/gltf-binary" }));
    createModelLayerAt(
      Cesium.Cartesian3.fromDegrees(fp.lon, fp.lat, fp.baseH),
      file.name.replace(/\.(glb|gltf)$/i, ""), url);
    closeAttrForReplace();
    toast("CADモデルに差し替えました（レイヤーパネルで向き・高さを調整）");
  };
  reader.readAsArrayBuffer(file);
};

// レイヤーパネル: 非表示建物の解除UI（app.jsのrenderLayerListから呼ばれる）
function renderHiddenRow(layer, li) {
  if (!layer.hiddenIds || layer.hiddenIds.length === 0) return;
  const row = document.createElement("div");
  row.className = "layer-row";
  const info = document.createElement("span");
  info.textContent = `🚫 非表示 ${layer.hiddenIds.length}棟`;
  const clearBtn = document.createElement("button");
  clearBtn.className = "tbtn";
  clearBtn.textContent = "すべて解除";
  clearBtn.onclick = () => {
    layer.hiddenIds = [];
    applyLayerStyle(layer);
    renderLayerList();
    saveState();
  };
  row.append(info, clearBtn);
  li.appendChild(row);
}
