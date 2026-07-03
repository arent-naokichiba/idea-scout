/* 地理院標高タイル TerrainProvider
 *
 * 国土地理院のPNG標高タイル（dem_png, DEM10B相当, z1〜14）をデコードして
 * Cesiumの地形として使う。タイルが存在しない場所（海上など）は標高0の平坦地形。
 *
 * 標高値の仕様: x = R*2^16 + G*2^8 + B
 *   x < 2^23  → 標高 = x * 0.01 [m]
 *   x = 2^23  → 無効値（0mとして扱う）
 *   x > 2^23  → 標高 = (x - 2^24) * 0.01 [m]
 */
"use strict";

const GSI_DEM_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png";
const GSI_DEM_MAX_LEVEL = 14;
const GSI_HEIGHTMAP_WIDTH = 65; // 256pxタイルを65x65グリッドに間引く

class GsiTerrainProvider {
  constructor() {
    this._tilingScheme = new Cesium.WebMercatorTilingScheme();
    this._levelZeroMaximumGeometricError =
      Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
        this._tilingScheme.ellipsoid,
        GSI_HEIGHTMAP_WIDTH,
        this._tilingScheme.getNumberOfXTilesAtLevel(0)
      );
    this._errorEvent = new Cesium.Event();
    this._credit = new Cesium.Credit("地理院タイル（標高）");
    // デコード用の使い回しcanvas
    this._canvas = document.createElement("canvas");
    this._canvas.width = 256;
    this._canvas.height = 256;
    this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
  }

  get errorEvent() { return this._errorEvent; }
  get credit() { return this._credit; }
  get tilingScheme() { return this._tilingScheme; }
  get hasWaterMask() { return false; }
  get hasVertexNormals() { return false; }
  get availability() { return undefined; }
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }

  getLevelMaximumGeometricError(level) {
    return this._levelZeroMaximumGeometricError / (1 << level);
  }

  getTileDataAvailable(x, y, level) {
    return level <= GSI_DEM_MAX_LEVEL;
  }

  loadTileDataAvailability() { return undefined; }

  requestTileGeometry(x, y, level, request) {
    const url = GSI_DEM_URL
      .replace("{z}", level)
      .replace("{x}", x)
      .replace("{y}", y);
    const resource = new Cesium.Resource({ url, request });
    const promise = resource.fetchImage({ preferImageBitmap: true, flipY: false });
    if (!promise) return undefined; // Cesium側のリクエストスロットリング

    return promise
      .then((image) => this._toHeightmap(image, level))
      .catch(() => this._flatHeightmap(level)); // 404 = データなし → 平坦
  }

  _toHeightmap(image, level) {
    this._ctx.clearRect(0, 0, 256, 256);
    this._ctx.drawImage(image, 0, 0, 256, 256);
    const pixels = this._ctx.getImageData(0, 0, 256, 256).data;

    const w = GSI_HEIGHTMAP_WIDTH;
    const buffer = new Float32Array(w * w);
    for (let gy = 0; gy < w; gy++) {
      const py = Math.round((gy * 255) / (w - 1));
      for (let gx = 0; gx < w; gx++) {
        const px = Math.round((gx * 255) / (w - 1));
        const i = (py * 256 + px) * 4;
        const v = pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2];
        let h = 0;
        if (v !== 8388608) { // 2^23 = 無効値
          h = v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01;
        }
        buffer[gy * w + gx] = h;
      }
    }
    return new Cesium.HeightmapTerrainData({
      buffer,
      width: w,
      height: w,
      childTileMask: level < GSI_DEM_MAX_LEVEL ? 15 : 0,
    });
  }

  _flatHeightmap(level) {
    const w = GSI_HEIGHTMAP_WIDTH;
    return new Cesium.HeightmapTerrainData({
      buffer: new Float32Array(w * w),
      width: w,
      height: w,
      childTileMask: level < GSI_DEM_MAX_LEVEL ? 15 : 0,
    });
  }
}
