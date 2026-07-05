/* 帳票・連携ハブ
 *
 * ReportEngine（汎用帳票エンジン）を使った帳票の生成UI。
 * - 標準テンプレート: 是正指示書 / 工事週報 / 近隣調査台帳
 * - カスタムテンプレート: JSONを編集してlocalStorageに保存（任意レイアウト・任意テーブル）
 * - 出力: 印刷ウィンドウ（ブラウザの「PDFとして保存」）/ HTMLファイル
 * - 連携エクスポート: DXF（interop.js）
 */
"use strict";

const DOC_TEMPLATES_KEY = "plateau-viewer-doc-templates";

// ---------- 標準テンプレート ----------
const DOC_BUILTIN_TEMPLATES = [
  {
    id: "correction",
    requires: "record",
    name: "是正指示書",
    blocks: [
      { type: "title", text: "是 正 指 示 書" },
      { type: "meta-table", rows: [
        ["工事名", "{project}"], ["件名", "{record.title}"],
        ["種別", "{record.typeLabel}"], ["状態", "{record.statusLabel}"],
        ["位置", "北緯 {record.latText} / 東経 {record.lonText}"], ["発行日", "{now}"],
      ]},
      { type: "text", label: "指示・記録内容", text: "{record.note}" },
      { type: "images", title: "現場写真", source: "record.photoItems", columns: 2, caption: true },
      { type: "meta-table", title: "是正確認欄（手書き用）", rows: [
        ["是正予定日", ""], ["是正完了日", ""], ["是正内容", ""], ["確認者 / 確認日", ""],
      ]},
    ],
  },
  {
    id: "weekly",
    requires: null,
    name: "工事週報",
    blocks: [
      { type: "title", text: "工 事 週 報", subtitle: "{project}" },
      { type: "meta-table", rows: [
        ["工事名", "{project}"], ["作成日", "{now}"], ["表示日付", "{cursorDate}"],
      ]},
      { type: "screenshot", caption: "現況（3Dビュー）" },
      { type: "gantt", title: "工程表", source: "schedule" },
      { type: "table", title: "工程一覧", source: "schedule", columns: [
        { label: "工程", path: "name", width: "26%" },
        { label: "開始", path: "start", width: "15%", align: "center" },
        { label: "終了", path: "end", width: "15%", align: "center" },
        { label: "進捗", path: "progress", width: "10%", align: "right", format: "percent" },
        { label: "状況", path: "statusText", align: "center" },
      ]},
      { type: "table", title: "現場記録（直近）", source: "records", columns: [
        { label: "種別", path: "typeLabel", width: "14%" },
        { label: "件名", path: "title", width: "34%" },
        { label: "状態", path: "statusLabel", width: "12%", align: "center" },
        { label: "メモ", path: "note" },
      ]},
    ],
  },
  {
    id: "survey",
    requires: "survey",
    name: "近隣調査台帳",
    blocks: [
      { type: "title", text: "近 隣 調 査 台 帳", subtitle: "{project}" },
      { type: "meta-table", rows: [["工事名", "{project}"], ["作成日", "{now}"], ["対象建物数", "{surveyCount}"]] },
      { type: "table", title: "調査対象一覧（距離順）", source: "survey", columns: [
        { label: "No", path: "no", width: "7%", align: "right" },
        { label: "距離(m)", path: "dist", width: "11%", align: "right" },
        { label: "用途", path: "usage", width: "22%" },
        { label: "階数", path: "storeys", width: "9%", align: "right" },
        { label: "高さ(m)", path: "height", width: "11%", align: "right" },
        { label: "建物ID", path: "gmlId" },
      ]},
      { type: "text", label: "備考", text: "" },
    ],
  },
  {
    id: "gaiyou",
    requires: null,
    name: "建築計画概要書（参考）",
    blocks: [
      { type: "title", text: "建 築 計 画 概 要 書", subtitle: "（本ツールによる参考資料）" },
      { type: "meta-table", title: "第一面（申請者等）", rows: [
        ["建築主", ""], ["代理者（設計者）", ""], ["工事施工者", ""],
        ["工事名", "{project}"], ["作成日", "{now}"],
      ]},
      { type: "meta-table", title: "第二面（敷地）", rows: [
        ["敷地の所在地", "{sitecheck.placeName}"],
        ["座標", "北緯 {sitecheck.lat} / 東経 {sitecheck.lon}"],
        ["用途地域", "{sitecheck.useDistrict}"],
        ["防火地域等", "{sitecheck.fire}"],
        ["敷地面積", "{sitecheck.calcSiteArea}"],
        ["最大建築面積", "{sitecheck.calcFootprint}"],
        ["最大延床面積", "{sitecheck.calcGfa}"],
      ]},
      { type: "meta-table", title: "第三面（建築物の概要）", rows: [
        ["主要用途", ""], ["構造", ""],
        ["建築面積", "{plan.footprint}"],
        ["延べ面積（概算）", "{plan.gfa}"],
        ["高さ", "{plan.height}"],
        ["階数（概算）", "{plan.floors}"],
      ]},
      { type: "meta-table", title: "法規チェック（本ツール参考判定）", rows: [
        ["斜線制限", "{plan.kisei}"],
        ["天空率（簡易比較）", "{plan.tenku}"],
        ["日影（冬至・等時間）", "{plan.hikage}"],
      ]},
      { type: "screenshot", caption: "配置図（現況3Dビュー）" },
      { type: "text", label: "備考",
        text: "本書はPLATEAU配信データと本ツールの簡易判定（外接矩形近似・緩和規定未考慮）による参考資料であり、確認申請の添付書類ではありません。申請にあたっては設計者による正式な法規検討と行政窓口での確認を要します。" },
    ],
  },
];

