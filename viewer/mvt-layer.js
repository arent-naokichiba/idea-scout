/* MVTレイヤー描画エンジン
 *
 * PLATEAUの都市計画決定情報などMVT（Mapbox Vector Tile）形式のデータセットを
 * CesiumのカスタムImageryProviderとしてcanvasに描画する。
 * デコードには viewer/vendor/mvt.js（pbf + @mapbox/vector-tile のバンドル）を使う。
 *
 * - オーバーズーム対応: maxDataLevel より深いズームでは親タイルを拡大描画
 * - pickFeatures対応: クリック位置のポリゴン/ライン属性を返す
 * - 凡例: 描画した カテゴリ→色 の対応を収集して onLegend で通知
 */
"use strict";

// 用途地域の標準配色（都市計画図の慣例に準拠）
const USE_DISTRICT_COLORS = [
  ["第一種低層住居専用地域", "#4cbd8d"],
  ["第二種低層住居専用地域", "#99d48a"],
  ["田園住居地域", "#b8dc7f"],
  ["第一種中高層住居専用地域", "#a3d178"],
  ["第二種中高層住居専用地域", "#c8df8d"],
  ["第一種住居地域", "#f5e37c"],
  ["第二種住居地域", "#f7d29a"],
  ["準住居地域", "#f0b56e"],
  ["近隣商業地域", "#f2a5b5"],
  ["商業地域", "#ea6d7a"],
  ["準工業地域", "#c39bd0"],
  ["工業地域", "#a5c3e6"],
  ["工業専用地域", "#7d9fd3"],
  // 防火・土砂・区域区分などの頻出カテゴリ
  ["防火地域", "#e5533d"],
  ["準防火地域", "#f0a24b"],
  ["土砂災害特別警戒区域", "#e5533d"],
  ["土砂災害警戒区域", "#f2d13e"],
  ["市街化区域", "#8fd0a0"],
  ["市街化調整区域", "#c9c9a3"],
];

// カテゴリ不明時のフォールバックパレット
const CATEGORY_PALETTE = [
  "#5fa8e6", "#e6a05f", "#7dc97d", "#d98cc2", "#c2b25f",
  "#6fc9c2", "#e67d7d", "#9b8ce6", "#a0b86e", "#e6c17d",
];

function mvtStringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// 地物のカテゴリ名（凡例ラベル）を決める。都市計画系は urf_function が基本
function mvtCategoryOf(props, layerName) {
  return (
    props.urf_function ||
    props.urf_useDistrict ||
    props.urf_usage ||
    props.luse_class ||
    props.function ||
    props.feature_type ||
    layerName
  );
}

// 「第1種/第１種」のような算用数字表記を漢数字に正規化して配色表とマッチさせる
const MVT_NUM_KANJI = { "1": "一", "2": "二", "１": "一", "２": "二" };
function mvtNormalizeCategory(s) {
  return String(s).replace(/第([1２2１])種/g, (m, n) => `第${MVT_NUM_KANJI[n]}種`);
}

function mvtColorFor(category) {
  const normalized = mvtNormalizeCategory(category);
  for (const [name, color] of USE_DISTRICT_COLORS) {
    if (normalized.includes(name)) return color;
  }
  return CATEGORY_PALETTE[mvtStringHash(String(category)) % CATEGORY_PALETTE.length];
}

class MvtImageryProvider {
  /**
   * @param {object} options
   * @param {string} options.urlTemplate - {z}/{x}/{y}.mvt 形式のURLテンプレート
   * @param {number} [options.minDataLevel=10] - タイルが存在する最小ズーム
   * @param {number} [options.maxDataLevel=16] - タイルが存在する最大ズーム（超えたら親を拡大）
   * @param {function} [options.onLegend] - 凡例更新コールバック（Map<label, cssColor>）
   */
  constructor(options) {
    this._urlTemplate = options.urlTemplate;
    this._minDataLevel = options.minDataLevel ?? 10;
    this._maxDataLevel = options.maxDataLevel ?? 16;
    this._onLegend = options.onLegend;
    this._legend = new Map();
    this._legendNotifyTimer = null;

    // デコード済みタイルのキャッシュ（LRU風: 上限超過で古いものから破棄）
    this._tileCache = new Map();
    this._tileCacheLimit = 120;

    this._tilingScheme = new Cesium.WebMercatorTilingScheme();
    this._errorEvent = new Cesium.Event();
    this._credit = new Cesium.Credit("国土交通省 Project PLATEAU");
    this._projection = new Cesium.WebMercatorProjection();
  }

