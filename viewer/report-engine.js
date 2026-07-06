/* 汎用帳票エンジン
 *
 * テンプレート（JSON）とデータコンテキストからA4印刷用HTMLを生成する。
 * ブラウザの印刷機能（PDFとして保存）でそのままPDF化できる。
 * ビューア以外にも転用できるよう、CesiumやアプリのUIには依存しない。
 *
 * テンプレート構造:
 *   { "name": "帳票名", "paper": "A4", "blocks": [ ...ブロック ] }
 *
 * ブロック種別:
 *   { "type": "title",      "text": "是正指示書", "subtitle": "{project}" }
 *   { "type": "text",       "label": "指示内容", "text": "{record.note}" }
 *   { "type": "meta-table", "title": "基本情報", "rows": [["工事名", "{project}"], ...] }
 *   { "type": "table",      "title": "工程一覧", "source": "schedule",
 *     "columns": [{ "label": "工程", "path": "name", "width": "30%", "align": "left" }, ...] }
 *   { "type": "images",     "source": "record.photos", "columns": 2, "caption": true }
 *   { "type": "gantt",      "source": "schedule" }
 *   { "type": "screenshot", "source": "screenshot", "caption": "現況" }
 *   { "type": "pagebreak" }
 *
 * 値の埋め込み: 文字列中の {path.to.value} をコンテキストから解決する。
 */
"use strict";

