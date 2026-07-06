/* 点群モジュール（PLY読み込み・2時期差分・工程進捗への反映）
 *
 * - ドローン測量等のPLY点群（ascii / binary_little_endian）を読み込み、
 *   クリック配置で実際の街並みに重ねる（高さで色分け表示）
 * - 読み込み時に1mグリッドへ最大高さをラスタライズしておき、
 *   2時期の点群の「差分ヒートマップ」（切土=青/盛土=赤）と土量を算定
 * - 点群の計測高さからBIMモデルの全高に対する出来高率を推定し、
 *   工程の進捗率へワンクリック反映（点群による進捗管理）
 */
"use strict";

const PC_MAX_RENDER_POINTS = 250000; // 表示上限（それ以上は間引く）
const PC_CELL_SIZE = 1.0;            // 差分グリッドのセルサイズ[m]

const pcPlaceState = { pending: null };
let pcCounter = 0;

// ---------- PLYパーサ ----------
function parsePly(buffer) {
  const bytes = new Uint8Array(buffer);
  // ヘッダ終端を探す
  const headerEnd = new TextDecoder().decode(bytes.slice(0, 4096)).indexOf("end_header");
  if (headerEnd < 0) throw new Error("PLYヘッダが見つかりません");
  const headerText = new TextDecoder().decode(bytes.slice(0, headerEnd));
  const dataStart = headerEnd + "end_header".length + 1;

  const lines = headerText.split(/\r?\n/);
  let format = "ascii";
  let vertexCount = 0;
  const props = []; // {name, type} 順序どおり
  let inVertex = false;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "format") format = parts[1];
    else if (parts[0] === "element") {
      inVertex = parts[1] === "vertex";
      if (inVertex) vertexCount = parseInt(parts[2], 10);
    } else if (parts[0] === "property" && inVertex) {
      props.push({ type: parts[1], name: parts[2] });
    }
  }
  if (vertexCount <= 0) throw new Error("頂点がありません");
  const xi = props.findIndex((p) => p.name === "x");
  const yi = props.findIndex((p) => p.name === "y");
  const zi = props.findIndex((p) => p.name === "z");
  if (xi < 0 || yi < 0 || zi < 0) throw new Error("x/y/zプロパティが必要です");

  const positions = new Float32Array(vertexCount * 3);
  if (format === "ascii") {
    const text = new TextDecoder().decode(bytes.slice(dataStart));
    const rows = text.split(/\r?\n/);
    let n = 0;
    for (const row of rows) {
      if (n >= vertexCount) break;
      const cols = row.trim().split(/\s+/);
      if (cols.length < props.length) continue;
      positions[n * 3] = parseFloat(cols[xi]);
      positions[n * 3 + 1] = parseFloat(cols[yi]);
      positions[n * 3 + 2] = parseFloat(cols[zi]);
      n++;
    }
  } else if (format === "binary_little_endian") {
    const sizes = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
      int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
    const stride = props.reduce((s, p) => s + (sizes[p.type] || 4), 0);
    const offsets = [];
    let off = 0;
    for (const p of props) { offsets.push(off); off += sizes[p.type] || 4; }
    const view = new DataView(buffer, dataStart);
    const readAt = (base, idx) => {
      const p = props[idx];
      const o = base + offsets[idx];
      if (p.type === "double" || p.type === "float64") return view.getFloat64(o, true);
      return view.getFloat32(o, true);
    };
    for (let n = 0; n < vertexCount; n++) {
      const base = n * stride;
      positions[n * 3] = readAt(base, xi);
      positions[n * 3 + 1] = readAt(base, yi);
      positions[n * 3 + 2] = readAt(base, zi);
    }
  } else {
    throw new Error(`未対応のPLY形式: ${format}（ascii / binary_little_endianのみ対応）`);
  }
  return { positions, count: vertexCount };
}