  // --- Cesium ImageryProvider インターフェース ---
  get tilingScheme() { return this._tilingScheme; }
  get rectangle() { return this._tilingScheme.rectangle; }
  get tileWidth() { return 256; }
  get tileHeight() { return 256; }
  get maximumLevel() { return 20; }
  get minimumLevel() { return 0; }
  get tileDiscardPolicy() { return undefined; }
  get errorEvent() { return this._errorEvent; }
  get credit() { return this._credit; }
  get proxy() { return undefined; }
  get hasAlphaChannel() { return true; }
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }

  getTileCredits() { return undefined; }

  get legend() { return this._legend; }

  async requestImage(x, y, level) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    if (level < this._minDataLevel) return canvas; // 浅いズームでは何も描かない

    const data = this._toDataTile(x, y, level);
    const tile = await this._fetchTile(data.x, data.y, data.level);
    if (!tile) return canvas;

    const ctx = canvas.getContext("2d");
    for (const layerName of Object.keys(tile.layers)) {
      this._drawLayer(ctx, tile.layers[layerName], layerName, data);
    }
    this._notifyLegend();
    return canvas;
  }

  async pickFeatures(x, y, level, longitude, latitude) {
    if (level < this._minDataLevel) return [];
    const data = this._toDataTile(x, y, level);
    const tile = await this._fetchTile(data.x, data.y, data.level);
    if (!tile) return [];

    // クリック位置をデータタイルのローカル座標へ変換（WebMercatorは線形なのでnative矩形で補間）
    const rect = this._tilingScheme.tileXYToNativeRectangle(data.x, data.y, data.level);
    const m = this._projection.project(new Cesium.Cartographic(longitude, latitude));

    const results = [];
    for (const layerName of Object.keys(tile.layers)) {
      const layer = tile.layers[layerName];
      const extent = layer.extent;
      const px = ((m.x - rect.west) / (rect.east - rect.west)) * extent;
      const py = ((rect.north - m.y) / (rect.north - rect.south)) * extent;
      // オーバーズーム時は画面上の許容距離をデータタイル座標に換算
      const tolerance = (extent / 256) * 6 / (1 << (level - data.level > 0 ? level - data.level : 0));

      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        if (this._hitTest(feature, px, py, tolerance)) {
          const info = new Cesium.ImageryLayerFeatureInfo();
          // vector-tileのpropertiesはnullプロトタイプの場合があるため通常オブジェクトに複製
          const props = Object.assign({}, feature.properties);
          info.name = mvtCategoryOf(props, layerName);
          info.properties = props;
          info.data = { layer: layerName };
          results.push(info);
        }
      }
    }
    return results;
  }

  // --- 内部処理 ---

  // 表示タイル座標 → 実データタイル座標（オーバーズーム対応）
  _toDataTile(x, y, level) {
    if (level <= this._maxDataLevel) {
      return { x, y, level, scale: 1, offsetX: 0, offsetY: 0 };
    }
    const dz = level - this._maxDataLevel;
    const scale = 1 << dz;
    return {
      x: x >> dz,
      y: y >> dz,
      level: this._maxDataLevel,
      scale,
      offsetX: x - (x >> dz) * scale,
      offsetY: y - (y >> dz) * scale,
    };
  }

  async _fetchTile(x, y, level) {
    const url = this._urlTemplate
      .replace("{z}", level)
      .replace("{x}", x)
      .replace("{y}", y);
    if (this._tileCache.has(url)) {
      const cached = this._tileCache.get(url);
      // LRU更新
      this._tileCache.delete(url);
      this._tileCache.set(url, cached);
      return cached;
    }
    const promise = (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null; // 404 = データなしタイル
        const buf = await resp.arrayBuffer();
        return new window.MVT.VectorTile(new window.MVT.PbfReader(new Uint8Array(buf)));
      } catch (e) {
        return null;
      }
    })();
    this._tileCache.set(url, promise);
    if (this._tileCache.size > this._tileCacheLimit) {
      this._tileCache.delete(this._tileCache.keys().next().value);
    }
    return promise;
  }

  _drawLayer(ctx, layer, layerName, data) {
    const extent = layer.extent;
    // タイル座標 → canvas座標（オーバーズーム時は部分拡大）
    const k = (256 * data.scale) / extent;
    const dx = -data.offsetX * 256;
    const dy = -data.offsetY * 256;

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const category = mvtCategoryOf(feature.properties, layerName);
      const color = mvtColorFor(category);
      if (!this._legend.has(category)) this._legend.set(category, color);

      const geom = feature.loadGeometry();
      if (feature.type === 3) {
        // ポリゴン（穴はevenoddで抜く）
        ctx.beginPath();
        for (const ring of geom) {
          for (let j = 0; j < ring.length; j++) {
            const cx = ring[j].x * k + dx;
            const cy = ring[j].y * k + dy;
            if (j === 0) ctx.moveTo(cx, cy);
            else ctx.lineTo(cx, cy);
          }
          ctx.closePath();
        }
        ctx.fillStyle = color + "99"; // alpha約0.6
        ctx.fill("evenodd");
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (feature.type === 2) {
        // ライン
        ctx.beginPath();
        for (const line of geom) {
          for (let j = 0; j < line.length; j++) {
            const cx = line[j].x * k + dx;
            const cy = line[j].y * k + dy;
            if (j === 0) ctx.moveTo(cx, cy);
            else ctx.lineTo(cx, cy);
          }
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (feature.type === 1) {
        // ポイント
        ctx.fillStyle = color;
        for (const points of geom) {
          for (const p of points) {
            ctx.beginPath();
            ctx.arc(p.x * k + dx, p.y * k + dy, 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  }

  _hitTest(feature, px, py, tolerance) {
    const geom = feature.loadGeometry();
    if (feature.type === 3) {
      // 全リングに対するeven-odd判定（外環と穴をまとめて評価）
      let inside = false;
      for (const ring of geom) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i].x, yi = ring[i].y;
          const xj = ring[j].x, yj = ring[j].y;
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
          }
        }
      }
      return inside;
    }
    if (feature.type === 2) {
      for (const line of geom) {
        for (let i = 0; i < line.length - 1; i++) {
          if (this._pointToSegment(px, py, line[i], line[i + 1]) <= tolerance) return true;
        }
      }
      return false;
    }
    // ポイント
    for (const points of geom) {
      for (const p of points) {
        const d = Math.hypot(p.x - px, p.y - py);
        if (d <= tolerance) return true;
      }
    }
    return false;
  }

  _pointToSegment(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  _notifyLegend() {
    if (!this._onLegend || this._legendNotifyTimer) return;
    this._legendNotifyTimer = setTimeout(() => {
      this._legendNotifyTimer = null;
      this._onLegend(this._legend);
    }, 500);
  }
}
