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

// 用途別の概算工事費単価（万円/m²・企画検討用の目安値）
const CASE_USAGES = [
  ["office", "事務所", 40],
  ["residence", "共同住宅", 35],
  ["retail", "商業施設", 40],
  ["hotel", "ホテル", 45],
  ["hospital", "病院・福祉", 50],
  ["school", "学校", 35],
  ["factory", "工場・倉庫", 25],
];

function caseUsageDef(c) {
  return CASE_USAGES.find((u) => u[0] === (c.usage || "office")) || CASE_USAGES[0];
}

// 概算工事費 = 延床概算 × 用途別単価
function caseCostMan(c, v) {
  return v.gfaNum * caseUsageDef(c)[2]; // 万円
}
function caseCostText(c, v) {
  const man = caseCostMan(c, v);
  return man >= 10000 ? `約 ${(man / 10000).toFixed(1)} 億円` : `約 ${Math.round(man).toLocaleString()} 万円`;
}

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

  // ワンクリック総合チェック: 斜線を再判定し、天空率・等時間日影も自動実行して
  // 比較表が常に最新の判定で埋まるようにする
  const kiseiLayers = state.layers.filter((l) => l.kind === "kisei");
  let checked = false;
  for (const k of kiseiLayers) kiseiJudge(k, true);
  if (kiseiLayers.length > 0) {
    const k0 = kiseiLayers[0];
    tenkuCompute(k0.kisei);
    const zone = state.layers.find((l) => l.id === k0.kisei.zoneId);
    if (zone) {
      const prev = (typeof lastHikage !== "undefined" && lastHikage)
        ? { planeH: lastHikage.planeH, regA: lastHikage.regA, regB: lastHikage.regB }
        : { planeH: 4, regA: 3, regB: 2 };
      hikageCompute(zone, prev);
    }
    renderLayerList();
    checked = true;
  }

  const plan = docPlanContext();
  const verdicts = kiseiLayers.flatMap((l) => l.kisei.verdicts);
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
  toast(checked
    ? `「${name || defName}」を保存しました（斜線・天空率・日影の総合チェックを自動実行）`
    : `「${name || defName}」を保存しました（斜線レイヤーがないため法規チェックは未実施）`);
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

let caseCompareCurrentId = null;

function caseCompare(caseId) {
  const c = casesLoad().find((x) => x.id === caseId);
  if (!c || c.variants.length === 0) return;
  caseCompareCurrentId = caseId;
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
  const minCost = Math.min(...c.variants.map((v) => caseCostMan(c, v)));
  addRow(`工事費概算（${caseUsageDef(c)[1]} ${caseUsageDef(c)[2]}万円/m²）`,
    c.variants.map((v) => caseCostText(c, v)),
    c.variants.map((v) => caseCostMan(c, v) === minCost));
  addRow("斜線制限", c.variants.map((v) => `${caseOkIcon(v.ok.kisei)} ${v.plan.kisei}`));
  addRow("天空率", c.variants.map((v) => `${caseOkIcon(v.ok.tenku)} ${v.plan.tenku}`));
  addRow("日影（等時間）", c.variants.map((v) => `${caseOkIcon(v.ok.hikage)} ${v.plan.hikage}`));
  body.appendChild(table);

  const note = document.createElement("div");
  note.className = "muted stats-note";
  note.textContent = "※法規チェックは各案の保存時点の簡易判定、工事費は延床×用途別単価の目安です。黄色ハイライト=延床最大・工事費最小・法規適合の案。案を適用して再チェックできます。";
  body.appendChild(note);
  $("caseCompareDialog").showModal();
}
$("caseCompareCloseBtn").onclick = () => $("caseCompareDialog").close();

