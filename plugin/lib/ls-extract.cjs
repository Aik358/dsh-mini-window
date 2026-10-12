#!/usr/bin/env node
/*
 * host-ls-extract.cjs —— 零依赖 Chromium/LevelDB LocalStorage 提取器
 * ---------------------------------------------------------------------------
 * 目的：把宿主（DSH 桌面壳 / Electron）LocalStorage 的 leveldb 目录「读出键值」，
 *       供 Companion 在应用层注入（文件级拷贝已被证伪：Chromium 会整库丢弃重建）。
 *
 * 只读：本脚本对 leveldb 目录只做 fs.readFileSync / readdirSync，绝不写入。
 *
 * 覆盖的磁盘格式（LevelDB 官方）：
 *   .ldb / .sst  —— SSTable
 *       footer(48B, 末尾) = metaindex_handle(varint off,varint size)
 *                          + index_handle(varint off,varint size) + 0 填充 + 8B magic(57fb808b247547db)
 *       block        —— [entry...][restart array u32[]][num_restarts u32] + trailer(1B 压缩类型 + 4B crc32c)
 *       entry        —— shared_len varint + non_shared_len varint + value_len varint
 *                       + key_delta(non_shared B) ; key = prev[0..shared] + key_delta
 *       压缩          —— 0=none, 1=Snappy(自带解压), 2=Zstd(不再自实现，报警告并跳过)
 *   .log         —— log::Writer 32KB 块 + WriteBatch
 *       记录头 7B    —— crc32c(u32 LE, 屏蔽后) + length(u16 LE) + type(u8)
 *       type         —— 1=FULL 2=FIRST 3=MIDDLE 4=LAST 0=ZERO(预分配/填充)
 *       WriteBatch   —— sequence(u64 LE) + count(u32 LE) + 若干记录
 *       批记录        —— type(u8, 1=PUT 0=DELETE) + key(varint len + bytes)
 *                       + [value(varint len + bytes)，仅 PUT]
 *   MANIFEST-*   —— 同 .log 的 log 格式，内容是 VersionEdit 序列（tag/value varint）
 *
 * 合并语义（LevelDB 真实语义）：
 *   SSTable 内的 key 是 internal key = user_key + 8B trailer(sequence<<8|type)。
 *   因此 SST 与 LOG 都带全局单调 sequence ⇒ 同一 user key 取 **sequence 最大** 的记录，
 *   type=0(DELETE) 即删除。sequence 相同时用「来源新鲜度」兜底：
 *   LOG(文件号大者优先) > L0(文件号大者优先) > L1 > L2 ...（与 leveldb::Version::Get 查找顺序一致）。
 *   MANIFEST 用于还原每个 .ldb 的 level；MANIFEST 缺失/损坏时退化为「文件号越大越新」。
 *
 * Chromium LocalStorage 键编码（实测见 --dump-raw，结论写在本文件 §decodeStorageKey）：
 *   "META:<origin>"                    → 元数据（不是脚本 key）
 *   "_<origin>\x00<flag><body>"        → 脚本 key
 *        flag=0x00 → body 是 Latin-1 字节（每字节一字符）
 *        flag=0x01 → body 是 UTF-16LE 码元序列
 *   值编码见 §decodeStorageValue（同样实测确定）。
 *
 * 用法：
 *   node host-ls-extract.cjs [--dir <leveldb 目录>] [--out <json 文件>] [--pretty]
 *                            [--check k1,k2,...] [--dump-raw] [--hex-limit N]
 *                            [--include-meta] [--strict-crc] [--quiet] [--report <file>]
 *   默认 dir = %APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb
 *   JSON → stdout（或 --out）；诊断/报告 → stderr（或 --report）。
 *
 * 编程接口：module.exports = { extractLevelDB, ... }
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ===========================================================================
// §0 常量
// ===========================================================================

const LOG_BLOCK_SIZE = 32 * 1024;
const LOG_HEADER_SIZE = 7;
const BLOCK_TRAILER_SIZE = 5;
const FOOTER_SIZE = 48;
const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

const TYPE_DELETION = 0;
const TYPE_VALUE = 1;

const LOG_ZERO = 0;
const LOG_FULL = 1;
const LOG_FIRST = 2;
const LOG_MIDDLE = 3;
const LOG_LAST = 4;

const DEFAULT_DSH_DIR = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  '@deepseek-ai',
  'dsh-desktop',
  'Local Storage',
  'leveldb'
);

/** 宿主实测已知 key（用于 --check 的默认列表）。 */
const DEFAULT_CHECK_KEYS = [
  'dsh-auto-memory.tourDismissed',
  'router:onboarding:model-guide-v2',
  'dam-skin',
  'sidebar:v1:',
];

// ===========================================================================
// §1 varint / 基础读取
// ===========================================================================

/** LevelDB varint：little-endian base-128。返回 {value, next}。 */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new RangeError(`varint 越界 @${p}`);
    const b = buf[p];
    p += 1;
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return { value: result, next: p };
    shift += 7;
    if (shift > 63) throw new RangeError('varint 过长');
  }
}

/** 读 length-prefixed slice（MANIFEST 内用）。 */
function readLengthPrefixedSlice(buf, pos) {
  const v = readVarint(buf, pos);
  const end = v.next + v.value;
  if (end > buf.length) throw new RangeError('length-prefixed slice 越界');
  return { value: buf.subarray(v.next, end), next: end };
}

