/* 施工・BIM支援機能
 *
 * - BIMモデル配置: glTF/GLBファイルをPLATEAUの街並みに設置（高さ・向き・スケール調整）
 * - クレーン配置シミュレーション: 作業半径の3D表示と周辺建物との旋回干渉チェック
 * - 近隣調査リスト: 指定地点から半径内の建物を抽出して属性一覧・CSV出力
 *
 * app.js のグローバル（viewer, state, renderLayerList 等）に依存するため、
 * app.js の後に読み込むこと。クリック処理は app.js から
 * constructionHandleClick / constructionHandleEscape 経由で委譲される。
 */
"use strict";

// ============================================================
// BIMモデル配置（glTF / GLB）
// ============================================================
const modelPlaceState = { pending: null, relocateLayer: null };
let modelCounter = 0;

function handleModelFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const url = URL.createObjectURL(new Blob([reader.result], { type: "model/gltf-binary" }));
    modelPlaceState.pending = { name: file.name.replace(/\.(glb|gltf)$/i, ""), url };
    closeDrawer();
    showHint(`「${file.name}」を配置する地点をクリックしてください（Escで中止）`);
  };
  reader.readAsArrayBuffer(file);
}

function placeModelAt(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;

  // 再配置モード
  if (modelPlaceState.relocateLayer) {
    const layer = modelPlaceState.relocateLayer;
    const carto = Cesium.Cartographic.fromCartesian(pos);
    layer.model.lon = Cesium.Math.toDegrees(carto.longitude);
    layer.model.lat = Cesium.Math.toDegrees(carto.latitude);
    layer.model.baseHeight = carto.height;
    modelPlaceState.relocateLayer = null;
    hideHint();
    updateModelEntity(layer);
    renderLayerList();
    return;
  }

  const pending = modelPlaceState.pending;
  modelPlaceState.pending = null;
  hideHint();
  createModelLayerAt(pos, pending.name, pending.url);
  toast(`配置しました: ${pending.name}（レイヤータブで向き・高さを調整できます）`);
}

// BIMモデルレイヤーを指定位置に生成する（配置フロー・建物差し替えの両方から使用）
function createModelLayerAt(position, name, url) {
  const carto = Cesium.Cartographic.fromCartesian(position);
  const layer = {
    id: `model-${++modelCounter}`,
    dataset: { name: `🏗 ${name}`, format: "glTF", type: "BIMモデル", type_en: "model" },
    kind: "model",
    visible: true,
    loading: false,
    entity: null,
    model: {
      url,
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      baseHeight: carto.height,
      heightOffset: 0,
      heading: 0,
      scale: 1,
    },
  };
  layer.entity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(layer.model.lon, layer.model.lat, layer.model.baseHeight),
    model: { uri: url, scale: 1 },
  });
  updateModelEntity(layer);
  state.layers.push(layer);
  renderLayerList();
  requestRender();
  return layer;
}

function updateModelEntity(layer) {
  const m = layer.model;
  const position = Cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.baseHeight + m.heightOffset);
  layer.entity.position = position;
  layer.entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
    position,
    new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(m.heading), 0, 0));
  layer.entity.model.scale = m.scale;
  requestRender();
}

// レイヤーパネルのBIMモデル用コントロール
function renderModelRows(layer, li) {
  const m = layer.model;

  const row1 = document.createElement("div");
  row1.className = "layer-row";
  const headingSlider = document.createElement("input");
  headingSlider.type = "range";
  headingSlider.min = "0";
  headingSlider.max = "360";
  headingSlider.step = "1";
  headingSlider.value = m.heading;
  headingSlider.oninput = () => {
    m.heading = parseFloat(headingSlider.value);
    updateModelEntity(layer);
  };
  row1.append("向き", headingSlider);
  li.appendChild(row1);

  const row2 = document.createElement("div");
  row2.className = "layer-row";
  const heightIn = document.createElement("input");
  heightIn.type = "number";
  heightIn.step = "0.5";
  heightIn.value = m.heightOffset;
  heightIn.onchange = () => {
    m.heightOffset = parseFloat(heightIn.value) || 0;
    updateModelEntity(layer);
  };
  const scaleIn = document.createElement("input");
  scaleIn.type = "number";
  scaleIn.step = "0.1";
  scaleIn.min = "0.01";
  scaleIn.value = m.scale;
  scaleIn.onchange = () => {
    m.scale = Math.max(0.01, parseFloat(scaleIn.value) || 1);
    updateModelEntity(layer);
  };
  row2.append("高さ+", heightIn, "倍率", scaleIn);
  li.appendChild(row2);

  // 出来高表示用の建物全高（工程リンク時に日付進捗でこの高さまで立ち上がる）
  const rowH = document.createElement("div");
  rowH.className = "layer-row";
  const buildHIn = document.createElement("input");
  buildHIn.type = "number";
  buildHIn.step = "1";
  buildHIn.min = "1";
  buildHIn.value = m.buildHeight || 30;
  buildHIn.title = "出来高表示（工程リンク時）に使うモデルの全高";
  buildHIn.onchange = () => {
    m.buildHeight = Math.max(1, parseFloat(buildHIn.value) || 30);
    if (typeof schedApplyProgress === "function") schedApplyProgress();
  };
  rowH.append("全高(m)", buildHIn, "※出来高表示用");
  li.appendChild(rowH);

  const row3 = document.createElement("div");
  row3.className = "layer-row";
  const relocateBtn = document.createElement("button");
  relocateBtn.className = "tbtn";
  relocateBtn.textContent = "📍 再配置";
  relocateBtn.onclick = () => {
    modelPlaceState.relocateLayer = layer;
    closeDrawer();
    showHint("移動先の地点をクリックしてください（Escで中止）");
  };
  row3.appendChild(relocateBtn);
  li.appendChild(row3);

  if (typeof renderShadowRow === "function") renderShadowRow(layer, li);
}

