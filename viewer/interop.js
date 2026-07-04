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
  const volumes = state.layers.filter((l) => l.kind === "volume");
  const records = (typeof recState !== "undefined") ? recState.records : [];

  let anchor = null;
  if (zones.length) anchor = zones[0].zone.points[0];
  else if (volumes.length) anchor = Cesium.Cartesian3.fromDegrees(volumes[0].volume.lon, volumes[0].volume.lat, volumes[0].volume.baseH);
  else if (vehicles.length) anchor = vehicles[0].vehicle.points[0];
  else if (cranes.length) anchor = cranes[0].crane.position;
  else if (records.length) anchor = Cesium.Cartesian3.fromDegrees(records[0].lon, records[0].lat, records[0].height);
  if (!anchor) {
    toast("書き出す作図要素がありません（ヤード・車両パス・クレーン・計画ボリューム・記録）");
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
    ["PLAN_BUILDING", 5], ["DIM", 3], ["SYMBOL", 7],
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
  const text = (layerName, x, y, height, value, angleDeg) => {
    w(0, "TEXT"); w(8, layerName);
    w(10, x.toFixed(3)); w(20, y.toFixed(3)); w(30, 0);
    w(40, height); w(1, dxfEscape(value));
    if (angleDeg) w(50, angleDeg.toFixed(2));
  };
  const line = (layerName, x1, y1, x2, y2) => {
    w(0, "LINE"); w(8, layerName);
    w(10, x1.toFixed(3)); w(20, y1.toFixed(3)); w(30, 0);
    w(11, x2.toFixed(3)); w(21, y2.toFixed(3)); w(31, 0);
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
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (pts) => {
    for (const [x, y] of pts) {
      bbox.minX = Math.min(bbox.minX, x); bbox.maxX = Math.max(bbox.maxX, x);
      bbox.minY = Math.min(bbox.minY, y); bbox.maxY = Math.max(bbox.maxY, y);
    }
  };

  for (const l of zones) {
    const pts = l.zone.points.map(toLocal);
    grow(pts);
    const layerName = `YARD_${(l.zone.type || "material").toUpperCase()}`;
    polyline(layerName, pts, true);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    text("TEXT", cx, cy, 1.2, l.zone.label);
    // 配置図用: 各辺の寸法（辺の中点に長さを注記）
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 0.5) continue;
      let ang = Cesium.Math.toDegrees(Math.atan2(y2 - y1, x2 - x1));
      if (ang > 90 || ang < -90) ang += 180; // 文字が逆さにならない向き
      // 辺の外側法線方向に少しオフセット（重心と反対側）
      const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const outward = ((mx - cx) * nx + (my - cy) * ny) >= 0 ? 1 : -1;
      text("DIM", mx + nx * outward * 1.2, my + ny * outward * 1.2, 0.9, `${len.toFixed(2)}m`, ang);
    }
    count++;
  }
  // 配置図用: 計画ボリューム（差替建物）の外形矩形 + 高さ注記
  for (const l of volumes) {
    const v = l.volume;
    const [cx, cy] = toLocal(Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.baseH));
    const rect = [
      [cx - v.width / 2, cy - v.depth / 2], [cx + v.width / 2, cy - v.depth / 2],
      [cx + v.width / 2, cy + v.depth / 2], [cx - v.width / 2, cy + v.depth / 2],
    ];
    grow(rect);
    polyline("PLAN_BUILDING", rect, true);
    text("PLAN_BUILDING", cx, cy, 1.4, l.dataset.name.replace(/^⬜\s*/, ""));
    text("DIM", cx, cy - 2.2, 0.9, `${v.width.toFixed(1)}×${v.depth.toFixed(1)}m H=${v.height.toFixed(1)}m`);
    count++;
  }
  for (const l of vehicles) {
    const pts = l.vehicle.points.map(toLocal);
    grow(pts);
    polyline("VEHICLE_PATH", pts, false);
    const [x, y] = pts[0];
    text("TEXT", x, y, 1.2, l.dataset.name.replace(/^🚚\s*/, ""));
    count++;
  }
  for (const l of cranes) {
    const [x, y] = toLocal(l.crane.position);
    const r = craneWorkRadius(l.crane);
    grow([[x - r, y - r], [x + r, y + r]]);
    circle("CRANE", x, y, r);
    point("CRANE", x, y);
    text("TEXT", x + 1, y + 1, 1.2,
      `${l.dataset.name.replace(/^🏗\s*/, "")} R=${r.toFixed(1)}m`);
    count++;
  }
  for (const r of records) {
    const [x, y] = toLocal(Cesium.Cartesian3.fromDegrees(r.lon, r.lat, r.height));
    grow([[x, y]]);
    point("RECORD", x, y);
    text("RECORD", x + 0.5, y + 0.5, 1.0, r.title || "(無題)");
    count++;
  }

  // 配置図用: 方位記号（図面右上、真北=+Y方向）
  if (Number.isFinite(bbox.maxX)) {
    const ax = bbox.maxX + 5, ay = bbox.maxY + 2, len = 5;
    line("SYMBOL", ax, ay, ax, ay + len);                       // 軸
    polyline("SYMBOL", [[ax - 0.9, ay + len - 1.8], [ax, ay + len], [ax + 0.9, ay + len - 1.8]], true); // 矢頭
    circle("SYMBOL", ax, ay + len / 2 - 0.2, len / 2 + 1.4);
    text("SYMBOL", ax - 0.6, ay + len + 1.0, 1.6, "N");
  }

  w(0, "ENDSEC");
  w(0, "EOF");

  const dxf = lines.join("\r\n") + "\r\n";
  downloadFile(dxf, `plateau-sekou-${exportTimestamp()}.dxf`, "application/dxf");
  toast(`${count}要素をDXFで書き出しました（寸法・方位付き配置図 / 基準点ローカル座標・単位m）`);
  return dxf;
}

