/* 法規チェック（斜線制限・冬至日影の簡易可視化）
 *
 * ① 斜線制限: 敷地（ヤード作図）に対して道路斜線・隣地斜線の制限面を
 *    3Dの半透明面として表示し、敷地内の計画ボリューム/BIMモデルの
 *    高さが制限面を超えていないかを簡易判定する。
 *      道路斜線: 住居系 1.25 / その他 1.5（前面道路の反対側境界から）
 *      隣地斜線: 住居系 20m+1.25 / その他 31m+2.5
 * ② 冬至日影: 計画ボリューム/BIMモデルの冬至日8〜16時の影の範囲を
 *    扇形（時刻別の投影輪郭）として地面に表示する。
 *
 * ※いずれも敷地形状を外接矩形で近似した参考表示。緩和規定・測定面高さ・
 *   北側斜線等は含まない。申請検討では法規の正式な検討が必要。
 */
"use strict";

let kiseiCounter = 0;

// ---------- 共通: 敷地のENUローカル化 ----------
function kiseiLocalFrame(points) {
  const origin = points[0];
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
  const pts = points.map((p) => {
    const l = Cesium.Matrix4.multiplyByPoint(inv, p, new Cesium.Cartesian3());
    return { x: l.x, y: l.y };
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const toWorld = (x, y, z) =>
    Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
  const toLocal = (cart) => {
    const l = Cesium.Matrix4.multiplyByPoint(inv, cart, new Cesium.Cartesian3());
    return { x: l.x, y: l.y, z: l.z };
  };
  return { origin, enu, inv, pts, bbox: { minX, minY, maxX, maxY }, toWorld, toLocal };
}

// ---------- ① 斜線制限 ----------
// 敷地ヤードのレイヤーパネルに追加されるコントロール（construction.jsから呼ばれる）
function renderKiseiRow(layer, li) {
  if (layer.kind !== "zone") return;
  const row = document.createElement("div");
  row.className = "layer-row";
  const roadSel = document.createElement("select");
  for (const [v, label] of [["S", "南側道路"], ["N", "北側道路"], ["E", "東側道路"], ["W", "西側道路"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    roadSel.appendChild(o);
  }
  const widthIn = document.createElement("input");
  widthIn.type = "number";
  widthIn.min = "2";
  widthIn.step = "0.5";
  widthIn.value = "6";
  widthIn.title = "前面道路の幅員(m)";
  const useSel = document.createElement("select");
  for (const [v, label] of [["res", "住居系"], ["other", "商業・工業系"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    useSel.appendChild(o);
  }
  // 敷地条件調査済みなら用途地域から自動選択
  if (typeof lastSiteCheck !== "undefined" && lastSiteCheck?.useDistrict?.includes("住居")) {
    useSel.value = "res";
  } else if (typeof lastSiteCheck !== "undefined" && lastSiteCheck) {
    useSel.value = "other";
  }
  const btn = document.createElement("button");
  btn.className = "tbtn";
  btn.textContent = "📐 斜線";
  btn.title = "道路斜線・隣地斜線の制限面を表示して高さ適合を判定";
  btn.onclick = () => createKiseiLayer(layer, {
    roadSide: roadSel.value,
    roadWidth: Math.max(2, parseFloat(widthIn.value) || 6),
    residential: useSel.value === "res",
  });
  row.append(roadSel, "幅員", widthIn, useSel, btn);
  li.appendChild(row);
}

function createKiseiLayer(zoneLayer, opts) {
  const frame = kiseiLocalFrame(zoneLayer.zone.points);
  const { minX, minY, maxX, maxY } = frame.bbox;
  const groundZ = 0;
  const roadSlope = opts.residential ? 1.25 : 1.5;
  const adjBase = opts.residential ? 20 : 31;
  const adjSlope = opts.residential ? 1.25 : 2.5;

  const layer = {
    id: `kisei-${++kiseiCounter}`,
    dataset: {
      name: `📐 斜線制限（${zoneLayer.zone.label} / ${opts.residential ? "住居系" : "商業・工業系"} / 道路${opts.roadWidth}m）`,
      format: "法規面", type: "法規チェック", type_en: "kisei",
    },
    kind: "kisei",
    visible: true,
    loading: false,
    entities: [],
    kisei: { zoneId: zoneLayer.id, ...opts, frame, verdicts: [] },
  };

  // 各辺の制限面（外接矩形近似）: 辺から敷地内側へ向かって立ち上がる斜面
  const sides = [
    { key: "S", edge: [[minX, minY], [maxX, minY]], inward: [0, 1], depth: maxY - minY },
    { key: "N", edge: [[minX, maxY], [maxX, maxY]], inward: [0, -1], depth: maxY - minY },
    { key: "W", edge: [[minX, minY], [minX, maxY]], inward: [1, 0], depth: maxX - minX },
    { key: "E", edge: [[maxX, minY], [maxX, maxY]], inward: [-1, 0], depth: maxX - minX },
  ];
  const roadColor = Cesium.Color.fromCssColorString("#f2913e");
  const adjColor = Cesium.Color.fromCssColorString("#9b8ce6");

  for (const side of sides) {
    const isRoad = side.key === opts.roadSide;
    const h0 = isRoad ? opts.roadWidth * roadSlope : adjBase;       // 境界線上の高さ
    const slope = isRoad ? roadSlope : adjSlope;
    const h1 = h0 + side.depth * slope;                             // 反対側での高さ
    const [a, b] = side.edge;
    const c = [b[0] + side.inward[0] * side.depth, b[1] + side.inward[1] * side.depth];
    const d = [a[0] + side.inward[0] * side.depth, a[1] + side.inward[1] * side.depth];
    const corners = [
      frame.toWorld(a[0], a[1], groundZ + h0),
      frame.toWorld(b[0], b[1], groundZ + h0),
      frame.toWorld(c[0], c[1], groundZ + h1),
      frame.toWorld(d[0], d[1], groundZ + h1),
    ];
    const color = isRoad ? roadColor : adjColor;
    layer.entities.push(viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(corners),
        material: color.withAlpha(0.16),
        perPositionHeight: true,
        outline: false,
      },
    }));
    // 境界線上の立ち上がりライン
    layer.entities.push(viewer.entities.add({
      polyline: { positions: [corners[0], corners[1]], width: 3, material: color.withAlpha(0.9) },
    }));
    if (isRoad) {
      layer.entities.push(viewer.entities.add({
        position: frame.toWorld((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, groundZ + h0 + 2),
        label: measureLabel(`道路斜線 1:${roadSlope}（幅員${opts.roadWidth}m → ${h0.toFixed(1)}m〜）`),
      }));
    }
  }

  kiseiJudge(layer);
  state.layers.push(layer);
  renderLayerList();
  requestRender();
  toast("斜線制限面を表示しました（オレンジ=道路斜線 / 紫=隣地斜線）");
  return layer;
}

// 敷地内の計画ボリューム/BIMモデルの高さ適合を判定する
function kiseiAllowedHeight(k, x, y) {
  const { minX, minY, maxX, maxY } = k.frame.bbox;
  const roadSlope = k.residential ? 1.25 : 1.5;
  const adjBase = k.residential ? 20 : 31;
  const adjSlope = k.residential ? 1.25 : 2.5;
  const dist = { S: y - minY, N: maxY - y, W: x - minX, E: maxX - x };
  let allowed = Infinity;
  for (const key of ["S", "N", "E", "W"]) {
    const h = key === k.roadSide
      ? (k.roadWidth + dist[key]) * roadSlope
      : adjBase + dist[key] * adjSlope;
    allowed = Math.min(allowed, h);
  }
  return allowed;
}

function kiseiJudge(layer) {
  const k = layer.kisei;
  k.verdicts = [];
  for (const target of state.layers) {
    let pos = null, height = null, name = target.dataset.name;
    if (target.kind === "volume") {
      pos = Cesium.Cartesian3.fromDegrees(target.volume.lon, target.volume.lat, 0);
      height = target.volume.height;
    } else if (target.kind === "model") {
      pos = Cesium.Cartesian3.fromDegrees(target.model.lon, target.model.lat, 0);
      height = (target.model.buildHeight || 30) + (target.model.heightOffset || 0);
    } else {
      continue;
    }
    const l = k.frame.toLocal(pos);
    const { minX, minY, maxX, maxY } = k.frame.bbox;
    if (l.x < minX - 1 || l.x > maxX + 1 || l.y < minY - 1 || l.y > maxY + 1) continue; // 敷地外
    const allowed = kiseiAllowedHeight(k, l.x, l.y);
    k.verdicts.push({
      name,
      height,
      allowed,
      ok: height <= allowed + 0.01,
      over: Math.max(0, height - allowed),
    });
  }
  if (k.verdicts.length > 0) {
    const ng = k.verdicts.filter((v) => !v.ok);
    toast(ng.length === 0
      ? `✅ 敷地内の計画建物 ${k.verdicts.length}件はすべて斜線制限に適合（参考判定）`
      : `⚠ ${ng.length}件が斜線制限を超過: ${ng.map((v) => `${v.name} +${v.over.toFixed(1)}m`).join(" / ")}`, 8000);
  }
}

// レイヤーパネルの斜線レイヤー用コントロール
function renderKiseiLayerRows(layer, li) {
  const k = layer.kisei;
  const row = document.createElement("div");
  row.className = "layer-row";
  const btn = document.createElement("button");
  btn.className = "tbtn";
  btn.textContent = "再判定";
  btn.onclick = () => { kiseiJudge(layer); renderLayerList(); };
  row.appendChild(btn);
  li.appendChild(row);
  for (const v of k.verdicts) {
    const r = document.createElement("div");
    r.className = "layer-row";
    r.textContent = v.ok
      ? `✅ ${v.name}: ${v.height.toFixed(1)}m ≦ 許容${v.allowed.toFixed(1)}m`
      : `⚠ ${v.name}: ${v.height.toFixed(1)}m（許容${v.allowed.toFixed(1)}m / ${v.over.toFixed(1)}m超過）`;
    li.appendChild(r);
  }
  const note = document.createElement("div");
  note.className = "layer-row muted";
  note.textContent = "※外接矩形近似の参考判定（緩和規定・北側斜線等は未考慮）";
  li.appendChild(note);
}

// ---------- ② 冬至日影（8〜16時の影範囲） ----------
// 太陽位置（簡易式）: 冬至 declination = -23.44°
function kiseiSunAt(latDeg, hour) {
  const phi = Cesium.Math.toRadians(latDeg);
  const delta = Cesium.Math.toRadians(-23.44);
  const H = Cesium.Math.toRadians((hour - 12) * 15);
  const sinAlt = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  let az = Math.acos(Math.max(-1, Math.min(1,
    (Math.sin(delta) - sinAlt * Math.sin(phi)) / (Math.cos(alt) * Math.cos(phi)))));
  if (hour > 12) az = 2 * Math.PI - az; // 午後は西側
  return { alt, az }; // azは北から時計回り
}

// ボリューム/BIMモデルのレイヤーパネルに追加（replace.js/construction.jsから呼ばれる）
function renderShadowRow(layer, li) {
  if (layer.kind !== "volume" && layer.kind !== "model") return;
  const row = document.createElement("div");
  row.className = "layer-row";
  const btn = document.createElement("button");
  btn.className = "tbtn";
  const active = layer.entities && layer.entities.length > 0;
  btn.textContent = active ? "🌗 冬至日影を消す" : "🌗 冬至日影(8〜16時)";
  btn.title = "冬至日の8〜16時に落ちる影の範囲を表示（日影規制検討の目安）";
  btn.onclick = () => {
    if (layer.entities && layer.entities.length > 0) {
      for (const e of layer.entities) viewer.entities.remove(e);
      layer.entities = [];
      renderLayerList();
      requestRender();
      return;
    }
    drawWinterShadow(layer);
    renderLayerList();
  };
  row.appendChild(btn);
  li.appendChild(row);
}

function drawWinterShadow(layer) {
  layer.entities = layer.entities || [];
  let lon, lat, baseH, h, w, d;
  if (layer.kind === "volume") {
    ({ lon, lat, baseH, height: h, width: w, depth: d } = layer.volume);
  } else {
    lon = layer.model.lon; lat = layer.model.lat; baseH = layer.model.baseHeight;
    h = layer.model.buildHeight || 30; w = 20; d = 20;
  }
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, baseH);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const toWorld = (x, y) =>
    Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(x, y, 0.4), new Cesium.Cartesian3());
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  const shadowColor = Cesium.Color.fromCssColorString("#4a5568");

  const tips = [];
  for (let hour = 8; hour <= 16; hour += 1) {
    const { alt, az } = kiseiSunAt(lat, hour);
    if (alt <= 0.02) continue;
    const L = Math.min(500, h / Math.tan(alt));
    // 影は太陽と反対方向
    const sx = Math.sin(az + Math.PI) * L;
    const sy = Math.cos(az + Math.PI) * L;
    const outline = corners.map(([x, y]) => toWorld(x + sx, y + sy));
    outline.push(outline[0]);
    layer.entities.push(viewer.entities.add({
      polyline: { positions: outline, width: hour === 8 || hour === 16 ? 3 : 1.5,
        material: shadowColor.withAlpha(hour === 8 || hour === 16 ? 0.9 : 0.4) },
    }));
    tips.push(toWorld(sx, sy));
    if (hour === 8 || hour === 12 || hour === 16) {
      layer.entities.push(viewer.entities.add({
        position: toWorld(sx, sy),
        label: measureLabel(`${hour}時`),
      }));
    }
  }
  if (tips.length >= 2) {
    layer.entities.push(viewer.entities.add({
      polyline: { positions: tips, width: 2.5, material: shadowColor.withAlpha(0.8) },
    }));
  }
  requestRender();
  toast("冬至日の影範囲（8〜16時）を表示しました ※平坦地・建物単体の目安");
}