// ============================================================
// クレーン配置シミュレーション
// ============================================================
const craneState = { arming: false };
let craneCounter = 0;
const CRANE_SWEEP_STEP_DEG = 10;

$("craneBtn").onclick = () => {
  craneState.arming = !craneState.arming;
  $("craneBtn").classList.toggle("active", craneState.arming);
  if (craneState.arming) {
    closeDrawer();
    showHint("クレーンの設置地点をクリックしてください（Escで中止）");
  } else {
    hideHint();
  }
};

function placeCraneAt(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;
  craneState.arming = false;
  $("craneBtn").classList.remove("active");
  hideHint();

  const layer = {
    id: `crane-${++craneCounter}`,
    dataset: { name: `🏗 クレーン ${craneCounter}`, format: "シミュレーション", type: "施工計画", type_en: "crane" },
    kind: "crane",
    visible: true,
    loading: false,
    entities: [],
    crane: {
      position: pos,
      boomLength: 50, // ブーム長[m]
      boomAngle: 60,  // 起伏角[度]
      pivotHeight: 3, // 旋回中心の地上高[m]
      sweepResult: null,
    },
  };
  state.layers.push(layer);
  redrawCrane(layer);
  renderLayerList();
  toast("クレーンを配置しました（レイヤータブでブーム長・起伏角を調整、干渉チェック実行）");
}

function craneWorkRadius(c) {
  return c.boomLength * Math.cos(Cesium.Math.toRadians(c.boomAngle));
}
function craneHookHeight(c) {
  return c.pivotHeight + c.boomLength * Math.sin(Cesium.Math.toRadians(c.boomAngle));
}

// ENUローカル座標(x=東, y=北, z=上)→世界座標
function craneLocalToWorld(c, x, y, z) {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(c.position);
  return Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
}

function redrawCrane(layer) {
  for (const e of layer.entities) viewer.entities.remove(e);
  layer.entities = [];
  const c = layer.crane;
  const r = craneWorkRadius(c);
  const carto = Cesium.Cartographic.fromCartesian(c.position);
  const accent = Cesium.Color.fromCssColorString("#4da3ff");

  // 旋回中心
  layer.entities.push(viewer.entities.add({
    position: c.position,
    point: { pixelSize: 9, color: accent, disableDepthTestDistance: Number.POSITIVE_INFINITY },
  }));
  // 作業半径の円
  layer.entities.push(viewer.entities.add({
    position: c.position,
    ellipse: {
      semiMajorAxis: r,
      semiMinorAxis: r,
      height: carto.height + 0.5,
      material: accent.withAlpha(0.12),
      outline: true,
      outlineColor: accent,
    },
  }));
  // ブーム（北向きの代表姿勢）とフック位置ラベル
  const pivot = craneLocalToWorld(c, 0, 0, c.pivotHeight);
  const tip = craneLocalToWorld(c, 0, r, craneHookHeight(c));
  layer.entities.push(viewer.entities.add({
    polyline: { positions: [pivot, tip], width: 4, material: Cesium.Color.fromCssColorString("#f2913e") },
  }));
  layer.entities.push(viewer.entities.add({
    position: tip,
    label: measureLabel(`作業半径 ${r.toFixed(1)}m / フック高 ${craneHookHeight(c).toFixed(1)}m`),
  }));

  // 干渉チェック結果（旋回可=緑 / 干渉=赤 の円弧）
  if (c.sweepResult) {
    drawSweepArcs(layer, c, r, carto.height);
  }
  layer.visible = true;
  requestRender();
}

function drawSweepArcs(layer, c, r, groundHeight) {
  const blocked = c.sweepResult.blocked;
  const n = blocked.length;
  let start = 0;
  while (start < n) {
    const state0 = blocked[start];
    let end = start;
    while (end + 1 < n && blocked[end + 1] === state0) end++;
    const positions = [];
    for (let a = start * CRANE_SWEEP_STEP_DEG; a <= (end + 1) * CRANE_SWEEP_STEP_DEG; a += 2) {
      const rad = Cesium.Math.toRadians(a);
      positions.push(craneLocalToWorld(c, r * Math.sin(rad), r * Math.cos(rad), 1.0));
    }
    layer.entities.push(viewer.entities.add({
      polyline: {
        positions,
        width: 6,
        material: state0
          ? Cesium.Color.fromCssColorString("#e05656")
          : Cesium.Color.fromCssColorString("#5fd08a"),
        clampToGround: false,
      },
    }));
    start = end + 1;
  }
}

// ブームを全方位に振って周辺建物との干渉を判定する
function runCraneSweep(layer) {
  const c = layer.crane;
  const pivot = craneLocalToWorld(c, 0, 0, c.pivotHeight);
  const angleRad = Cesium.Math.toRadians(c.boomAngle);
  const steps = Math.floor(360 / CRANE_SWEEP_STEP_DEG);
  const blocked = [];
  let blockedCount = 0;

  for (let i = 0; i < steps; i++) {
    const az = Cesium.Math.toRadians(i * CRANE_SWEEP_STEP_DEG + CRANE_SWEEP_STEP_DEG / 2);
    // 方位azへ起伏角angleで伸びるブーム方向の単位ベクトル（ENU→世界座標）
    const dirLocal = new Cesium.Cartesian3(
      Math.cos(angleRad) * Math.sin(az),
      Math.cos(angleRad) * Math.cos(az),
      Math.sin(angleRad));
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(c.position);
    const dir = Cesium.Cartesian3.normalize(
      Cesium.Matrix4.multiplyByPointAsVector(enu, dirLocal, new Cesium.Cartesian3()),
      new Cesium.Cartesian3());
    let hit = null;
    try {
      hit = viewer.scene.pickFromRay(new Cesium.Ray(pivot, dir), viewer.entities.values);
    } catch (e) { /* レイピック非対応 */ }
    const isBlocked = !!(hit && hit.position &&
      Cesium.Cartesian3.distance(pivot, hit.position) < c.boomLength);
    blocked.push(isBlocked);
    if (isBlocked) blockedCount++;
  }

  c.sweepResult = { blocked, blockedCount, steps };
  redrawCrane(layer);
  renderLayerList();
  toast(blockedCount === 0
    ? "全方位で干渉なし（旋回可能）"
    : `${steps}方位中 ${blockedCount}方位で建物と干渉（赤い円弧）`);
}