const ReportEngine = (() => {
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // "a.b.c" 形式のパスをコンテキストから解決する
  function get(ctx, path) {
    if (!path) return undefined;
    return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
  }

  // 文字列中の {path} を解決する
  function fill(text, ctx) {
    return String(text ?? "").replace(/\{([\w.]+)\}/g, (m, p) => {
      const v = get(ctx, p);
      return v === undefined || v === null ? "" : String(v);
    });
  }

  function fmt(value, format) {
    if (value === undefined || value === null || value === "") return "";
    if (format === "number") return Number(value).toLocaleString("ja-JP");
    if (format === "percent") return `${Math.round(Number(value))}%`;
    if (format === "date") return new Date(value).toLocaleDateString("ja-JP");
    if (format === "datetime") return new Date(value).toLocaleString("ja-JP");
    return String(value);
  }

  const renderers = {
    title(b, ctx) {
      return `<h1 class="rp-title">${esc(fill(b.text, ctx))}</h1>` +
        (b.subtitle ? `<div class="rp-subtitle">${esc(fill(b.subtitle, ctx))}</div>` : "");
    },

    text(b, ctx) {
      const body = esc(fill(b.text, ctx)).replace(/\n/g, "<br>");
      return (b.label ? `<div class="rp-label">${esc(fill(b.label, ctx))}</div>` : "") +
        `<div class="rp-text">${body || "&nbsp;"}</div>`;
    },

    "meta-table"(b, ctx) {
      const rows = (b.rows || []).map(([k, v]) =>
        `<tr><th>${esc(fill(k, ctx))}</th><td>${esc(fill(v, ctx))}</td></tr>`).join("");
      return (b.title ? `<div class="rp-label">${esc(fill(b.title, ctx))}</div>` : "") +
        `<table class="rp-meta"><tbody>${rows}</tbody></table>`;
    },

    table(b, ctx) {
      const data = get(ctx, b.source);
      const rows = Array.isArray(data) ? data : [];
      const cols = b.columns || [];
      const head = cols.map((c) =>
        `<th style="${c.width ? `width:${c.width};` : ""}text-align:${c.align || "left"}">${esc(c.label)}</th>`).join("");
      const body = rows.map((row) => "<tr>" + cols.map((c) => {
        const raw = c.path ? get(row, c.path) : fill(c.text || "", row);
        return `<td style="text-align:${c.align || "left"}">${esc(fmt(raw, c.format))}</td>`;
      }).join("") + "</tr>").join("");
      return (b.title ? `<div class="rp-label">${esc(fill(b.title, ctx))}</div>` : "") +
        `<table class="rp-table"><thead><tr>${head}</tr></thead><tbody>${body ||
          `<tr><td colspan="${cols.length}" class="rp-empty">（データなし）</td></tr>`}</tbody></table>`;
    },

    images(b, ctx) {
      const items = get(ctx, b.source) || b.items || [];
      const cols = Math.max(1, Math.min(4, b.columns || 2));
      const cells = items.map((it) => `
        <div class="rp-imgCell" style="width:${(100 / cols).toFixed(2)}%">
          <img src="${esc(it.src)}" alt="">
          ${b.caption !== false && it.caption ? `<div class="rp-imgCap">${esc(it.caption)}</div>` : ""}
        </div>`).join("");
      return (b.title ? `<div class="rp-label">${esc(fill(b.title, ctx))}</div>` : "") +
        `<div class="rp-imgGrid">${cells || '<div class="rp-empty">（画像なし）</div>'}</div>`;
    },

    screenshot(b, ctx) {
      const src = get(ctx, b.source || "screenshot");
      if (!src) return "";
      return (b.caption ? `<div class="rp-label">${esc(fill(b.caption, ctx))}</div>` : "") +
        `<img class="rp-shot" src="${esc(src)}" alt="">`;
    },

    gantt(b, ctx) {
      const tasks = get(ctx, b.source || "schedule") || [];
      if (tasks.length === 0) return '<div class="rp-empty">（工程なし）</div>';
      let min = Infinity, max = -Infinity;
      for (const t of tasks) {
        const s = Date.parse(t.start), e = Date.parse(t.end);
        if (Number.isFinite(s)) min = Math.min(min, s);
        if (Number.isFinite(e)) max = Math.max(max, e + 86399000);
      }
      if (!Number.isFinite(min) || max <= min) return "";
      const span = max - min;
      const rows = tasks.map((t) => {
        const s = Date.parse(t.start), e = Date.parse(t.end) + 86399000;
        const left = ((s - min) / span) * 100;
        const width = Math.max(0.5, ((e - s) / span) * 100);
        const color = (t.progress || 0) >= 100 ? "#3f7d5a" : t.delayed ? "#c0392b" : "#3c78c8";
        return `<tr><td class="rp-ganttName">${esc(t.name)}</td>
          <td class="rp-ganttBarCell"><div class="rp-ganttTrack">
            <div class="rp-ganttBar" style="left:${left}%;width:${width}%;background:${color}"></div>
          </div></td>
          <td class="rp-ganttPct">${t.progress || 0}%</td></tr>`;
      }).join("");
      return (b.title ? `<div class="rp-label">${esc(fill(b.title, ctx))}</div>` : "") +
        `<table class="rp-gantt"><tbody>${rows}</tbody></table>`;
    },

    pagebreak() {
      return '<div class="rp-break"></div>';
    },
  };

  const BASE_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif;
         color: #1c1c1c; font-size: 11pt; line-height: 1.65; margin: 0; }
  .rp-page { max-width: 182mm; margin: 0 auto; padding: 10px; }
  .rp-title { font-size: 19pt; text-align: center; letter-spacing: .3em;
              border-bottom: 3px double #333; padding-bottom: 6px; margin: 0 0 4px; }
  .rp-subtitle { text-align: center; color: #555; margin-bottom: 14px; }
  .rp-label { font-weight: 700; margin: 14px 0 4px; border-left: 4px solid #3c78c8; padding-left: 7px; }
  .rp-text { border: 1px solid #bbb; border-radius: 4px; padding: 8px 10px; min-height: 2em; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  .rp-meta th { width: 28%; background: #f0f3f6; }
  .rp-meta th, .rp-meta td, .rp-table th, .rp-table td { border: 1px solid #999; padding: 4px 8px; }
  .rp-table th { background: #f0f3f6; }
  .rp-empty { color: #888; text-align: center; }
  .rp-imgGrid { display: flex; flex-wrap: wrap; }
  .rp-imgCell { padding: 3px; }
  .rp-imgCell img { width: 100%; border: 1px solid #999; display: block; }
  .rp-imgCap { font-size: 8.5pt; color: #444; padding: 2px 1px; }
  .rp-shot { width: 100%; border: 1px solid #999; margin: 4px 0; }
  .rp-gantt td { border: none; padding: 2px 4px; }
  .rp-ganttName { width: 26%; font-size: 9.5pt; }
  .rp-ganttPct { width: 44px; text-align: right; font-size: 9.5pt; }
  .rp-ganttTrack { position: relative; height: 12px; background: #eef1f4; border-radius: 3px; }
  .rp-ganttBar { position: absolute; top: 2px; bottom: 2px; border-radius: 2px; }
  .rp-break { page-break-after: always; }
  .rp-toolbar { position: fixed; top: 8px; right: 8px; display: flex; gap: 6px; }
  .rp-toolbar button { padding: 8px 16px; font-size: 12px; cursor: pointer;
    border: 1px solid #888; border-radius: 6px; background: #fff; }
  @media print { .rp-toolbar { display: none; } }
  `;

  /** テンプレート + コンテキスト → 完全なHTML文書 */
  function render(template, ctx) {
    const blocks = (template.blocks || []).map((b) => {
      const renderer = renderers[b.type];
      if (!renderer) return `<div class="rp-empty">未対応ブロック: ${esc(b.type)}</div>`;
      try {
        return renderer(b, ctx);
      } catch (e) {
        return `<div class="rp-empty">ブロック描画エラー(${esc(b.type)}): ${esc(e.message)}</div>`;
      }
    }).join("\n");
    return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<title>${esc(fill(template.name || "帳票", ctx))}</title>
<style>${BASE_CSS}\n${template.css || ""}</style></head>
<body><div class="rp-page">${blocks}</div>
<div class="rp-toolbar"><button onclick="window.print()">🖨 印刷 / PDF保存</button></div>
</body></html>`;
  }

  /** 生成したHTMLを別ウィンドウで開く（そこから印刷/PDF保存） */
  function openPrint(html) {
    const w = window.open("", "_blank");
    if (!w) return null;
    w.document.open();
    w.document.write(html);
    w.document.close();
    return w;
  }

  return { render, openPrint, fill, get, renderers, BASE_CSS };
})();
