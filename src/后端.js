// MailProxy Worker
// 收信：catch-all -> 本 Worker -> ①转发 QQ  ②存 D1（双写，QQ 不丢）
// 发信：前端/CLI -> POST /api/send -> Resend(优先)/MailChannels Email API（双通道，支持附件，服务端限总量 40MB）
// 管理：/api/messages、/api/addresses（建/删邮箱别名 + 列信/读信/删信）
// 前端：GET / 返回 frontend/index.html（同源，登录只填账号，页面不显示账号名）
// 全程跑 Cloudflare 免费套餐，无 VPS、不绑卡。

const DOMAIN = env.DOMAIN || 'your-domain.example.com';
const ADMIN_ACCOUNT = env.ADMIN_ACCOUNT || 'admin'; // 登录账号（大小写不敏感；不出现在前端页面上；可用 ADMIN_ACCOUNT secret 覆盖）

// 轻量防撞库：按客户端 IP 限制登录尝试频率（内存级，够用即可）
const RL = new Map(); // ip -> { count, ts }
const RL_MAX = 20;    // 窗口内最多尝试次数
const RL_WINDOW = 60; // 窗口秒数
function loginAllowed(ip) {
  const now = Date.now();
  const e = RL.get(ip);
  if (!e || now - e.ts > RL_WINDOW * 1000) { RL.set(ip, { count: 1, ts: now }); return true; }
  e.count++;
  RL.set(ip, e);
  return e.count <= RL_MAX;
}

