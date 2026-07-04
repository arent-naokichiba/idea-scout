/* 複数現場ダッシュボード
 *
 * 「現在の状態（レイヤー構成・カメラ・作図・工程）」を現場として保存し、
 * 現場一覧から切り替えられる。各現場カードには工程サマリー（工程数・平均進捗・
 * 本日時点の遅延数・次の工程）を表示するので、複数現場の状況を一覧で把握できる。
 *
 * 保存先はlocalStorage。BIMモデル（ファイル由来）とGeoJSONインポートは保存対象外。
 */
"use strict";

const SITES_STORAGE_KEY = "plateau-viewer-sites";

function sitesLoad() {
  try {
    return JSON.parse(localStorage.getItem(SITES_STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}
function sitesSave(sites) {
  try {
    localStorage.setItem(SITES_STORAGE_KEY, JSON.stringify(sites));
  } catch (e) {
    toast("現場の保存に失敗しました（ブラウザの保存容量を超過）");
  }
}

function siteSnapshot(name) {
  return {
    id: `site-${Math.random().toString(36).slice(2, 10)}`,
    name,
    savedAt: new Date().toISOString(),
    viewerState: serializeState(),
    construction: serializeConstruction(),
    schedule: schedSerialize(),
  };
}

$("siteSaveBtn").onclick = () => {
  const sites = sitesLoad();
  const name = window.prompt("現場名を入力してください:", schedule.project || `現場 ${sites.length + 1}`);
  if (!name) return;
  sites.push(siteSnapshot(name));
  sitesSave(sites);
  renderSites();
  toast(`現場「${name}」を保存しました`);
};

// 現場の工程サマリー（本日基準）
function siteSummary(site) {
  const tasks = site.schedule?.tasks || [];
  if (tasks.length === 0) return { text: "工程未登録", delayed: 0 };
  const avg = tasks.reduce((n, t) => n + (t.progress || 0), 0) / tasks.length;
  const delayed = tasks.filter((t) => schedTaskDelayed(t)).length;
  const now = Date.now();
  const upcoming = tasks
    .filter((t) => (schedParseDate(t.start) ?? 0) > now)
    .sort((a, b) => schedParseDate(a.start) - schedParseDate(b.start))[0];
  let text = `工程${tasks.length}件 / 平均進捗${Math.round(avg)}%`;
  if (upcoming) text += ` / 次: ${upcoming.name}（${upcoming.start}）`;
  return { text, delayed };
}

async function openSite(site) {
  toast(`現場「${site.name}」を開いています...`);
  // 現在のレイヤーをすべて撤去してから復元
  for (const layer of [...state.layers]) removeLayer(layer);
  if (typeof clearSurveyResult === "function") clearSurveyResult();
  await restoreState(site.viewerState || {}, false);
  restoreConstruction(site.construction);
  schedLoad(site.schedule || { version: 1, tasks: [] }, { announce: false });
  renderSites();
  toast(`現場「${site.name}」を開きました`);
}

function renderSites() {
  const sites = sitesLoad();
  const ul = $("siteList");
  ul.innerHTML = "";
  $("siteEmpty").classList.toggle("hidden", sites.length > 0);

  sites.forEach((site, index) => {
    const li = document.createElement("li");

    const head = document.createElement("div");
    head.className = "layer-head";
    const name = document.createElement("div");
    name.className = "layer-name";
    name.textContent = site.name;
    name.title = `保存: ${new Date(site.savedAt).toLocaleString("ja-JP")}`;
    name.style.cursor = "pointer";
    name.onclick = () => openSite(site);
    const openBtn = iconBtn("📂", "この現場を開く", () => openSite(site));
    const updateBtn = iconBtn("💾", "現在の状態でこの現場を上書き保存", () => {
      const sitesNow = sitesLoad();
      const target = sitesNow[index];
      if (!target) return;
      const snap = siteSnapshot(site.name);
      snap.id = target.id;
      sitesNow[index] = snap;
      sitesSave(sitesNow);
      renderSites();
      toast(`現場「${site.name}」を上書き保存しました`);
    });
    const delBtn = iconBtn("🗑", "削除", () => {
      if (!window.confirm(`現場「${site.name}」を削除しますか？`)) return;
      const sitesNow = sitesLoad();
      sitesNow.splice(index, 1);
      sitesSave(sitesNow);
      renderSites();
    });
    delBtn.classList.add("danger");
    head.append(name, openBtn, updateBtn, delBtn);
    li.appendChild(head);

    const summary = siteSummary(site);
    const meta = document.createElement("div");
    meta.className = "result-meta";
    meta.textContent = summary.text;
    li.appendChild(meta);
    if (summary.delayed > 0) {
      const warn = document.createElement("div");
      warn.className = "site-warn";
      warn.textContent = `⚠ 本日時点で${summary.delayed}件の工程が予定より遅延`;
      li.appendChild(warn);
    }

    ul.appendChild(li);
  });
}

renderSites();
