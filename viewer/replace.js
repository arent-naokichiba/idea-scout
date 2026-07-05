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

// ============================================================
// ボリューム配置エディタ（敷地に単棟/L字/コの字/ツインを自動配置）
// 生成される各棟は通常の計画ボリュームレイヤー（高さ編集・保存・法規判定対象）
// ============================================================
const MASSING_SHAPES = [
  ["single", "単棟"],
  ["l", "L字"],
  ["c", "コの字"],
  ["twin", "ツイン"],
  ["tower", "タワー+低層棟"],
];

// 形状ごとのボックス群（frameローカル座標・base=積み上げ開始高さ）
// タワー+低層棟は低層部（〜12m）の上にタワーを積む
function massingBoxes(shape, x0, y0, W, D, h) {
  if (shape === "single") {
    return [{ cx: x0 + W / 2, cy: y0 + D / 2, w: W, d: D, h, base: 0 }];
  }
  if (shape === "l") {
    const t = Math.max(6, Math.min(W, D) * 0.45);
    return [
      { cx: x0 + W / 2, cy: y0 + t / 2, w: W, d: t, h, base: 0 },
      { cx: x0 + t / 2, cy: y0 + t + (D - t) / 2, w: t, d: D - t, h, base: 0 },
    ];
  }
  if (shape === "c") {
    const t = Math.max(6, Math.min(W, D) * 0.4);
    return [
      { cx: x0 + W / 2, cy: y0 + t / 2, w: W, d: t, h, base: 0 },
      { cx: x0 + t / 2, cy: y0 + t + (D - t) / 2, w: t, d: D - t, h, base: 0 },
      { cx: x0 + W - t / 2, cy: y0 + t + (D - t) / 2, w: t, d: D - t, h, base: 0 },
    ];
  }
  if (shape === "twin") {
    const gap = Math.max(4, W * 0.12);
    const w = (W - gap) / 2, d = D * 0.7;
    return [
      { cx: x0 + w / 2, cy: y0 + D / 2, w, d, h, base: 0 },
      { cx: x0 + W - w / 2, cy: y0 + D / 2, w, d, h, base: 0 },
    ];
  }
  // tower: 低層棟（全面・最大12m）+ その上に北寄りタワー
  const hp = Math.min(12, Math.max(3.1, h * 0.3));
  if (h - hp < 3) {
    return [{ cx: x0 + W / 2, cy: y0 + D / 2, w: W, d: D, h, base: 0 }];
  }
  return [
    { cx: x0 + W / 2, cy: y0 + D / 2, w: W, d: D, h: hp, base: 0 },
    { cx: x0 + W / 2, cy: y0 + D * 0.65, w: W * 0.55, d: D * 0.5, h: h - hp, base: hp },
  ];
}

// 敷地ヤードのレイヤーパネルに追加（construction.jsのrenderZoneRowsから呼ばれる）
function renderMassingRow(layer, li) {
  if (layer.kind !== "zone") return;
  const row = document.createElement("div");
  row.className = "layer-row";
  const shapeSel = document.createElement("select");
  for (const [v, label] of MASSING_SHAPES) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    shapeSel.appendChild(o);
  }
  const hIn = document.createElement("input");
  hIn.type = "number";
  hIn.min = "3";
  hIn.step = "3";
  hIn.value = "30";
  hIn.title = "配置するボリュームの高さ(m)";
  const btn = document.createElement("button");
  btn.className = "tbtn";
  btn.textContent = "⬜ 配置";
  btn.title = "敷地に計画ボリュームを自動配置（敷地内の既存ボリュームは置き換え）";
  btn.onclick = () => massingPlace(layer, shapeSel.value, Math.max(3, parseFloat(hIn.value) || 30));
  const farBtn = document.createElement("button");
  farBtn.className = "tbtn";
  farBtn.textContent = "容積MAX";
  farBtn.title = "容積率いっぱいの延床になる高さを自動算定して配置（敷地条件調査済みならその容積率を使用）";
  farBtn.onclick = () => massingFitFar(layer, shapeSel.value, hIn);
  row.append(shapeSel, "高さ", hIn, btn, farBtn);
  li.appendChild(row);
}