$("dxfBtn").onclick = () => exportDxf();

// ============================================================
// BCF 2.1 書き出し（現場記録 → Revit/Navisworks/Solibri等のBIMツール）
// ============================================================
function xmlEsc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

const BCF_TYPE = { memo: "Comment", issue: "Issue", inspect: "Request", safety: "Issue" };
const BCF_STATUS = { open: "Active", doing: "InProgress", done: "Closed" };

async function exportBcf() {
  const records = recState.records;
  if (records.length === 0) {
    toast("書き出す記録がありません（📌 記録で作成してください）");
    return null;
  }
  const files = [{
    name: "bcf.version",
    data: `<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>`,
  }];

  // 視点座標は最初の記録を原点としたローカル[m]（X=東, Y=北, Z=上）
  const origin = Cesium.Cartesian3.fromDegrees(records[0].lon, records[0].lat, records[0].height);
  const inv = Cesium.Matrix4.inverse(
    Cesium.Transforms.eastNorthUpToFixedFrame(origin), new Cesium.Matrix4());

  for (const r of records) {
    const guid = crypto.randomUUID();
    const vpGuid = crypto.randomUUID();
    const p = Cesium.Matrix4.multiplyByPoint(inv,
      Cesium.Cartesian3.fromDegrees(r.lon, r.lat, r.height), new Cesium.Cartesian3());
    const photo = r.photos[0];
    const snapExt = photo && photo.blob.type.includes("png") ? "png" : "jpg";

    let markup = `<?xml version="1.0" encoding="UTF-8"?>\n<Markup>\n`;
    markup += `  <Topic Guid="${guid}" TopicType="${BCF_TYPE[r.type] || "Issue"}" TopicStatus="${BCF_STATUS[r.status] || "Active"}">\n`;
    markup += `    <Title>${xmlEsc(r.title || "(無題)")}</Title>\n`;
    markup += `    <CreationDate>${r.createdAt}</CreationDate>\n`;
    markup += `    <CreationAuthor>PLATEAU Viewer</CreationAuthor>\n`;
    if (r.note) markup += `    <Description>${xmlEsc(r.note)}</Description>\n`;
    markup += `  </Topic>\n`;
    if (r.note) {
      markup += `  <Comment Guid="${crypto.randomUUID()}">\n`;
      markup += `    <Date>${r.updatedAt}</Date>\n    <Author>PLATEAU Viewer</Author>\n`;
      markup += `    <Comment>${xmlEsc(r.note)}</Comment>\n  </Comment>\n`;
    }
    markup += `  <Viewpoints Guid="${vpGuid}">\n    <Viewpoint>viewpoint.bcfv</Viewpoint>\n`;
    if (photo) markup += `    <Snapshot>snapshot.${snapExt}</Snapshot>\n`;
    markup += `  </Viewpoints>\n</Markup>\n`;
    files.push({ name: `${guid}/markup.bcf`, data: markup });

    const viewpoint = `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${vpGuid}">
  <PerspectiveCamera>
    <CameraViewPoint><X>${p.x.toFixed(3)}</X><Y>${(p.y - 12).toFixed(3)}</Y><Z>${(p.z + 12).toFixed(3)}</Z></CameraViewPoint>
    <CameraDirection><X>0</X><Y>0.707</Y><Z>-0.707</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>0.707</Y><Z>0.707</Z></CameraUpVector>
    <FieldOfView>60</FieldOfView>
  </PerspectiveCamera>
</VisualizationInfo>\n`;
    files.push({ name: `${guid}/viewpoint.bcfv`, data: viewpoint });
    if (photo) files.push({ name: `${guid}/snapshot.${snapExt}`, data: photo.blob });
  }

  const blob = await MiniZip.create(files);
  downloadFile(blob, `plateau-issues-${exportTimestamp()}.bcf`, "application/octet-stream");
  toast(`${records.length}件の記録をBCF 2.1で書き出しました（BIMツールの指摘管理に読み込めます）`);
  return blob;
}
$("bcfBtn").onclick = () => exportBcf();

