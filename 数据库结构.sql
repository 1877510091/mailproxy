-- ============================================================
-- 自建邮箱后台 · 完整数据库结构（重建 / 迁移用）
-- 最后更新：2026-09-21，与 src/后端.js 当前实现保持一致
-- ============================================================
--
-- 本文件包含「邮件主库 (DB: mailproxy)」与「云盘库 (DRV: drive)」的全部表。
-- 两个库各自执行本文件一次即可；所有语句 IF NOT EXISTS，重复执行安全：
--
--   wrangler d1 execute mailproxy --remote --file=./数据库结构.sql
--   wrangler d1 execute mailproxy --local  --file=./数据库结构.sql
--   wrangler d1 execute drive     --remote --file=./数据库结构.sql
--   wrangler d1 execute drive     --local  --file=./数据库结构.sql
--
-- 说明：drive 库实际只需 files / file_chunks / shares 三表；
--       全量执行到 drive 库不会报错（多余表为空，无副作用）。
-- ============================================================


-- ===================== 邮件主库 (DB: mailproxy) =====================

-- 收件箱（双写：原信转发 QQ 的同时存此表）
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_addr  TEXT,
  to_addr    TEXT,
  subject    TEXT,
  body_text  TEXT,        -- 解析后的纯文本正文（读信时也会实时重解析 raw）
  raw        TEXT,        -- 原始信件全文（含信头），读信后前端不返回
  received_at INTEGER,    -- 毫秒时间戳
  deleted    INTEGER DEFAULT 0,   -- 软删除标记：1 = 在「已删除」
  deleted_at INTEGER              -- 软删除时间，用于定时清理 >30 天
);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(received_at DESC);

-- 邮箱别名（@your-domain.example.com 下的子地址）
CREATE TABLE IF NOT EXISTS addresses (
  local      TEXT PRIMARY KEY,   -- 完整地址，如 me@your-domain.example.com
  note       TEXT,
  created_at INTEGER,
  avatar     TEXT,               -- 128x128 JPEG dataURL（<100KB，可空）
  starred    INTEGER DEFAULT 0   -- 星标 0/1
);

-- 已发送
CREATE TABLE IF NOT EXISTS sent (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_addr  TEXT,
  to_addr    TEXT,
  subject    TEXT,
  body_text  TEXT,
  sent_at    INTEGER
);

-- 草稿箱
CREATE TABLE IF NOT EXISTS drafts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_addr  TEXT,
  to_addr    TEXT,
  subject    TEXT,
  body_text  TEXT,
  updated_at INTEGER
);

-- 通讯录 / 重要联系人
CREATE TABLE IF NOT EXISTS contacts (
  addr       TEXT PRIMARY KEY,
  name       TEXT,
  note       TEXT,
  created_at INTEGER
);

-- 记事本
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT,
  content    TEXT,
  updated_at INTEGER
);


-- ===================== 云盘库 (DRV: drive) =====================

-- 云盘文件元数据
CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT,
  size       INTEGER,   -- 字节
  type       TEXT,      -- MIME
  created_at INTEGER
);

-- 文件分块（D1 单行 ≤2MB，故每块 ≤1.25MiB）
-- data 优先存 BLOB；若运行时不支持 BLOB 参数，后端自动回退为 TEXT(base64)。
-- 读取时两种格式都兼容（代码按 typeof 判断），故本列用 BLOB 类型即可。
CREATE TABLE IF NOT EXISTS file_chunks (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER,
  idx     INTEGER,     -- 分块序号，0 起
  data    BLOB
);
CREATE INDEX IF NOT EXISTS idx_file_chunks_fid ON file_chunks(file_id);

-- 分享记录（公开下载链接 + 提取码 + 统计）
CREATE TABLE IF NOT EXISTS shares (
  token      TEXT PRIMARY KEY,  -- 12 位公开令牌，出现在 /s/<token>
  file_id    INTEGER,
  code       TEXT,              -- 提取码（可空 = 无码公开）
  created_at INTEGER,
  expires_at INTEGER,           -- 过期时间戳（可空 = 永久）
  downloads  INTEGER DEFAULT 0  -- 下载次数统计
);
