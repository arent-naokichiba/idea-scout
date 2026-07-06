/* 工程管理モジュール
 *
 * 単体で使える組み込み工程管理。工程（タスク）にビューアのレイヤーを紐づけると、
 * 日付カーソル・再生に連動してその時点の現場配置（ヤード・クレーン・車両パス・
 * BIMモデル等）が再現される。
 *
 * 外部の工程管理システムとの連携インターフェース:
 *  1. JSONスキーマでのインポート/エクスポート（下記 SCHEDULE_SCHEMA_VERSION）
 *  2. ローカルサーバREST: GET/POST /api/schedule（CORS開放・外部からプッシュ可）
 *  3. iframe埋め込み用 postMessage API:
 *       { type: "plateau:setSchedule", schedule } … 工程データを差し替え
 *       { type: "plateau:setDate", date: "2026-07-01" } … 日付カーソルを移動
 *       { type: "plateau:getSchedule" } … 現在の工程データを返信
 *       { type: "plateau:play" } … 再生開始
 *
 * スキーマ:
 *   { "version": 1, "project": "現場名",
 *     "tasks": [{ "id": "t1", "name": "仮設工事", "start": "2026-07-01",
 *                 "end": "2026-07-20", "progress": 40, "layers": ["zone-1"] }] }
 */
"use strict";

const SCHEDULE_SCHEMA_VERSION = 1;
const SCHEDULE_STORAGE_KEY = "plateau-viewer-schedule";

const schedule = {
  project: "",
  tasks: [],
  current: Date.now(),
  playing: null,
  autoSyncTimer: null,
  linkEditTaskId: null,
};
let scheduleTaskCounter = 0;