// ===========================================================================
// §2 crc32c（Castagnoli，LevelDB log/block 校验用）
// ===========================================================================

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32c(buf, start, end, crc) {
  const s = start === undefined ? 0 : start;
  const e = end === undefined ? buf.length : end;
  let c = ~(crc === undefined ? 0 : crc) >>> 0;
  for (let i = s; i < e; i += 1) {
    c = CRC32C_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/** 复用的 1 字节缓冲（crc 增量计算用）。 */
const TYPE_BYTE_BUF = Buffer.alloc(1);

/**
 * 计算「A ‖ typeByte」的屏蔽前 crc32c（**typeByte 在后**）。
 *
 * 用于 **SSTable block trailer**：LevelDB 规范是
 *   `block: crc = Mask(crc32c(block_contents ‖ compression_type))`
 * 即「先算内容的 crc，再用 type 字节 Extend 一次」。
 */
function crc32cWithTypeByte(firstBuf, firstStart, firstEnd, typeByte) {
  TYPE_BYTE_BUF[0] = typeByte;
  return crc32c(TYPE_BYTE_BUF, 0, 1, crc32c(firstBuf, firstStart, firstEnd));
}

/**
 * 计算「typeByte ‖ payload」的屏蔽前 crc32c（**typeByte 在前**）。
 *
 * 用于 **LevelDB log 记录**：规范原文（log_format.md）是
 *   `checksum: Mask(crc32c(type ‖ payload))`
 * ⚠️ 与 block trailer 的**顺序相反**。此前 log 解析误用了 `crc32cWithTypeByte`
 * （type 在后），导致**每一条记录都报 CRC 不符**（实测 158/158、51/51 全错），
 * 且 `strictCrc=true` 时会把全部记录丢掉。payload 本身没错，所以数据仍能解出
 * ——这类「恒定偏移的假告警」最容易骗过只看结果的验收。
 */
function crc32cTypeThenPayload(typeByte, buf, start, end) {
  TYPE_BYTE_BUF[0] = typeByte;
  // 先算 type 字节的 crc，再把 payload 接上去 continue
  return crc32c(buf, start, end, crc32c(TYPE_BYTE_BUF, 0, 1));
}

/** LevelDB log 的 CRC 屏蔽：(crc >> 15) | (crc << 17) 再 + 0xa282ead8。 */
function maskCrc32c(crc) {
  const rotated = ((crc >>> 15) | (crc << 17)) >>> 0;
  return (rotated + 0xa282ead8) >>> 0;
}

function maskedCrc32c(buf, start, end) {
  return maskCrc32c(crc32c(buf, start, end));
}

// ===========================================================================
// §3 Snappy 解压（Chromium leveldb 默认压缩 = Snappy）
// ===========================================================================

/** 解压 Snappy raw（非 framed）流。 */
function snappyUncompress(input) {
  if (input.length === 0) throw new Error('snappy: 空输入');
  const head = readVarint(input, 0);
  const expected = head.value;
  let ip = head.next;
  const out = Buffer.allocUnsafe(expected);
  let op = 0;

  while (ip < input.length) {
    const tag = input[ip];
    ip += 1;
    const kind = tag & 0x03;

    if (kind === 0) {
      // literal
      let len = tag >>> 2;
      if (len >= 60) {
        const extra = len - 59; // 60→1B 61→2B 62→3B 63→4B
        len = 0;
        for (let i = 0; i < extra; i += 1) {
          if (ip >= input.length) throw new Error('snappy: literal 长度越界');
          len += input[ip] * Math.pow(2, 8 * i);
          ip += 1;
        }
      }
      len += 1;
      if (ip + len > input.length) throw new Error('snappy: literal 数据越界');
      if (op + len > out.length) throw new Error('snappy: 输出越界(literal)');
      input.copy(out, op, ip, ip + len);
      op += len;
      ip += len;
    } else {
      // copy
      let len;
      let offset;
      if (kind === 1) {
        len = ((tag >>> 2) & 0x07) + 4;
        if (ip >= input.length) throw new Error('snappy: copy1 越界');
        offset = ((tag >>> 5) << 8) | input[ip];
        ip += 1;
      } else if (kind === 2) {
        len = (tag >>> 2) + 1;
        if (ip + 2 > input.length) throw new Error('snappy: copy2 越界');
        offset = input[ip] | (input[ip + 1] << 8);
        ip += 2;
      } else {
        len = (tag >>> 2) + 1;
        if (ip + 4 > input.length) throw new Error('snappy: copy4 越界');
        offset = input.readUInt32LE(ip);
        ip += 4;
      }
      if (offset === 0 || offset > op) throw new Error(`snappy: 非法 offset=${offset} op=${op}`);
      if (op + len > out.length) throw new Error('snappy: 输出越界(copy)');
      for (let i = 0; i < len; i += 1) {
        out[op] = out[op - offset];
        op += 1;
      }
    }
  }

  if (op !== expected) throw new Error(`snappy: 长度不符 期望${expected} 实得${op}`);
  return out;
}

// ===========================================================================
// §4 SSTable block 解析
// ===========================================================================

/**
 * 读一个 block（含 trailer 校验 + 解压）。
 *
 * ⚠ 关键格式事实（实测取证，勿改）：LevelDB 的 BlockHandle.size **不含 5 字节 trailer**。
 * 上游 table_builder.cc::WriteRawBlock 在写 handle 时用的是 `block_contents_.size()`
 * （即压缩后内容长度，trailer 仅写到文件里但不计入 size）。
 * 因此原文件长度 = handle.offset + size + 5。若误减去 5 会读不到任何 entry。
 */
function readBlock(buf, offset, size, warn) {
  const total = size + BLOCK_TRAILER_SIZE;
  if (offset < 0 || offset + total > buf.length) {
    throw new Error(`block 越界: off=${offset} size=${size}(+5 trailer) file=${buf.length}`);
  }
  const compression = buf[offset + size];
  const crcStored = buf.readUInt32LE(offset + size + 1);
  const raw = buf.subarray(offset, offset + size);
  // block 校验覆盖 "content ‖ compression_type" 一个字节。
  const crcActual = maskCrc32c(crc32cWithTypeByte(raw, 0, raw.length, compression));
  if (crcActual !== crcStored && warn) {
    warn(`block crc 不符 @${offset} size=${size} 存储=${crcStored.toString(16)} 实算=${crcActual.toString(16)}`);
  }
  if (compression === 0) return { data: Buffer.from(raw), compression };
  if (compression === 1) return { data: snappyUncompress(raw), compression };
  throw new Error(`不支持的 block 压缩类型 ${compression}（1=snappy 已支持, 2=zstd 未支持）`);
}

/**
 * 遍历 block 内的 entry。key 为原始（internal）key。
 * @returns {Array<{key: Buffer, value: Buffer}>}
 */
function parseBlockEntries(data, warn) {
  const out = [];
  if (data.length < 4) throw new Error('block 太短');
  const numRestarts = data.readUInt32LE(data.length - 4);
  if (numRestarts > (data.length / 4) + 1) throw new Error(`restart 数非法 ${numRestarts}`);
  const restartArrayStart = data.length - 4 - numRestarts * 4;
  if (restartArrayStart < 0) throw new Error('restart array 越界');

  let pos = 0;
  let prevKey = Buffer.alloc(0);
  while (pos < restartArrayStart) {
    const shared = readVarint(data, pos);
    const nonShared = readVarint(data, shared.next);
    const valueLen = readVarint(data, nonShared.next);
    let p = valueLen.next;
    if (shared.value > prevKey.length) throw new Error('shared 前缀超过前 key 长度');
    if (p + nonShared.value + valueLen.value > data.length) throw new Error('entry 越界');
    const key = Buffer.concat([
      prevKey.subarray(0, shared.value),
      data.subarray(p, p + nonShared.value),
    ]);
    p += nonShared.value;
    const value = Buffer.from(data.subarray(p, p + valueLen.value));
    p += valueLen.value;
    if (p <= pos) throw new Error(`entry 游标未前进（pos=${pos} p=${p}），block 已损坏`);
    out.push({ key, value });
    prevKey = key;
    pos = p;
    if (out.length > 5_000_000) throw new Error('entry 数异常，疑似损坏');
  }
  return out;
}

/** 拆 internal key → {userKey, sequence, type}。 */
function splitInternalKey(key) {
  if (key.length < 8) throw new Error('internal key 短于 8 字节');
  const userKey = key.subarray(0, key.length - 8);
  const lo = key.readUInt32LE(key.length - 8);
  const hi = key.readUInt32LE(key.length - 4);
  const packed = (BigInt(hi) << 32n) | BigInt(lo);
  const type = Number(packed & 0xffn);
  const sequence = Number(packed >> 8n);
  return { userKey, sequence, type };
}

/**
 * 解析整个 SSTable。
 * @returns {{entries: Array<{userKey, sequence, type, value}>, blockCount: number}}
 */
function parseSSTable(buf, warn) {
  if (buf.length < FOOTER_SIZE) throw new Error(`文件过短(${buf.length}B)，不是 SSTable`);
  const magic = buf.subarray(buf.length - 8);
  if (!magic.equals(TABLE_MAGIC)) {
    throw new Error(`table magic 不符（得到 ${magic.toString('hex')}），不是 SSTable`);
  }
  const footerStart = buf.length - FOOTER_SIZE;
  const handles = [];
  {
    const a = readVarint(buf, footerStart);
    const b = readVarint(buf, a.next);
    const c = readVarint(buf, b.next);
    const d = readVarint(buf, c.next);
    handles.push({ offset: a.value, size: b.value }, { offset: c.value, size: d.value });
  }
  const indexHandle = handles[1];
  const indexBlock = readBlock(buf, indexHandle.offset, indexHandle.size, warn);
  const indexEntries = parseBlockEntries(indexBlock.data, warn);

  const entries = [];
  for (const idx of indexEntries) {
    // index entry value = BlockHandle(offset varint, size varint)
    let off;
    let sz;
    try {
      const a = readVarint(idx.value, 0);
      const b = readVarint(idx.value, a.next);
      off = a.value;
      sz = b.value;
    } catch (err) {
      if (warn) warn(`index 里的 block handle 解析失败: ${err.message}`);
      continue;
    }
    let dataBlock;
    try {
      dataBlock = readBlock(buf, off, sz, warn);
    } catch (err) {
      if (warn) warn(`data block 读取失败 off=${off} size=${sz}: ${err.message}`);
      continue;
    }
    let blockEntries;
    try {
      blockEntries = parseBlockEntries(dataBlock.data, warn);
    } catch (err) {
      if (warn) warn(`data block 解析失败 off=${off}: ${err.message}`);
      continue;
    }
    for (const e of blockEntries) {
      try {
        const { userKey, sequence, type } = splitInternalKey(e.key);
        entries.push({ userKey, sequence, type, value: e.value });
      } catch (err) {
        if (warn) warn(`internal key 解析失败: ${err.message}`);
      }
    }
  }
  return { entries, blockCount: indexEntries.length };
}

// ===========================================================================
// §5 LOG / MANIFEST（log::Writer 记录）
// ===========================================================================

/**
 * 读一个.log 文件，重组出完整 logical record 列表。
 * @returns {{records: Buffer[], warnings: string[]}}
 */
function readLogRecords(buf, strictCrc) {
  const records = [];
  const warnings = [];
  let pos = 0;
  let pending = null;

  while (pos < buf.length) {
    const blockOffset = pos % LOG_BLOCK_SIZE;
    const spaceLeft = LOG_BLOCK_SIZE - blockOffset;
    if (spaceLeft < LOG_HEADER_SIZE) {
      pos += spaceLeft; // 块尾不足以放 header，跳到下一块
      continue;
    }
    if (pos + LOG_HEADER_SIZE > buf.length) break;
    const crcStored = buf.readUInt32LE(pos);
    const length = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];

    if (type === LOG_ZERO && length === 0) {
      pos += spaceLeft; // 预分配/填充，跳到下一块
      continue;
    }
    if (length > spaceLeft - LOG_HEADER_SIZE) {
      warnings.push(`log 记录长度越界 @${pos}: len=${length} 块内剩余=${spaceLeft - LOG_HEADER_SIZE}（截断/损坏，停止解析）`);
      break;
    }
    const data = buf.subarray(pos + LOG_HEADER_SIZE, pos + LOG_HEADER_SIZE + length);
    // LevelDB 的 log crc 覆盖 "type ‖ payload"（type **在前**）。
    // ⚠️ 这里曾经误用 crc32cWithTypeByte（type 在后，那是 block trailer 的形状），
    //    结果 100% 记录报 CRC 不符。见该函数旁的注释。
    const crcActual = maskCrc32c(crc32cTypeThenPayload(type, data, 0, data.length));
    const crcOk = crcActual === crcStored;
    if (!crcOk) {
      warnings.push(`log crc 不符 @${pos} type=${type} len=${length}`);
      if (strictCrc) {
        pos += LOG_HEADER_SIZE + length;
        pending = null;
        continue;
      }
    }
    pos += LOG_HEADER_SIZE + length;

    if (type === LOG_FULL) {
      if (pending) {
        warnings.push('log: FULL 出现在未闭合的分片序列中，丢弃前序分片');
        pending = null;
      }
      records.push(data);
    } else if (type === LOG_FIRST) {
      if (pending) warnings.push('log: 新的 FIRST 覆盖未闭合分片');
      pending = [data];
    } else if (type === LOG_MIDDLE) {
      if (!pending) warnings.push('log: MIDDLE 没有前置 FIRST（丢弃）');
      else pending.push(data);
    } else if (type === LOG_LAST) {
      if (!pending) {
        warnings.push('log: LAST 没有前置 FIRST（丢弃）');
      } else {
        pending.push(data);
        records.push(Buffer.concat(pending));
        pending = null;
      }
    } else {
      warnings.push(`log: 未知记录类型 ${type} @${pos}`);
    }
  }
  if (pending) warnings.push('log: 结尾存在未闭合分片序列（文件正在写入或已截断）');
  return { records, warnings };
}

/**
 * 解析 WriteBatch。key 为 **user key**（非 internal key），sequence 来自批头。
 * @returns {Array<{userKey, sequence, type, value}>}
 */
function parseWriteBatch(buf, warn) {
  if (buf.length < 12) {
    if (warn) warn(`WriteBatch 头不足 12B（${buf.length}B），跳过`);
    return [];
  }
  const baseSeq = Number(buf.readBigUInt64LE(0));
  const count = buf.readUInt32LE(8);
  const out = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    if (pos >= buf.length) {
      if (warn) warn(`WriteBatch 记录不足：声明 ${count} 条，实读 ${i} 条`);
      break;
    }
    const type = buf[pos];
    pos += 1;
    let keyLen;
    try {
      const v = readVarint(buf, pos);
      keyLen = v.value;
      pos = v.next;
    } catch (err) {
      if (warn) warn(`WriteBatch key 长度解析失败: ${err.message}`);
      break;
    }
    if (pos + keyLen > buf.length) {
      if (warn) warn('WriteBatch key 越界，停止');
      break;
    }
    const userKey = Buffer.from(buf.subarray(pos, pos + keyLen));
    pos += keyLen;
    let value = Buffer.alloc(0);
    if (type === TYPE_VALUE) {
      let valLen;
      try {
        const v = readVarint(buf, pos);
        valLen = v.value;
        pos = v.next;
      } catch (err) {
        if (warn) warn(`WriteBatch value 长度解析失败: ${err.message}`);
        break;
      }
      if (pos + valLen > buf.length) {
        if (warn) warn('WriteBatch value 越界，停止');
        break;
      }
      value = Buffer.from(buf.subarray(pos, pos + valLen));
      pos += valLen;
    } else if (type !== TYPE_DELETION) {
      if (warn) warn(`WriteBatch 未知记录类型 ${type}，尝试按 DELETE 处理`);
    }
    out.push({ userKey, sequence: baseSeq + i, type, value });
  }
  return out;
}