function docUserTemplates() {
  try {
    return JSON.parse(localStorage.getItem(DOC_TEMPLATES_KEY)) || [];
  } catch (e) {
    return [];
  }
}
function docAllTemplates() {
  return [...DOC_BUILTIN_TEMPLATES, ...docUserTemplates()];
}

// ---------- データコンテキスト ----------
function docRecordContext(record) {
  const typeDef = REC_TYPES.find((t) => t[0] === record.type);
  return {
    ...record,
    typeLabel: typeDef ? typeDef[1] : record.type,
    statusLabel: REC_STATUS.find((s) => s[0] === record.status)?.[1] || record.status,
    latText: record.lat.toFixed(6),
    lonText: record.lon.toFixed(6),
    photoItems: record.photos.map((p) => ({
      src: URL.createObjectURL(p.blob),
      caption: `${p.name || "写真"}（${new Date(p.ts).toLocaleString("ja-JP")}）`,
    })),
  };
}

async function buildDocContext(recordId) {
  const screenshot = await captureCanvas();
  const record = recState.records.find((r) => r.id === recordId);
  return {
    now: new Date().toLocaleDateString("ja-JP"),
    project: schedule.project || "（工事名未設定）",
    cursorDate: schedFormat(schedule.current),
    screenshot,
    schedule: schedule.tasks.map((t) => ({
      ...t,
      delayed: schedTaskDelayed(t),
      statusText: (t.progress || 0) >= 100 ? "完了" : schedTaskDelayed(t) ? "遅延" : "順調",
    })),
    records: recState.records.map((r) => docRecordContext(r)),
    record: record ? docRecordContext(record) : null,
    survey: (lastSurveyRows || []).map((r, i) => ({
      no: i + 1,
      dist: r["_距離m"],
      usage: r["bldg:usage"] ?? r["用途"] ?? "-",
      storeys: r["bldg:storeysAboveGround"] ?? r["地上階数"] ?? "-",
      height: typeof (r["bldg:measuredHeight"] ?? r["計測高さ"]) === "number"
        ? (r["bldg:measuredHeight"] ?? r["計測高さ"]).toFixed(1) : "-",
      gmlId: r["gml_id"] || "-",
    })),
    surveyCount: (lastSurveyRows || []).length,
    layers: state.layers.map((l) => l.dataset.name),
    // 敷地条件調査（sitecheck.js実行後に利用可能）
    sitecheck: (typeof lastSiteCheck !== "undefined" && lastSiteCheck) ? {
      ...lastSiteCheck,
      fire: lastSiteCheck.rows.find((r) => r.item.includes("防火"))?.value || "-",
      calcSiteArea: lastSiteCheck.calc ? `${lastSiteCheck.calc.siteArea.toLocaleString()} m²` : "-",
      calcFootprint: lastSiteCheck.calc ? `${lastSiteCheck.calc.maxFootprint.toLocaleString()} m²（建蔽率 ${lastSiteCheck.calc.coverage}%）` : "-",
      calcGfa: lastSiteCheck.calc ? `${lastSiteCheck.calc.maxGfa.toLocaleString()} m²（容積率 ${lastSiteCheck.calc.far}%）` : "-",
      calcFloors: lastSiteCheck.calc ? `約 ${lastSiteCheck.calc.refFloors} 階（容積率÷建蔽率）` : "-",
    } : null,
    // 計画建物と法規チェック結果（建築計画概要書用）
    plan: docPlanContext(),
  };
}