// クレーン機種プリセット（ブーム長は代表値・目安）
const CRANE_PRESETS = [
  ["custom", "カスタム", null],
  ["rt25", "ラフター 25t（ブーム30.5m）", 30.5],
  ["rt50", "ラフター 50t（ブーム38m）", 38],
  ["rt70", "ラフター 70t（ブーム44m）", 44],
  ["at100", "オールテレーン 100t（ブーム51m）", 51],
  ["at200", "オールテレーン 200t（ブーム60m）", 60],
  ["at350", "オールテレーン 350t（ブーム70m）", 70],
];

// レイヤーパネルのクレーン用コントロール
function renderCraneRows(layer, li) {
  const c = layer.crane;

  const row0 = document.createElement("div");
  row0.className = "layer-row";
  const presetSel = document.createElement("select");
  for (const [key, label] of CRANE_PRESETS) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    if ((c.preset || "custom") === key) opt.selected = true;
    presetSel.appendChild(opt);
  }
  presetSel.onchange = () => {
    const preset = CRANE_PRESETS.find((p) => p[0] === presetSel.value);
    c.preset = presetSel.value;
    if (preset && preset[2]) c.boomLength = preset[2];
    c.sweepResult = null;
    redrawCrane(layer);
    renderLayerList();
  };
  row0.append("機種", presetSel);
  li.appendChild(row0);

  const row1 = document.createElement("div");
  row1.className = "layer-row";
  const boomIn = document.createElement("input");
  boomIn.type = "number";
  boomIn.step = "1";
  boomIn.min = "5";
  boomIn.value = c.boomLength;
  const angleIn = document.createElement("input");
  angleIn.type = "number";
  angleIn.step = "1";
  angleIn.min = "10";
  angleIn.max = "85";
  angleIn.value = c.boomAngle;
  const apply = () => {
    c.boomLength = Math.max(5, parseFloat(boomIn.value) || 50);
    c.boomAngle = Math.min(85, Math.max(10, parseFloat(angleIn.value) || 60));
    c.preset = "custom";
    c.sweepResult = null; // パラメータ変更で干渉結果は無効化
    redrawCrane(layer);
    renderLayerList();
  };
  boomIn.onchange = angleIn.onchange = apply;
  row1.append("ブーム(m)", boomIn, "起伏(°)", angleIn);
  li.appendChild(row1);

  const row2 = document.createElement("div");
  row2.className = "layer-row";
  const info = document.createElement("span");
  info.textContent = `半径 ${craneWorkRadius(c).toFixed(1)}m / フック高 ${craneHookHeight(c).toFixed(1)}m`;
  row2.appendChild(info);
  li.appendChild(row2);

  const row3 = document.createElement("div");
  row3.className = "layer-row";
  const sweepBtn = document.createElement("button");
  sweepBtn.className = "tbtn";
  sweepBtn.textContent = "干渉チェック";
  sweepBtn.title = "全方位にブームを振って周辺建物との干渉を判定（建物を表示した状態で実行）";
  sweepBtn.onclick = () => runCraneSweep(layer);
  row3.appendChild(sweepBtn);
  if (c.sweepResult) {
    const result = document.createElement("span");
    result.textContent = c.sweepResult.blockedCount === 0
      ? "✅ 干渉なし"
      : `⚠ ${c.sweepResult.blockedCount}/${c.sweepResult.steps}方位で干渉`;
    row3.appendChild(result);
  }
  li.appendChild(row3);
}

// ============================================================
// 近隣調査リスト（半径内の建物抽出）
// ============================================================
const surveyState = { arming: false, circleEntity: null, highlights: [] };
let lastSurveyRows = null;

$("surveyBtn").onclick = () => {
  surveyState.arming = !surveyState.arming;
  $("surveyBtn").classList.toggle("active", surveyState.arming);
  if (surveyState.arming) {
    closeDrawer();
    showHint("調査の中心地点（現場位置）をクリックしてください（Escで中止）");
  } else {
    hideHint();
  }
};

