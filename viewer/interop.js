/* 外部連携（CAD等とのインポート/エクスポート）
 *
 * 第一弾: DXF書き出し（AutoCAD / Jw_cad / BricsCAD等で開けるR12形式）
 * 作図したヤード・車両パス・クレーン・記録ピンを、基準点原点のローカル座標[m]で
 * レイヤー分けして出力する。仮設計画図をCADに引き継ぐための出口。
 */
"use strict";

function dxfEscape(s) {
  // 非ASCII文字はAutoCAD標準の \\U+XXXX ユニコードエスケープで出力する
  // （DXF R12はUTF-8非対応のため。AutoCAD/ezdxf等が正しく日本語表示できる）
  return String(s ?? "").replace(/[\r\n]/g, " ").replace(/[\u0080-\uffff]/g,
    (c) => `\\U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

function exportDxf() {
  // 基準点: 最初に見つかった作図要素の位置（ヘッダにコメントとして緯度経度を記録）
  const zones = state.layers.filter((l) => l.kind === "zone");
  const vehicles = state.layers.filter((l) => l.kind === "vehicle");
  const cranes = state.layers.filter((l) => l.kind === "crane");
  const records = (typeof recState !== "undefined") ? recState.records : [];

  let anchor = null;
  if (zones.length) anchor = zones[0].zone.points[0];
  else if (vehicles.length) anchor = vehicles[0].vehicle.points[0];
  else if (cranes.length) anchor = cranes[0].crane.position;
  else if (records.length) anchor = Cesium.Cartesian3.fromDegrees(records[0].lon, records[0].lat, records[0].height);
  if (!anchor) {
    toast("書き出す作図要素がありません（ヤード・車両パス・クレーン・記録）");
    return null;
  }

  const inv = Cesium.Matrix4.inverse(
    Cesium.Transforms.eastNorthUpToFixedFrame(anchor), new Cesium.Matrix4());
  const toLocal = (cart) => {
    const p = Cesium.Matrix4.multiplyByPoint(inv, cart, new Cesium.Cartesian3());
    return [p.x, p.y];
  };
  const anchorCarto = Cesium.Cartographic.fromCartesian(anchor);

  const lines = [];
  const w = (code, value) => { lines.push(String(code)); lines.push(String(value)); };

  // ---- HEADER ----
  w(999, `PLATEAU Viewer DXF export / origin: lat=${Cesium.Math.toDegrees(anchorCarto.latitude).toFixed(8)} lon=${Cesium.Math.toDegrees(anchorCarto.longitude).toFixed(8)} (local meters, X=East, Y=North)`);
  w(0, "SECTION"); w(2, "HEADER");
  w(9, "$ACADVER"); w(1, "AC1009");
  w(9, "$INSUNITS"); w(70, 6); // meters
  w(0, "ENDSEC");

  // ---- TABLES (レイヤー定義) ----
  const layerDefs = [
    ["YARD_MATERIAL", 2], ["YARD_OFFICE", 5], ["YARD_PARKING", 3], ["YARD_GATE", 30],
    ["YARD_DANGER", 1], ["YARD_FENCE", 8], ["VEHICLE_PATH", 4], ["CRANE", 6], ["RECORD", 7], ["TEXT", 7],
  ];
  w(0, "SECTION"); w(2, "TABLES");
  w(0, "TABLE"); w(2, "LAYER"); w(70, layerDefs.length);
  for (const [name, color] of layerDefs) {
    w(0, "LAYER"); w(2, name); w(70, 0); w(62, color); w(6, "CONTINUOUS");
  }
  w(0, "ENDTAB"); w(0, "ENDSEC");

  // ---- ENTITIES ----
  w(0, "SECTION"); w(2, "ENTITIES");

  const polyline = (layerName, pts, closed) => {
    w(0, "POLYLINE"); w(8, layerName); w(66, 1); w(70, closed ? 1 : 0);
    for (const [x, y] of pts) {
      w(0, "VERTEX"); w(8, layerName);
      w(10, x.toFixed(3)); w(20, y.toFixed(3)); w(30, 0);
    }
    w(0, "SEQEND");
  };
  const text = (layerName, x, y, height, value) => {
    w(0, "TEXT"); w(8, layerName);
    w(10, x.toFixed(3)); w(20, y.toFixed(3)); w(30, 0);
    w(40, height); w(1, dxfEscape(value));
  };
  const circle = (layerName, x, y, r) => {
    w(0, "CIRCLE"); w(8, layerName);
    w(10, x.toFixed(3)); w(20, y.toFixed(3)); w(30, 0); w(40, r.toFixed(3));
  };
  const point = (layerName, x, y) => {
    w(0, "POINT"); w(8, layerName);
    w(10, x.toFixed(3)); w(20, y.toFixed(3)); w(30, 0);
  };

  let count = 0;
  for (const l of zones) {
    const pts = l.zone.points.map(toLocal);
    const layerName = `YARD_${(l.zone.type || "material").toUpperCase()}`;
    polyline(layerName, pts, true);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    text("TEXT", cx, cy, 1.2, l.zone.label);
    count++;
  }
  for (const l of vehicles) {
    polyline("VEHICLE_PATH", l.vehicle.points.map(toLocal), false);
    const [x, y] = toLocal(l.vehicle.points[0]);
    text("TEXT", x, y, 1.2, l.dataset.name.replace(/^🚚\s*/, ""));
    count++;
  }
  for (const l of cranes) {
    const [x, y] = toLocal(l.crane.position);
    circle("CRANE", x, y, craneWorkRadius(l.crane));
    point("CRANE", x, y);
    text("TEXT", x + 1, y + 1, 1.2,
      `${l.dataset.name.replace(/^🏗\s*/, "")} R=${craneWorkRadius(l.crane).toFixed(1)}m`);
    count++;
  }
  for (const r of records) {
    const [x, y] = toLocal(Cesium.Cartesian3.fromDegrees(r.lon, r.lat, r.height));
    point("RECORD", x, y);
    text("RECORD", x + 0.5, y + 0.5, 1.0, r.title || "(無題)");
    count++;
  }

  w(0, "ENDSEC");
  w(0, "EOF");

  const dxf = lines.join("\r\n") + "\r\n";
  downloadFile(dxf, `plateau-sekou-${exportTimestamp()}.dxf`, "application/dxf");
  toast(`${count}要素をDXFで書き出しました（基準点のローカル座標・単位m）`);
  return dxf;
}

$("dxfBtn").onclick = () => exportDxf();