// ---------- 日付ユーティリティ ----------
function schedParseDate(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function schedFormat(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function schedRange() {
  let min = Infinity, max = -Infinity;
  for (const t of schedule.tasks) {
    const s = schedParseDate(t.start), e = schedParseDate(t.end);
    if (s !== null) min = Math.min(min, s);
    if (e !== null) max = Math.max(max, e);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    min = Date.now();
    max = min + 30 * 86400000;
  }
  return [min, max + 86399000]; // 終了日の終わりまで
}
function schedTaskActive(task, ms) {
  const s = schedParseDate(task.start), e = schedParseDate(task.end);
  if (s === null || e === null) return false;
  return ms >= s && ms <= e + 86399000;
}

// 日付基準の予定出来高率（予実比較用）
function schedPlannedPct(task, ms) {
  const s = schedParseDate(task.start), e = schedParseDate(task.end);
  if (s === null || e === null) return 0;
  const endMs = e + 86399000;
  if (ms <= s) return 0;
  if (ms >= endMs) return 100;
  return ((ms - s) / (endMs - s)) * 100;
}

// 実績が予定より5ポイント以上遅れていれば遅延とみなす
function schedTaskDelayed(task, ms = Date.now()) {
  const planned = schedPlannedPct(task, ms);
  return planned > 0 && planned - (task.progress || 0) > 5;
}

// ---------- レイヤー連動 ----------
function schedSetLayerVisible(layer, visible) {
  if (layer.visible === visible) return;
  layer.visible = visible;
  if (layer.tileset) layer.tileset.show = visible;
  if (layer.imageryLayer) layer.imageryLayer.show = visible;
  if (layer.dataSource) layer.dataSource.show = visible;
  if (layer.entity) layer.entity.show = visible;
  if (layer.entities) for (const e of layer.entities) e.show = visible;
}

function schedApplyVisibility() {
  // 何らかの工程にリンクされたレイヤーは「アクティブな工程があるときだけ表示」
  const linked = new Map();
  for (const task of schedule.tasks) {
    const active = schedTaskActive(task, schedule.current);
    for (const id of task.layers || []) {
      linked.set(id, (linked.get(id) || false) || active);
    }
  }
  let changed = false;
  for (const layer of state.layers) {
    if (linked.has(layer.id)) {
      if (layer.visible !== linked.get(layer.id)) changed = true;
      schedSetLayerVisible(layer, linked.get(layer.id));
    }
  }
  schedApplyProgress();
  if (changed) {
    renderLayerList();
    requestRender();
  }
}

// ---------- 出来高表示（BIMモデルを日付進捗に応じて下から立ち上げる） ----------
function schedApplyProgress() {
  for (const layer of state.layers) {
    if (layer.kind !== "model" || !layer.entity) continue;
    const tasks = schedule.tasks.filter((t) => (t.layers || []).includes(layer.id));
    if (tasks.length === 0) {
      if (layer.model.clipped) {
        layer.entity.model.clippingPlanes = undefined;
        layer.model.clipped = false;
      }
      continue;
    }
    // 紐づく工程の期間内での経過割合を出来高率とする（複数工程なら最大値）
    let frac = 0;
    for (const t of tasks) {
      const s = schedParseDate(t.start);
      const e = schedParseDate(t.end);
      if (s === null || e === null) continue;
      const endMs = e + 86399000;
      if (schedule.current >= endMs) frac = Math.max(frac, 1);
      else if (schedule.current > s) frac = Math.max(frac, (schedule.current - s) / (endMs - s));
    }
    schedSetModelProgress(layer, frac);
  }
  requestRender();
}

function schedSetModelProgress(layer, frac) {
  if (frac >= 1) {
    if (layer.model.clipped) {
      layer.entity.model.clippingPlanes = undefined;
      layer.model.clipped = false;
    }
    return;
  }
  // モデル座標系（Z-up・スケール前）での切断高さ
  const buildHeight = layer.model.buildHeight || 30;
  const clipHeight = Math.max(0.3, frac * buildHeight) / (layer.model.scale || 1);
  layer.entity.model.clippingPlanes = new Cesium.ClippingPlaneCollection({
    planes: [new Cesium.ClippingPlane(new Cesium.Cartesian3(0, 0, -1), clipHeight)],
  });
  layer.model.clipped = true;
}

// ---------- 状態変更 ----------
function schedSetDate(ms, fromSlider = false) {
  const [min, max] = schedRange();
  schedule.current = Math.min(max, Math.max(min, ms));
  $("schedDate").textContent = schedFormat(schedule.current);
  if (!fromSlider) {
    $("schedSlider").value = Math.round(((schedule.current - min) / (max - min)) * 1000);
  }
  schedApplyVisibility();
  schedRenderTasks(); // バーのアクティブ状態を更新
}

function schedMutated(save = true) {
  if (save) schedSaveLocal();
  schedRenderTasks();
  schedApplyVisibility();
}

function schedSerialize() {
  return {
    version: SCHEDULE_SCHEMA_VERSION,
    project: schedule.project,
    tasks: schedule.tasks.map((t) => ({
      id: t.id, name: t.name, start: t.start, end: t.end,
      progress: t.progress || 0, layers: t.layers || [],
    })),
  };
}

function schedLoad(data, { announce = true } = {}) {
  if (!data || !Array.isArray(data.tasks)) {
    if (announce) toast("工程データの形式が不正です（tasks配列が必要）");
    return false;
  }
  schedule.project = data.project || "";
  schedule.tasks = data.tasks.map((t, i) => ({
    id: t.id || `t${++scheduleTaskCounter}`,
    name: t.name || `工程 ${i + 1}`,
    start: t.start || schedFormat(Date.now()),
    end: t.end || schedFormat(Date.now() + 7 * 86400000),
    progress: Number(t.progress) || 0,
    layers: Array.isArray(t.layers) ? t.layers : [],
  }));
  const [min] = schedRange();
  schedSetDate(Math.max(min, Math.min(Date.now(), schedRange()[1])));
  schedMutated();
  if (announce) toast(`工程を読み込みました（${schedule.tasks.length}件）`);
  return true;
}

function schedSaveLocal() {
  try {
    localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(schedSerialize()));
  } catch (e) { /* 容量超過等は無視 */ }
}

// ---------- タスクUI ----------
function schedRenderTasks() {
  const box = $("schedTasks");
  box.innerHTML = "";
  const [min, max] = schedRange();
  const span = max - min;

  if (schedule.tasks.length === 0) {
    const p = document.createElement("div");
    p.className = "muted center";
    p.textContent = "「＋ 工程」で工程を追加するか、「連携」から外部データを読み込んでください。";
    box.appendChild(p);
    return;
  }

  for (const task of schedule.tasks) {
    const row = document.createElement("div");
    row.className = "sched-row";

    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.className = "sched-name";
    nameIn.value = task.name;
    nameIn.onchange = () => { task.name = nameIn.value; schedMutated(); };

    const startIn = document.createElement("input");
    startIn.type = "date";
    startIn.className = "sched-dateIn";
    startIn.value = task.start;
    startIn.onchange = () => { task.start = startIn.value; schedMutated(); schedSetDate(schedule.current); };

    const endIn = document.createElement("input");
    endIn.type = "date";
    endIn.className = "sched-dateIn";
    endIn.value = task.end;
    endIn.onchange = () => { task.end = endIn.value; schedMutated(); schedSetDate(schedule.current); };

    const progIn = document.createElement("input");
    progIn.type = "number";
    progIn.className = "sched-prog";
    progIn.min = "0";
    progIn.max = "100";
    progIn.value = task.progress || 0;
    progIn.title = "進捗率(%)";
    progIn.onchange = () => { task.progress = Math.min(100, Math.max(0, parseInt(progIn.value, 10) || 0)); schedMutated(); };

    // 予実比較（今日時点の予定出来高に対する遅れを警告）
    const delayBadge = document.createElement("span");
    delayBadge.className = "sched-delay";
    if (schedTaskDelayed(task)) {
      delayBadge.textContent = `⚠予定${Math.round(schedPlannedPct(task, Date.now()))}%`;
      delayBadge.title = `本日時点の予定出来高${Math.round(schedPlannedPct(task, Date.now()))}%に対し実績${task.progress || 0}%（遅延）`;
    } else if ((task.progress || 0) >= 100) {
      delayBadge.textContent = "✅";
      delayBadge.className = "sched-delay ok";
    }

    // ガントバー
    const bar = document.createElement("div");
    bar.className = "sched-bar";
    const s = schedParseDate(task.start), e = schedParseDate(task.end);
    if (s !== null && e !== null && e >= s) {
      const seg = document.createElement("div");
      const active = schedTaskActive(task, schedule.current);
      seg.className = "sched-seg" + (active ? " active" : "") + ((task.progress || 0) >= 100 ? " done" : "");
      seg.style.left = `${((s - min) / span) * 100}%`;
      seg.style.width = `${Math.max(0.5, ((e + 86399000 - s) / span) * 100)}%`;
      const prog = document.createElement("div");
      prog.className = "sched-segProg";
      prog.style.width = `${task.progress || 0}%`;
      seg.appendChild(prog);
      bar.appendChild(seg);
      // 日付カーソル
      const cursor = document.createElement("div");
      cursor.className = "sched-cursor";
      cursor.style.left = `${((schedule.current - min) / span) * 100}%`;
      bar.appendChild(cursor);
    }

    const linkBtn = document.createElement("button");
    linkBtn.className = "tbtn";
    const linkCount = (task.layers || []).length;
    linkBtn.textContent = `🔗${linkCount > 0 ? linkCount : ""}`;
    linkBtn.title = "この工程に表示レイヤーを紐づける";
    linkBtn.onclick = () => {
      schedule.linkEditTaskId = schedule.linkEditTaskId === task.id ? null : task.id;
      schedRenderTasks();
    };

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.textContent = "🗑";
    delBtn.onclick = () => {
      schedule.tasks = schedule.tasks.filter((t) => t !== task);
      schedMutated();
      schedSetDate(schedule.current);
    };

    row.append(nameIn, startIn, endIn, progIn, delayBadge, bar, linkBtn, delBtn);
    box.appendChild(row);

    // レイヤーリンク編集
    if (schedule.linkEditTaskId === task.id) {
      const linkBox = document.createElement("div");
      linkBox.className = "sched-links";
      if (state.layers.length === 0) {
        linkBox.textContent = "リンク可能なレイヤーがありません（マップにレイヤーを追加してください）";
      } else {
        for (const layer of state.layers) {
          const label = document.createElement("label");
          label.className = "chk";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = (task.layers || []).includes(layer.id);
          cb.onchange = () => {
            task.layers = task.layers || [];
            if (cb.checked) task.layers.push(layer.id);
            else task.layers = task.layers.filter((id) => id !== layer.id);
            schedMutated();
          };
          label.append(cb, ` ${layer.dataset.name}`);
          linkBox.appendChild(label);
        }
      }
      box.appendChild(linkBox);
    }
  }
}

// ---------- パネル操作 ----------
$("scheduleBtn").onclick = () => {
  const panel = $("schedulePanel");
  const show = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !show);
  $("scheduleBtn").classList.toggle("active", show);
  if (show) schedSetDate(schedule.current);
};
$("schedCloseBtn").onclick = () => {
  $("schedulePanel").classList.add("hidden");
  $("scheduleBtn").classList.remove("active");
};