async function runSurveyAt(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;
  surveyState.arming = false;
  $("surveyBtn").classList.remove("active");
  hideHint();

  const input = window.prompt("調査半径をメートルで入力してください:", "50");
  if (input === null) return;
  const radius = Math.max(5, parseFloat(input) || 50);

  const bldgLayers = state.layers.filter(
    (l) => l.kind === "tiles" && l.dataset.type_en === "bldg" && l.tileset && l.visible);
  if (bldgLayers.length === 0) {
    toast("建築物モデルのレイヤーを表示してから実行してください");
    return;
  }
  toast(`半径${radius}mの建物を抽出しています...`);

  const centerCarto = Cesium.Cartographic.fromCartesian(pos);
  const centerLon = Cesium.Math.toDegrees(centerCarto.longitude);
  const centerLat = Cesium.Math.toDegrees(centerCarto.latitude);

  // 可視タイルの地物を収集（統計と同じ方式）
  const tilesPerLayer = new Map();
  const collectors = [];
  for (const l of bldgLayers) {
    const set = new Set();
    tilesPerLayer.set(l, set);
    const cb = (tile) => set.add(tile);
    collectors.push([l, cb]);
    l.tileset.tileVisible.addEventListener(cb);
  }
  await postRenderOnce();
  for (const [l, cb] of collectors) l.tileset.tileVisible.removeEventListener(cb);

  clearSurveyResult();
  const seen = new Set();
  const rows = [];
  for (const [, tiles] of tilesPerLayer) {
    for (const tile of tiles) {
      const content = tile.content;
      if (!content || !content.featuresLength) continue;
      for (let i = 0; i < content.featuresLength; i++) {
        const f = content.getFeature(i);
        const lon = Number(featureProp(f, ["_x"]));
        const lat = Number(featureProp(f, ["_y"]));
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const dist = haversineMeters(centerLat, centerLon, lat, lon);
        if (dist > radius) continue;
        const id = featureProp(f, ["gml_id"]);
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        const row = { _距離m: Math.round(dist * 10) / 10 };
        for (const key of f.getPropertyIds()) {
          const v = f.getProperty(key);
          if (v === undefined || v === null || v === "") continue;
          row[key] = v;
        }
        rows.push(row);
        // 対象建物をハイライト
        surveyState.highlights.push({ feature: f, color: Cesium.Color.clone(f.color) });
        f.color = Cesium.Color.fromCssColorString("#ffd166");
      }
    }
  }
  rows.sort((a, b) => a["_距離m"] - b["_距離m"]);
  lastSurveyRows = rows;

  // 調査円を描画
  surveyState.circleEntity = viewer.entities.add({
    position: pos,
    ellipse: {
      semiMajorAxis: radius,
      semiMinorAxis: radius,
      height: centerCarto.height + 0.5,
      material: Cesium.Color.fromCssColorString("#ffd166").withAlpha(0.12),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString("#ffd166"),
    },
  });
  requestRender();
  renderSurveyDialog(radius, rows);
}

function clearSurveyResult() {
  if (surveyState.circleEntity) {
    viewer.entities.remove(surveyState.circleEntity);
    surveyState.circleEntity = null;
  }
  for (const h of surveyState.highlights) {
    try { h.feature.color = h.color; } catch (e) { /* タイル解放済み */ }
  }
  surveyState.highlights = [];
  requestRender();
}

function renderSurveyDialog(radius, rows) {
  $("surveyTitle").textContent = `近隣調査リスト — 半径${radius}m / ${rows.length}棟`;
  const body = $("surveyBody");
  body.innerHTML = "";
  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "muted center";
    p.textContent = "半径内に読み込み済みの建物がありません。現場にズームしてから再実行してください。";
    body.appendChild(p);
  } else {
    const table = document.createElement("table");
    table.className = "survey-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of ["距離(m)", "用途", "地上階数", "高さ(m)", "gml_id"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      const usage = r["bldg:usage"] ?? r["用途"] ?? r["usage"] ?? "-";
      const storeys = r["bldg:storeysAboveGround"] ?? r["地上階数"] ?? "-";
      const height = r["bldg:measuredHeight"] ?? r["計測高さ"] ?? "-";
      for (const v of [r["_距離m"], usage, storeys,
                       typeof height === "number" ? height.toFixed(1) : height,
                       r["gml_id"] || "-"]) {
        const td = document.createElement("td");
        td.textContent = String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }
  $("surveyDialog").showModal();
}

$("surveyCloseBtn").onclick = () => {
  $("surveyDialog").close();
  clearSurveyResult();
};

