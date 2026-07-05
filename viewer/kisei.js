/* 法規チェック（斜線制限・冬至日影・天空率・等時間日影の簡易可視化）
 *
 * ① 斜線制限: 敷地（ヤード作図）に対して道路斜線・隣地斜線の制限面を
 *    3Dの半透明面として表示し、敷地内の計画ボリューム/BIMモデルの
 *    高さが制限面を超えていないかを簡易判定する。
 *      道路斜線: 住居系 1.25 / その他 1.5（前面道路の反対側境界から）
 *      隣地斜線: 住居系 20m+1.25 / その他 31m+2.5
 * ② 冬至日影: 計画ボリューム/BIMモデルの冬至日8〜16時の影の範囲を
 *    扇形（時刻別の投影輪郭）として地面に表示する。
 * ③ 天空率: 前面道路の反対側境界上の測定点から、計画建物と
 *    斜線適合建物の天空率を比較（斜線NG時の緩和検討の当たり付け）。
 * ④ 等時間日影: 冬至日8〜16時に影となる時間数を測定面グリッドで集計し、
 *    等時間日影のヒートマップと敷地境界5m/10mラインで規制値と比較する。
 *
 * ※いずれも敷地形状を外接矩形で近似した参考表示。緩和規定・真北方位・
 *   測定点の正式な取り方等は含まない。申請検討では法規の正式な検討が必要。
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
  // 北側斜線（低層住居系 5m+1.25 / 中高層住居系 10m+1.25）
  const kitaSel = document.createElement("select");
  for (const [v, label] of [["none", "北側斜線なし"], ["low", "北側5m+1.25"], ["mid", "北側10m+1.25"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    kitaSel.appendChild(o);
  }
  kitaSel.title = "北側斜線（第1・2種低層/田園: 5m+1.25 / 第1・2種中高層: 10m+1.25）";
  if (typeof lastSiteCheck !== "undefined" && lastSiteCheck) {
    const ud = lastSiteCheck.useDistrict || "";
    if (ud.includes("低層") || ud.includes("田園")) kitaSel.value = "low";
    else if (ud.includes("中高")) kitaSel.value = "mid";
  }
  const btn = document.createElement("button");
  btn.className = "tbtn";
  btn.textContent = "📐 斜線";
  btn.title = "道路斜線・隣地斜線・北側斜線の制限面を表示して高さ適合を判定";
  btn.onclick = () => createKiseiLayer(layer, {
    roadSide: roadSel.value,
    roadWidth: Math.max(2, parseFloat(widthIn.value) || 6),
    residential: useSel.value === "res",
    kita: kitaSel.value,
  });
  row.append(roadSel, "幅員", widthIn, useSel, kitaSel, btn);
  li.appendChild(row);

  // 等時間日影（冬至日・測定面グリッド集計）
  const row2 = document.createElement("div");
  row2.className = "layer-row";
  const planeSel = document.createElement("select");
  for (const [v, label] of [["1.5", "測定面GL+1.5m"], ["4", "測定面GL+4m"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    planeSel.appendChild(o);
  }
  const regSel = document.createElement("select");
  for (const r of HIKAGE_REGS) {
    const o = document.createElement("option");
    o.value = r[0];
    o.textContent = r[1];
    regSel.appendChild(o);
  }
  const hBtn = document.createElement("button");
  hBtn.className = "tbtn";
  hBtn.textContent = "🕛 等時間";
  hBtn.title = "冬至日8〜16時の等時間日影ヒートマップと敷地境界5m/10mラインで規制値を簡易チェック";
  hBtn.onclick = () => {
    const reg = HIKAGE_REGS.find((r) => r[0] === regSel.value);
    createHikageLayer(layer, { planeH: parseFloat(planeSel.value), regA: reg[2], regB: reg[3] });
  };
  row2.append(planeSel, regSel, hBtn);
  li.appendChild(row2);
}

function createKiseiLayer(zoneLayer, opts) {
  const frame = kiseiLocalFrame(zoneLayer.zone.points);
  const { minX, minY, maxX, maxY } = frame.bbox;
  const groundZ = 0;
  const roadSlope = opts.residential ? 1.25 : 1.5;
  const adjBase = opts.residential ? 20 : 31;
  const adjSlope = opts.residential ? 1.25 : 2.5;

  const kitaBase = opts.kita === "low" ? 5 : opts.kita === "mid" ? 10 : null;

  const layer = {
    id: `kisei-${++kiseiCounter}`,
    dataset: {
      name: `📐 斜線制限（${zoneLayer.zone.label} / ${opts.residential ? "住居系" : "商業・工業系"} / 道路${opts.roadWidth}m${kitaBase !== null ? ` / 北側${kitaBase}m` : ""}）`,
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

  // 北側斜線: 北側境界から真北方向の距離に応じて 5m/10m + 1.25×距離（緑面）
  if (kitaBase !== null) {
    const kitaColor = Cesium.Color.fromCssColorString("#3ec97f");
    const depth = maxY - minY;
    const h1 = kitaBase + depth * 1.25;
    layer.entities.push(viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy([
          frame.toWorld(minX, maxY, groundZ + kitaBase),
          frame.toWorld(maxX, maxY, groundZ + kitaBase),
          frame.toWorld(maxX, minY, groundZ + h1),
          frame.toWorld(minX, minY, groundZ + h1),
        ]),
        material: kitaColor.withAlpha(0.16),
        perPositionHeight: true,
        outline: false,
      },
    }));
    layer.entities.push(viewer.entities.add({
      polyline: {
        positions: [frame.toWorld(minX, maxY, groundZ + kitaBase), frame.toWorld(maxX, maxY, groundZ + kitaBase)],
        width: 3, material: kitaColor.withAlpha(0.9),
      },
    }));
    layer.entities.push(viewer.entities.add({
      position: frame.toWorld((minX + maxX) / 2, maxY, groundZ + kitaBase + 2),
      label: measureLabel(`北側斜線 ${kitaBase}m+1.25`),
    }));
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
  // 北側斜線（北側境界からの真北方向距離）
  if (k.kita === "low") allowed = Math.min(allowed, 5 + dist.N * 1.25);
  else if (k.kita === "mid") allowed = Math.min(allowed, 10 + dist.N * 1.25);
  return allowed;
}

function kiseiJudge(layer, silent) {
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
  if (!silent && k.verdicts.length > 0) {
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
  const tenkuBtn = document.createElement("button");
  tenkuBtn.className = "tbtn";
  tenkuBtn.textContent = "🌌 天空率";
  tenkuBtn.title = "前面道路の反対側境界の測定点から計画建物と斜線適合建物の天空率を比較（緩和検討の目安）";
  tenkuBtn.onclick = () => runTenku(layer);
  row.append(btn, tenkuBtn);
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
  note.textContent = "※外接矩形近似の参考判定（緩和規定等は未考慮 / 真北=座標北と仮定）";
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

// ---------- 共通: 敷地内の計画建物をボックス近似で集める ----------
// 戻り値はframeローカル座標のボックス群 {name, cx, cy, z0, w, d, h}
function kiseiCollectBoxes(frame) {
  const { minX, minY, maxX, maxY } = frame.bbox;
  const boxes = [];
  for (const target of state.layers) {
    let lon, lat, baseH, w, d, h, name = target.dataset.name;
    if (target.kind === "volume") {
      ({ lon, lat, baseH, width: w, depth: d, height: h } = target.volume);
    } else if (target.kind === "model") {
      lon = target.model.lon; lat = target.model.lat; baseH = target.model.baseHeight;
      w = 20; d = 20;
      h = (target.model.buildHeight || 30) + (target.model.heightOffset || 0);
    } else {
      continue;
    }
    const l = frame.toLocal(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
    if (l.x < minX - 1 || l.x > maxX + 1 || l.y < minY - 1 || l.y > maxY + 1) continue;
    boxes.push({ name, cx: l.x, cy: l.y, z0: 0, w, d, h });
  }
  return boxes;
}

// ---------- ③ 天空率（斜線緩和検討・簡易） ----------
let lastTenku = null;

// 測定点から見た方位別の最大遮蔽仰角（ボックス群のシルエット）
function tenkuMaxAltPerAz(boxes, px, py, pz, nAz) {
  const thetas = new Float64Array(nAz);
  for (let i = 0; i < nAz; i++) {
    const az = (i / nAz) * Math.PI * 2;
    const dx = Math.sin(az), dy = Math.cos(az);
    for (const b of boxes) {
      const top = b.z0 + b.h - pz;
      if (top <= 0) continue;
      // XY平面でのレイと矩形のスラブ判定
      let tmin = 0.001, tmax = Infinity;
      const lox = b.cx - b.w / 2, hix = b.cx + b.w / 2;
      const loy = b.cy - b.d / 2, hiy = b.cy + b.d / 2;
      if (Math.abs(dx) < 1e-9) {
        if (px < lox || px > hix) continue;
      } else {
        let t1 = (lox - px) / dx, t2 = (hix - px) / dx;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      }
      if (Math.abs(dy) < 1e-9) {
        if (py < loy || py > hiy) continue;
      } else {
        let t1 = (loy - py) / dy, t2 = (hiy - py) / dy;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      }
      if (tmin > tmax || tmax <= 0) continue;
      const theta = Math.atan(top / Math.max(tmin, 0.001));
      if (theta > thetas[i]) thetas[i] = theta;
    }
  }
  return thetas;
}

// 天空率 = 天空図（正射影）上で空が占める面積比。方位スライスごとに
// 遮蔽域の面積は sin²θ に比例する（∫0..θ sinh·cosh dh = sin²θ/2）
function tenkuSkyRatio(thetas) {
  let blocked = 0;
  for (const t of thetas) blocked += Math.sin(t) * Math.sin(t);
  return 1 - blocked / thetas.length;
}

// 計算のみ（lastTenkuを更新して結果を返す。ダイアログ表示なし）
function tenkuCompute(k) {
  const frame = k.frame;
  const { minX, minY, maxX, maxY } = frame.bbox;
  const planBoxes = kiseiCollectBoxes(frame);
  if (planBoxes.length === 0) return null;

  // 測定点: 前面道路の反対側境界線上（中点）・地盤面高さ
  let px, py;
  if (k.roadSide === "S") { px = (minX + maxX) / 2; py = minY - k.roadWidth; }
  else if (k.roadSide === "N") { px = (minX + maxX) / 2; py = maxY + k.roadWidth; }
  else if (k.roadSide === "W") { px = minX - k.roadWidth; py = (minY + maxY) / 2; }
  else { px = maxX + k.roadWidth; py = (minY + maxY) / 2; }

  const N_AZ = 360;
  const thetasPlan = tenkuMaxAltPerAz(planBoxes, px, py, 0, N_AZ);

  // 斜線適合建物: 敷地を格子分割し、各セルを許容高さいっぱいの柱として近似
  const N_CELL = 14;
  const compBoxes = [];
  const cw = (maxX - minX) / N_CELL, cd = (maxY - minY) / N_CELL;
  for (let ix = 0; ix < N_CELL; ix++) {
    for (let iy = 0; iy < N_CELL; iy++) {
      const cx = minX + (ix + 0.5) * cw, cy = minY + (iy + 0.5) * cd;
      const h = kiseiAllowedHeight(k, cx, cy);
      if (h > 0.1) compBoxes.push({ cx, cy, z0: 0, w: cw, d: cd, h });
    }
  }
  const thetasComp = tenkuMaxAltPerAz(compBoxes, px, py, 0, N_AZ);

  const plan = tenkuSkyRatio(thetasPlan) * 100;
  const comp = tenkuSkyRatio(thetasComp) * 100;
  const ok = plan >= comp - 1e-9;
  lastTenku = { plan, comp, ok, roadSide: k.roadSide, roadWidth: k.roadWidth,
    date: new Date().toLocaleDateString("ja-JP") };
  return { ...lastTenku, thetasPlan, thetasComp };
}

function runTenku(layer) {
  const r = tenkuCompute(layer.kisei);
  if (!r) {
    toast("敷地内に計画ボリューム/CADモデルがありません（建物差し替え等で配置してください）");
    return;
  }
  renderTenkuDialog(r.thetasPlan, r.thetasComp);
  toast(r.ok
    ? `✅ 天空率: 計画 ${r.plan.toFixed(1)}% ≧ 適合建物 ${r.comp.toFixed(1)}% — 天空率による緩和の可能性あり（参考）`
    : `⚠ 天空率: 計画 ${r.plan.toFixed(1)}% ＜ 適合建物 ${r.comp.toFixed(1)}% — このままでは緩和は見込めません（参考）`, 9000);
}

// 天空図（正射影）をキャンバスに描く
function tenkuDrawChart(canvas, thetas, pct, caption) {
  const g = canvas.getContext("2d");
  const W = canvas.width, cx = W / 2, cy = W / 2, R = W / 2 - 14;
  g.clearRect(0, 0, W, canvas.height);
  // 空
  g.fillStyle = "#b9d7f2";
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  // 遮蔽（建物シルエット）: 方位ごとに外周からr=R·cosθまで塗る
  g.fillStyle = "#4a5568";
  const n = thetas.length;
  for (let i = 0; i < n; i++) {
    if (thetas[i] <= 0) continue;
    const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;   // 北=上・時計回り
    const a1 = ((i + 1.02) / n) * Math.PI * 2 - Math.PI / 2;
    const rIn = R * Math.cos(thetas[i]);
    g.beginPath();
    g.arc(cx, cy, R, a0, a1);
    g.arc(cx, cy, rIn, a1, a0, true);
    g.closePath();
    g.fill();
  }
  // 外周・方位
  g.strokeStyle = "#8a94a6"; g.lineWidth = 1.5;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  g.fillStyle = "#c8d0dc"; g.font = "12px sans-serif"; g.textAlign = "center";
  g.fillText("N", cx, cy - R - 3);
  g.font = "bold 15px sans-serif";
  g.fillText(`${pct.toFixed(1)}%`, cx, cy + R + 18);
  g.font = "12px sans-serif";
  g.fillText(caption, cx, cy + R + 34);
}

function renderTenkuDialog(thetasPlan, thetasComp) {
  const body = $("tenkuBody");
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "tenku-wrap";
  for (const [thetas, pct, caption] of [
    [thetasPlan, lastTenku.plan, "計画建物"],
    [thetasComp, lastTenku.comp, "斜線適合建物"],
  ]) {
    const c = document.createElement("canvas");
    c.width = 220; c.height = 260;
    tenkuDrawChart(c, thetas, pct, caption);
    wrap.appendChild(c);
  }
  body.appendChild(wrap);
  const verdict = document.createElement("div");
  verdict.className = "layer-row";
  verdict.textContent = lastTenku.ok
    ? `✅ 計画 ${lastTenku.plan.toFixed(1)}% ≧ 適合建物 ${lastTenku.comp.toFixed(1)}% — 天空率による斜線緩和の可能性あり`
    : `⚠ 計画 ${lastTenku.plan.toFixed(1)}% ＜ 適合建物 ${lastTenku.comp.toFixed(1)}% — 緩和には形状の見直しが必要`;
  body.appendChild(verdict);
  const note = document.createElement("div");
  note.className = "muted stats-note";
  note.textContent = `※測定点は前面道路（${{ S: "南", N: "北", E: "東", W: "西" }[lastTenku.roadSide]}側・幅員${lastTenku.roadWidth}m）の反対側境界の中点1点のみの簡易比較です。法規上は境界線上の複数測定点すべてでの比較が必要です。`;
  body.appendChild(note);
  $("tenkuDialog").showModal();
}

// ---------- ④ 等時間日影（冬至日8〜16時） ----------
let hikageCounter = 0;
let lastHikage = null;

// [id, 表示, 5-10m帯の規制h, 10m超の規制h]
const HIKAGE_REGS = [
  ["3-2", "規制 3h/2h", 3, 2],
  ["4-2.5", "規制 4h/2.5h", 4, 2.5],
  ["5-3", "規制 5h/3h", 5, 3],
];

// 計算のみ（lastHikageを更新して格子集計を返す。レイヤー生成なし）
function hikageCompute(zoneLayer, opts) {
  const frame = kiseiLocalFrame(zoneLayer.zone.points);
  const boxes = kiseiCollectBoxes(frame);
  if (boxes.length === 0) return null;
  const { minX, minY, maxX, maxY } = frame.bbox;
  const carto = Cesium.Cartographic.fromCartesian(frame.origin);
  const lat = Cesium.Math.toDegrees(carto.latitude);

  // グリッド範囲: 敷地境界+マージン（建物高さに応じて拡大）
  const maxH = Math.max(...boxes.map((b) => b.h));
  const margin = Math.min(150, Math.max(60, maxH * 2.5));
  const gx0 = minX - margin, gy0 = minY - margin;
  const gx1 = maxX + margin, gy1 = maxY + margin;
  const pitch = Math.max(1.2, Math.max(gx1 - gx0, gy1 - gy0) / 140);
  const nx = Math.ceil((gx1 - gx0) / pitch), ny = Math.ceil((gy1 - gy0) / pitch);

  // 太陽方向を10分刻みで前計算
  const steps = [];
  for (let hour = 8; hour <= 16.001; hour += 1 / 6) {
    const { alt, az } = kiseiSunAt(lat, hour);
    if (alt <= 0.02) continue;
    const ca = Math.cos(alt);
    steps.push({ dx: Math.sin(az) * ca, dy: Math.cos(az) * ca, dz: Math.sin(alt) });
  }
  const stepH = 1 / 6;
  const pz = opts.planeH;

  // 各セルの日影時間集計 + 規制帯ごとの最大値
  const hours = new Float32Array(nx * ny);
  let max5 = 0, max10 = 0;
  for (let iy = 0; iy < ny; iy++) {
    const y = gy0 + (iy + 0.5) * pitch;
    for (let ix = 0; ix < nx; ix++) {
      const x = gx0 + (ix + 0.5) * pitch;
      let sh = 0;
      for (const s of steps) {
        let hit = false;
        for (const b of boxes) {
          // 太陽方向レイとボックスのスラブ判定
          let tmin = 0.001, tmax = Infinity, t1, t2, t;
          const lox = b.cx - b.w / 2, hix = b.cx + b.w / 2;
          const loy = b.cy - b.d / 2, hiy = b.cy + b.d / 2;
          if (Math.abs(s.dx) < 1e-9) { if (x < lox || x > hix) continue; }
          else {
            t1 = (lox - x) / s.dx; t2 = (hix - x) / s.dx;
            if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
            if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
          }
          if (Math.abs(s.dy) < 1e-9) { if (y < loy || y > hiy) continue; }
          else {
            t1 = (loy - y) / s.dy; t2 = (hiy - y) / s.dy;
            if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
            if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
          }
          t1 = (b.z0 - pz) / s.dz; t2 = (b.z0 + b.h - pz) / s.dz;
          if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
          if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
          if (tmin <= tmax && tmax > 0) { hit = true; break; }
        }
        if (hit) sh += stepH;
      }
      hours[iy * nx + ix] = sh;
      // 敷地境界からの距離（外接矩形基準）で規制帯を判定
      const ddx = Math.max(minX - x, 0, x - maxX);
      const ddy = Math.max(minY - y, 0, y - maxY);
      const dist = Math.hypot(ddx, ddy);
      if (dist > 5 && dist <= 10) { if (sh > max5) max5 = sh; }
      else if (dist > 10) { if (sh > max10) max10 = sh; }
    }
  }
  const ok = max5 <= opts.regA + 1e-6 && max10 <= opts.regB + 1e-6;
  lastHikage = { planeH: opts.planeH, regA: opts.regA, regB: opts.regB,
    max5, max10, ok, date: new Date().toLocaleDateString("ja-JP") };
  return { frame, hours, nx, ny, gx0, gy0, gx1, gy1, pitch, max5, max10, ok };
}

function createHikageLayer(zoneLayer, opts) {
  const r = hikageCompute(zoneLayer, opts);
  if (!r) {
    toast("敷地内に計画ボリューム/CADモデルがありません（建物差し替え等で配置してください）");
    return null;
  }
  const { frame, hours, nx, ny, gx0, gy0, gx1, gy1, max5, max10, ok } = r;
  const { minX, minY, maxX, maxY } = frame.bbox;
  const carto = Cesium.Cartographic.fromCartesian(frame.origin);

  // ヒートマップキャンバス（北が上になるようyを反転して描く）
  const canvas = document.createElement("canvas");
  canvas.width = nx; canvas.height = ny;
  const g = canvas.getContext("2d");
  const bandColor = (h) =>
    h >= 5 ? "rgba(107,17,17,0.66)" :
    h >= 4 ? "rgba(165,25,25,0.58)" :
    h >= 3 ? "rgba(226,58,58,0.52)" :
    h >= 2.5 ? "rgba(240,120,32,0.46)" :
    h >= 2 ? "rgba(242,190,34,0.42)" :
    h >= 1 ? "rgba(246,226,140,0.30)" : null;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = bandColor(hours[iy * nx + ix]);
      if (!c) continue;
      g.fillStyle = c;
      g.fillRect(ix, ny - 1 - iy, 1, 1);
    }
  }

  const layer = {
    id: `hikage-${++hikageCounter}`,
    dataset: {
      name: `🕛 等時間日影（${zoneLayer.zone.label} / GL+${opts.planeH}m / ${opts.regA}h・${opts.regB}h）`,
      format: "法規面", type: "法規チェック", type_en: "hikage",
    },
    kind: "hikage",
    visible: true,
    loading: false,
    entities: [],
    hikage: { ...lastHikage },
  };

  // ヒートマップを測定面高さに貼る
  const swC = Cesium.Cartographic.fromCartesian(frame.toWorld(gx0, gy0, 0));
  const neC = Cesium.Cartographic.fromCartesian(frame.toWorld(gx1, gy1, 0));
  layer.entities.push(viewer.entities.add({
    rectangle: {
      coordinates: Cesium.Rectangle.fromRadians(swC.longitude, swC.latitude, neC.longitude, neC.latitude),
      material: new Cesium.ImageMaterialProperty({ image: canvas, transparent: true }),
      height: carto.height + opts.planeH,
    },
  }));

  // 敷地境界5m/10mライン
  for (const [off, color, label] of [[5, "#4dd2ff", "5m"], [10, "#4d7dff", "10m"]]) {
    const z = opts.planeH + 0.3;
    const ring = [
      frame.toWorld(minX - off, minY - off, z), frame.toWorld(maxX + off, minY - off, z),
      frame.toWorld(maxX + off, maxY + off, z), frame.toWorld(minX - off, maxY + off, z),
      frame.toWorld(minX - off, minY - off, z),
    ];
    layer.entities.push(viewer.entities.add({
      polyline: { positions: ring, width: 2.5, material: Cesium.Color.fromCssColorString(color).withAlpha(0.9) },
    }));
    layer.entities.push(viewer.entities.add({
      position: frame.toWorld(maxX + off, (minY + maxY) / 2, z + 1),
      label: measureLabel(`境界+${label}`),
    }));
  }

  state.layers.push(layer);
  renderLayerList();
  requestRender();
  toast(ok
    ? `✅ 等時間日影: 5-10m帯 最大${max5.toFixed(1)}h ≦ ${opts.regA}h / 10m超 最大${max10.toFixed(1)}h ≦ ${opts.regB}h — 規制内（参考）`
    : `⚠ 等時間日影: 5-10m帯 最大${max5.toFixed(1)}h（規制${opts.regA}h）/ 10m超 最大${max10.toFixed(1)}h（規制${opts.regB}h）— 超過あり（参考）`, 9000);
  return layer;
}

// レイヤーパネルの等時間日影レイヤー用表示
function renderHikageLayerRows(layer, li) {
  const h = layer.hikage;
  const r1 = document.createElement("div");
  r1.className = "layer-row";
  r1.textContent = `${h.ok ? "✅" : "⚠"} 5-10m帯 最大${h.max5.toFixed(1)}h（規制${h.regA}h）/ 10m超 最大${h.max10.toFixed(1)}h（規制${h.regB}h）`;
  li.appendChild(r1);
  const note = document.createElement("div");
  note.className = "layer-row muted";
  note.textContent = "※冬至日8〜16時・10分刻み・外接矩形近似の参考判定（真北=座標北と仮定）";
  li.appendChild(note);
}

$("tenkuCloseBtn") && ($("tenkuCloseBtn").onclick = () => $("tenkuDialog").close());