/** 解析 log 文件（.log / MANIFEST）→ 记录列表 + 警告。 */
function parseLogFile(buf, strictCrc) {
  const { records, warnings } = readLogRecords(buf, strictCrc);
  return { records, warnings };
}

// ===========================================================================
// §6 MANIFEST → 文件级别映射
// ===========================================================================

const VE_COMPARATOR = 1;
const VE_LOG_NUMBER = 2;
const VE_NEXT_FILE_NUMBER = 3;
const VE_LAST_SEQUENCE = 4;
const VE_COMPACT_POINTER = 5;
const VE_DELETED_FILE = 6;
const VE_NEW_FILE = 7;
const VE_PREV_LOG_NUMBER = 9;

/**
 * 回放 MANIFEST，得到当前 version 的 {fileNumber → level}。
 * @returns {{levels: Map<number, number>, logNumber: number, lastSequence: number, warnings: string[]}}
 */
function parseManifest(buf, strictCrc) {
  const { records, warnings } = readLogRecords(buf, strictCrc);
  const levels = new Map();
  let logNumber = 0;
  let lastSequence = 0;
  for (const rec of records) {
    let pos = 0;
    while (pos < rec.length) {
      let tag;
      try {
        const t = readVarint(rec, pos);
        tag = t.value;
        pos = t.next;
        switch (tag) {
          case VE_COMPARATOR: {
            const s = readLengthPrefixedSlice(rec, pos);
            pos = s.next;
            break;
          }
          case VE_LOG_NUMBER: {
            const v = readVarint(rec, pos);
            logNumber = v.value;
            pos = v.next;
            break;
          }
          case VE_NEXT_FILE_NUMBER: {
            pos = readVarint(rec, pos).next;
            break;
          }
          case VE_LAST_SEQUENCE: {
            const v = readVarint(rec, pos);
            lastSequence = v.value;
            pos = v.next;
            break;
          }
          case VE_COMPACT_POINTER: {
            pos = readVarint(rec, pos).next;
            const s = readLengthPrefixedSlice(rec, pos);
            pos = s.next;
            break;
          }
          case VE_DELETED_FILE: {
            const lv = readVarint(rec, pos);
            const num = readVarint(rec, lv.next);
            pos = num.next;
            levels.delete(num.value);
            break;
          }
          case VE_NEW_FILE: {
            const lv = readVarint(rec, pos);
            const num = readVarint(rec, lv.next);
            const sz = readVarint(rec, num.next);
            const smallest = readLengthPrefixedSlice(rec, sz.next);
            const largest = readLengthPrefixedSlice(rec, smallest.next);
            pos = largest.next;
            levels.set(num.value, lv.value);
            break;
          }
          case VE_PREV_LOG_NUMBER: {
            pos = readVarint(rec, pos).next;
            break;
          }
          default:
            throw new Error(`未知 VersionEdit tag ${tag}`);
        }
      } catch (err) {
        warnings.push(`MANIFEST VersionEdit 解析中断(tag=${tag}): ${err.message}`);
        pos = rec.length;
      }
    }
  }
  return { levels, logNumber, lastSequence, warnings };
}