$("surveyCsvBtn").onclick = () => {
  if (!lastSurveyRows || lastSurveyRows.length === 0) return;
  const keys = [];
  for (const row of lastSurveyRows) {
    for (const k of Object.keys(row)) {
      if (k !== "attributes" && !keys.includes(k)) keys.push(k);
    }
  }
  const esc = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [keys.join(",")];
  for (const row of lastSurveyRows) {
    lines.push(keys.map((k) => (row[k] !== undefined ? esc(row[k]) : "")).join(","));
  }
  downloadFile("\ufeff" + lines.join("\n"),
    `plateau-survey-${exportTimestamp()}.csv`, "text/csv;charset=utf-8");
  toast(`${lastSurveyRows.length}棟の調査リストをCSVで保存しました`);
};

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = Cesium.Math.toRadians(lat2 - lat1);
  const dLon = Cesium.Math.toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(Cesium.Math.toRadians(lat1)) * Math.cos(Cesium.Math.toRadians(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ============================================================
// 車両走行パス検討（旋回可否の簡易スイープパス）
// ============================================================
// 設計車両の目安値（道路構造令の設計諸元等を参考。カスタム入力可）
const VEHICLE_PRESETS = [
  ["small", "小型トラック（2t）", { width: 1.9, length: 4.7, turnRadius: 6 }],
  ["medium", "中型トラック（4t）", { width: 2.2, length: 7.6, turnRadius: 7 }],
  ["mixer", "ミキサー車・大型（10t）", { width: 2.5, length: 8.5, turnRadius: 9 }],
  ["large", "大型トラック（12m）", { width: 2.5, length: 12.0, turnRadius: 12 }],
  ["trailer", "セミトレーラー（16.5m）", { width: 2.5, length: 16.5, turnRadius: 12 }],
  ["pump", "コンクリートポンプ車", { width: 2.5, length: 11.0, turnRadius: 10 }],
];
const VEHICLE_MARGIN = 0.3; // 走行帯の左右余裕[m]

const vehicleState = { active: false, points: [], previewEntities: [] };
let vehicleCounter = 0;

$("vehicleBtn").onclick = () => {
  if (vehicleState.active) {
    cancelVehicleDraw();
    return;
  }
  vehicleState.active = true;
  vehicleState.points = [];
  $("vehicleBtn").classList.add("active");
  closeDrawer();
  showHint("走行ルートを順にクリック（ダブルクリックで確定 / Escで中止）");
};

function cancelVehicleDraw() {
  vehicleState.active = false;
  vehicleState.points = [];
  for (const e of vehicleState.previewEntities) viewer.entities.remove(e);
  vehicleState.previewEntities = [];
  $("vehicleBtn").classList.remove("active");
  hideHint();
  requestRender();
}

function vehicleAddPoint(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;
  const pts = vehicleState.points;
  // ダブルクリック由来の重複点を除外
  if (pts.length > 0 && Cesium.Cartesian3.distance(pts[pts.length - 1], pos) < 1.0) return;
  pts.push(pos);
  vehicleState.previewEntities.push(viewer.entities.add({
    position: pos,
    point: { pixelSize: 7, color: Cesium.Color.fromCssColorString("#5fd08a"), disableDepthTestDistance: Number.POSITIVE_INFINITY },
  }));
  if (pts.length >= 2) {
    vehicleState.previewEntities.push(viewer.entities.add({
      polyline: { positions: [pts[pts.length - 2], pts[pts.length - 1]], width: 2, material: Cesium.Color.fromCssColorString("#5fd08a").withAlpha(0.7) },
    }));
  }
  requestRender();
}

function finishVehicleDraw() {
  const pts = vehicleState.points.slice();
  cancelVehicleDraw();
  if (pts.length < 2) {
    toast("2点以上クリックしてルートを描いてください");
    return;
  }
  const preset = VEHICLE_PRESETS[2]; // デフォルト: ミキサー車・大型10t
  const layer = {
    id: `vehicle-${++vehicleCounter}`,
    dataset: { name: `🚚 車両パス ${vehicleCounter}`, format: "シミュレーション", type: "施工計画", type_en: "vehicle" },
    kind: "vehicle",
    visible: true,
    loading: false,
    entities: [],
    vehicle: { points: pts, preset: preset[0], ...preset[2], result: null },
  };
  state.layers.push(layer);
  rebuildVehiclePath(layer);
  renderLayerList();
}

// ENU平面（起点基準）での2D計算ユーティリティ
function vehicleTo2d(points) {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(points[0]);
  const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
  return {
    enu,
    pts: points.map((p) => {
      const local = Cesium.Matrix4.multiplyByPoint(inv, p, new Cesium.Cartesian3());
      return { x: local.x, y: local.y };
    }),
  };
}

function vehicleToWorld(enu, x, y, z = 0.4) {
  return Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
}

function rebuildVehiclePath(layer) {
  for (const e of layer.entities) viewer.entities.remove(e);
  layer.entities = [];
  const v = layer.vehicle;
  const { enu, pts } = vehicleTo2d(v.points);
  const half = v.width / 2 + VEHICLE_MARGIN;
  const green = Cesium.Color.fromCssColorString("#5fd08a");
  const red = Cesium.Color.fromCssColorString("#e05656");

  // 各セグメントの走行帯（車幅+余裕の帯）
  let totalLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    totalLen += len;
    if (len < 0.01) continue;
    const nx = -dy / len * half, ny = dx / len * half; // 左法線
    const corners = [
      vehicleToWorld(enu, a.x + nx, a.y + ny),
      vehicleToWorld(enu, b.x + nx, b.y + ny),
      vehicleToWorld(enu, b.x - nx, b.y - ny),
      vehicleToWorld(enu, a.x - nx, a.y - ny),
    ];
    layer.entities.push(viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(corners),
        material: Cesium.Color.fromCssColorString("#4da3ff").withAlpha(0.25),
        perPositionHeight: true,
      },
    }));
  }
  // 中心線（進行方向の矢印 = 一方通行・運行方向の表現）
  layer.entities.push(viewer.entities.add({
    polyline: {
      positions: pts.map((p) => vehicleToWorld(enu, p.x, p.y, 0.6)),
      width: 12,
      material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.WHITE.withAlpha(0.85)),
    },
  }));

  // 車両の簡易3Dモデル（キャブ+荷台のボックス表現、先頭セグメントの向きに配置）
  const segDx = pts[1].x - pts[0].x;
  const segDy = pts[1].y - pts[0].y;
  if (Math.hypot(segDx, segDy) > 0.5) {
    const heading = Math.atan2(segDx, segDy); // 北基準の方位角
    const f = { x: Math.sin(heading), y: Math.cos(heading) };
    const cabLen = Math.max(1.5, v.length * 0.24);
    const bodyLen = Math.max(3, v.length * 0.68);
    const addBox = (cx, cy, len, hgt, css) => {
      const position = vehicleToWorld(enu, cx, cy, hgt / 2 + 0.2);
      layer.entities.push(viewer.entities.add({
        position,
        orientation: Cesium.Transforms.headingPitchRollQuaternion(
          position, new Cesium.HeadingPitchRoll(heading, 0, 0)),
        box: {
          dimensions: new Cesium.Cartesian3(v.width, len, hgt),
          material: Cesium.Color.fromCssColorString(css).withAlpha(0.95),
          outline: true,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.4),
        },
      }));
    };
    addBox(pts[0].x + f.x * (cabLen / 2), pts[0].y + f.y * (cabLen / 2), cabLen, 2.6, "#4da3ff");
    addBox(pts[0].x + f.x * (cabLen + bodyLen / 2), pts[0].y + f.y * (cabLen + bodyLen / 2), bodyLen, 3.1, "#c8ccd2");
  }

  // 各コーナーの旋回判定（最小回転半径のフィレットが収まるか）
  let ngCount = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const v1 = { x: p1.x - p0.x, y: p1.y - p0.y };
    const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    if (l1 < 0.01 || l2 < 0.01) continue;
    const u1 = { x: v1.x / l1, y: v1.y / l1 };
    const u2 = { x: v2.x / l2, y: v2.y / l2 };
    const cross = u1.x * u2.y - u1.y * u2.x;
    const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const deflection = Math.acos(dot); // 転向角[rad]
    if (deflection < 0.03) continue; // ほぼ直進

    const R = v.turnRadius;
    const tangent = R * Math.tan(deflection / 2); // 接線長
    // 前後セグメントに接線長が収まれば旋回可（隣のコーナーと共有するため半分まで）
    const ok = tangent <= l1 * 0.75 && tangent <= l2 * 0.75;
    if (!ok) ngCount++;

    // フィレット円弧を描画
    const t1 = { x: p1.x - u1.x * tangent, y: p1.y - u1.y * tangent };
    const side = cross > 0 ? 1 : -1; // 左折=1 右折=-1
    const n1 = { x: -u1.y * side, y: u1.x * side }; // 旋回中心方向の法線
    const center = { x: t1.x + n1.x * R, y: t1.y + n1.y * R };
    const startAng = Math.atan2(t1.y - center.y, t1.x - center.x);
    const arcPositions = [];
    const steps = 12;
    for (let s = 0; s <= steps; s++) {
      const ang = startAng + side * deflection * (s / steps);
      arcPositions.push(vehicleToWorld(enu, center.x + R * Math.cos(ang), center.y + R * Math.sin(ang), 0.8));
    }
    layer.entities.push(viewer.entities.add({
      polyline: { positions: arcPositions, width: 5, material: ok ? green : red },
    }));
    if (!ok) {
      layer.entities.push(viewer.entities.add({
        position: vehicleToWorld(enu, p1.x, p1.y, 2),
        label: measureLabel(`要切り返し（R${R}m が収まりません）`),
      }));
    }
  }

  // 起点にサマリーラベル
  layer.entities.push(viewer.entities.add({
    position: vehicleToWorld(enu, pts[0].x, pts[0].y, 2),
    label: measureLabel(`${VEHICLE_PRESETS.find((p) => p[0] === v.preset)?.[1] || "カスタム"} / 全長${totalLen.toFixed(0)}m`),
  }));

  v.result = { ngCount, corners: Math.max(0, pts.length - 2), totalLen };
  layer.visible = true;
  requestRender();
}

