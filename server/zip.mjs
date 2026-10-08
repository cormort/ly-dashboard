import zlib from 'node:zlib';

/**
 * 讀 ZIP 裡的一個檔案（只用 Node 內建的 zlib，不引入依賴）。
 *
 * 為什麼要自己讀：全國法規資料庫的資料檔端點（`law.moj.gov.tw/api/ch/law/json`）回的是
 * **ZIP 壓縮檔**（內含 ChLaw.json，解開約 26MB），不是 JSON；而 repo 的 package.json 沒有
 * 任何 runtime 依賴，為了一個 6MB 的壓縮檔裝 unzipper／adm-zip 不划算。
 *
 * 只支援 File API 需要的路徑：EOCD → 中央目錄 → 單一項目的 local header。
 * **不支援 ZIP64**（資料檔的單一項目與總大小都遠低於 4GB，沒有需要）。
 */
export function readZipEntry(buffer, entryName) {
  const eocd = findEocd(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目錄格式異常（找不到項目標頭）');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === entryName) return readEntryAt(buffer, localOffset, method, compressedSize, name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP 裡沒有 ${entryName}`);
}

function findEocd(buffer) {
  // EOCD 在檔尾，但可能被註解（最多 65535 位元組）往後推，所以由後往前找
  const from = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= from; i--) if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  throw new Error('不是 ZIP 檔（找不到 EOCD）');
}

function readEntryAt(buffer, localOffset, method, compressedSize, name) {
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP 項目 ${name} 的標頭異常`);
  // 壓縮大小以中央目錄為準：local header 在串流寫入時可能是 0（資料描述元放在後面）
  const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
  const data = buffer.subarray(start, start + compressedSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`ZIP 項目 ${name} 用了不支援的壓縮方式（method ${method}）`);
}
