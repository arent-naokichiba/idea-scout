/* 最小ZIPユーティリティ（依存ライブラリなし）
 *
 * BCF書き出しやプロジェクトパッケージなど、複数ファイルを1つにまとめる
 * 連携機能の共通土台。無圧縮（STORED）のみ対応 — ZIP仕様準拠なので
 * OS標準の解凍・Revit等のBCFリーダー・Pythonのzipfileで開ける。
 * ファイル名はUTF-8フラグ付きで日本語対応。
 */
"use strict";

const MiniZip = (() => {
  // ---- CRC32 ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    const d = date || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, day };
  }

  /**
   * ZIPを作成する
   * @param {Array<{name: string, data: Uint8Array|string|Blob}>} files
   * @returns {Promise<Blob>}
   */
  async function create(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime();

    for (const file of files) {
      let data = file.data;
      if (typeof data === "string") data = encoder.encode(data);
      else if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
      const name = encoder.encode(file.name);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);        // version needed
      local.setUint16(6, 0x0800, true);    // UTF-8 filename flag
      local.setUint16(8, 0, true);         // method: STORED
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, day, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }

    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: "application/zip" });
  }

  /**
   * ZIPを読む（STOREDのみ / 自前パッケージの読み込み用）
   * @param {ArrayBuffer} buffer
   * @returns {Map<string, Uint8Array>}
   */
  function read(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    // EOCDを末尾から探す
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("ZIPではありません（EOCDが見つかりません）");
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true); // central directory offset
    const decoder = new TextDecoder();
    const out = new Map();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error("セントラルディレクトリが不正です");
      const method = view.getUint16(p + 10, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      if (method !== 0) throw new Error(`圧縮ZIPは未対応です（${name}）。本アプリで書き出したパッケージを指定してください`);
      // ローカルヘッダを読んでデータ位置を確定
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      out.set(name, bytes.subarray(dataStart, dataStart + size));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  return { create, read, crc32 };
})();