// レイヤーパネルの車両パス用コントロール
function renderVehicleRows(layer, li) {
  const v = layer.vehicle;

  const row1 = document.createElement("div");
  row1.className = "layer-row";
  const presetSel = document.createElement("select");
  for (const [key, label] of VEHICLE_PRESETS) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    if (v.preset === key) opt.selected = true;
    presetSel.appendChild(opt);
  }
  presetSel.onchange = () => {
    const preset = VEHICLE_PRESETS.find((p) => p[0] === presetSel.value);
    v.preset = presetSel.value;
    Object.assign(v, preset[2]);
    rebuildVehiclePath(layer);
    renderLayerList();
  };
  row1.append("車種", presetSel);
  li.appendChild(row1);

  const row2 = document.createElement("div");
  row2.className = "layer-row";
  const widthIn = document.createElement("input");
  widthIn.type = "number";
  widthIn.step = "0.1";
  widthIn.value = v.width;
  const radiusIn = document.createElement("input");
  radiusIn.type = "number";
  radiusIn.step = "0.5";
  radiusIn.value = v.turnRadius;
  const apply = () => {
    v.width = Math.max(1, parseFloat(widthIn.value) || 2.5);
    v.turnRadius = Math.max(2, parseFloat(radiusIn.value) || 9);
    rebuildVehiclePath(layer);
    renderLayerList();
  };
  widthIn.onchange = radiusIn.onchange = apply;
  row2.append("車幅(m)", widthIn, "回転半径(m)", radiusIn);
  li.appendChild(row2);

  if (v.result) {
    const row3 = document.createElement("div");
    row3.className = "layer-row";
    row3.textContent = v.result.ngCount === 0
      ? `✅ 全${v.result.corners}コーナー旋回可（全長${v.result.totalLen.toFixed(0)}m）`
      : `⚠ ${v.result.ngCount}/${v.result.corners}コーナーで要切り返し`;
    li.appendChild(row3);
  }
}

// ============================================================
// ヤード作図（資材置き場・仮設事務所・仮囲い等）
// ============================================================
const ZONE_TYPES = [
  ["material", "資材置き場", "#f2d13e", 2.0],
  ["office", "仮設事務所", "#4da3ff", 3.0],
  ["parking", "車両待機・駐車", "#5fd08a", 0.3],
  ["gate", "出入口ゲート", "#e0a03d", 4.0],
  ["danger", "立入禁止・危険区域", "#e05656", 0.3],
  ["fence", "仮囲い", "#9aa1ac", 3.0],
];

const zoneState = { active: false, points: [], previewEntities: [] };
let zoneCounter = 0;

$("zoneBtn").onclick = () => {
  if (zoneState.active) {
    cancelZoneDraw();
    return;
  }
  zoneState.active = true;
  zoneState.points = [];
  $("zoneBtn").classList.add("active");
  closeDrawer();
  showHint("ヤードの頂点を順にクリック（3点以上・ダブルクリックで確定 / Escで中止）");
};

function cancelZoneDraw() {
  zoneState.active = false;
  zoneState.points = [];
  for (const e of zoneState.previewEntities) viewer.entities.remove(e);
  zoneState.previewEntities = [];
  $("zoneBtn").classList.remove("active");
  hideHint();
  requestRender();
}