// ===========================================================================
// §7 Chromium LocalStorage 键/值解码（实测字节布局）
// ===========================================================================

function utf8(buf) {
  return Buffer.from(buf).toString('utf8');
}

function latin1(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i += 1) s += String.fromCharCode(buf[i]);
  return s;
}

function utf16le(buf) {
  const n = buf.length - (buf.length % 2);
  let s = '';
  for (let i = 0; i < n; i += 2) s += String.fromCharCode(buf[i] | (buf[i + 1] << 8));
  if (n !== buf.length) s += '\ufffd';
  return s;
}

/**
 * 解码 leveldb user key → {kind:'meta'|'data'|'unknown', origin, key, ...}
 *
 * ⚠ 实测字节布局（2026-10-11 用 --dump-raw 对真实宿主库取证，勿凭想象改）：
 *
 *   data key = 0x5f('_') + <origin utf8> + 0x00 + <flag> + <body>
 *       flag=0x00 → body 为 **UTF-16LE** 码元序列
 *       flag=0x01 → body 为 **8-bit / Latin-1**（每字节一字符）
 *   实测样本：
 *     _dsh-app://app \x00 \x01 "dsh.sessions.current"
 *       → 5f 6473682d6170703a2f2f617070 00 01 6473682e73657373696f6e732e63757272656e74
 *     _dsh-app://app \x00 \x00 "dsh.sidebar-right.v1.session-…"
 *       → 5f 6473682d6170703a2f2f617070 00 00 d700 6800 2e00 …（每字符后跟 0x00 = UTF-16LE）
 *
 *   meta key = "META:" + <origin utf8>
 *
 * 注意：任务书初稿曾假定「0x00=Latin1 / 0x01=UTF-16」，与实测相反；
 * 判据是同一文件内 0x01 的 body 全是 ASCII 单字节、0x00 的 body 全是 "字符+00" 交错。
 */