// ---------- 工具 ----------
function authOk(req, env) {
  const url = new URL(req.url);
  const q = url.searchParams.get('tk') || '';          // 允许 URL 带令牌（浏览器跳转下载用）
  const h = req.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return (t && t === env.ADMIN_TOKEN) || (q && q === env.ADMIN_TOKEN);
}
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}
// 轻量 MIME 正文提取：递归解析 multipart，支持 base64 / quoted-printable / 各字符集
function decodeTransfer(str, encoding, charset) {
  encoding = (encoding || '7bit').toLowerCase().trim();
  charset = (charset || 'utf-8').toLowerCase().trim();
  let bytes;
  try {
    if (encoding === 'base64') {
      const bin = atob(str.replace(/\s+/g, ''));
      bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    } else if (encoding === 'quoted-printable') {
      const qp = str.replace(/=(?:\r?\n)/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      bytes = Uint8Array.from(qp, c => c.charCodeAt(0));
    } else {
      bytes = Uint8Array.from(str, c => c.charCodeAt(0));
    }
  } catch (e) { return str; }
  try { return new TextDecoder(charset).decode(bytes); }
  catch (e) { try { return new TextDecoder('utf-8').decode(bytes); } catch (e2) { return str; } }
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

// 返回 { kind: 'plain'|'html'|'other', text }
function pickText(partStr, depth) {
  const hm = partStr.match(/\r?\n\r?\n/);
  const headers = ((hm ? partStr.slice(0, hm.index) : partStr) || '').replace(/\r?\n[ \t]+/g, ' ');
  const body = hm ? partStr.slice(hm.index + hm[0].length) : '';
  const ctype = (((headers.match(/content-type:\s*([^;\r\n]+)/i) || [])[1]) || 'text/plain').trim().toLowerCase();
  const cte = (((headers.match(/content-transfer-encoding:\s*([^\s;"\r\n]+)/i) || [])[1]) || '').trim();
  const charset = (((headers.match(/charset\s*=\s*"?([^";\r\n]+)/i) || [])[1]) || 'utf-8').trim();
  if (ctype.startsWith('multipart/') && depth < 5) {
    const b = (headers.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];
    if (!b) return { kind: 'other', text: '' };
    const delim = '--' + b;
    const first = body.indexOf(delim);
    if (first < 0) return { kind: 'other', text: '' };
    let plain = '', html = '';
    for (const seg of body.slice(first).split(delim)) {
      const s = seg.replace(/^\r?\n/, '');
      if (!s.trim() || s.trim() === '--') continue;
      const r = pickText(s, depth + 1);
      if (r.kind === 'plain' && !plain) plain = r.text;
      else if (r.kind === 'html' && !html) html = r.text;
      if (plain) break;
    }
    if (plain) return { kind: 'plain', text: plain };
    if (html) return { kind: 'html', text: html };
    return { kind: 'other', text: '' };
  }
  const text = decodeTransfer(body, cte, charset).trim();
  if (ctype.startsWith('text/plain')) return { kind: 'plain', text };
  if (ctype.startsWith('text/html')) return { kind: 'html', text: stripHtml(text) };
  return { kind: 'other', text: '' };
}

function extractPlainText(raw) {
  try {
    const r = pickText(raw, 0);
    return r.text || '';
  } catch (e) { return ''; }
}

// 解码 RFC 2047 编码词（=?UTF-8?B?...?= / =?...?Q?...?=），否则中文主题会显示成乱码
function decodeEncodedWords(s) {
  if (!s) return '';
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    try {
      let bytes;
      if (enc.toLowerCase() === 'b') {
        const bin = atob(txt);
        bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      } else {
        const q = txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(q, c => c.charCodeAt(0));
      }
      return new TextDecoder(cs).decode(bytes);
    } catch (e) { return m; }
  });
}

// 从原始信头解析真实发件人（message.from 是信封地址，Resend 等会显示成回执地址）
function extractFromHeader(raw) {
  const m = raw.match(/^from:\s*(.+)$/im);
  if (m) {
    const line = m[1].trim();
    const ang = line.match(/<([^>]+)>/);
    if (ang) return ang[1].trim();
    const bare = line.match(/[^\s'"]+@[^\s'"]+/);
    if (bare) return bare[0];
  }
  return null;
}

// ---------- 发信：双通道（Resend 优先，MailChannels API 备用） ----------
// 背景：MailChannels 于 2024-08-31 关停 Workers 免费通道，未认证请求返回 401。
// 现支持：env.RESEND_API_KEY（Resend，免费 100 封/天）或 env.MAILCHANNELS_API_KEY（MailChannels Email API 免费档）。
async function sendMail(env, { to, from, subject, text, html, name, attachments }) {
  if (!from || !from.endsWith('@' + DOMAIN)) {
    return new Response(JSON.stringify({ ok: false, error: '发件人必须是 @' + DOMAIN }), {
      status: 400, headers: { 'content-type': 'application/json', ...cors() },
    });
  }
  if (!to) {
    return new Response(JSON.stringify({ ok: false, error: '缺少收件人' }), {
      status: 400, headers: { 'content-type': 'application/json', ...cors() },
    });
  }
  // 归一化附件：[{ filename, type, content(base64) }]
  // Resend 硬限制：整封邮件（含 base64 编码后的附件）≤ 40MB。base64 膨胀约 33%，
  // 故原始文件总量 ≈ 29MB 为安全上限；这里按编码后 ≤ 39MB 兜底（留出正文/协议开销）。
  const MAX_ATT_B64 = 39 * 1048576;
  let atts = [];
  let totalB64 = 0;
  if (Array.isArray(attachments) && attachments.length) {
    for (const a of attachments.slice(0, 15)) {
      const b64 = String(a.content || '').replace(/\s/g, '');
      if (!b64) continue;
      try { atob(b64.slice(0, 64)); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: '附件 ' + (a.filename || '') + ' 不是有效的 base64' }), {
          status: 400, headers: { 'content-type': 'application/json', ...cors() },
        });
      }
      if (totalB64 + b64.length > MAX_ATT_B64) {
        return new Response(JSON.stringify({ ok: false, error: '附件编码后总量超过 39MB（Resend 上限 40MB），请减少附件' }), {
          status: 400, headers: { 'content-type': 'application/json', ...cors() },
        });
      }
      totalB64 += b64.length;
      atts.push({
        content: b64,
        filename: String(a.filename || 'attachment').replace(/[\r\n"]/g, ''),
        type: a.type || 'application/octet-stream',
      });
    }
  }

  // 通道 1：Resend
  if (env.RESEND_API_KEY) {
    const body = {
      from: name ? `${name} <${from}>` : from,
      to: to.split(',').map(s => s.trim()).filter(Boolean),
      subject: subject || '',
    };
    if (text) body.text = text;
    if (html) body.html = html;
    if (!body.text && !body.html) body.text = ' ';   // Resend 要求 text/html 至少其一，纯附件邮件兜底
    if (atts.length) body.attachments = atts.map(a => ({ filename: a.filename, content: a.content }));
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.RESEND_API_KEY },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    return new Response(JSON.stringify({ ok: r.ok, status: r.status, channel: 'resend', detail: txt }), {
      status: r.ok ? 200 : 502,
      headers: { 'content-type': 'application/json', ...cors() },
    });
  }

  // 通道 2：MailChannels Email API（带 Key；没 Key 会 401，仅作备用）
  const content = [];
  if (text) content.push({ type: 'text/plain', value: text });
  if (html) content.push({ type: 'text/html', value: html });
  if (!content.length) content.push({ type: 'text/plain', value: ' ' });   // 纯附件邮件兜底
  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from, name: name || from },
    subject: subject || '',
    content,
  };
  if (atts.length) {
    body.attachments = atts.map(a => ({ ...a, disposition: 'attachment' }));
  }
  const headers = { 'content-type': 'application/json' };
  if (env.MAILCHANNELS_API_KEY) headers['X-API-Key'] = env.MAILCHANNELS_API_KEY;
  const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const txt = await r.text();
  return new Response(JSON.stringify({ ok: r.ok, status: r.status, channel: 'mailchannels', detail: txt }), {
    status: r.ok ? 200 : 502,
    headers: { 'content-type': 'application/json', ...cors() },
  });
}

// ---------- 收信：email 事件 ----------
async function handleEmail(message, env, ctx) {
  // ① 双写：原样转发 QQ（保留现有收信体验）
  ctx.waitUntil(message.forward(env.QQ_EMAIL));
  // ② 存 D1（主题解码 RFC 2047；发件人从 From 信头解析，取不到再退回信封地址）
  const raw = await new Response(message.raw).text();
  const from = extractFromHeader(raw) || message.from;
  const to = message.to;
  const subject = decodeEncodedWords(message.headers.get('subject') || '');
  const text = extractPlainText(raw);
  ctx.waitUntil(
    env.DB.prepare(
      'INSERT INTO messages (from_addr,to_addr,subject,body_text,raw,received_at) VALUES (?,?,?,?,?,?)'
    ).bind(from, to, subject, text, raw, Date.now()).run()
  );
}

// 组装并返回云盘文件内容（管理下载 / 公开分享下载共用）
async function serveDriveFile(env, fileId, inline) {
  const meta = await env.DRV.prepare('SELECT name,type,size FROM files WHERE id=?').bind(fileId).first();
  if (!meta) return new Response(JSON.stringify({ ok: false, error: '文件不存在' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const { results } = await env.DRV.prepare('SELECT data FROM file_chunks WHERE file_id=? ORDER BY idx').bind(fileId).all();
  const out = new Uint8Array(meta.size);
  let off = 0;
  for (const r of results) {
    if (typeof r.data === 'string') {          // base64 TEXT 分块
      const bin = atob(r.data);
      out.set(Uint8Array.from(bin, c => c.charCodeAt(0)), off);
      off += bin.length;
    } else {                                    // 兼容历史 BLOB 分块
      const u8 = r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data || []);
      out.set(u8, off); off += u8.length;
    }
  }
  if (off !== meta.size) return new Response(JSON.stringify({ ok: false, error: '文件分块不完整（数据可能损坏）' }), { status: 500, headers: { 'content-type': 'application/json' } });
  return new Response(out, { headers: {
    'content-type': meta.type || 'application/octet-stream',
    'content-length': String(off),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
  } });
}

// 分享落地页（/s/<token> 或 /s/<token>=<提取码>）：与登录页同风格的简洁卡片
function sharePageHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='0'%3E%3Cstop offset='0' stop-color='%238B5CF6'/%3E%3Cstop offset='1' stop-color='%23EC4899'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='14' fill='url(%23g)'/%3E%3Cpath d='M52 10 28 34m24-24L36 52l-8-18-18-8 42-16z' fill='none' stroke='%23fff' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" />
<title>文件分享 · MailProxy</title>
<style>
:root {
  --bg0:#FFF0F5; --border:#F3DCE9; --text:#1E1B4B; --text2:#6366F1; --text3:#A5A8D8;
  --grad:linear-gradient(90deg,#8B5CF6,#EC4899);
  --card:rgba(255,255,255,0.78); --input:rgba(255,255,255,0.68); --accent:#EC4899;
  --bgimg:
    radial-gradient(1100px 700px at 8% -8%, rgba(255,228,225,0.95), transparent 60%),
    radial-gradient(1000px 720px at 96% 4%, rgba(230,230,250,0.90), transparent 62%),
    radial-gradient(900px 640px at 20% 108%, rgba(255,209,220,0.75), transparent 60%),
    radial-gradient(880px 600px at 88% 100%, rgba(216,191,246,0.65), transparent 62%);
}
html[data-theme="dark"] {
  --bg0:#15131f; --border:#3a2f55; --text:#ECE9FB; --text2:#B8A6F0; --text3:#8A82B8;
  --grad:linear-gradient(90deg,#A78BFA,#F472B6);
  --card:rgba(46,40,68,0.82); --input:rgba(54,47,80,0.65); --accent:#F472B6;
  --bgimg:
    radial-gradient(1100px 700px at 8% -8%, rgba(60,48,92,0.95), transparent 60%),
    radial-gradient(1000px 720px at 96% 4%, rgba(46,38,72,0.90), transparent 62%),
    radial-gradient(900px 640px at 20% 108%, rgba(72,46,84,0.75), transparent 60%),
    radial-gradient(880px 600px at 88% 100%, rgba(40,34,62,0.78), transparent 62%);
}
* { box-sizing:border-box; }
html, body { height:100%; }
body { margin:0; font-family:"Segoe UI","Microsoft YaHei UI",sans-serif; font-size:14px; color:var(--text);
  background:var(--bgimg), var(--bg0); background-attachment:fixed;
  display:flex; align-items:center; justify-content:center; }
.card { width:380px; max-width:calc(100vw - 28px); padding:38px 34px 30px; border-radius:16px;
  background:var(--card); border:1px solid var(--border);
  box-shadow:0 22px 60px rgba(88,70,170,0.28);
  backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); }
.mark { width:52px; height:52px; border-radius:16px; background:var(--grad); display:flex; align-items:center; justify-content:center;
  margin:0 auto 16px; box-shadow:0 8px 20px rgba(236,72,153,0.35); }
h1 { margin:0; font-size:20px; text-align:center; }
.sub { color:var(--text3); font-size:12px; margin:5px 0 22px; text-align:center; }
.fmeta { display:flex; align-items:center; gap:12px; padding:14px; border:1px solid var(--border); border-radius:12px;
  background:var(--input); margin-bottom:16px; }
.ficon { width:42px; height:42px; border-radius:10px; background:var(--grad); color:#fff; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; }
.fname { font-weight:600; word-break:break-all; }
.fsize { color:var(--text3); font-size:12px; margin-top:3px; }
input { width:100%; font-family:inherit; font-size:14px; color:var(--text); background:var(--input);
  border:1px solid var(--border); border-radius:9px; padding:11px 12px; outline:none; letter-spacing:4px; text-align:center; }
input:focus { border:1.5px solid var(--accent); }
.btn { width:100%; margin-top:14px; padding:12px 0; border:none; border-radius:10px; cursor:pointer;
  background:var(--grad); color:#fff; font-size:15px; font-weight:600; font-family:inherit;
  box-shadow:0 6px 16px rgba(236,72,153,0.32); transition:all .15s ease; }
.btn:hover { filter:brightness(1.07); }
.btn:disabled { opacity:.6; cursor:default; }
.err { color:#EE5A6F; font-size:12.5px; margin-top:10px; text-align:center; min-height:18px; }
.tip { color:var(--text3); font-size:11.5px; margin-top:14px; text-align:center; }
.hidden { display:none; }
.theme-toggle { position:fixed; top:18px; right:20px; width:40px; height:40px; border-radius:50%; cursor:pointer;
  border:1px solid var(--border); background:var(--card); color:var(--text); font-size:18px;
  box-shadow:0 6px 16px rgba(88,70,170,0.18); transition:transform .15s ease; }
.theme-toggle:hover { transform:scale(1.08); }
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-6px)} 75%{transform:translateX(6px)} }
.shake { animation:shake .25s ease; }
</style>
</head>
<body>
<button class="theme-toggle" id="tt" onclick="toggleTheme()" title="切换深色 / 浅色">🌙</button>
<div class="card">
  <div class="mark">
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9 22 2"/></svg>
  </div>
  <h1 id="h-title">文件分享</h1>
  <div class="sub" id="h-sub">MailProxy 云盘 · 在线下载</div>
  <div class="fmeta">
    <div class="ficon" id="ficon">🔒</div>
    <div><div class="fname" id="fname">加载中…</div><div class="fsize" id="fsize"></div></div>
  </div>
  <input id="code" class="hidden" placeholder="请输入提取码" maxlength="16" onkeydown="if(event.key==='Enter')dl()" />
  <button class="btn" id="dlbtn" onclick="dl()">下 载</button>
  <div class="err" id="err"></div>
  <div class="tip">由 MailProxy 云盘分享 · 通过浏览器下载管理器下载</div>
</div>
<script>
// 主题：手动选择优先，否则跟随系统
const saved = localStorage.getItem('mp_share_theme');
const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
const initT = saved || (sysDark ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', initT);
document.getElementById('tt').textContent = initT === 'dark' ? '☀️' : '🌙';
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('mp_share_theme', next);
  document.getElementById('tt').textContent = next === 'dark' ? '☀️' : '🌙';
}
// 链接支持 /s/<token>=<提取码>：带码打开免输入
const raw = decodeURIComponent(location.pathname.split('/')[2] || '');
const eq = raw.indexOf('=');
const T = eq >= 0 ? raw.slice(0, eq) : raw;
const PRE = eq >= 0 ? raw.slice(eq + 1) : '';
function fmt(b){ return b>1048576 ? (b/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(b/1024))+' KB'; }
function icon(t){ if((t||'').startsWith('image/'))return '🖼️'; if((t||'').startsWith('video/'))return '🎬'; if((t||'').startsWith('audio/'))return '🎵'; if((t||'').includes('pdf'))return '📕'; if((t||'').startsWith('text/'))return '📄'; return '📦'; }
let HAS = false, VERIFIED = false;
const errEl = document.getElementById('err'), codeEl = document.getElementById('code'), btn = document.getElementById('dlbtn');
function reveal(d) {
  VERIFIED = true;
  document.getElementById('ficon').textContent = icon(d.type);
  document.getElementById('fname').textContent = d.name;
  document.getElementById('fsize').textContent = fmt(d.size);
  document.title = d.name + ' · 文件分享';
}
async function check() {
  const code = PRE || codeEl.value.trim();
  const r = await fetch('/api/share/' + T + '?code=' + encodeURIComponent(code));
  const d = await r.json();
  if (r.status === 410) { document.getElementById('fname').textContent = '分享链接已过期'; document.getElementById('h-title').textContent = '文件分享'; btn.disabled = true; errEl.textContent = ''; return false; }
  if (!d.ok) { document.getElementById('fname').textContent = d.error || '分享不存在'; btn.disabled = true; return false; }
  if (d.hasCode && !d.verified) {
    HAS = true;
    document.getElementById('code').classList.remove('hidden');
    document.getElementById('fname').textContent = '🔒 加密分享';
    document.getElementById('fsize').textContent = '输入提取码后查看文件并下载';
    if (PRE) { errEl.textContent = ''; return await check(); }   // 链接自带提取码：自动验证
    return false;
  }
  reveal(d);
  codeEl.classList.add('hidden');
  errEl.textContent = '';
  return true;
}
check();
async function dl() {
  if (VERIFIED) { location.href = '/api/share/' + T + '/download' + (HAS ? '?code=' + encodeURIComponent(PRE || codeEl.value.trim()) : ''); return; }
  const code = (PRE || codeEl.value.trim());
  if (HAS && !code) { errEl.textContent = '请输入提取码'; codeEl.classList.add('shake'); setTimeout(()=>codeEl.classList.remove('shake'),300); return; }
  btn.disabled = true; btn.textContent = '验证中…';
  const ok = await check();
  btn.disabled = false; btn.textContent = '下 载';
  if (!ok) { codeEl.classList.add('shake'); setTimeout(()=>codeEl.classList.remove('shake'),300); errEl.textContent = errEl.textContent || '提取码错误'; return; }
  location.href = '/api/share/' + T + '/download?code=' + encodeURIComponent(code);
}
</script>
</body>
</html>`;
}

// ---------- HTTP API ----------
async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

  // 非 API 请求 → 返回静态前端（/ 直接由 assets 提供 index.html，同源）
  if (!p.startsWith('/api/')) {
    if (p.startsWith('/s/')) {
      const token = p.slice(3).replace(/[^a-zA-Z0-9]/g, '');
      if (!token) return env.ASSETS.fetch(request);
      return new Response(sharePageHTML(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return env.ASSETS.fetch(request);
  }

  // 登录（只校验账号，大小写不敏感；返回内部 token 供后续 API 鉴权）
  if (p === '/api/login' && method === 'POST') {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (!loginAllowed(ip)) {
      return new Response(JSON.stringify({ ok: false, error: '尝试过于频繁，请 1 分钟后再试' }), {
        status: 429, headers: { 'content-type': 'application/json', ...cors() },
      });
    }
    const { account } = await request.json().catch(() => ({}));
    const ok = !!account && account.trim().toLowerCase() === ADMIN_ACCOUNT;
    return new Response(JSON.stringify({ ok, token: ok ? env.ADMIN_TOKEN : null }), {
      status: ok ? 200 : 401, headers: { 'content-type': 'application/json', ...cors() },
    });
  }

  // ---------- 云盘公开分享（无需登录；有提取码时验证前不返回文件名） ----------
  if (p.startsWith('/api/share/') && method === 'GET') {
    const token = p.split('/')[3] || '';
    const sh = await env.DRV.prepare('SELECT * FROM shares WHERE token=?').bind(token).first();
    if (!sh) return new Response(JSON.stringify({ ok: false, error: '分享不存在或已取消' }), { status: 404, headers: { 'content-type': 'application/json', ...cors() } });
    if (sh.expires_at && sh.expires_at < Date.now()) {
      return new Response(JSON.stringify({ ok: false, error: '分享链接已过期' }), { status: 410, headers: { 'content-type': 'application/json', ...cors() } });
    }
    const provided = url.searchParams.get('code') || '';
    if (sh.code && provided !== sh.code) {
      return new Response(JSON.stringify({ ok: true, hasCode: true, verified: false }), { headers: { 'content-type': 'application/json', ...cors() } });
    }
    const meta = await env.DRV.prepare('SELECT name,size,type FROM files WHERE id=?').bind(sh.file_id).first();
    if (!meta) return new Response(JSON.stringify({ ok: false, error: '文件已删除' }), { status: 404, headers: { 'content-type': 'application/json', ...cors() } });
    if (p === '/api/share/' + token && !p.endsWith('/download')) {
      return new Response(JSON.stringify({ ok: true, hasCode: !!sh.code, verified: true, name: meta.name, size: meta.size, type: meta.type, downloads: sh.downloads || 0 }), { headers: { 'content-type': 'application/json', ...cors() } });
    }
    if (p === '/api/share/' + token + '/download') {
      ctx.waitUntil(env.DRV.prepare('UPDATE shares SET downloads=COALESCE(downloads,0)+1 WHERE token=?').bind(token).run());
      return serveDriveFile(env, sh.file_id, false);
    }
    return new Response('Not Found', { status: 404, headers: cors() });
  }

  if (!authOk(request, env)) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json', ...cors() },
    });
  }

  // 发信（成功后记录到「已发送」）
  if (p === '/api/send' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const resp = await sendMail(env, b);
    let data = {};
    try { data = await resp.json(); } catch (e) {}
    if (data.ok) {
      try {
        await env.DB.prepare('INSERT INTO sent (from_addr,to_addr,subject,body_text,sent_at) VALUES (?,?,?,?,?)')
          .bind(b.from || '', b.to || '', b.subject || '', b.text || '', Date.now()).run();
      } catch (e) {}
    }
    return new Response(JSON.stringify(data), { status: resp.status, headers: { 'content-type': 'application/json', ...cors() } });
  }

  // 列信（不含正文）；?to= 按收件人过滤；?deleted=1 查已删除
  if (p === '/api/messages' && method === 'GET') {
    const to = url.searchParams.get('to');
    const del = url.searchParams.get('deleted') === '1';
    let sql = 'SELECT id,from_addr,to_addr,subject,received_at FROM messages WHERE deleted=?';
    const binds = [del ? 1 : 0];
    if (to) { sql += ' AND to_addr=?'; binds.push(to); }
    sql += ' ORDER BY received_at DESC LIMIT 200';
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // 批量删信（{ ids: [1,2,3] }，默认软删除进「已删除」；purge:true 彻底删除）
  if (p === '/api/messages/bulk-delete' && method === 'POST') {
    const { ids, purge } = await request.json().catch(() => ({}));
    if (Array.isArray(ids) && ids.length) {
      const q = ids.map(() => '?').join(',');
      if (purge) await env.DB.prepare(`DELETE FROM messages WHERE id IN (${q})`).bind(...ids).run();
      else await env.DB.prepare(`UPDATE messages SET deleted=1, deleted_at=? WHERE id IN (${q})`).bind(Date.now(), ...ids).run();
    }
    return new Response(JSON.stringify({ ok: true, deleted: Array.isArray(ids) ? ids.length : 0 }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // 读信 / 删信
  let m = p.match(/^\/api\/messages\/(\d+)$/);
  if (m && method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(m[1]).first();
    if (row) {
      // 读信时实时从原始信件解析正文（新邮件解析逻辑自动作用于旧信）
      row.body_text = extractPlainText(row.raw) || '(未解析到正文)';
      delete row.raw;
    }
    return new Response(JSON.stringify(row || null), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (m && method === 'DELETE') {
    if (url.searchParams.get('purge') === '1') {
      await env.DB.prepare('DELETE FROM messages WHERE id=?').bind(m[1]).run();
    } else {
      await env.DB.prepare('UPDATE messages SET deleted=1, deleted_at=? WHERE id=?').bind(Date.now(), m[1]).run();
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  // 恢复（从已删除移回收件箱）
  if (m && method === 'POST') {
    await env.DB.prepare('UPDATE messages SET deleted=0, deleted_at=NULL WHERE id=?').bind(m[1]).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // 列地址别名
  if (p === '/api/addresses' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM addresses ORDER BY created_at DESC').all();
    return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  // 新建/更新地址别名（avatar：128x128 JPEG dataURL；starred：星标 0/1；更新时保留未传字段）
  if (p === '/api/addresses' && method === 'POST') {
    const { local, note, avatar, starred } = await request.json().catch(() => ({}));
    if (!local || !local.endsWith('@' + DOMAIN)) {
      return new Response(JSON.stringify({ ok: false, error: '须为完整 @' + DOMAIN + ' 地址' }), { status: 400, headers: { 'content-type': 'application/json', ...cors() } });
    }
    const av = (typeof avatar === 'string' && avatar.startsWith('data:image/') && avatar.length < 100000) ? avatar : null;
    const ex = await env.DB.prepare('SELECT note,avatar,starred FROM addresses WHERE local=?').bind(local).first();
    const n = (ex && avatar === undefined) ? ex.note : (note || '');
    const a = (av !== null) ? av : (ex ? ex.avatar : null);
    const st = (starred === undefined && ex) ? (ex.starred || 0) : ((starred === 1 || starred === true) ? 1 : 0);
    if (ex) {
      await env.DB.prepare('UPDATE addresses SET note=?,avatar=?,starred=? WHERE local=?').bind(n, a, st, local).run();
    } else {
      await env.DB.prepare('INSERT INTO addresses (local,note,avatar,starred,created_at) VALUES (?,?,?,?,?)').bind(local, n, a, st, Date.now()).run();
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  // 删地址别名
  m = p.match(/^\/api\/addresses\/(.+)$/);
  if (m && method === 'DELETE') {
    const local = decodeURIComponent(m[1]);
    await env.DB.prepare('DELETE FROM addresses WHERE local=?').bind(local).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // ---------- 云盘（独立 D1 库，分块存储） ----------
  // D1 限制：单行 ≤2MB，且 batch 的 BLOB 参数会报 Malformed input（序列化 bug），
  // 故分块以 base64 TEXT 存储：原始块 1.25MiB → base64 ≈1.67MB < 2MB。存储开销 +33%。
  const CHUNK_SZ = 1310720;
  const DRV_QUOTA = 350 * 1048576; // 预留 base64 膨胀空间，实际可存 ≈350MB 原始文件
  if (p === '/api/drive' && method === 'GET') {
    const { results } = await env.DRV.prepare('SELECT id,name,size,type,created_at FROM files ORDER BY created_at DESC').all();
    const u = await env.DRV.prepare('SELECT COALESCE(SUM(size),0) AS used, COUNT(*) AS cnt FROM files').first();
    return new Response(JSON.stringify({ files: results, used: u.used, count: u.cnt, quota: DRV_QUOTA }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (p === '/api/drive' && method === 'POST') {
    // 二进制直传：文件字节作为请求体，元数据在 query（避免 base64 编解码耗尽免费版 10ms CPU）
    const name = decodeURIComponent(url.searchParams.get('name') || '未命名').replace(/[\r\n]/g, '').slice(0, 200);
    const type = (url.searchParams.get('type') || 'application/octet-stream').slice(0, 100);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) return new Response(JSON.stringify({ ok: false, error: '缺少文件内容' }), { status: 400, headers: { 'content-type': 'application/json', ...cors() } });
    const u = await env.DRV.prepare('SELECT COALESCE(SUM(size),0) AS used FROM files').first();
    if (bytes.length > 25 * 1048576) {
      return new Response(JSON.stringify({ ok: false, error: '单文件上限 25MB' }), { status: 400, headers: { 'content-type': 'application/json', ...cors() } });
    }
    if (u.used + bytes.length > DRV_QUOTA) {
      return new Response(JSON.stringify({ ok: false, error: '云盘空间不足（免费版单库上限 500MB）' }), { status: 400, headers: { 'content-type': 'application/json', ...cors() } });
    }
    const r = await env.DRV.prepare('INSERT INTO files (name,size,type,created_at) VALUES (?,?,?,?)').bind(name, bytes.length, type, Date.now()).run();
    const fid = r.meta && r.meta.last_row_id;
    let useText = false;
    for (let i = 0; i * CHUNK_SZ < bytes.length; i++) {
      const chunk = bytes.subarray(i * CHUNK_SZ, Math.min((i + 1) * CHUNK_SZ, bytes.length));
      try {
        if (useText) throw new Error('text-fallback');
        await env.DRV.prepare('INSERT INTO file_chunks (file_id,idx,data) VALUES (?,?,?)').bind(fid, i, chunk).run();
      } catch (e) {
        // 环境不支持 BLOB 参数时回退 base64 TEXT（有小概率触发 CPU 限制，仅兜底）
        useText = true;
        let bin = '';
        for (let j = 0; j < chunk.length; j += 8192) bin += String.fromCharCode.apply(null, chunk.subarray(j, j + 8192));
        await env.DRV.prepare('INSERT INTO file_chunks (file_id,idx,data) VALUES (?,?,?)').bind(fid, i, btoa(bin)).run();
      }
    }
    return new Response(JSON.stringify({ ok: true, id: fid, size: bytes.length }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  // 创建分享（code 可选；expires 有效期小时数，可选 1/24/72/168/720，不传=永久；返回 /s/<token> 公开链接）
  const sm = p.match(/^\/api\/drive\/(\d+)\/share$/);
  if (sm && method === 'POST') {
    const { code, expires } = await request.json().catch(() => ({}));
    const meta = await env.DRV.prepare('SELECT id FROM files WHERE id=?').bind(sm[1]).first();
    if (!meta) return new Response(JSON.stringify({ ok: false, error: '文件不存在' }), { status: 404, headers: { 'content-type': 'application/json', ...cors() } });
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const cd = code ? String(code).trim().slice(0, 16) : null;
    const expHours = Number(expires);
    const expAt = [1, 24, 72, 168, 720].includes(expHours) ? Date.now() + expHours * 3600000 : null;
    await env.DRV.prepare('INSERT INTO shares (token,file_id,code,expires_at,created_at) VALUES (?,?,?,?,?)').bind(token, Number(sm[1]), cd, expAt, Date.now()).run();
    return new Response(JSON.stringify({ ok: true, token, url: url.origin + '/s/' + token, code: cd, expiresAt: expAt }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  m = p.match(/^\/api\/drive\/(\d+)$/);
  if (m && method === 'GET') {
    const inline = url.searchParams.get('inline') === '1';
    return serveDriveFile(env, Number(m[1]), inline);
  }
  if (m && method === 'POST') {
    const { name } = await request.json().catch(() => ({}));
    if (!name || !String(name).trim()) return new Response(JSON.stringify({ ok: false, error: '名称不能为空' }), { status: 400, headers: { 'content-type': 'application/json', ...cors() } });
    await env.DRV.prepare('UPDATE files SET name=? WHERE id=?').bind(String(name).trim().slice(0, 200), m[1]).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (m && method === 'DELETE') {
    await env.DRV.prepare('DELETE FROM file_chunks WHERE file_id=?').bind(m[1]).run();
    await env.DRV.prepare('DELETE FROM files WHERE id=?').bind(m[1]).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // ---------- 已发送（?from= 按发件账号过滤） ----------
  if (p === '/api/sent' && method === 'GET') {
    const from = url.searchParams.get('from');
    let sql = 'SELECT id,from_addr,to_addr,subject,sent_at FROM sent';
    const binds = [];
    if (from) { sql += ' WHERE from_addr=?'; binds.push(from); }
    sql += ' ORDER BY sent_at DESC LIMIT 200';
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  m = p.match(/^\/api\/sent\/(\d+)$/);
  if (m && method === 'GET') {
    const row = await env.DB.prepare('SELECT id,from_addr,to_addr,subject,body_text,sent_at FROM sent WHERE id=?').bind(m[1]).first();
    return new Response(JSON.stringify(row || null), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (m && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sent WHERE id=?').bind(m[1]).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // ---------- 草稿箱 ----------
  if (p === '/api/drafts' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id,from_addr,to_addr,subject,updated_at FROM drafts ORDER BY updated_at DESC LIMIT 200').all();
    return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (p === '/api/drafts' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (b.id) {
      await env.DB.prepare('UPDATE drafts SET from_addr=?,to_addr=?,subject=?,body_text=?,updated_at=? WHERE id=?')
        .bind(b.from || '', b.to || '', b.subject || '', b.text || '', Date.now(), b.id).run();
      return new Response(JSON.stringify({ ok: true, id: b.id }), { headers: { 'content-type': 'application/json', ...cors() } });
    }
    const r = await env.DB.prepare('INSERT INTO drafts (from_addr,to_addr,subject,body_text,updated_at) VALUES (?,?,?,?,?)')
      .bind(b.from || '', b.to || '', b.subject || '', b.text || '', Date.now()).run();
    return new Response(JSON.stringify({ ok: true, id: r.meta && r.meta.last_row_id }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  m = p.match(/^\/api\/drafts\/(\d+)$/);
  if (m && method === 'GET') {
    const row = await env.DB.prepare('SELECT id,from_addr,to_addr,subject,body_text,updated_at FROM drafts WHERE id=?').bind(m[1]).first();
    return new Response(JSON.stringify(row || null), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (m && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM drafts WHERE id=?').bind(m[1]).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // ---------- 重要联系人 / 通讯录 ----------
  if (p === '/api/contacts' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT addr,name,note,created_at FROM contacts ORDER BY created_at DESC').all();
    return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (p === '/api/contacts' && method === 'POST') {
    const { addr, name, note } = await request.json().catch(() => ({}));
    if (!addr || !addr.includes('@')) {
      return new Response(JSON.stringify({ ok: false, error: '地址无效' }), { status: 400, headers: { 'content-type': 'application/json', ...cors() } });
    }
    const ex = await env.DB.prepare('SELECT addr FROM contacts WHERE addr=?').bind(addr).first();
    if (ex) {
      await env.DB.prepare('UPDATE contacts SET name=?, note=? WHERE addr=?').bind(name || null, note || null, addr).run();
    } else {
      await env.DB.prepare('INSERT INTO contacts (addr,name,note,created_at) VALUES (?,?,?,?)').bind(addr, name || null, note || null, Date.now()).run();
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  m = p.match(/^\/api\/contacts\/(.+)$/);
  if (m && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM contacts WHERE addr=?').bind(decodeURIComponent(m[1])).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // ---------- 分享记录 / 取消分享 ----------
  m = p.match(/^\/api\/drive\/(\d+)\/shares$/);
  if (m && method === 'GET') {
    const { results } = await env.DRV.prepare('SELECT token,code,downloads,expires_at,created_at FROM shares WHERE file_id=? ORDER BY created_at DESC').bind(m[1]).all();
    return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  m = p.match(/^\/api\/share\/([a-z0-9]+)$/);
  if (m && method === 'DELETE') {
    await env.DRV.prepare('DELETE FROM shares WHERE token=?').bind(m[1]).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  // ---------- 记事本 ----------
  if (p === '/api/notes' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id,title,updated_at FROM notes ORDER BY updated_at DESC LIMIT 500').all();
    return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (p === '/api/notes' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const title = String(b.title || '无标题笔记').slice(0, 200);
    const content = String(b.content || '');
    if (b.id) {
      await env.DB.prepare('UPDATE notes SET title=?,content=?,updated_at=? WHERE id=?').bind(title, content, Date.now(), b.id).run();
      return new Response(JSON.stringify({ ok: true, id: b.id }), { headers: { 'content-type': 'application/json', ...cors() } });
    }
    const r = await env.DB.prepare('INSERT INTO notes (title,content,updated_at) VALUES (?,?,?)').bind(title, content, Date.now()).run();
    return new Response(JSON.stringify({ ok: true, id: r.meta && r.meta.last_row_id }), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  m = p.match(/^\/api\/notes\/(\d+)$/);
  if (m && method === 'GET') {
    const row = await env.DB.prepare('SELECT id,title,content,updated_at FROM notes WHERE id=?').bind(m[1]).first();
    return new Response(JSON.stringify(row || null), { headers: { 'content-type': 'application/json', ...cors() } });
  }
  if (m && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM notes WHERE id=?').bind(m[1]).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...cors() } });
  }

  return new Response('Not Found', { status: 404, headers: cors() });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500, headers: { 'content-type': 'application/json', ...cors() },
      });
    }
  },
  async email(message, env, ctx) {
    try {
      await handleEmail(message, env, ctx);
    } catch (e) {
      // 收信失败不应 reject 整封，记录到控制台即可
      console.error('email handle error', e);
    }
  },
  // 每日定时（北京时间凌晨 4 点）：清理「已删除」超过 30 天的邮件 + 过期的分享链接
  async scheduled(event, env, ctx) {
    try {
      const r = await env.DB.prepare('DELETE FROM messages WHERE deleted=1 AND deleted_at IS NOT NULL AND deleted_at < ?')
        .bind(Date.now() - 30 * 86400000).run();
      console.log('cron purge deleted messages:', r.meta && r.meta.changes);
      const s = await env.DRV.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?')
        .bind(Date.now()).run();
      console.log('cron purge expired shares:', s.meta && s.meta.changes);
    } catch (e) {
      console.error('cron purge error', e);
    }
  },
};