$("schedAddBtn").onclick = () => {
  const start = schedule.tasks.length > 0 ? schedule.current : Date.now();
  schedule.tasks.push({
    id: `t${++scheduleTaskCounter}-${Math.random().toString(36).slice(2, 6)}`,
    name: `工程 ${schedule.tasks.length + 1}`,
    start: schedFormat(start),
    end: schedFormat(start + 7 * 86400000),
    progress: 0,
    layers: [],
  });
  schedMutated();
  schedSetDate(schedule.current);
};

$("schedSlider").oninput = (e) => {
  const [min, max] = schedRange();
  schedSetDate(min + (parseInt(e.target.value, 10) / 1000) * (max - min), true);
  $("schedDate").textContent = schedFormat(schedule.current);
};

$("schedTodayBtn").onclick = () => schedSetDate(Date.now());

function schedStopPlayback() {
  if (schedule.playing) clearInterval(schedule.playing);
  schedule.playing = null;
  $("schedPlayBtn").textContent = "▶ 再生";
}

function schedStartPlayback(onDone) {
  schedStopPlayback();
  const [min, max] = schedRange();
  if (schedule.current >= max - 1000) schedSetDate(min);
  $("schedPlayBtn").textContent = "⏸ 停止";
  schedule.playing = setInterval(() => {
    const step = (max - min) / 240; // 約12秒で全期間
    if (schedule.current + step >= max) {
      schedSetDate(max);
      schedStopPlayback();
      if (onDone) onDone();
    } else {
      schedSetDate(schedule.current + step);
    }
  }, 50);
}