function decodeStorageKey(raw) {
  if (raw.length >= 5 && raw.subarray(0, 5).toString('latin1') === 'META:') {
    return { kind: 'meta', origin: utf8(raw.subarray(5)), rawKey: raw };
  }
  if (raw.length > 1 && raw[0] === 0x5f /* '_' */) {
    const sep = raw.indexOf(0x00, 1);
    if (sep > 1) {
      const origin = utf8(raw.subarray(1, sep));
      const rest = raw.subarray(sep + 1);
      if (rest.length < 1) {
        return { kind: 'data', origin, key: null, flag: null, rawKey: raw, problem: '脚本 key 为空' };
      }
      const flag = rest[0];
      const body = rest.subarray(1);
      if (flag === 0x00) {
        return { kind: 'data', origin, key: utf16le(body), flag, encoding: 'utf16le', rawKey: raw };
      }
      if (flag === 0x01) {
        return { kind: 'data', origin, key: latin1(body), flag, encoding: 'latin1', rawKey: raw };
      }
      return {
        kind: 'data',
        origin,
        key: null,
        flag,
        rawKey: raw,
        problem: `未知 key 编码标志 0x${flag.toString(16)}`,
      };
    }
    return { kind: 'unknown', origin: null, rawKey: raw, problem: '没有 origin 分隔符 0x00' };
  }
  return { kind: 'unknown', origin: null, rawKey: raw, problem: '未知 key 前缀' };
}