// ============================================================
// プロジェクトパッケージ（一式の書き出し / 読み込み）
// ============================================================
async function exportPackage() {
  toast("プロジェクト一式を書き出しています...");
  const files = [
    { name: "manifest.json", data: JSON.stringify({ app: "plateau-viewer", format: 1, exportedAt: new Date().toISOString() }, null, 1) },
    { name: "state.json", data: JSON.stringify(serializeState(), null, 1) },
    { name: "construction.json", data: JSON.stringify(serializeConstruction(), null, 1) },
    { name: "schedule.json", data: JSON.stringify(schedSerialize(), null, 1) },
    { name: "sites.json", data: JSON.stringify(sitesLoad(), null, 1) },
    { name: "templates.json", data: JSON.stringify(docUserTemplates(), null, 1) },
    { name: "bookmarks.json", data: localStorage.getItem(BOOKMARK_KEY) || "[]" },
  ];
  const recMeta = [];
  for (const r of recState.records) {
    const meta = { ...r, photos: [], audios: [], videos: [] };
    for (const [kind, arr] of [["photos", r.photos], ["audios", r.audios], ["videos", r.videos]]) {
      for (const m of arr) {
        const ext = ((m.blob.type.split("/")[1] || "bin").split(";")[0]) || "bin";
        const path = `media/${r.id}/${m.id}.${ext}`;
        files.push({ name: path, data: m.blob });
        meta[kind].push({ id: m.id, name: m.name, ts: m.ts, path, mime: m.blob.type });
      }
    }
    recMeta.push(meta);
  }
  files.push({ name: "records.json", data: JSON.stringify(recMeta, null, 1) });
  const blob = await MiniZip.create(files);
  downloadFile(blob, `plateau-project-${exportTimestamp()}.zip`, "application/zip");
  toast(`プロジェクト一式を書き出しました（記録${recMeta.length}件・${(blob.size / 1024 / 1024).toFixed(1)}MB）`);
  return blob;
}
$("pkgExportBtn").onclick = () => exportPackage();