$("schedPlayBtn").onclick = () => {
  if (schedule.playing) schedStopPlayback();
  else schedStartPlayback();
};

// ---------- 4D再生の動画書き出し（WebM） ----------
$("schedVideoBtn").onclick = () => {
  if (schedule.recording) return;
  if (schedule.tasks.length === 0) {
    toast("工程がありません。工程を追加してから録画してください");
    return;
  }
  const canvas = viewer.canvas;
  if (typeof MediaRecorder === "undefined" || !canvas.captureStream) {
    toast("このブラウザは動画書き出しに未対応です");
    return;
  }
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) {
    toast("WebM録画に未対応のブラウザです");
    return;
  }

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  const prevRenderMode = viewer.scene.requestRenderMode;
  recorder.onstop = () => {
    viewer.scene.requestRenderMode = prevRenderMode;
    for (const track of stream.getTracks()) track.stop();
    schedule.recording = false;
    $("schedVideoBtn").classList.remove("active");
    const blob = new Blob(chunks, { type: "video/webm" });
    downloadFile(blob, `plateau-4d-${exportTimestamp()}.webm`, "video/webm");
    toast(`4D動画を保存しました（${(blob.size / 1024 / 1024).toFixed(1)} MB）`);
  };

  schedule.recording = true;
  $("schedVideoBtn").classList.add("active");
  viewer.scene.requestRenderMode = false; // 録画中は連続レンダリングで滑らかに
  toast("4D再生を録画しています...（再生終了で自動保存）");
  recorder.start(250);
  schedSetDate(schedRange()[0]);
  schedStartPlayback(() => {
    setTimeout(() => recorder.stop(), 500); // 最終フレームを確実に収録
  });
};