// ---------- 比較検討書（帳票出力） ----------
async function caseCompareDoc(caseId) {
  const c = casesLoad().find((x) => x.id === caseId);
  if (!c || c.variants.length === 0) return null;
  const usage = caseUsageDef(c);
  const columns = [{ label: "項目", path: "item", width: "20%" }]
    .concat(c.variants.map((v, i) => ({ label: v.name, path: `v${i}` })));
  const rows = [];
  const addRow = (item, fn) => rows.push(Object.fromEntries(
    [["item", item], ...c.variants.map((v, i) => [`v${i}`, fn(v)])]));
  addRow("保存日時", (v) => new Date(v.savedAt).toLocaleString("ja-JP"));
  addRow("ボリューム数", (v) => `${v.volumes.length}件`);
  addRow("最高高さ", (v) => `${v.maxH.toFixed(1)} m`);
  addRow("建築面積", (v) => v.plan.footprint);
  addRow("延床概算", (v) => v.plan.gfa);
  addRow("階数（概算）", (v) => v.plan.floors);
  addRow(`工事費概算（${usage[1]} ${usage[2]}万円/m²）`, (v) => caseCostText(c, v));
  addRow("斜線制限", (v) => `${caseOkIcon(v.ok.kisei)} ${v.plan.kisei}`);
  addRow("天空率", (v) => `${caseOkIcon(v.ok.tenku)} ${v.plan.tenku}`);
  addRow("日影（等時間）", (v) => `${caseOkIcon(v.ok.hikage)} ${v.plan.hikage}`);

  const template = {
    id: "case-compare",
    name: "ボリューム比較検討書",
    blocks: [
      { type: "title", text: "ボリューム比較検討書", subtitle: c.name },
      { type: "meta-table", rows: [
        ["案件名", c.name],
        ["所在地", c.sitecheck?.placeName || "-"],
        ["用途地域", c.sitecheck?.useDistrict || "-"],
        ["想定用途（概算単価）", `${usage[1]}（${usage[2]}万円/m²）`],
        ["作成日", "{now}"],
      ]},
      { type: "table", title: `比較表（${c.variants.length}案）`, source: "rows", columns },
      { type: "screenshot", caption: "検討モデル（3Dビュー）" },
      { type: "text", label: "備考",
        text: "本書はPLATEAU配信データと本ツールの簡易判定（外接矩形近似・緩和規定未考慮）および用途別概算単価による参考資料です。工事費・法規適合の確定には見積・設計者による正式な検討を要します。" },
    ],
  };
  const ctx = {
    now: new Date().toLocaleDateString("ja-JP"),
    rows,
    screenshot: await captureCanvas(),
  };
  const html = ReportEngine.render(template, ctx);
  const w = ReportEngine.openPrint(html);
  if (!w) toast("ポップアップがブロックされました");
  return html;
}
$("caseCompareDocBtn").onclick = () => caseCompareDoc(caseCompareCurrentId);

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

    // 想定用途（工事費概算の単価に使用）
    const usageRow = document.createElement("div");
    usageRow.className = "layer-row";
    const usageSel = document.createElement("select");
    for (const [v, label, unit] of CASE_USAGES) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = `${label}（${unit}万円/m²）`;
      if ((c.usage || "office") === v) o.selected = true;
      usageSel.appendChild(o);
    }
    usageSel.title = "工事費概算に使う用途別単価（目安値）";
    usageSel.onchange = () => {
      const cases2 = casesLoad();
      cases2.find((x) => x.id === c.id).usage = usageSel.value;
      casesSave(cases2);
      renderCases();
    };
    usageRow.append("用途", usageSel);
    li.appendChild(usageRow);

    for (const v of c.variants) {
      const row = document.createElement("div");
      row.className = "layer-row";
      const label = document.createElement("span");
      label.style.flex = "1";
      label.textContent = `${v.name} — ${v.plan.gfa} / ${caseCostText(c, v)} / 高${v.maxH.toFixed(0)}m ${caseOkIcon(v.ok.kisei)}${caseOkIcon(v.ok.tenku)}${caseOkIcon(v.ok.hikage)}`;
      label.title = `斜線${caseOkIcon(v.ok.kisei)} / 天空率${caseOkIcon(v.ok.tenku)} / 日影${caseOkIcon(v.ok.hikage)} / 工事費は${caseUsageDef(c)[1]}単価の目安`;
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
