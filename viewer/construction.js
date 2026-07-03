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

  const carto = Cesium.Cartographic.fromCartesian(pos);
  const layer = {
    id: `model-${++modelCounter}`,
    dataset: { name: `🏗 ${pending.name}`, format: "glTF", type: "BIMモデル", type_en: "model" },
    kind: "model",
    visible: true,
    loading: false,
    entity: null,
    model: {
      url: pending.url,
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
    model: { uri: pending.url, scale: 1 },
  });
  updateModelEntity(layer);
  state.layers.push(layer);
  renderLayerList();
  toast(`配置しました: ${pending.name}（レイヤータブで向き・高さを調整できます）`);
  requestRender();
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

// レイヤーパネルのクレーン用コントロール
function renderCraneRows(layer, li) {
  const c = layer.crane;

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
  return false;
}