function zoneAddPoint(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;
  const pts = zoneState.points;
  if (pts.length > 0 && Cesium.Cartesian3.distance(pts[pts.length - 1], pos) < 1.0) return;
  pts.push(pos);
  zoneState.previewEntities.push(viewer.entities.add({
    position: pos,
    point: { pixelSize: 7, color: Cesium.Color.fromCssColorString("#f2d13e"), disableDepthTestDistance: Number.POSITIVE_INFINITY },
  }));
  if (pts.length >= 2) {
    zoneState.previewEntities.push(viewer.entities.add({
      polyline: { positions: [pts[pts.length - 2], pts[pts.length - 1]], width: 2, material: Cesium.Color.fromCssColorString("#f2d13e").withAlpha(0.7) },
    }));
  }
  requestRender();
}

function finishZoneDraw() {
  const pts = zoneState.points.slice();
  cancelZoneDraw();
  if (pts.length < 3) {
    toast("3点以上クリックして範囲を描いてください");
    return;
  }
  const layer = {
    id: `zone-${++zoneCounter}`,
    dataset: { name: `⬛ 資材置き場 ${zoneCounter}`, format: "作図", type: "施工計画", type_en: "zone" },
    kind: "zone",
    visible: true,
    loading: false,
    entities: [],
    zone: { points: pts, type: "material", label: `資材置き場 ${zoneCounter}` },
  };
  state.layers.push(layer);
  rebuildZone(layer);
  renderLayerList();
}

function rebuildZone(layer) {
  for (const e of layer.entities) viewer.entities.remove(e);
  layer.entities = [];
  const z = layer.zone;
  const def = ZONE_TYPES.find((t) => t[0] === z.type) || ZONE_TYPES[0];
  const color = Cesium.Color.fromCssColorString(def[2]);
  const groundHeight = Cesium.Cartographic.fromCartesian(z.points[0]).height;
  const area = polygonArea(z.points);
  z.area = area;

  layer.entities.push(viewer.entities.add({
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(z.points),
      material: color.withAlpha(z.type === "fence" ? 0.15 : 0.4),
      height: groundHeight,
      extrudedHeight: groundHeight + def[3],
      outline: true,
      outlineColor: color,
    },
  }));
  // 中心にラベル（名称と面積）
  const center = Cesium.BoundingSphere.fromPoints(z.points).center;
  const centerCarto = Cesium.Cartographic.fromCartesian(center);
  layer.entities.push(viewer.entities.add({
    position: Cesium.Cartesian3.fromRadians(centerCarto.longitude, centerCarto.latitude, groundHeight + def[3] + 2),
    label: measureLabel(`${z.label}（${area >= 10000 ? (area / 10000).toFixed(2) + " ha" : area.toFixed(0) + " m²"}）`),
  }));
  layer.dataset.name = `⬛ ${z.label}`;
  layer.visible = true;
  requestRender();
}

// レイヤーパネルのヤード用コントロール
function renderZoneRows(layer, li) {
  const z = layer.zone;

  const row1 = document.createElement("div");
  row1.className = "layer-row";
  const typeSel = document.createElement("select");
  for (const [key, label] of ZONE_TYPES) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    if (z.type === key) opt.selected = true;
    typeSel.appendChild(opt);
  }
  typeSel.onchange = () => {
    const def = ZONE_TYPES.find((t) => t[0] === typeSel.value);
    // 既定名のままなら種別名に合わせて更新
    if (ZONE_TYPES.some((t) => z.label.startsWith(t[1]))) {
      z.label = `${def[1]} ${layer.id.split("-")[1]}`;
    }
    z.type = typeSel.value;
    rebuildZone(layer);
    renderLayerList();
  };
  row1.append("種別", typeSel);
  li.appendChild(row1);

  const row2 = document.createElement("div");
  row2.className = "layer-row";
  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.value = z.label;
  nameIn.style.flex = "1";
  nameIn.onchange = () => {
    z.label = nameIn.value || z.label;
    rebuildZone(layer);
    renderLayerList();
  };
  row2.append("名称", nameIn);
  li.appendChild(row2);

  const row3 = document.createElement("div");
  row3.className = "layer-row";
  const info = document.createElement("span");
  info.textContent = `面積 ${z.area >= 10000 ? (z.area / 10000).toFixed(2) + " ha" : (z.area || 0).toFixed(0) + " m²"}`;
  const exportBtn = document.createElement("button");
  exportBtn.className = "tbtn";
  exportBtn.textContent = "全ヤードをGeoJSON保存";
  exportBtn.title = "作図した全ヤードをGeoJSONで保存（インポートで再利用可）";
  exportBtn.onclick = exportZonesGeojson;
  row3.append(info, exportBtn);
  li.appendChild(row3);

  if (typeof renderKiseiRow === "function") renderKiseiRow(layer, li);
}

function exportZonesGeojson() {
  const zones = state.layers.filter((l) => l.kind === "zone");
  if (zones.length === 0) return;
  const features = zones.map((l) => {
    const coords = l.zone.points.map((p) => {
      const c = Cesium.Cartographic.fromCartesian(p);
      return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
    });
    coords.push(coords[0]); // リングを閉じる
    const def = ZONE_TYPES.find((t) => t[0] === l.zone.type);
    return {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [coords] },
      properties: { 名称: l.zone.label, 種別: def ? def[1] : l.zone.type, "面積m2": Math.round(l.zone.area || 0) },
    };
  });
  downloadFile(JSON.stringify({ type: "FeatureCollection", name: "施工ヤード計画", features }),
    `plateau-yards-${exportTimestamp()}.geojson`, "application/geo+json");
  toast(`${features.length}件のヤードをGeoJSONで保存しました`);
}