// 計画ボリューム/CADモデルと法規チェック（kisei.js）の結果を帳票向け文字列に整形
function docPlanContext() {
  const vols = state.layers.filter((l) => l.kind === "volume");
  const model = state.layers.find((l) => l.kind === "model");
  let footprint = "-", gfa = "-", height = "-", floors = "-";
  if (vols.length > 0) {
    // 複数棟（L字/コの字/ツイン等の分割配置）は全棟を合算する
    const fa = vols.reduce((s, l) => s + l.volume.width * l.volume.depth, 0);
    const gfaN = vols.reduce((s, l) =>
      s + l.volume.width * l.volume.depth * Math.max(1, Math.floor(l.volume.height / 3.1)), 0);
    // 積層配置（タワー+低層棟）は天端 = 基準高さ+高さ で評価する
    const minBase = Math.min(...vols.map((l) => l.volume.baseH || 0));
    const maxH = Math.max(...vols.map((l) => (l.volume.baseH || 0) + l.volume.height)) - minBase;
    const fl = Math.max(1, Math.floor(maxH / 3.1));
    const v0 = vols[0].volume;
    footprint = `${Math.round(fa).toLocaleString()} m²（${vols.length === 1 ? `${v0.width.toFixed(1)}×${v0.depth.toFixed(1)}m` : `${vols.length}棟`}）`;
    gfa = `約 ${Math.round(gfaN).toLocaleString()} m²`;
    height = `${maxH.toFixed(1)} m`;
    floors = `約 ${fl} 階${vols.length > 1 ? "（最高部）" : ""}`;
  } else if (model) {
    footprint = "（CADモデル配置）";
    height = `${((model.model.buildHeight || 30) + (model.model.heightOffset || 0)).toFixed(1)} m`;
  }
  let kisei = "未実施";
  const verdicts = state.layers.filter((l) => l.kind === "kisei").flatMap((l) => l.kisei.verdicts);
  if (verdicts.length) {
    const ng = verdicts.filter((v) => !v.ok);
    kisei = ng.length === 0
      ? `適合（${verdicts.length}件判定 / 外接矩形近似）`
      : `超過あり: ${ng.map((v) => `${v.name} +${v.over.toFixed(1)}m`).join(" / ")}`;
  }
  const tenku = (typeof lastTenku !== "undefined" && lastTenku)
    ? `計画 ${lastTenku.plan.toFixed(1)}% / 斜線適合建物 ${lastTenku.comp.toFixed(1)}% → ${lastTenku.ok ? "適合建物以上（緩和の可能性あり）" : "適合建物未満"}`
    : "未実施";
  const hikage = (typeof lastHikage !== "undefined" && lastHikage)
    ? `5-10m帯 最大${lastHikage.max5.toFixed(1)}h（規制${lastHikage.regA}h）/ 10m超 最大${lastHikage.max10.toFixed(1)}h（規制${lastHikage.regB}h）→ ${lastHikage.ok ? "規制内" : "超過"}（測定面GL+${lastHikage.planeH}m）`
    : "未実施";
  return { footprint, gfa, height, floors, kisei, tenku, hikage };
}