// 最大高さグリッドを作る（差分・進捗推定用）
function pcBuildGrid(positions, count) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const w = Math.max(1, Math.ceil((maxX - minX) / PC_CELL_SIZE));
  const h = Math.max(1, Math.ceil((maxY - minY) / PC_CELL_SIZE));
  if (w * h > 4_000_000) throw new Error("点群の範囲が広すぎます（2km四方程度まで）");
  const maxZGrid = new Float32Array(w * h).fill(-Infinity);
  for (let i = 0; i < count; i++) {
    const cx = Math.min(w - 1, Math.floor((positions[i * 3] - minX) / PC_CELL_SIZE));
    const cy = Math.min(h - 1, Math.floor((positions[i * 3 + 1] - minY) / PC_CELL_SIZE));
    const z = positions[i * 3 + 2];
    const idx = cy * w + cx;
    if (z > maxZGrid[idx]) maxZGrid[idx] = z;
  }
  return { minX, minY, maxX, maxY, minZ, maxZ, w, h, maxZGrid };
}

// ---------- 読み込み・配置 ----------
function handlePlyFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { positions, count } = parsePly(reader.result);
      const grid = pcBuildGrid(positions, count);
      pcPlaceState.pending = { name: file.name.replace(/\.ply$/i, ""), positions, count, grid };
      closeDrawer();
      showHint(`点群「${file.name}」（${count.toLocaleString()}点）の基準位置をクリックしてください（Escで中止）`);
      toast("点群のローカル原点を置く地点をクリックしてください");
    } catch (e) {
      toast("PLYの読み込みに失敗: " + e.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function placePointCloudAt(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;
  const pending = pcPlaceState.pending;
  pcPlaceState.pending = null;
  hideHint();

  const layer = {
    id: `points-${++pcCounter}`,
    dataset: { name: `☁ ${pending.name}`, format: "点群(PLY)", type: "計測データ", type_en: "points" },
    kind: "points",
    visible: true,
    loading: false,
    collection: null,
    points: {
      positions: pending.positions,
      count: pending.count,
      grid: pending.grid,
      anchor: pos,           // ローカル(0,0,minZ)を置く位置
      heightOffset: 0,
      pixelSize: 2,
    },
  };
  pcRebuild(layer);
  state.layers.push(layer);
  renderLayerList();
  viewer.flyTo(layer.collection, { duration: 1.5 }).catch(() => {});
  toast(`点群を配置しました（${pending.count.toLocaleString()}点 / 表示は最大${PC_MAX_RENDER_POINTS.toLocaleString()}点に間引き）`);
}

function pcRebuild(layer) {
  if (layer.collection) viewer.scene.primitives.remove(layer.collection);
  const p = layer.points;
  const collection = new Cesium.PointPrimitiveCollection();
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(p.anchor);
  const g = p.grid;
  const stride = Math.max(1, Math.ceil(p.count / PC_MAX_RENDER_POINTS));
  const zMin = g.minZ;
  const zMax = Math.max(zMin + 0.01, g.maxZ);
  for (let i = 0; i < p.count; i += stride) {
    const x = p.positions[i * 3], y = p.positions[i * 3 + 1], z = p.positions[i * 3 + 2];
    const t = (z - zMin) / (zMax - zMin);
    collection.add({
      position: Cesium.Matrix4.multiplyByPoint(enu,
        new Cesium.Cartesian3(x - g.minX, y - g.minY, z - zMin + p.heightOffset), new Cesium.Cartesian3()),
      color: pcRampColor(t),
      pixelSize: p.pixelSize,
    });
  }
  layer.collection = collection;
  collection.show = layer.visible;
  viewer.scene.primitives.add(collection);
  requestRender();
}

function pcRampColor(t) {
  // 低→高: 青→緑→黄→赤
  const stops = [
    [0, [61, 125, 200]], [0.35, [95, 176, 165]], [0.6, [158, 207, 99]],
    [0.8, [242, 209, 62]], [1, [224, 69, 47]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const f = (t - a[0]) / Math.max(0.0001, b[0] - a[0]);
  return new Cesium.Color(
    (a[1][0] + (b[1][0] - a[1][0]) * f) / 255,
    (a[1][1] + (b[1][1] - a[1][1]) * f) / 255,
    (a[1][2] + (b[1][2] - a[1][2]) * f) / 255, 1);
}

// ---------- レイヤーパネルの点群コントロール ----------
function renderPointsRows(layer, li) {
  const p = layer.points;

  const row1 = document.createElement("div");
  row1.className = "layer-row";
  const hIn = document.createElement("input");
  hIn.type = "number";
  hIn.step = "0.5";
  hIn.value = p.heightOffset;
  hIn.onchange = () => { p.heightOffset = parseFloat(hIn.value) || 0; pcRebuild(layer); };
  const sizeIn = document.createElement("input");
  sizeIn.type = "number";
  sizeIn.min = "1";
  sizeIn.max = "8";
  sizeIn.value = p.pixelSize;
  sizeIn.onchange = () => { p.pixelSize = Math.min(8, Math.max(1, parseInt(sizeIn.value, 10) || 2)); pcRebuild(layer); };
  row1.append("高さ+", hIn, "点サイズ", sizeIn);
  li.appendChild(row1);

  const row2 = document.createElement("div");
  row2.className = "layer-row";
  row2.textContent = `${p.count.toLocaleString()}点 / 範囲 ${(p.grid.maxX - p.grid.minX).toFixed(0)}×${(p.grid.maxY - p.grid.minY).toFixed(0)}m / 高さ ${(p.grid.maxZ - p.grid.minZ).toFixed(1)}m`;
  li.appendChild(row2);

  const row3 = document.createElement("div");
  row3.className = "layer-row";
  const others = state.layers.filter((l) => l.kind === "points" && l !== layer);
  if (others.length > 0) {
    const diffSel = document.createElement("select");
    for (const o of others) {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.dataset.name;
      diffSel.appendChild(opt);
    }
    const diffBtn = document.createElement("button");
    diffBtn.className = "tbtn";
    diffBtn.textContent = "差分比較";
    diffBtn.title = "この点群（旧）と選択した点群（新）の高さ差分ヒートマップと土量を算定";
    diffBtn.onclick = () => pcDiff(layer, state.layers.find((l) => l.id === diffSel.value));
    row3.append("新時期:", diffSel, diffBtn);
    li.appendChild(row3);
  }

  // 工程進捗への反映
  if (schedule.tasks.length > 0) {
    const row4 = document.createElement("div");
    row4.className = "layer-row";
    const taskSel = document.createElement("select");
    for (const t of schedule.tasks) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      taskSel.appendChild(opt);
    }
    const applyBtn = document.createElement("button");
    applyBtn.className = "tbtn";
    applyBtn.textContent = "進捗へ反映";
    applyBtn.title = "点群の計測高さ(P95)÷BIMモデルの全高 から出来高率を推定して工程進捗に反映";
    applyBtn.onclick = () => pcApplyProgress(layer, taskSel.value);
    row4.append("工程:", taskSel, applyBtn);
    li.appendChild(row4);
  }
}

// ---------- 2時期差分（ヒートマップ + 土量） ----------
function pcDiff(oldLayer, newLayer) {
  if (!newLayer) return;
  const a = oldLayer.points, b = newLayer.points;
  // 新旧のアンカーずれをENUで補正（同一基準で配置されている前提が基本）
  const enuInv = Cesium.Matrix4.inverse(
    Cesium.Transforms.eastNorthUpToFixedFrame(a.anchor), new Cesium.Matrix4());
  const bLocal = Cesium.Matrix4.multiplyByPoint(enuInv, b.anchor, new Cesium.Cartesian3());

  const ga = a.grid, gb = b.grid;
  const w = ga.w, h = ga.h;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);

  let fill = 0, cut = 0, cells = 0, sum = 0;
  const cellArea = PC_CELL_SIZE * PC_CELL_SIZE;
  const scaleMax = 5; // ±5mで色飽和
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const za = ga.maxZGrid[cy * w + cx];
      if (za === -Infinity) continue;
      // 対応する新時期セル（旧アンカー基準のENUでの新アンカーずれを補正）
      // 旧レイヤーのローカル座標: (x - ga.minX)。新レイヤーは bLocal だけずれて配置されている
      const localX = (cx + 0.5) * PC_CELL_SIZE;
      const localY = (cy + 0.5) * PC_CELL_SIZE;
      const bx = Math.floor((localX - bLocal.x) / PC_CELL_SIZE);
      const by = Math.floor((localY - bLocal.y) / PC_CELL_SIZE);
      if (bx < 0 || by < 0 || bx >= gb.w || by >= gb.h) continue;
      const zb = gb.maxZGrid[by * gb.w + bx];
      if (zb === -Infinity) continue;
      const d = (zb - gb.minZ + bLocal.z + (b.heightOffset || 0)) - (za - ga.minZ + (a.heightOffset || 0));
      cells++;
      sum += d;
      if (d > 0) fill += d * cellArea;
      else cut += -d * cellArea;
      // 青(-)→白(0)→赤(+)
      const t = Math.max(-1, Math.min(1, d / scaleMax));
      const idx = ((h - 1 - cy) * w + cx) * 4; // 画像は上下反転
      if (t >= 0) {
        img.data[idx] = 224; img.data[idx + 1] = Math.round(230 - 160 * t); img.data[idx + 2] = Math.round(230 - 185 * t);
      } else {
        img.data[idx] = Math.round(230 + 130 * t); img.data[idx + 1] = Math.round(230 - 60 * -t); img.data[idx + 2] = 224;
      }
      img.data[idx + 3] = Math.abs(d) < 0.15 ? 60 : 200;
    }
  }
  ctx.putImageData(img, 0, 0);

  if (cells === 0) {
    toast("重なり合うセルがありません（2つの点群を同じ基準位置に配置してください）");
    return;
  }

  // ヒートマップを地面に貼る（旧点群のグリッド範囲）
  const carto = Cesium.Cartographic.fromCartesian(a.anchor);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const mLon = 1 / (111320 * Math.cos(carto.latitude));
  const mLat = 1 / 110950;
  const rect = Cesium.Rectangle.fromDegrees(
    lon, lat, lon + (ga.maxX - ga.minX) * mLon, lat + (ga.maxY - ga.minY) * mLat);
  if (oldLayer.diffEntity) viewer.entities.remove(oldLayer.diffEntity);
  oldLayer.diffEntity = viewer.entities.add({
    rectangle: {
      coordinates: rect,
      material: new Cesium.ImageMaterialProperty({ image: canvas, transparent: true }),
      height: carto.height + 0.8,
    },
  });
  requestRender();

  const avg = sum / cells;
  toast(`差分: 平均${avg >= 0 ? "+" : ""}${avg.toFixed(2)}m / 盛土・増加 ${Math.round(fill).toLocaleString()}m³ / 切土・減少 ${Math.round(cut).toLocaleString()}m³`, 8000);
  oldLayer.diffResult = { fill, cut, avg, cells };
}

// ---------- 点群から工程進捗を推定 ----------
function pcApplyProgress(layer, taskId) {
  const task = schedule.tasks.find((t) => t.id === taskId);
  if (!task) return;
  // 計測高さ: グリッド最大高さ分布のP95（外れ値除去）
  const heights = [];
  const g = layer.points.grid;
  for (let i = 0; i < g.maxZGrid.length; i++) {
    if (g.maxZGrid[i] !== -Infinity) heights.push(g.maxZGrid[i] - g.minZ);
  }
  heights.sort((x, y) => x - y);
  const measured = heights[Math.floor(heights.length * 0.95)] || 0;
  // 全高: リンクされたBIMモデル > なければマップ上のBIMモデル > 既定30m
  const linkedModel = state.layers.find((l) => l.kind === "model" && (task.layers || []).includes(l.id))
    || state.layers.find((l) => l.kind === "model");
  const buildHeight = linkedModel?.model.buildHeight || 30;
  const progress = Math.min(100, Math.round((measured / buildHeight) * 100));
  task.progress = progress;
  schedMutated();
  toast(`点群計測高さ ${measured.toFixed(1)}m ÷ 全高 ${buildHeight}m → 工程「${task.name}」の進捗を ${progress}% に更新しました`, 7000);
}