/**
 * 解码 LocalStorage 的值。
 * ⚠ 实测：值首字节与 key 同约定 —— 0x00=UTF-16LE，0x01=8-bit Latin-1；空值长度为 0。
 *   实测样本：值 00 7b00 2200 … = `{"…` UTF-16LE；值 01 7b22 6472… = `{"dr…` ASCII。
 * 兼容：若首字节既非 0x00 也非 0x01（罕见/旧版本），按 UTF-8 兜底并标 suspicious。
 */
function decodeStorageValue(buf) {
  if (buf.length === 0) return { text: '', encoding: 'empty' };
  const flag = buf[0];
  const body = buf.subarray(1);
  if (flag === 0x00) {
    return { text: utf16le(body), encoding: 'utf16le' };
  }
  if (flag === 0x01) {
    return { text: latin1(body), encoding: 'latin1' };
  }
  return { text: utf8(buf), encoding: 'utf8-fallback', suspicious: true };
}

// ===========================================================================
// §8 主流程
// ===========================================================================

function fileNumberOf(name) {
  const m = /^(\d+)\.(ldb|sst|log)$/i.exec(name);
  return m ? Number(m[1]) : -1;
}

function listDataFiles(dir) {
  const names = fs.readdirSync(dir);
  const ldb = [];
  const logs = [];
  for (const name of names) {
    const m = /^(\d+)\.(ldb|sst)$/i.exec(name);
    if (m) ldb.push({ name, num: Number(m[1]) });
    const l = /^(\d+)\.log$/i.exec(name);
    if (l) logs.push({ name, num: Number(l[1]) });
  }
  ldb.sort((a, b) => b.num - a.num);
  logs.sort((a, b) => b.num - a.num);
  return { ldb, logs };
}

/**
 * 从 leveldb 目录提取 LocalStorage 键值。
 *
 * @param {object} opts
 * @param {string} opts.dir                leveldb 目录
 * @param {boolean} [opts.includeMeta]     是否把 META 值以 hex 形式放进 stores
 * @param {boolean} [opts.strictCrc]       log crc 不符时丢弃该记录（默认仍尝试解析）
 * @param {boolean} [opts.collectRecords]  是否返回原始记录（调试/取证）
 * @returns {{stores: object, meta: object, records: Array, stats: object, warnings: string[]}}
 */