// ---------- UI ----------
$("docBtn").onclick = () => {
  docRefreshTemplateSelect();
  docRefreshRecordSelect();
  $("docDialog").showModal();
};
$("docCloseBtn").onclick = () => $("docDialog").close();

function docRefreshTemplateSelect() {
  const sel = $("docTemplateSel");
  sel.innerHTML = "";
  for (const t of docAllTemplates()) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.name + (DOC_BUILTIN_TEMPLATES.some((b) => b.id === t.id) ? "" : "（カスタム）");
    sel.appendChild(o);
  }
  docUpdateTargetVisibility();
}
$("docTemplateSel") && ($("docTemplateSel").onchange = () => docUpdateTargetVisibility());

function docUpdateTargetVisibility() {
  const t = docAllTemplates().find((x) => x.id === $("docTemplateSel").value);
  $("docRecordRow").classList.toggle("hidden", t?.requires !== "record");
}

function docRefreshRecordSelect() {
  const sel = $("docRecordSel");
  sel.innerHTML = "";
  for (const r of recState.records) {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = `${r.title || "(無題)"} [${REC_STATUS.find((s) => s[0] === r.status)?.[1]}]`;
    sel.appendChild(o);
  }
}

async function docGenerate(openWindow) {
  const template = docAllTemplates().find((x) => x.id === $("docTemplateSel").value);
  if (!template) return null;
  if (template.requires === "record" && recState.records.length === 0) {
    toast("記録がありません。先に「📌 記録」で現場記録を作成してください");
    return null;
  }
  if (template.requires === "survey" && (!lastSurveyRows || lastSurveyRows.length === 0)) {
    toast("調査結果がありません。先に「📋 調査」を実行してください");
    return null;
  }
  toast("帳票を生成しています...");
  const ctx = await buildDocContext($("docRecordSel").value);
  const html = ReportEngine.render(template, ctx);
  if (openWindow) {
    const w = ReportEngine.openPrint(html);
    if (!w) toast("ポップアップがブロックされました。ブラウザの設定を確認してください");
  } else {
    downloadFile(html, `${template.name}-${exportTimestamp()}.html`, "text/html;charset=utf-8");
    toast("帳票をHTMLで保存しました（ブラウザで開いて印刷/PDF保存できます）");
  }
  return html;
}

$("docPrintBtn").onclick = () => docGenerate(true);
$("docHtmlBtn").onclick = () => docGenerate(false);

// ---------- カスタムテンプレート編集 ----------
$("docEditBtn").onclick = () => {
  const t = docAllTemplates().find((x) => x.id === $("docTemplateSel").value);
  $("docTemplateJson").value = JSON.stringify(t, null, 2);
  $("docEditor").classList.toggle("hidden");
};

$("docSaveTemplateBtn").onclick = () => {
  try {
    const t = JSON.parse($("docTemplateJson").value);
    if (!t.id || !t.name || !Array.isArray(t.blocks)) {
      toast("id / name / blocks は必須です");
      return;
    }
    if (DOC_BUILTIN_TEMPLATES.some((b) => b.id === t.id)) {
      t.id = t.id + "-custom";
      toast(`標準テンプレートは上書きできないため「${t.id}」として保存します`);
    }
    const users = docUserTemplates().filter((x) => x.id !== t.id);
    users.push(t);
    localStorage.setItem(DOC_TEMPLATES_KEY, JSON.stringify(users));
    docRefreshTemplateSelect();
    $("docTemplateSel").value = t.id;
    docUpdateTargetVisibility();
    toast(`テンプレート「${t.name}」を保存しました`);
  } catch (e) {
    toast("JSONの形式が不正です: " + e.message);
  }
};

$("docDeleteTemplateBtn").onclick = () => {
  const id = $("docTemplateSel").value;
  if (DOC_BUILTIN_TEMPLATES.some((b) => b.id === id)) {
    toast("標準テンプレートは削除できません");
    return;
  }
  localStorage.setItem(DOC_TEMPLATES_KEY,
    JSON.stringify(docUserTemplates().filter((x) => x.id !== id)));
  docRefreshTemplateSelect();
  toast("カスタムテンプレートを削除しました");
};