// ---------- HTMLレポート用の工程表セクション（app.jsのbuildReportHtmlから参照） ----------
function schedReportSection() {
  if (schedule.tasks.length === 0) return "";
  const [min, max] = schedRange();
  const span = max - min;
  const cursorLeft = ((schedule.current - min) / span) * 100;
  const rows = schedule.tasks.map((t) => {
    const s = schedParseDate(t.start);
    const e = (schedParseDate(t.end) ?? s ?? min) + 86399000;
    const left = s !== null ? ((s - min) / span) * 100 : 0;
    const width = s !== null ? Math.max(0.5, ((e - s) / span) * 100) : 0;
    const active = schedTaskActive(t, schedule.current);
    const color = active ? "#3c78c8" : (t.progress || 0) >= 100 ? "#3f7d5a" : "#9aa6b4";
    return `<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.start)}</td><td>${escapeHtml(t.end)}</td>
      <td>${t.progress || 0}%</td>
      <td style="width:42%"><div style="position:relative;height:14px;background:#eef1f4;border-radius:4px;">
        <div style="position:absolute;left:${left}%;width:${width}%;top:2px;bottom:2px;background:${color};border-radius:3px;"></div>
        <div style="position:absolute;left:${cursorLeft}%;top:0;bottom:0;width:2px;background:#e0a03d;"></div>
      </div></td></tr>`;
  }).join("");
  return `
  <h2>工程表${schedule.project ? " — " + escapeHtml(schedule.project) : ""}</h2>
  <p>表示日付: ${schedFormat(schedule.current)}（ガント上のオレンジ線）</p>
  <table><thead><tr><th>工程</th><th>開始</th><th>終了</th><th>進捗</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table>`;
}

// ---------- 入出力・外部連携 ----------
$("schedExportBtn").onclick = () => {
  downloadFile(JSON.stringify(schedSerialize(), null, 2),
    `plateau-schedule-${exportTimestamp()}.json`, "application/json");
  toast("工程データをJSONで保存しました");
};

$("schedImportBtn").onclick = () => $("schedFile").click();
$("schedFile").onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      schedLoad(JSON.parse(reader.result));
    } catch (err) {
      toast("JSONとして解釈できません: " + file.name);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
};

$("schedSyncBtn").onclick = () => $("schedSync").classList.toggle("hidden");

$("schedServerLoadBtn").onclick = async () => {
  try {
    const data = await api("schedule");
    schedLoad(data);
  } catch (e) {
    toast("サーバから工程を取得できません（plateau_viewer.py起動時のみ利用可）");
  }
};

$("schedServerSaveBtn").onclick = async () => {
  try {
    const resp = await fetch("api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(schedSerialize()),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    toast("サーバに保存しました（外部システムから GET /api/schedule で参照可）");
  } catch (e) {
    toast("サーバに保存できません（plateau_viewer.py起動時のみ利用可）");
  }
};

async function schedFetchUrl() {
  const url = $("schedUrlIn").value.trim();
  if (!url) return;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(String(resp.status));
    schedLoad(await resp.json());
  } catch (e) {
    toast("外部URLから取得できません: " + e.message);
  }
}
$("schedUrlBtn").onclick = schedFetchUrl;
$("schedAutoSync").onchange = (e) => {
  clearInterval(schedule.autoSyncTimer);
  schedule.autoSyncTimer = null;
  if (e.target.checked) {
    schedule.autoSyncTimer = setInterval(schedFetchUrl, 60000);
    toast("60秒ごとに外部URLから工程を自動更新します");
  }
};

// iframe埋め込み・外部システム向け postMessage API
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || typeof d !== "object" || typeof d.type !== "string" || !d.type.startsWith("plateau:")) return;
  switch (d.type) {
    case "plateau:setSchedule":
      if (schedLoad(d.schedule)) {
        $("schedulePanel").classList.remove("hidden");
        $("scheduleBtn").classList.add("active");
      }
      break;
    case "plateau:setDate": {
      const ms = schedParseDate(d.date);
      if (ms !== null) {
        $("schedulePanel").classList.remove("hidden");
        $("scheduleBtn").classList.add("active");
        schedSetDate(ms);
      }
      break;
    }
    case "plateau:getSchedule":
      if (ev.source && ev.source.postMessage) {
        ev.source.postMessage({ type: "plateau:schedule", schedule: schedSerialize() }, "*");
      }
      break;
    case "plateau:play":
      if (!schedule.playing) $("schedPlayBtn").click();
      break;
  }
});

// ---------- 起動時: localStorageから復元 ----------
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(SCHEDULE_STORAGE_KEY));
    if (saved && Array.isArray(saved.tasks) && saved.tasks.length > 0) {
      schedLoad(saved, { announce: false });
      return;
    }
  } catch (e) { /* 破損時は初期状態 */ }
  schedSetDate(Date.now());
})();
