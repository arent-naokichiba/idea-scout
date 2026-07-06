/* 現場記録モジュール（野帳・指摘管理・写真・電子黒板・音声・動画）
 *
 * 3Dマップの任意の位置にピンを打ち、記録（野帳メモ・指摘・検査）を残す。
 * - 種別（メモ/指摘/検査/安全）とステータス（未対応/対応中/完了）で指摘管理
 * - 現場写真の添付（スマホではカメラ直接起動）、電子黒板の自動合成、
 *   ペンによるマークアップ描画
 * - ボイスメモ録音（MediaRecorder）とムービーコメント添付
 * - 保存先はIndexedDB（写真・音声・動画のBlobも含めてブラウザ内に永続化）
 */
"use strict";

// ---------- IndexedDB ----------
const RECORDS_DB = "plateau-viewer-db";
const RECORDS_STORE = "records";

function recordsDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RECORDS_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(RECORDS_STORE)) {
        req.result.createObjectStore(RECORDS_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function recordsPut(record) {
  const db = await recordsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDS_STORE, "readwrite");
    tx.objectStore(RECORDS_STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function recordsDelete(id) {
  const db = await recordsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDS_STORE, "readwrite");
    tx.objectStore(RECORDS_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function recordsAll() {
  const db = await recordsDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(RECORDS_STORE, "readonly").objectStore(RECORDS_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ---------- 状態 ----------
const REC_TYPES = [
  ["memo", "📝 メモ", "#4da3ff"],
  ["issue", "⚠ 指摘・是正", "#e05656"],
  ["inspect", "✅ 検査", "#5fd08a"],
  ["safety", "🦺 安全", "#f2d13e"],
];
const REC_STATUS = [["open", "未対応"], ["doing", "対応中"], ["done", "完了"]];
const REC_STATUS_COLOR = { open: "#e05656", doing: "#f2d13e", done: "#5fd08a" };

const recState = {
  arming: false,
  records: [],       // メモリ上のキャッシュ（IndexedDBと同期）
  pins: new Map(),   // id -> entity
  editing: null,     // 編集中のrecord
  recorder: null,    // 音声録音中のMediaRecorder
  mediaUrls: [],     // ダイアログで生成したObjectURL（クローズ時に解放）
};

$("recordBtn").onclick = () => {
  recState.arming = !recState.arming;
  $("recordBtn").classList.toggle("active", recState.arming);
  if (recState.arming) {
    closeDrawer();
    showHint("記録を残す地点をクリックしてください（Escで中止）");
  } else {
    hideHint();
  }
};

function recordAddAt(windowPos) {
  const pos = pickPosition(windowPos);
  if (!Cesium.defined(pos)) return;
  recState.arming = false;
  $("recordBtn").classList.remove("active");
  hideHint();
  const carto = Cesium.Cartographic.fromCartesian(pos);
  const record = {
    id: `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
    height: carto.height,
    title: "",
    note: "",
    type: "memo",
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    photos: [],  // {id, name, blob, ts}
    audios: [],  // {id, blob, ts}
    videos: [],  // {id, name, blob, ts}
  };
  recState.records.push(record);
  recordSave(record);
  recordRenderPin(record);
  openRecordDialog(record);
  renderRecordList();
}

async function recordSave(record) {
  record.updatedAt = new Date().toISOString();
  try {
    await recordsPut(record);
  } catch (e) {
    console.error(e);
    toast("記録の保存に失敗しました（ブラウザの保存容量を確認してください）");
  }
}

// ---------- マップ上のピン ----------
function recordRenderPin(record) {
  const old = recState.pins.get(record.id);
  if (old) viewer.entities.remove(old);
  const typeDef = REC_TYPES.find((t) => t[0] === record.type) || REC_TYPES[0];
  const entity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, record.height + 1.5),
    point: {
      pixelSize: 11,
      color: Cesium.Color.fromCssColorString(REC_STATUS_COLOR[record.status] || "#4da3ff"),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: `${typeDef[1].split(" ")[0]} ${record.title || "(無題)"}`,
      font: "12px sans-serif",
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString("#14181e").withAlpha(0.8),
      pixelOffset: new Cesium.Cartesian2(0, -20),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  entity.plateauRecordId = record.id;
  recState.pins.set(record.id, entity);
  requestRender();
}

function recordHandlePick(picked) {
  const id = picked?.id?.plateauRecordId;
  if (!id) return false;
  const record = recState.records.find((r) => r.id === id);
  if (record) openRecordDialog(record);
  return true;
}

// ---------- 記録ダイアログ ----------
function recMediaUrl(blob) {
  const url = URL.createObjectURL(blob);
  recState.mediaUrls.push(url);
  return url;
}

function openRecordDialog(record) {
  recState.editing = record;
  const body = $("recordBody");
  body.innerHTML = "";
  $("recordTitleHead").textContent = record.title || "現場記録";

  // 基本情報（野帳）
  const titleIn = document.createElement("input");
  titleIn.type = "text";
  titleIn.placeholder = "タイトル（例: 3F梁の配筋確認）";
  titleIn.value = record.title;
  titleIn.className = "rec-title";
  titleIn.onchange = () => {
    record.title = titleIn.value;
    recordSave(record);
    recordRenderPin(record);
    renderRecordList();
  };

  const row = document.createElement("div");
  row.className = "rec-row";
  const typeSel = document.createElement("select");
  for (const [v, label] of REC_TYPES) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (record.type === v) o.selected = true;
    typeSel.appendChild(o);
  }
  typeSel.onchange = () => { record.type = typeSel.value; recordSave(record); recordRenderPin(record); renderRecordList(); };
  const statusSel = document.createElement("select");
  for (const [v, label] of REC_STATUS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (record.status === v) o.selected = true;
    statusSel.appendChild(o);
  }
  statusSel.onchange = () => { record.status = statusSel.value; recordSave(record); recordRenderPin(record); renderRecordList(); };
  const flyBtn = document.createElement("button");
  flyBtn.className = "tbtn";
  flyBtn.textContent = "🎯 位置へ";
  flyBtn.onclick = () => viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(record.lon, record.lat - 0.001, record.height + 80),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 1.2,
  });
  row.append(typeSel, statusSel, flyBtn);

  const noteIn = document.createElement("textarea");
  noteIn.placeholder = "野帳メモ（状況・指示内容・寸法など）";
  noteIn.value = record.note;
  noteIn.className = "rec-note";
  noteIn.onchange = () => { record.note = noteIn.value; recordSave(record); };

  body.append(titleIn, row, noteIn);

  // 写真
  body.appendChild(recSectionHeading("📷 現場写真", [
    recBtn("写真を追加", () => $("recPhotoFile").click()),
  ]));
  const photoBox = document.createElement("div");
  photoBox.className = "rec-photos";
  for (const photo of record.photos) {
    photoBox.appendChild(recPhotoCard(record, photo));
  }
  if (record.photos.length === 0) photoBox.appendChild(recEmpty("写真はありません（スマホではカメラが起動します）"));
  body.appendChild(photoBox);

  // 音声
  const recAudioBtn = recBtn(recState.recorder ? "⏹ 録音停止" : "🎙 ボイスメモ録音", () => toggleVoiceRecording(record));
  recAudioBtn.id = "recVoiceToggle";
  body.appendChild(recSectionHeading("🎙 ボイスメモ", [recAudioBtn]));
  const audioBox = document.createElement("div");
  audioBox.className = "rec-media";
  for (const a of record.audios) {
    const item = document.createElement("div");
    item.className = "rec-mediaItem";
    const player = document.createElement("audio");
    player.controls = true;
    player.src = recMediaUrl(a.blob);
    item.append(player, recDelBtn(() => {
      record.audios = record.audios.filter((x) => x.id !== a.id);
      recordSave(record);
      openRecordDialog(record);
    }));
    audioBox.appendChild(item);
  }
  if (record.audios.length === 0) audioBox.appendChild(recEmpty("ボイスメモはありません"));
  body.appendChild(audioBox);

  // 動画
  body.appendChild(recSectionHeading("🎬 ムービーコメント", [
    recBtn("動画を追加", () => $("recVideoFile").click()),
  ]));
  const videoBox = document.createElement("div");
  videoBox.className = "rec-media";
  for (const v of record.videos) {
    const item = document.createElement("div");
    item.className = "rec-mediaItem";
    const player = document.createElement("video");
    player.controls = true;
    player.className = "rec-video";
    player.src = recMediaUrl(v.blob);
    item.append(player, recDelBtn(() => {
      record.videos = record.videos.filter((x) => x.id !== v.id);
      recordSave(record);
      openRecordDialog(record);
    }));
    videoBox.appendChild(item);
  }
  if (record.videos.length === 0) videoBox.appendChild(recEmpty("動画はありません（スマホではビデオ撮影が起動します）"));
  body.appendChild(videoBox);

  // フッター
  const foot = document.createElement("div");
  foot.className = "rec-row";
  const meta = document.createElement("span");
  meta.className = "muted";
  meta.textContent = `作成 ${new Date(record.createdAt).toLocaleString("ja-JP")}`;
  const delRec = document.createElement("button");
  delRec.className = "tbtn";
  delRec.textContent = "🗑 記録を削除";
  delRec.onclick = async () => {
    if (!window.confirm("この記録を削除しますか？")) return;
    await recordsDelete(record.id);
    recState.records = recState.records.filter((r) => r.id !== record.id);
    const pin = recState.pins.get(record.id);
    if (pin) viewer.entities.remove(pin);
    recState.pins.delete(record.id);
    closeRecordDialog();
    renderRecordList();
    requestRender();
  };
  foot.append(meta, delRec);
  body.appendChild(foot);

  $("recordDialog").showModal();
}

function closeRecordDialog() {
  stopVoiceRecording(false);
  $("recordDialog").close();
  for (const url of recState.mediaUrls) URL.revokeObjectURL(url);
  recState.mediaUrls = [];
  recState.editing = null;
}
$("recordCloseBtn").onclick = closeRecordDialog;

function recSectionHeading(title, buttons) {
  const h = document.createElement("div");
  h.className = "rec-heading";
  const span = document.createElement("span");
  span.textContent = title;
  h.appendChild(span);
  for (const b of buttons) h.appendChild(b);
  return h;
}
function recBtn(text, onclick) {
  const b = document.createElement("button");
  b.className = "tbtn";
  b.textContent = text;
  b.onclick = onclick;
  return b;
}
function recDelBtn(onclick) {
  const b = document.createElement("button");
  b.className = "icon-btn danger";
  b.textContent = "🗑";
  b.onclick = onclick;
  return b;
}
function recEmpty(text) {
  const d = document.createElement("div");
  d.className = "muted";
  d.textContent = text;
  return d;
}

// ---------- 写真（添付・電子黒板・マークアップ） ----------
$("recPhotoFile").onchange = (e) => {
  const record = recState.editing;
  if (!record) return;
  for (const file of e.target.files) {
    record.photos.push({
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      name: file.name,
      blob: file,
      ts: new Date().toISOString(),
    });
  }
  recordSave(record);
  openRecordDialog(record);
  e.target.value = "";
};

$("recVideoFile").onchange = (e) => {
  const record = recState.editing;
  if (!record) return;
  for (const file of e.target.files) {
    record.videos.push({
      id: `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      name: file.name,
      blob: file,
      ts: new Date().toISOString(),
    });
  }
  recordSave(record);
  openRecordDialog(record);
  e.target.value = "";
};

function recPhotoCard(record, photo) {
  const card = document.createElement("div");
  card.className = "rec-photo";
  const img = document.createElement("img");
  img.src = recMediaUrl(photo.blob);
  img.alt = photo.name;
  card.appendChild(img);
  const bar = document.createElement("div");
  bar.className = "rec-photoBar";
  bar.append(
    recBtn("黒板", () => composeBlackboard(record, photo)),
    recBtn("描込", () => openMarkup(record, photo)),
    recBtn("保存", () => downloadFile(photo.blob, photo.name || "photo.jpg", photo.blob.type || "image/jpeg")),
    recDelBtn(() => {
      record.photos = record.photos.filter((p) => p.id !== photo.id);
      recordSave(record);
      openRecordDialog(record);
    }),
  );
  card.appendChild(bar);
  return card;
}

// 電子黒板を写真の左下に合成した新しい写真を追加する
async function composeBlackboard(record, photo) {
  const 工事名 = window.prompt("工事名:", schedule.project || "") ?? "";
  const 工種 = window.prompt("工種・部位:", record.title || "") ?? "";
  const 備考 = window.prompt("備考:", "") ?? "";

  const bitmap = await createImageBitmap(photo.blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  // 黒板（左下・写真幅の約38%）
  const bw = Math.max(280, canvas.width * 0.38);
  const lineH = bw / 9;
  const bh = lineH * 5;
  const bx = canvas.width * 0.02;
  const by = canvas.height - bh - canvas.height * 0.02;
  ctx.fillStyle = "#1d5c3d";
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, bw / 200);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.font = `${lineH * 0.52}px sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  const lines = [
    ["工事名", 工事名],
    ["工種", 工種],
    ["撮影日", new Date().toLocaleDateString("ja-JP")],
    ["位置", `${record.lat.toFixed(5)}, ${record.lon.toFixed(5)}`],
    ["備考", 備考],
  ];
  lines.forEach(([key, value], i) => {
    const y = by + lineH * (i + 0.5);
    ctx.fillText(`${key}：${value}`, bx + bw * 0.04, y, bw * 0.92);
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(bx, by + lineH * i);
      ctx.lineTo(bx + bw, by + lineH * i);
      ctx.stroke();
    }
  });

  canvas.toBlob((blob) => {
    record.photos.push({
      id: `p-${Date.now().toString(36)}-bb`,
      name: `黒板_${photo.name || "photo"}.jpg`,
      blob,
      ts: new Date().toISOString(),
    });
    recordSave(record);
    openRecordDialog(record);
    toast("電子黒板を合成した写真を追加しました");
  }, "image/jpeg", 0.92);
}

// ---------- 写真マークアップ（ペン描画） ----------
const markupState = { record: null, photo: null, drawing: false, history: [] };

async function openMarkup(record, photo) {
  markupState.record = record;
  markupState.photo = photo;
  markupState.history = [];
  const bitmap = await createImageBitmap(photo.blob);
  const canvas = $("markupCanvas");
  // 大きすぎる写真は縮小（描画性能と保存サイズのため）
  const scale = Math.min(1, 1600 / bitmap.width, 1200 / bitmap.height);
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  markupState.history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  $("markupDialog").showModal();
}

(() => {
  const canvas = $("markupCanvas");
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  };
  canvas.addEventListener("pointerdown", (e) => {
    markupState.drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = $("markupColor").value;
    ctx.lineWidth = parseInt($("markupWidth").value, 10);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(...pos(e));
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!markupState.drawing) return;
    const ctx = canvas.getContext("2d");
    ctx.lineTo(...pos(e));
    ctx.stroke();
  });
  canvas.addEventListener("pointerup", () => {
    if (!markupState.drawing) return;
    markupState.drawing = false;
    const ctx = canvas.getContext("2d");
    markupState.history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (markupState.history.length > 20) markupState.history.shift();
  });
})();

$("markupUndoBtn").onclick = () => {
  if (markupState.history.length < 2) return;
  markupState.history.pop();
  const canvas = $("markupCanvas");
  canvas.getContext("2d").putImageData(markupState.history[markupState.history.length - 1], 0, 0);
};
$("markupCancelBtn").onclick = () => $("markupDialog").close();
$("markupSaveBtn").onclick = () => {
  const { record, photo } = markupState;
  $("markupCanvas").toBlob((blob) => {
    record.photos.push({
      id: `p-${Date.now().toString(36)}-mk`,
      name: `描込_${photo.name || "photo"}.jpg`,
      blob,
      ts: new Date().toISOString(),
    });
    recordSave(record);
    $("markupDialog").close();
    openRecordDialog(record);
    toast("マークアップした写真を追加しました");
  }, "image/jpeg", 0.92);
};

// ---------- ボイスメモ ----------
async function toggleVoiceRecording(record) {
  if (recState.recorder) {
    stopVoiceRecording(true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      if (chunks.length && recState.voiceSave) {
        record.audios.push({
          id: `a-${Date.now().toString(36)}`,
          blob: new Blob(chunks, { type: mime || "audio/webm" }),
          ts: new Date().toISOString(),
        });
        recordSave(record);
        if (recState.editing === record) openRecordDialog(record);
        toast("ボイスメモを保存しました");
      }
    };
    recState.recorder = recorder;
    recState.voiceSave = true;
    recorder.start();
    const btn = $("recVoiceToggle");
    if (btn) {
      btn.textContent = "⏹ 録音停止";
      btn.classList.add("active");
    }
    toast("録音中...（もう一度押すと停止・保存）");
  } catch (e) {
    toast("マイクを利用できません: " + e.message);
  }
}

function stopVoiceRecording(save) {
  if (!recState.recorder) return;
  recState.voiceSave = save;
  try { recState.recorder.stop(); } catch (e) { /* 既に停止 */ }
  recState.recorder = null;
}

// ---------- 記録一覧タブ ----------
function renderRecordList() {
  const ul = $("recordList");
  if (!ul) return;
  ul.innerHTML = "";
  const filter = $("recordFilter").value;
  const records = recState.records
    .filter((r) => filter === "all" || r.status === filter)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  $("recordEmpty").classList.toggle("hidden", records.length > 0);

  for (const record of records) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "layer-head";
    const typeDef = REC_TYPES.find((t) => t[0] === record.type) || REC_TYPES[0];
    const name = document.createElement("div");
    name.className = "layer-name";
    name.textContent = `${typeDef[1].split(" ")[0]} ${record.title || "(無題)"}`;
    name.style.cursor = "pointer";
    name.onclick = () => openRecordDialog(record);
    const status = document.createElement("span");
    status.className = "chip";
    status.textContent = REC_STATUS.find((s) => s[0] === record.status)?.[1] || record.status;
    status.style.background = REC_STATUS_COLOR[record.status];
    status.style.color = "#14181e";
    head.append(name, status);
    li.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "result-meta";
    const counts = [];
    if (record.photos.length) counts.push(`📷${record.photos.length}`);
    if (record.audios.length) counts.push(`🎙${record.audios.length}`);
    if (record.videos.length) counts.push(`🎬${record.videos.length}`);
    meta.textContent = `${new Date(record.updatedAt).toLocaleString("ja-JP")} ${counts.join(" ")}`;
    li.appendChild(meta);
    ul.appendChild(li);
  }
}

$("recordFilter").onchange = renderRecordList;

$("recordCsvBtn").onclick = () => {
  if (recState.records.length === 0) return;
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ["種別,ステータス,タイトル,メモ,緯度,経度,作成日時,写真数,音声数,動画数"];
  for (const r of recState.records) {
    const typeDef = REC_TYPES.find((t) => t[0] === r.type);
    lines.push([
      typeDef ? typeDef[1] : r.type,
      REC_STATUS.find((s) => s[0] === r.status)?.[1] || r.status,
      esc(r.title), esc(r.note), r.lat.toFixed(6), r.lon.toFixed(6),
      r.createdAt, r.photos.length, r.audios.length, r.videos.length,
    ].join(","));
  }
  downloadFile("\ufeff" + lines.join("\n"), `plateau-records-${exportTimestamp()}.csv`, "text/csv;charset=utf-8");
  toast(`${recState.records.length}件の記録をCSVで保存しました`);
};

// ---------- 起動時: IndexedDBから復元 ----------
(async () => {
  try {
    recState.records = await recordsAll();
    for (const record of recState.records) recordRenderPin(record);
    renderRecordList();
  } catch (e) {
    console.warn("記録の復元に失敗:", e);
  }
})();