// 容積率いっぱいの延床になる高さを求めて配置する
function massingFitFar(zoneLayer, shape, hInput) {
  let far = (typeof lastSiteCheck !== "undefined" && lastSiteCheck?.calc?.far) || null;
  if (!far) {
    const input = window.prompt("容積率(%)を入力してください:", "400");
    if (input === null) return;
    far = parseFloat(input);
    if (!Number.isFinite(far) || far <= 0) return;
  }
  const frame = kiseiLocalFrame(zoneLayer.zone.points);
  const { minX, minY, maxX, maxY } = frame.bbox;
  const o = 3;
  const W = maxX - minX - o * 2, D = maxY - minY - o * 2;
  if (W < 6 || D < 6) {
    toast("敷地が小さすぎます（10m角以上のヤードで使用してください）");
    return;
  }
  const target = (zoneLayer.zone.area || (maxX - minX) * (maxY - minY)) * far / 100;
  let h;
  if (shape === "tower") {
    // 低層棟12m（3層）を全面に取り、残り延床をタワーで消化
    const probe = massingBoxes("tower", 0, 0, W, D, 100);
    const faPod = probe[0].w * probe[0].d;
    const faTower = probe[1].w * probe[1].d;
    const remain = target - faPod * 3;
    const towerFloors = Math.floor(remain / faTower);
    if (towerFloors < 1) {
      h = Math.max(3.1, Math.floor(target / faPod) * 3.1);
    } else {
      h = 12 + towerFloors * 3.1;
    }
  } else {
    const faSum = massingBoxes(shape, 0, 0, W, D, 10)
      .reduce((s, b) => s + b.w * b.d, 0);
    h = Math.max(3.1, Math.floor(target / faSum) * 3.1);
  }
  h = Math.round(h * 10) / 10;
  if (hInput) hInput.value = h;
  massingPlace(zoneLayer, shape, h);
  toast(`容積率${far}% → 目標延床 約${Math.round(target).toLocaleString()}m² から高さ${h}mを自動算定しました`, 8000);
}

function massingPlace(zoneLayer, shape, h) {
  const frame = kiseiLocalFrame(zoneLayer.zone.points);
  const { minX, minY, maxX, maxY } = frame.bbox;
  const o = 3; // 境界からの離隔
  const W = maxX - minX - o * 2, D = maxY - minY - o * 2;
  if (W < 6 || D < 6) {
    toast("敷地が小さすぎます（10m角以上のヤードで使用してください）");
    return;
  }
  const x0 = minX + o, y0 = minY + o;
  const boxes = massingBoxes(shape, x0, y0, W, D, h);

  // 敷地内の既存ボリュームは置き換え（マッシングスタディの繰り返し用）
  const inSite = state.layers.filter((l) => {
    if (l.kind !== "volume") return false;
    const p = frame.toLocal(Cesium.Cartesian3.fromDegrees(l.volume.lon, l.volume.lat, 0));
    return p.x >= minX - 1 && p.x <= maxX + 1 && p.y >= minY - 1 && p.y <= maxY + 1;
  });
  for (const l of inSite) removeLayer(l);

  for (const b of boxes) {
    const carto = Cesium.Cartographic.fromCartesian(frame.toWorld(b.cx, b.cy, 0));
    restoreVolumeLayer({
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      baseH: carto.height + b.base,
      width: b.w, depth: b.d, height: b.h,
    });
  }
  for (const k of state.layers.filter((l) => l.kind === "kisei")) kiseiJudge(k, true);
  renderLayerList();
  requestRender();
  const def = MASSING_SHAPES.find((s) => s[0] === shape);
  toast(`${def[1]}ボリュームを配置しました（${boxes.length}棟・高さ${h}m${inSite.length ? ` / 既存${inSite.length}棟を置換` : ""}）`);
}

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