function extractLevelDB(opts) {
  const options = opts || {};
  const dir = options.dir;
  if (!dir) throw new Error('缺少 dir');
  const t0 = process.hrtime.bigint();
  const warnings = [];

  const stats = {
    dir,
    files: [],
    totalBytes: 0,
    ldbEntries: 0,
    logEntries: 0,
    manifestFiles: 0,
    supersededRecords: 0,
    deletedKeys: 0,
    origins: 0,
    keys: 0,
    metaEntries: 0,
    undecodableKeys: [],
    byOrigin: {},
  };

  if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error(`不是目录: ${dir}`);

  const { ldb, logs } = listDataFiles(dir);

  // ---- MANIFEST（用于还原 level；缺失也能工作） ----
  let manifest = { levels: new Map(), logNumber: 0, lastSequence: 0 };
  const manifestName = fs
    .readdirSync(dir)
    .filter((n) => /^MANIFEST-\d+$/i.test(n))
    .sort()
    .pop();
  if (manifestName) {
    try {
      const mBuf = fs.readFileSync(path.join(dir, manifestName));
      const parsed = parseManifest(mBuf, options.strictCrc);
      manifest = parsed;
      stats.manifestFiles = manifest.levels.size;
      for (const w of parsed.warnings) warnings.push(`${manifestName}: ${w}`);
      stats.files.push({ name: manifestName, bytes: mBuf.length, kind: 'manifest', entries: manifest.levels.size });
      stats.totalBytes += mBuf.length;
    } catch (err) {
      warnings.push(`${manifestName}: 解析失败（忽略 level 信息）: ${err.message}`);
    }
  } else {
    warnings.push('未找到 MANIFEST-*，level 信息缺失，退化为「文件号越大越新」');
  }

  // ---- 来源新鲜度排序（数字越小越新） ----
  // 0..: LOG 文件（文件号大者优先）
  // 之后: L0（文件号大者优先）→ L1 → L2 ...
  const sources = [];
  let rank = 0;
  for (const f of logs) sources.push({ ...f, kind: 'log', rank: rank++ });
  const levelOf = (num) => (manifest.levels.has(num) ? manifest.levels.get(num) : 0);
  const sstSorted = [...ldb].sort((a, b) => {
    const la = levelOf(a.num);
    const lb = levelOf(b.num);
    if (la !== lb) return la - lb;
    return b.num - a.num;
  });
  for (const f of sstSorted) sources.push({ ...f, kind: 'sst', rank: rank++, level: levelOf(f.num) });

  // ---- 读取全部来源 ----
  const allRecords = [];
  for (const src of sources) {
    const full = path.join(dir, src.name);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (err) {
      warnings.push(`${src.name}: 读取失败: ${err.message}`);
      continue;
    }
    stats.totalBytes += buf.length;
    const fileStat = {
      name: src.name,
      bytes: buf.length,
      kind: src.kind,
      level: src.kind === 'sst' ? src.level : undefined,
      rank: src.rank,
      entries: 0,
      warnings: 0,
    };
    const warn = (m) => {
      fileStat.warnings += 1;
      warnings.push(`${src.name}: ${m}`);
    };
    try {
      if (src.kind === 'sst') {
        const { entries, blockCount } = parseSSTable(buf, warn);
        fileStat.blocks = blockCount;
        fileStat.entries = entries.length;
        stats.ldbEntries += entries.length;
        for (const e of entries) {
          allRecords.push({ ...e, source: src.name, rank: src.rank, kind: 'sst' });
        }
      } else {
        const { records, warnings: logWarns } = parseLogFile(buf, options.strictCrc);
        for (const w of logWarns) warn(w);
        let n = 0;
        for (const rec of records) {
          const batch = parseWriteBatch(rec, warn);
          for (const e of batch) {
            allRecords.push({ ...e, source: src.name, rank: src.rank, kind: 'log' });
            n += 1;
          }
        }
        fileStat.entries = n;
        fileStat.logRecords = records.length;
        stats.logEntries += n;
      }
    } catch (err) {
      warn(`解析失败: ${err.message}`);
    }
    stats.files.push(fileStat);
  }

  // ---- 合并：sequence 最大者胜；相同则来源更新者胜 ----
  const winner = new Map(); // rawUserKey(hex/base64) → record
  for (const rec of allRecords) {
    const id = rec.userKey.toString('base64');
    const cur = winner.get(id);
    if (!cur) {
      winner.set(id, rec);
      continue;
    }
    const better =
      rec.sequence > cur.sequence || (rec.sequence === cur.sequence && rec.rank < cur.rank);
    if (better) {
      stats.supersededRecords += 1;
      winner.set(id, rec);
    } else {
      stats.supersededRecords += 1;
    }
  }

  // ---- 解码 + 组装 ----
  const stores = {};
  const meta = {};
  const records = [];
  for (const rec of winner.values()) {
    if (rec.type === TYPE_DELETION) {
      stats.deletedKeys += 1;
      if (options.collectRecords) {
        records.push({
          keyRaw: rec.userKey,
          keyHex: rec.userKey.toString('hex'),
          source: rec.source,
          sequence: rec.sequence,
          type: 'DELETE',
        });
      }
      continue;
    }
    const dec = decodeStorageKey(rec.userKey);
    if (dec.kind === 'meta') {
      stats.metaEntries += 1;
      meta[dec.origin] = rec.value.toString('hex');
      if (options.includeMeta) {
        if (!stores[dec.origin]) stores[dec.origin] = {};
        stores[dec.origin]['__META__'] = rec.value.toString('hex');
      }
      continue;
    }
    if (dec.kind !== 'data' || dec.key === null) {
      stats.undecodableKeys.push({
        source: rec.source,
        sequence: rec.sequence,
        hex: rec.userKey.toString('hex'),
        problem: dec.problem || '未知',
      });
      continue;
    }
    const val = decodeStorageValue(rec.value);
    if (!stores[dec.origin]) stores[dec.origin] = {};
    stores[dec.origin][dec.key] = val.text;
    if (options.collectRecords) {
      records.push({
        origin: dec.origin,
        key: dec.key,
        keyHex: rec.userKey.toString('hex'),
        keyRaw: rec.userKey,
        keyFlag: dec.flag,
        keyEncoding: dec.encoding,
        valueEncoding: val.encoding,
        valueBytes: rec.value.length,
        valueHex: rec.value.toString('hex'),
        source: rec.source,
        kind: rec.kind,
        sequence: rec.sequence,
      });
    }
  }

  // ---- 统计 ----
  const origins = Object.keys(stores).sort();
  const out = {};
  let keyTotal = 0;
  for (const o of origins) {
    const keys = Object.keys(stores[o]).sort();
    out[o] = {};
    for (const k of keys) out[o][k] = stores[o][k];
    keyTotal += keys.length;
    stats.byOrigin[o] = keys.length;
  }
  stats.origins = origins.length;
  stats.keys = keyTotal;
  stats.elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  stats.allRecords = allRecords.length;

  return { stores: out, meta, records, stats, warnings };
}

// ===========================================================================
// §9 CLI
// ===========================================================================