async function importPackage(file) {
  let entries;
  try {
    entries = MiniZip.read(await file.arrayBuffer());
  } catch (e) {
    toast("読み込めません: " + e.message);
    return;
  }
  const decoder = new TextDecoder();
  const json = (n) => (entries.has(n) ? JSON.parse(decoder.decode(entries.get(n))) : null);
  const manifest = json("manifest.json");
  if (!manifest || manifest.app !== "plateau-viewer") {
    toast("PLATEAU Viewerのプロジェクトパッケージではありません");
    return;
  }
  toast("プロジェクトを読み込んでいます...");

  // 現在のレイヤー・記録ピンを撤去
  for (const layer of [...state.layers]) removeLayer(layer);
  for (const [, pin] of recState.pins) viewer.entities.remove(pin);
  recState.pins.clear();

  // localStorage系（現場・テンプレ・ブックマーク）
  const sites = json("sites.json");
  if (sites) localStorage.setItem(SITES_STORAGE_KEY, JSON.stringify(sites));
  const templates = json("templates.json");
  if (templates) localStorage.setItem(DOC_TEMPLATES_KEY, JSON.stringify(templates));
  if (entries.has("bookmarks.json")) {
    localStorage.setItem(BOOKMARK_KEY, decoder.decode(entries.get("bookmarks.json")));
  }
  renderSites();
  renderBookmarks();

  // 記録（メディア復元 → IndexedDBへ）
  const recMeta = json("records.json") || [];
  const oldIds = recState.records.map((r) => r.id);
  for (const id of oldIds) await recordsDelete(id);
  recState.records = [];
  for (const meta of recMeta) {
    const record = { ...meta, photos: [], audios: [], videos: [] };
    for (const kind of ["photos", "audios", "videos"]) {
      for (const m of meta[kind] || []) {
        const bytes = entries.get(m.path);
        if (!bytes) continue;
        record[kind].push({ id: m.id, name: m.name, ts: m.ts, blob: new Blob([bytes], { type: m.mime }) });
      }
    }
    recState.records.push(record);
    await recordsPut(record);
    recordRenderPin(record);
  }
  renderRecordList();

  // レイヤー・作図・工程をライブ適用
  const viewerState = json("state.json");
  if (viewerState) await restoreState(viewerState, false);
  restoreConstruction(json("construction.json"));
  schedLoad(json("schedule.json") || { version: 1, tasks: [] }, { announce: false });

  toast(`プロジェクトを読み込みました（記録${recMeta.length}件）`);
}
$("pkgImportBtn").onclick = () => $("pkgFile").click();
$("pkgFile").onchange = (e) => {
  if (e.target.files[0]) importPackage(e.target.files[0]);
  e.target.value = "";
};

// ============================================================
// 工程CSVインポート（Excel・他社工程管理からの取り込み / Shift-JIS対応）
// ============================================================
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += c;
    } else if (c === '"') inQuote = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

function csvFindCol(header, keywords) {
  return header.findIndex((h) => keywords.some((k) => String(h).includes(k)));
}

function csvNormalizeDate(s) {
  const t = Date.parse(String(s).trim().replace(/\./g, "/"));
  return Number.isFinite(t) ? schedFormat(t) : null;
}

async function importScheduleCsv(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buf);
  if (text.includes("�")) text = new TextDecoder("shift-jis").decode(buf); // Excel既定のSJIS
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = parseCsv(text);
  if (rows.length < 2) {
    toast("CSVにデータ行がありません");
    return;
  }
  const header = rows[0];
  const nameCol = csvFindCol(header, ["名称", "工程", "タスク", "作業", "name"]);
  const startCol = csvFindCol(header, ["開始", "着手", "start"]);
  const endCol = csvFindCol(header, ["終了", "完了", "end", "finish"]);
  const progCol = csvFindCol(header, ["進捗", "出来高", "progress", "%"]);
  if (nameCol < 0 || startCol < 0 || endCol < 0) {
    toast("ヘッダーに 名称/開始/終了 に相当する列が見つかりません");
    return;
  }
  let added = 0;
  for (const row of rows.slice(1)) {
    const start = csvNormalizeDate(row[startCol]);
    const end = csvNormalizeDate(row[endCol]);
    if (!row[nameCol] || !start || !end) continue;
    schedule.tasks.push({
      id: `csv-${Date.now().toString(36)}-${added}`,
      name: String(row[nameCol]).trim(),
      start, end,
      progress: progCol >= 0 ? Math.min(100, Math.max(0, parseFloat(row[progCol]) || 0)) : 0,
      layers: [],
    });
    added++;
  }
  schedMutated();
  schedSetDate(schedule.current);
  toast(`CSVから${added}件の工程を取り込みました`);
}
$("schedCsvBtn").onclick = () => $("schedCsvFile").click();
$("schedCsvFile").onchange = (e) => {
  if (e.target.files[0]) importScheduleCsv(e.target.files[0]);
  e.target.value = "";
};
