/* 案件管理・ボリューム比較スタディ
 *
 * 敷地検討〜法規チェックの一連の作業を「案件」として束ね、
 * 計画ボリューム構成を「案」（A案/B案…）としてスナップショット保存する。
 *  - 案件: 名称・カメラ位置・敷地条件調査結果（sitecheck.js）・案の一覧
 *  - 案: 計画ボリューム構成 + 指標（建築面積/延床/高さ/階数）
 *        + 法規チェック結果（斜線/天空率/日影 — 保存時点の判定）
 *  - 適用: 現在の計画ボリュームを案の内容に差し替えて再検討できる
 *  - 比較表: 案を横に並べ、延床最大と法規適合を強調表示
 * データはlocalStorage（プロジェクトパッケージにも含まれる）。
 */
"use strict";

const CASES_KEY = "plateau-viewer-cases";

function casesLoad() {
  try {
    return JSON.parse(localStorage.getItem(CASES_KEY)) || [];
  } catch (e) {
    return [];
  }
}
function casesSave(cases) {
  localStorage.setItem(CASES_KEY, JSON.stringify(cases));
}

// ---------- 案件の作成・削除 ----------
$("caseNewBtn").onclick = () => {
  const name = window.prompt("案件名:", "新規案件");
  if (name === null) return;
  const cases = casesLoad();
  cases.push({
    id: crypto.randomUUID(),
    name: name || "新規案件",
    createdAt: new Date().toISOString(),
    camera: getCameraState(),
    sitecheck: (typeof lastSiteCheck !== "undefined" && lastSiteCheck)
      ? { placeName: lastSiteCheck.placeName, useDistrict: lastSiteCheck.useDistrict,
          lat: lastSiteCheck.lat, lon: lastSiteCheck.lon, date: lastSiteCheck.date }
      : null,
    variants: [],
  });
  casesSave(cases);
  renderCases();
  toast(`案件「${name || "新規案件"}」を作成しました（現在の視点・敷地条件を紐付け）`);
};

// ---------- 案（ボリューム構成スナップショット） ----------
function caseSaveVariant(caseId) {
  const cases = casesLoad();
  const c = cases.find((x) => x.id === caseId);
  if (!c) return;
  const volumes = serializeConstruction().volumes;
  if (volumes.length === 0) {
    toast("計画ボリュームがありません（建物差し替え等でボリュームを配置してください）");
    return;
  }
  const defName = `案${String.fromCharCode(65 + (c.variants.length % 26))}`;
  const name = window.prompt("案の名称:", defName);
  if (name === null) return;

  const plan = docPlanContext();
  const verdicts = state.layers.filter((l) => l.kind === "kisei").flatMap((l) => l.kisei.verdicts);
  c.variants.push({
    id: crypto.randomUUID(),
    name: name || defName,
    savedAt: new Date().toISOString(),
    volumes,
    gfaNum: volumes.reduce((s, v) =>
      s + v.width * v.depth * Math.max(1, Math.floor(v.height / 3.1)), 0),
    maxH: Math.max(...volumes.map((v) => v.height)),
    plan,
    ok: {
      kisei: verdicts.length ? verdicts.every((v) => v.ok) : null,
      tenku: (typeof lastTenku !== "undefined" && lastTenku) ? lastTenku.ok : null,
      hikage: (typeof lastHikage !== "undefined" && lastHikage) ? lastHikage.ok : null,
    },
  });
  casesSave(cases);
  renderCases();
  toast(`「${name || defName}」を保存しました（ボリューム${volumes.length}件 + 法規チェック結果）`);
}

function caseApplyVariant(caseId, variantId) {
  const c = casesLoad().find((x) => x.id === caseId);
  const v = c?.variants.find((x) => x.id === variantId);
  if (!v) return;
  for (const layer of state.layers.filter((l) => l.kind === "volume")) removeLayer(layer);
  restoreConstruction({ volumes: v.volumes });
  // 斜線レイヤーがあれば適用後の構成で再判定
  for (const k of state.layers.filter((l) => l.kind === "kisei")) kiseiJudge(k);
  renderLayerList();
  requestRender();
  toast(`「${v.name}」を適用しました（ボリューム${v.volumes.length}件 / 斜線は再判定済み）`);
}

// ---------- 比較表 ----------
function caseOkIcon(v) {
  return v === true ? "✅" : v === false ? "⚠" : "—";
}