function parseArgv(argv) {
  const o = {
    dir: DEFAULT_DSH_DIR,
    out: null,
    pretty: false,
    check: DEFAULT_CHECK_KEYS,
    checkExplicit: false,
    dumpRaw: false,
    hexLimit: 160,
    includeMeta: false,
    strictCrc: false,
    quiet: false,
    report: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} 缺少参数`);
      return argv[i];
    };
    switch (a) {
      case '--dir': o.dir = next(); break;
      case '--out': o.out = next(); break;
      case '--report': o.report = next(); break;
      case '--pretty': o.pretty = true; break;
      case '--check': o.check = next().split(',').map((s) => s.trim()).filter(Boolean); o.checkExplicit = true; break;
      case '--no-check': o.check = []; o.checkExplicit = true; break;
      case '--dump-raw': o.dumpRaw = true; break;
      case '--hex-limit': o.hexLimit = Number(next()); break;
      case '--include-meta': o.includeMeta = true; break;
      case '--strict-crc': o.strictCrc = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h':
      case '--help': o.help = true; break;
      default: throw new Error(`未知参数 ${a}`);
    }
  }
  return o;
}

function hexPreview(buf, limit) {
  const hex = buf.toString('hex');
  if (hex.length <= limit) return hex;
  return `${hex.slice(0, limit)}…(+${buf.length - limit / 2}B)`;
}

function asciiPreview(buf, limit) {
  let s = '';
  for (const b of buf) {
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    if (s.length >= limit) break;
  }
  return s;
}

function main(argv) {
  let o;
  try {
    o = parseArgv(argv);
  } catch (err) {
    process.stderr.write(`参数错误: ${err.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(
      'host-ls-extract.cjs --dir <leveldb dir> [--out f.json] [--pretty] [--check k1,k2]\n' +
        '                   [--dump-raw] [--hex-limit N] [--include-meta] [--strict-crc] [--quiet]\n'
    );
    return 0;
  }

  let result;
  try {
    result = extractLevelDB({
      dir: o.dir,
      includeMeta: o.includeMeta,
      strictCrc: o.strictCrc,
      collectRecords: o.dumpRaw,
    });
  } catch (err) {
    process.stderr.write(`提取失败: ${err.message}\n`);
    return 1;
  }

  const lines = [];
  const log = (s) => lines.push(s);

  if (o.dumpRaw) {
    log('=== 原始记录 dump（按来源文件序，未合并） ===');
    for (const f of result.stats.files) {
      if (f.kind === 'manifest') continue;
      log(`-- ${f.name} kind=${f.kind} level=${f.level === undefined ? '-' : f.level} bytes=${f.bytes} entries=${f.entries}`);
    }
    log('');
    log('=== 胜出记录（合并后）原始 key hex ===');
    for (const r of result.records) {
      if (r.type === 'DELETE') {
        log(`[${r.source} seq=${r.sequence}] DELETE key=${hexPreview(r.keyRaw, o.hexLimit)}`);
        continue;
      }
      const raw = Buffer.from(r.keyHex, 'hex');
      log(
        `[${r.source} seq=${r.sequence} ${r.keyEncoding || '?'}] origin=${r.origin}\n` +
          `    key="${r.key}"\n` +
          `    rawKey(${raw.length}B)=${hexPreview(raw, o.hexLimit)}\n` +
          `    ascii=${asciiPreview(raw, 64)}\n` +
          `    val(${r.valueBytes}B)=${hexPreview(Buffer.from(r.valueHex, 'hex'), Math.min(o.hexLimit, 120))} valEnc=${r.valueEncoding}`
      );
    }
  }

  const json = JSON.stringify(result.stores, null, o.pretty ? 2 : 0);
  if (o.out) {
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(o.out, json, 'utf8');
  } else if (!o.dumpRaw) {
    process.stdout.write(`${json}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.stores, null, 2)}\n`);
  }

  // ---- 报告（stderr） ----
  log('');
  log(`dir: ${result.stats.dir}`);
  log(`文件: ${result.stats.files.length} 个，合计 ${result.stats.totalBytes} B`);
  for (const f of result.stats.files) {
    if (f.kind === 'manifest') continue;
    log(
      `  ${f.name.padEnd(16)} ${String(f.bytes).padStart(8)} B  kind=${String(f.kind).padEnd(4)} ` +
        `level=${f.level === undefined ? '-' : f.level} entries=${String(f.entries).padStart(5)} warn=${f.warnings}`
    );
  }
  log(
    `记录: 合并前 ${result.stats.allRecords} 条（sst ${result.stats.ldbEntries} + log ${result.stats.logEntries}），` +
      `被更新版本覆盖 ${result.stats.supersededRecords} 条，DELETE 生效 ${result.stats.deletedKeys} 条`
  );
  log(`结果: origin ${result.stats.origins} 个，key 合计 ${result.stats.keys} 个，META ${result.stats.metaEntries} 条`);
  for (const origin of Object.keys(result.stats.byOrigin).sort()) {
    log(`  ${origin}  →  ${result.stats.byOrigin[origin]} keys`);
  }
  log(`耗时: ${result.stats.elapsedMs.toFixed(1)} ms`);

  if (o.check.length) {
    log('');
    log(`检查 key（${o.check.length} 个，全库跨 origin 查找）:`);
    for (const k of o.check) {
      const hits = [];
      for (const origin of Object.keys(result.stores)) {
        for (const kk of Object.keys(result.stores[origin])) {
          if (kk === k || kk.startsWith(k)) {
            hits.push(`${origin} :: ${kk} = ${JSON.stringify(result.stores[origin][kk]).slice(0, 80)}`);
          }
        }
      }
      if (hits.length === 0) log(`  ✗ ${k}  → 未找到`);
      else for (const h of hits) log(`  ✓ ${k}  → ${h}`);
    }
  }

  if (result.stats.undecodableKeys.length) {
    log('');
    log(`无法解码的 key ${result.stats.undecodableKeys.length} 个:`);
    for (const u of result.stats.undecodableKeys.slice(0, 20)) {
      log(`  ${u.problem}  seq=${u.sequence} hex=${u.hex.slice(0, 120)}`);
    }
  }
  if (result.warnings.length) {
    log('');
    log(`警告 ${result.warnings.length} 条:`);
    for (const w of result.warnings.slice(0, 40)) log(`  ! ${w}`);
    if (result.warnings.length > 40) log(`  …（余 ${result.warnings.length - 40} 条）`);
  }

  const report = `${lines.join('\n')}\n`;
  if (o.report) {
    fs.mkdirSync(path.dirname(path.resolve(o.report)), { recursive: true });
    fs.writeFileSync(o.report, report, 'utf8');
  }
  if (!o.quiet) process.stderr.write(report);

  return 0;
}

module.exports = {
  extractLevelDB,
  decodeStorageKey,
  decodeStorageValue,
  parseSSTable,
  splitInternalKey,
  parseBlockEntries,
  readBlock,
  readLogRecords,
  parseWriteBatch,
  parseManifest,
  snappyUncompress,
  crc32c,
  maskCrc32c,
  maskedCrc32c,
  readVarint,
  readLengthPrefixedSlice,
  listDataFiles,
  DEFAULT_DSH_DIR,
  DEFAULT_CHECK_KEYS,
  TABLE_MAGIC,
  LOG_BLOCK_SIZE,
  LOG_HEADER_SIZE,
  BLOCK_TRAILER_SIZE,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