// ============================================================
// 作図レイヤーのシリアライズ/復元（現場保存用）
// IDを保持するため、工程とのリンクも現場切替後に維持される
// ============================================================
function constructionCartoArray(p) {
  const c = Cesium.Cartographic.fromCartesian(p);
  return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude), c.height];
}
function constructionToCartesian(a) {
  return Cesium.Cartesian3.fromDegrees(a[0], a[1], a[2] || 0);
}
function constructionBumpCounter(id, kind) {
  const n = parseInt(String(id).split("-")[1], 10);
  if (!Number.isFinite(n)) return;
  if (kind === "zone") zoneCounter = Math.max(zoneCounter, n);
  else if (kind === "crane") craneCounter = Math.max(craneCounter, n);
  else if (kind === "vehicle") vehicleCounter = Math.max(vehicleCounter, n);
}

function serializeConstruction() {
  return {
    zones: state.layers.filter((l) => l.kind === "zone").map((l) => ({
      id: l.id,
      points: l.zone.points.map(constructionCartoArray),
      type: l.zone.type,
      label: l.zone.label,
    })),
    cranes: state.layers.filter((l) => l.kind === "crane").map((l) => ({
      id: l.id,
      position: constructionCartoArray(l.crane.position),
      boomLength: l.crane.boomLength,
      boomAngle: l.crane.boomAngle,
      pivotHeight: l.crane.pivotHeight,
      preset: l.crane.preset || "custom",
    })),
    vehicles: state.layers.filter((l) => l.kind === "vehicle").map((l) => ({
      id: l.id,
      points: l.vehicle.points.map(constructionCartoArray),
      preset: l.vehicle.preset,
      width: l.vehicle.width,
      length: l.vehicle.length,
      turnRadius: l.vehicle.turnRadius,
    })),
    volumes: state.layers.filter((l) => l.kind === "volume").map((l) => ({
      id: l.id,
      name: l.dataset.name,
      ...l.volume,
      sourceGmlId: l.sourceGmlId || null,
    })),
  };
}

function restoreConstruction(data) {
  if (!data) return;
  for (const z of data.zones || []) {
    constructionBumpCounter(z.id, "zone");
    const layer = {
      id: z.id || `zone-${++zoneCounter}`,
      dataset: { name: `⬛ ${z.label}`, format: "作図", type: "施工計画", type_en: "zone" },
      kind: "zone", visible: true, loading: false, entities: [],
      zone: { points: z.points.map(constructionToCartesian), type: z.type, label: z.label },
    };
    state.layers.push(layer);
    rebuildZone(layer);
  }
  for (const c of data.cranes || []) {
    constructionBumpCounter(c.id, "crane");
    const layer = {
      id: c.id || `crane-${++craneCounter}`,
      dataset: { name: `🏗 クレーン ${(c.id || "").split("-")[1] || ""}`, format: "シミュレーション", type: "施工計画", type_en: "crane" },
      kind: "crane", visible: true, loading: false, entities: [],
      crane: {
        position: constructionToCartesian(c.position),
        boomLength: c.boomLength, boomAngle: c.boomAngle,
        pivotHeight: c.pivotHeight || 3, preset: c.preset || "custom",
        sweepResult: null,
      },
    };
    state.layers.push(layer);
    redrawCrane(layer);
  }
  for (const v of data.vehicles || []) {
    constructionBumpCounter(v.id, "vehicle");
    const layer = {
      id: v.id || `vehicle-${++vehicleCounter}`,
      dataset: { name: `🚚 車両パス ${(v.id || "").split("-")[1] || ""}`, format: "シミュレーション", type: "施工計画", type_en: "vehicle" },
      kind: "vehicle", visible: true, loading: false, entities: [],
      vehicle: {
        points: v.points.map(constructionToCartesian),
        preset: v.preset || "custom",
        width: v.width, length: v.length, turnRadius: v.turnRadius,
        result: null,
      },
    };
    state.layers.push(layer);
    rebuildVehiclePath(layer);
  }
  for (const v of data.volumes || []) {
    if (typeof restoreVolumeLayer === "function") restoreVolumeLayer(v);
  }
  renderLayerList();
}

// ============================================================
// app.js からの委譲（クリック / Esc）
// ============================================================
function constructionHandleClick(windowPos) {
  if (modelPlaceState.pending || modelPlaceState.relocateLayer) {
    placeModelAt(windowPos);
    return true;
  }
  if (craneState.arming) {
    placeCraneAt(windowPos);
    return true;
  }
  if (surveyState.arming) {
    runSurveyAt(windowPos);
    return true;
  }
  if (vehicleState.active) {
    vehicleAddPoint(windowPos);
    return true;
  }
  if (zoneState.active) {
    zoneAddPoint(windowPos);
    return true;
  }
  return false;
}

function constructionHandleDoubleClick() {
  if (vehicleState.active) {
    finishVehicleDraw();
    return true;
  }
  if (zoneState.active) {
    finishZoneDraw();
    return true;
  }
  return false;
}

function constructionHandleEscape() {
  if (modelPlaceState.pending || modelPlaceState.relocateLayer) {
    modelPlaceState.pending = null;
    modelPlaceState.relocateLayer = null;
    hideHint();
    return true;
  }
  if (craneState.arming) {
    craneState.arming = false;
    $("craneBtn").classList.remove("active");
    hideHint();
    return true;
  }
  if (surveyState.arming) {
    surveyState.arming = false;
    $("surveyBtn").classList.remove("active");
    hideHint();
    return true;
  }
  if (vehicleState.active) {
    cancelVehicleDraw();
    return true;
  }
  if (zoneState.active) {
    cancelZoneDraw();
    return true;
  }
  return false;
}