function caseCompare(caseId) {
  const c = casesLoad().find((x) => x.id === caseId);
  if (!c || c.variants.length === 0) return;
  $("caseCompareTitle").textContent = `案の比較 — ${c.name}`;
  const body = $("caseCompareBody");
  body.innerHTML = "";

  const bestGfa = Math.max(...c.variants.map((v) => v.gfaNum));
  const table = document.createElement("table");
  table.className = "survey-table case-compare";
  const addRow = (label, cells, highlights) => {
    const tr = document.createElement("tr");
    const th = document.createElement("td");
    th.textContent = label;
    th.className = "case-rowhead";
    tr.appendChild(th);
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (highlights && highlights[i]) td.className = "case-best";
      tr.appendChild(td);
    });
    table.appendChild(tr);
  };
  addRow("", c.variants.map((v) => v.name),
    c.variants.map((v) => v.ok.kisei === true && v.ok.hikage !== false && v.ok.tenku !== false));
  addRow("保存日時", c.variants.map((v) => new Date(v.savedAt).toLocaleString("ja-JP")));
  addRow("ボリューム数", c.variants.map((v) => `${v.volumes.length}件`));
  addRow("最高高さ", c.variants.map((v) => `${v.maxH.toFixed(1)} m`));
  addRow("建築面積", c.variants.map((v) => v.plan.footprint));
  addRow("延床概算", c.variants.map((v) => v.plan.gfa),
    c.variants.map((v) => v.gfaNum === bestGfa));
  addRow("階数（概算）", c.variants.map((v) => v.plan.floors));
  addRow("斜線制限", c.variants.map((v) => `${caseOkIcon(v.ok.kisei)} ${v.plan.kisei}`));
  addRow("天空率", c.variants.map((v) => `${caseOkIcon(v.ok.tenku)} ${v.plan.tenku}`));
  addRow("日影（等時間）", c.variants.map((v) => `${caseOkIcon(v.ok.hikage)} ${v.plan.hikage}`));
  body.appendChild(table);

  const note = document.createElement("div");
  note.className = "muted stats-note";
  note.textContent = "※法規チェックは各案の保存時点の簡易判定です。黄色ハイライト=延床最大・法規適合の案。案を適用して再チェックできます。";
  body.appendChild(note);
  $("caseCompareDialog").showModal();
}
$("caseCompareCloseBtn").onclick = () => $("caseCompareDialog").close();

// ---------- 一覧表示 ----------
function renderCases() {
  const cases = casesLoad();
  const list = $("caseList");
  list.innerHTML = "";
  $("caseEmpty").classList.toggle("hidden", cases.length > 0);

  for (const c of cases) {
    const li = document.createElement("li");

    const head = document.createElement("div");
    head.className = "layer-head";
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = `📁 ${c.name}`;
    const flyBtn = document.createElement("button");
    flyBtn.className = "icon-btn";
    flyBtn.textContent = "🎯";
    flyBtn.title = "案件の視点に移動";
    flyBtn.onclick = () => setCameraState(c.camera, 1.2);
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.textContent = "🗑";
    delBtn.title = "案件を削除";
    delBtn.onclick = () => {
      if (!window.confirm(`案件「${c.name}」を削除しますか？（案${c.variants.length}件も削除されます）`)) return;
      casesSave(casesLoad().filter((x) => x.id !== c.id));
      renderCases();
    };
    head.append(name, flyBtn, delBtn);
    li.appendChild(head);

    const info = document.createElement("div");
    info.className = "layer-row muted";
    info.textContent = c.sitecheck
      ? `${c.sitecheck.placeName} / ${c.sitecheck.useDistrict}（敷地条件 ${c.sitecheck.date}調査）`
      : `作成 ${new Date(c.createdAt).toLocaleDateString("ja-JP")}（敷地条件調査なし）`;
    li.appendChild(info);

    for (const v of c.variants) {
      const row = document.createElement("div");
      row.className = "layer-row";
      const label = document.createElement("span");
      label.style.flex = "1";
      label.textContent = `${v.name} — ${v.plan.gfa} / 高${v.maxH.toFixed(0)}m ${caseOkIcon(v.ok.kisei)}${caseOkIcon(v.ok.tenku)}${caseOkIcon(v.ok.hikage)}`;
      label.title = `斜線${caseOkIcon(v.ok.kisei)} / 天空率${caseOkIcon(v.ok.tenku)} / 日影${caseOkIcon(v.ok.hikage)}`;
      const applyBtn = document.createElement("button");
      applyBtn.className = "tbtn";
      applyBtn.textContent = "適用";
      applyBtn.title = "現在の計画ボリュームをこの案に差し替える";
      applyBtn.onclick = () => caseApplyVariant(c.id, v.id);
      const vDelBtn = document.createElement("button");
      vDelBtn.className = "icon-btn danger";
      vDelBtn.textContent = "🗑";
      vDelBtn.onclick = () => {
        const cases2 = casesLoad();
        const c2 = cases2.find((x) => x.id === c.id);
        c2.variants = c2.variants.filter((x) => x.id !== v.id);
        casesSave(cases2);
        renderCases();
      };
      row.append(label, applyBtn, vDelBtn);
      li.appendChild(row);
    }

    const actions = document.createElement("div");
    actions.className = "layer-row";
    const saveBtn = document.createElement("button");
    saveBtn.className = "tbtn";
    saveBtn.textContent = "＋現在の計画を案として保存";
    saveBtn.onclick = () => caseSaveVariant(c.id);
    actions.appendChild(saveBtn);
    if (c.variants.length >= 2) {
      const cmpBtn = document.createElement("button");
      cmpBtn.className = "tbtn";
      cmpBtn.textContent = "📊 比較表";
      cmpBtn.onclick = () => caseCompare(c.id);
      actions.appendChild(cmpBtn);
    }
    li.appendChild(actions);
    list.appendChild(li);
  }
}

renderCases();
