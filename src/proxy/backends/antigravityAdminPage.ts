// Fork patch: page of the multi-account admin panel (antigravityAdmin.ts serves it at /).
// Self-contained single page (no external assets): login, dashboard, accounts, proxy pool, API keys, settings.
// NOTE: the script below is inside a String.raw template, so it must not contain backticks or ${...}.
export const agAdminPageHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Antigravity 网关管理</title>
<script>try{var __t=localStorage.getItem("agyAdminTheme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",__t)}catch(e){document.documentElement.setAttribute("data-theme","light")}</script>
<style>
:root{--bg:#f4f6f9;--sf:#fff;--sf2:#f8fafc;--bd:#e4e8ef;--tx:#111827;--mu:#6b7280;--pr:#0d9488;--pr2:#0f766e;--prt:#fff;--prs:rgba(13,148,136,.1);--gr:#16a34a;--grs:rgba(22,163,74,.12);--ye:#d97706;--yes:rgba(217,119,6,.13);--rd:#dc2626;--rds:rgba(220,38,38,.1);--sh:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);--shl:0 16px 40px rgba(16,24,40,.18);--r:12px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light}
[data-theme=dark]{--bg:#0a101d;--sf:#111a2d;--sf2:#0d1526;--bd:#212d45;--tx:#e6eaf3;--mu:#8e9ab1;--pr:#2dd4bf;--pr2:#5eead4;--prt:#042f2a;--prs:rgba(45,212,191,.13);--gr:#4ade80;--grs:rgba(74,222,128,.14);--ye:#fbbf24;--yes:rgba(251,191,36,.14);--rd:#f87171;--rds:rgba(248,113,113,.15);--sh:none;--shl:0 16px 40px rgba(0,0,0,.55);color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0}
body{background:var(--bg);color:var(--tx);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
body[data-state=boot] #login,body[data-state=boot] #app{display:none}
body[data-state=login] #app{display:none}
body[data-state=app] #login{display:none}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--pr)}
.muted{color:var(--mu)}.xs{font-size:12px}.mono{font-family:var(--mono)}
svg.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none;vertical-align:-3px}

/* ---- login ---- */
#login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(900px 500px at 15% 0%,rgba(13,148,136,.16),transparent 60%),radial-gradient(800px 500px at 90% 100%,rgba(99,102,241,.14),transparent 60%),var(--bg)}
.lcard{width:100%;max-width:400px;background:var(--sf);border:1px solid var(--bd);border-radius:16px;box-shadow:var(--shl);padding:36px 32px 28px}
.lcard .logo{display:block;width:48px;height:48px;margin:0 auto 16px}
.lcard h1{margin:0;text-align:center;font-size:21px;font-weight:700;letter-spacing:.2px}
.lcard .sub{text-align:center;color:var(--mu);margin:6px 0 24px;font-size:13px}
.lcard .foot{margin-top:18px;text-align:center;color:var(--mu);font-size:12px}
.lerr{margin-top:12px;padding:8px 12px;border-radius:8px;background:var(--rds);color:var(--rd);font-size:13px}

/* ---- shell ---- */
#app{display:flex;min-height:100vh}
.side{width:240px;flex:none;background:var(--sf);border-right:1px solid var(--bd);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;z-index:40}
.brand{display:flex;align-items:center;gap:11px;padding:18px 20px 16px}
.brand .logo{width:34px;height:34px}
.brand b{display:block;font-size:15px;line-height:1.2;letter-spacing:.2px}
.brand span{font-size:11px;color:var(--mu);letter-spacing:.6px}
.nav{padding:6px 12px;display:flex;flex-direction:column;gap:2px;flex:1}
.nav .sec{padding:12px 10px 6px;font-size:11px;color:var(--mu);letter-spacing:.8px;text-transform:uppercase}
.nav a{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:9px;color:var(--mu);text-decoration:none;font-weight:500;cursor:pointer;transition:background .12s,color .12s}
.nav a:hover{background:var(--sf2);color:var(--tx)}
.nav a.on{background:var(--prs);color:var(--pr)}
.nav a .cnt{margin-left:auto;font-size:11px;padding:1px 7px;border-radius:99px;background:var(--rds);color:var(--rd);font-weight:600}
.sfoot{padding:14px 16px;border-top:1px solid var(--bd);display:flex;align-items:center;gap:8px}
.sfoot .ver{flex:1;min-width:0;font-size:12px;color:var(--mu)}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{height:60px;flex:none;display:flex;align-items:center;gap:10px;padding:0 24px;background:color-mix(in srgb,var(--sf) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:30}
.top h2{margin:0;font-size:17px;font-weight:650}
.top .sp{flex:1}
.content{padding:24px;width:100%;max-width:1360px;margin:0 auto}
.scrim{display:none}
.menubtn{display:none}
@media(max-width:900px){
  .side{position:fixed;left:0;top:0;transform:translateX(-102%);transition:transform .2s}
  .side.open{transform:none;box-shadow:var(--shl)}
  .scrim.on{display:block;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:35}
  .menubtn{display:inline-flex}
  .content{padding:16px}.top{padding:0 14px}
}

/* ---- controls ---- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;padding:0 14px;border:1px solid var(--bd);border-radius:9px;background:var(--sf);color:var(--tx);font-weight:500;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,box-shadow .12s}
.btn:hover{background:var(--sf2);border-color:color-mix(in srgb,var(--pr) 45%,var(--bd))}
.btn:focus-visible,.icon-btn:focus-visible,.nav a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--pr);outline-offset:1px}
.btn.primary{background:var(--pr);border-color:var(--pr);color:var(--prt)}
.btn.primary:hover{background:var(--pr2);border-color:var(--pr2)}
.btn.danger{color:var(--rd)}.btn.danger:hover{background:var(--rds);border-color:var(--rd)}
.btn.danger.solid{background:var(--rd);border-color:var(--rd);color:#fff}
.btn.sm{height:30px;padding:0 10px;font-size:13px;border-radius:8px}
.btn[disabled]{opacity:.55;cursor:not-allowed}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--mu);cursor:pointer}
.icon-btn:hover{background:var(--sf2);color:var(--tx)}
.icon-btn.bd{border-color:var(--bd);background:var(--sf)}
.spin{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:rot .7s linear infinite;display:inline-block}
@keyframes rot{to{transform:rotate(360deg)}}
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.field>label,.lbl{font-size:13px;font-weight:600}
.field .hint{font-size:12px;color:var(--mu)}
.inp,.sel,.txa{width:100%;height:38px;padding:0 12px;border:1px solid var(--bd);border-radius:9px;background:var(--sf);color:var(--tx);transition:border-color .12s,box-shadow .12s}
.txa{height:auto;min-height:130px;padding:10px 12px;resize:vertical;font-family:var(--mono);font-size:12.5px}
.inp:focus,.sel:focus,.txa:focus{outline:none;border-color:var(--pr);box-shadow:0 0 0 3px var(--prs)}
.inp.mono{font-family:var(--mono);font-size:13px}
.iwrap{position:relative}.iwrap .icon-btn{position:absolute;right:3px;top:2px}
.search{position:relative;width:260px;max-width:100%}
@media(max-width:560px){.search{width:100%}.toolbar .sp{display:none}.toolbar .btn.primary{margin-left:auto}}.search .i{position:absolute;left:11px;top:11px;color:var(--mu)}.search .inp{padding-left:34px}
.seg{display:inline-flex;padding:3px;background:var(--sf2);border:1px solid var(--bd);border-radius:10px;gap:2px}
.seg button{border:0;background:transparent;padding:6px 14px;border-radius:7px;color:var(--mu);font-weight:500;cursor:pointer}
.seg button.on{background:var(--sf);color:var(--tx);box-shadow:var(--sh)}
.sw{position:relative;width:38px;height:22px;flex:none}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:1}
.sw i{position:absolute;inset:0;border-radius:99px;background:var(--bd);transition:background .15s}
.sw i:after{content:"";position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.sw input:checked+i{background:var(--pr)}.sw input:checked+i:after{transform:translateX(16px)}
.sw input:focus-visible+i{outline:2px solid var(--pr);outline-offset:2px}

/* ---- surfaces ---- */
.card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh)}
.card>.hd{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--bd)}
.card>.hd h3{margin:0;font-size:15px;font-weight:650}
.card>.hd .sp{flex:1}
.card>.bd{padding:20px}
.stack{display:flex;flex-direction:column;gap:20px}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:16px}
.toolbar .sp{flex:1}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
@media(max-width:1000px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.stats{grid-template-columns:minmax(0,1fr)}}
.stat{padding:18px 20px;display:flex;gap:14px;align-items:flex-start}
.stat .ico{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:none;background:var(--prs);color:var(--pr)}
.stat .ico.g{background:var(--grs);color:var(--gr)}.stat .ico.y{background:var(--yes);color:var(--ye)}.stat .ico.r{background:var(--rds);color:var(--rd)}
.stat .k{font-size:12.5px;color:var(--mu)}
.stat .v{font-size:26px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;margin:2px 0}
.stat .s{font-size:12px;color:var(--mu)}
.cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:20px}
@media(max-width:1100px){.cols{grid-template-columns:minmax(0,1fr)}}
.tw{overflow-x:auto}
table{width:100%;min-width:780px;border-collapse:collapse}
th{padding:10px 16px;text-align:left;font-size:12px;font-weight:600;color:var(--mu);background:var(--sf2);border-bottom:1px solid var(--bd);white-space:nowrap}
td{padding:13px 16px;border-bottom:1px solid var(--bd);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--sf2)}
td.act{text-align:right;white-space:nowrap;width:1%}
.cell b{font-weight:600;white-space:nowrap}.cell .l2{font-size:12px;color:var(--mu);word-break:break-all}
.tag{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;background:var(--sf2);color:var(--mu);white-space:nowrap}
.tag:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.tag.green{background:var(--grs);color:var(--gr)}.tag.yellow{background:var(--yes);color:var(--ye)}.tag.red{background:var(--rds);color:var(--rd)}.tag.blue{background:var(--prs);color:var(--pr)}
.tag.plain:before{display:none}
.chip{display:inline-block;white-space:nowrap;padding:1px 8px;border-radius:6px;background:var(--sf2);border:1px solid var(--bd);font-size:12px;font-family:var(--mono)}
.bar{height:6px;border-radius:3px;background:var(--bd);overflow:hidden;flex:1;min-width:60px}.bar i{display:block;height:100%;border-radius:3px}
.c-green{background:var(--gr)}.c-yellow{background:var(--ye)}.c-red{background:var(--rd)}
.qrow{display:flex;align-items:center;gap:8px;font-size:12px;min-width:170px}.qrow+.qrow{margin-top:5px}
.qrow .ql{width:92px;color:var(--mu);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qrow .qp{width:36px;text-align:right;font-variant-numeric:tabular-nums}
.empty{padding:48px 20px;text-align:center;color:var(--mu)}
.empty .ei{width:52px;height:52px;margin:0 auto 12px;border-radius:14px;background:var(--prs);color:var(--pr);display:flex;align-items:center;justify-content:center}
.empty .ei svg{width:24px;height:24px}
.empty b{display:block;color:var(--tx);font-size:15px;margin-bottom:4px}
.empty .btn{margin-top:14px}
.skel{height:14px;border-radius:6px;background:linear-gradient(90deg,var(--bd),var(--sf2),var(--bd));background-size:200% 100%;animation:sk 1.2s infinite}
@keyframes sk{to{background-position:-200% 0}}
.skrow{padding:18px 20px;display:flex;flex-direction:column;gap:14px}
.kv{display:grid;grid-template-columns:150px 1fr;gap:0}
.kv>div{padding:12px 0;border-bottom:1px solid var(--bd)}.kv>div:nth-last-child(-n+2){border-bottom:0}
.kv>div:nth-child(odd){color:var(--mu)}
.list .row{display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--bd)}.list .row:last-child{border-bottom:0}
.list .row .grow{flex:1;min-width:0}
.note{display:flex;gap:10px;padding:12px 14px;border-radius:10px;font-size:13px;background:var(--yes);color:var(--tx)}
.note svg{color:var(--ye);margin-top:2px}
.note.info{background:var(--prs)}.note.info svg{color:var(--pr)}
pre.code{margin:0;padding:14px 16px;border-radius:10px;background:var(--sf2);border:1px solid var(--bd);font:12.5px/1.6 var(--mono);overflow:auto;white-space:pre-wrap;word-break:break-all}
.secret{display:flex;gap:8px}.secret .inp{font-family:var(--mono);font-size:13px}

/* ---- menu / modal / toast ---- */
.menu{position:relative;display:inline-block}
.pop{position:absolute;right:0;top:calc(100% + 4px);min-width:170px;background:var(--sf);border:1px solid var(--bd);border-radius:10px;box-shadow:var(--shl);padding:5px;z-index:25;text-align:left}
.pop button{display:flex;width:100%;align-items:center;gap:9px;padding:8px 10px;border:0;background:transparent;border-radius:7px;cursor:pointer;color:var(--tx)}
.pop button:hover{background:var(--sf2)}.pop button.danger{color:var(--rd)}.pop hr{border:0;border-top:1px solid var(--bd);margin:5px 2px}
.mback{position:fixed;inset:0;background:rgba(8,12,24,.5);backdrop-filter:blur(2px);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;overflow:auto;animation:fade .12s}
.modal{width:100%;max-width:520px;background:var(--sf);border:1px solid var(--bd);border-radius:16px;box-shadow:var(--shl);animation:pop .14s}
.modal.sm{max-width:420px}.modal.lg{max-width:680px}
.mhead{display:flex;align-items:center;padding:18px 22px 6px}.mhead h3{margin:0;flex:1;font-size:17px}
.mbody{padding:12px 22px 20px}.mfoot{display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--bd);background:var(--sf2);border-radius:0 0 16px 16px}.mfoot:empty{display:none}
.mbody p.msg{margin:4px 0 0;color:var(--mu);word-break:break-all}
.steps{display:flex;align-items:center;margin:4px 0 20px}
.steps .s{display:flex;align-items:center;gap:8px;color:var(--mu);font-size:13px;font-weight:500}
.steps .s b{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;background:var(--sf2);border:1px solid var(--bd)}
.steps .s.on{color:var(--tx)}.steps .s.on b{background:var(--pr);border-color:var(--pr);color:var(--prt)}
.steps .s.done b{background:var(--prs);border-color:var(--pr);color:var(--pr)}
.steps .ln{flex:1;height:1px;background:var(--bd);margin:0 12px}
.okmark{width:56px;height:56px;margin:6px auto 14px;border-radius:50%;background:var(--grs);color:var(--gr);display:flex;align-items:center;justify-content:center}
.okmark svg{width:28px;height:28px}.okmark.bad{background:var(--rds);color:var(--rd)}
.checks{display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto;padding:8px;border:1px solid var(--bd);border-radius:9px}
.checks label{display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:400}
.radio{display:flex;gap:10px;margin-bottom:12px}.radio label{flex:1;display:flex;gap:8px;align-items:center;padding:10px 12px;border:1px solid var(--bd);border-radius:9px;cursor:pointer;font-weight:500}
.radio label:has(input:checked){border-color:var(--pr);background:var(--prs)}
#toasts{position:fixed;top:16px;right:16px;z-index:90;display:flex;flex-direction:column;gap:8px;max-width:calc(100vw - 32px)}
.toast{display:flex;gap:10px;align-items:flex-start;padding:11px 14px;min-width:240px;max-width:380px;background:var(--sf);border:1px solid var(--bd);border-left:4px solid var(--pr);border-radius:10px;box-shadow:var(--shl);animation:pop .14s;word-break:break-word}
.toast.err{border-left-color:var(--rd)}.toast.ok{border-left-color:var(--gr)}
@keyframes fade{from{opacity:0}}@keyframes pop{from{opacity:0;transform:translateY(-6px) scale(.98)}}
</style></head>
<body data-state="boot">

<div id="login">
  <form class="lcard" id="lform" autocomplete="on">
    <svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="lg1" x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse"><stop stop-color="#14b8a6"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#lg1)"/><circle cx="24" cy="24" r="12" fill="none" stroke="#fff" stroke-width="2.4" opacity=".95"/><ellipse cx="24" cy="24" rx="5" ry="12" fill="none" stroke="#fff" stroke-width="2" opacity=".85"/><path d="M12 24h24" stroke="#fff" stroke-width="2" opacity=".6"/><circle cx="24" cy="12" r="2.6" fill="#fff"/><circle cx="24" cy="36" r="2.6" fill="#fff"/></svg>
    <h1>Antigravity 网关管理</h1>
    <div class="sub">登录以管理账号、代理与 API 密钥</div>
    <div class="field">
      <label for="pw">管理口令</label>
      <div class="iwrap"><input class="inp" id="pw" type="password" placeholder="MERIDIAN_ADMIN_TOKEN" autocomplete="current-password" autofocus><button type="button" class="icon-btn" id="pwEye" aria-label="显示或隐藏口令"></button></div>
    </div>
    <button class="btn primary" id="lbtn" type="submit" style="width:100%;height:40px">登录</button>
    <div class="lerr" id="lerr" hidden></div>
    <div class="foot">口令来自服务端环境变量，仅保存在本浏览器</div>
  </form>
</div>

<div id="app">
  <aside class="side" id="side">
    <div class="brand">
      <svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="lg2" x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse"><stop stop-color="#14b8a6"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#lg2)"/><circle cx="24" cy="24" r="12" fill="none" stroke="#fff" stroke-width="2.4"/><ellipse cx="24" cy="24" rx="5" ry="12" fill="none" stroke="#fff" stroke-width="2" opacity=".85"/><path d="M12 24h24" stroke="#fff" stroke-width="2" opacity=".6"/><circle cx="24" cy="12" r="2.6" fill="#fff"/><circle cx="24" cy="36" r="2.6" fill="#fff"/></svg>
      <div><b>Antigravity</b><span>MERIDIAN 网关</span></div>
    </div>
    <nav class="nav" id="nav" aria-label="主导航"></nav>
    <div class="sfoot"><div class="ver" id="ver"></div><button class="icon-btn" id="outBtn" title="退出登录" aria-label="退出登录"></button></div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <div class="main">
    <header class="top">
      <button class="icon-btn menubtn" id="menuBtn" aria-label="打开菜单"></button>
      <h2 id="title"></h2><span class="sp"></span>
      <button class="icon-btn bd" id="refBtn" title="刷新" aria-label="刷新"></button>
      <button class="icon-btn bd" id="thBtn" title="切换主题" aria-label="切换主题"></button>
    </header>
    <main class="content" id="view"></main>
  </div>
</div>
<div id="toasts" role="status" aria-live="polite"></div>

<script>
(function () {
"use strict";
var KEY = "agyAdminToken", THEME = "agyAdminTheme";
var S = { token: "", route: "dashboard", accounts: [], pool: {}, proxies: [], keys: { gateway: [], accounts: [] }, overview: null, settings: null, f: { q: "", st: "all" }, loaded: {}, timer: 0 };

/* ---------- helpers ---------- */
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function fmt(t, v) { return t.replace(/\{(!?)(\w+)\}/g, function (_, raw, k) { var x = v[k]; if (x == null) x = ""; return raw ? x : esc(x); }); }
var IC = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  key: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4",
  sliders: "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6",
  refresh: "M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  plus: "M12 5v14 M5 12h14", search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42",
  moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
  copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  ext: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3",
  trash: "M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  edit: "M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  more: "M12 12h.01 M19 12h.01 M5 12h.01", check: "M20 6L9 17l-5-5", x: "M18 6L6 18 M6 6l12 12",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z", menu: "M3 12h18 M3 6h18 M3 18h18",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeoff: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94 M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19 M1 1l22 22",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12",
  alert: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  act: "M22 12h-4l-3 9L9 3l-3 9H2", login: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4 M10 17l5-5-5-5 M15 12H3"
};
function ic(n, sw) { return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"' + (sw ? ' style="stroke-width:' + sw + '"' : "") + '><path d="' + IC[n] + '"/></svg>'; }
function pad(n) { return (n < 10 ? "0" : "") + n; }
function rel(ms) {
  if (!ms) return "—";
  var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "刚刚"; if (s < 3600) return Math.round(s / 60) + " 分钟前";
  if (s < 86400) return Math.round(s / 3600) + " 小时前"; return Math.round(s / 86400) + " 天前";
}
function dt(ms) { if (!ms) return "—"; var d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function num(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
function toast(msg, type) {
  var el = document.createElement("div"); el.className = "toast" + (type ? " " + type : ""); el.textContent = msg;
  $("#toasts").appendChild(el); setTimeout(function () { el.remove(); }, type === "err" ? 6500 : 3500);
}
function copy(text) {
  function fallback() {
    var t = document.createElement("textarea"); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; } t.remove(); return ok;
  }
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
  return Promise.resolve(fallback());
}
function copyToast(text) { return copy(text).then(function (ok) { toast(ok ? "已复制到剪贴板" : "复制失败，请手动复制", ok ? "ok" : "err"); }); }
async function busy(btn, fn) {
  if (btn.disabled) return;
  var old = btn.innerHTML, w = btn.offsetWidth; btn.disabled = true; btn.style.minWidth = w + "px"; btn.innerHTML = '<span class="spin"></span>';
  try { return await fn(); } catch (e) { toast(e.message || String(e), "err"); } finally { btn.disabled = false; btn.innerHTML = old; btn.style.minWidth = ""; }
}
async function api(method, path, body) {
  var res = await fetch(path, { method: method, headers: { Authorization: "Bearer " + S.token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  var data = null; try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) { logout(true); throw new Error((data && data.error) || "登录已失效，请重新登录"); }
  if (!res.ok) throw new Error((data && data.error) || ("请求失败 (" + res.status + ")"));
  return data;
}
function empty(icon, title, text, btn) {
  return '<div class="empty"><div class="ei">' + ic(icon) + "</div><b>" + esc(title) + "</b><div>" + esc(text) + "</div>" + (btn || "") + "</div>";
}
function skeleton(n) { var h = '<div class="skrow">'; for (var i = 0; i < (n || 4); i++) h += '<div class="skel" style="width:' + (60 + (i * 13) % 35) + '%"></div>'; return h + "</div>"; }

/* ---------- modal ---------- */
var modals = [];
function modal(o) {
  var back = document.createElement("div"); back.className = "mback";
  back.innerHTML = fmt('<div class="modal {size}" role="dialog" aria-modal="true" aria-label="{title}"><div class="mhead"><h3>{title}</h3><button class="icon-btn" data-close aria-label="关闭">{!x}</button></div><div class="mbody">{!body}</div><div class="mfoot">{!foot}</div></div>',
    { size: o.size || "", title: o.title, x: ic("x"), body: o.body || "", foot: o.foot || "" });
  var m = { el: back, closed: false, close: function (v) {
    if (m.closed) return; m.closed = true; back.remove(); modals.splice(modals.indexOf(m), 1);
    if (o.onClose) o.onClose(v);
  } };
  back.addEventListener("mousedown", function (e) { if (e.target === back && !o.sticky) m.close(); });
  back.addEventListener("click", function (e) { if (e.target.closest("[data-close]")) m.close(); });
  document.body.appendChild(back); modals.push(m);
  var f = $("input:not([type=hidden]):not([readonly]),select,textarea", back); if (f) f.focus();
  return m;
}
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && modals.length) { var m = modals[modals.length - 1]; if (!m.sticky) m.close(); }
});
function confirmBox(title, msg, okText, danger) {
  return new Promise(function (resolve) {
    var yes = false;
    var m = modal({ title: title, size: "sm", body: '<p class="msg">' + esc(msg) + "</p>",
      foot: '<button class="btn" data-close>取消</button><button class="btn ' + (danger ? "danger solid" : "primary") + '" id="cfOk">' + esc(okText || "确定") + "</button>",
      onClose: function () { resolve(yes); } });
    $("#cfOk", m.el).onclick = function () { yes = true; m.close(); };
  });
}

/* ---------- derived data ---------- */
function proxyName(id) { var p = S.proxies.filter(function (x) { return x.id === id; })[0]; return p ? p.name : ""; }
function accStatus(a) {
  if (a.disabled) return ["", "已停用"]; if (a.error) return ["red", "异常"];
  if (a.serving) return ["green", "运行中"]; if (!a.email) return ["yellow", "待登录"]; return ["", "未服务"];
}
function pct(w) { return Math.max(0, Math.min(100, Math.round(w.utilization * 100))); }
function tone(p) { return p >= 85 ? "red" : p >= 60 ? "yellow" : "green"; }
function winLabel(w) { return String(w.type || "") + (w.group ? " · " + w.group : ""); }
function quotaRows(q, max) {
  if (!q) return '<span class="muted">—</span>';
  if (q.error) return '<span class="tag red plain" title="' + esc(q.error) + '">额度读取失败</span>';
  var ws = (q.windows || []).slice().sort(function (a, b) { return b.utilization - a.utilization; });
  if (!ws.length) return '<span class="muted">—</span>';
  var h = ws.slice(0, max).map(function (w) {
    var p = pct(w), left = Math.max(0, Math.round((w.resetsAt - Date.now()) / 60000));
    var tip = winLabel(w) + " · 已用 " + p + "% · " + (w.resetsAt ? "重置于 " + dt(w.resetsAt) + "（还剩 " + Math.floor(left / 60) + "h " + left % 60 + "m）" : "");
    return fmt('<div class="qrow" title="{tip}"><span class="ql">{l}</span><div class="bar"><i class="c-{t}" style="width:{p}%"></i></div><span class="qp">{p}%</span></div>', { tip: tip, l: String((w.group ? w.group + " " : "") + (w.type || "")).trim(), t: tone(p), p: p });
  }).join("");
  if (ws.length > max) h += '<div class="muted xs" style="margin-top:4px">另有 ' + (ws.length - max) + " 项额度</div>";
  return h;
}
function latCls(ms) { return ms == null ? "" : ms < 900 ? "green" : ms < 2500 ? "yellow" : "red"; }

/* ---------- views ---------- */
var VIEWS = {
  dashboard: {
    title: "仪表盘", icon: "grid", name: "仪表盘",
    load: function () { return Promise.all([api("GET", "/api/overview"), api("GET", "/api/accounts")]).then(function (r) { S.overview = r[0]; S.accounts = r[1].accounts; S.pool = r[1].pool || {}; }); },
    shell: function () { return '<div class="stack"><div class="stats" id="stats">' + '<div class="card stat"><div class="skel" style="width:100%;height:60px"></div></div>'.repeat(4) + '</div><div class="cols"><div class="card"><div class="hd"><h3>额度概览</h3><span class="sp"></span><span class="muted xs">每 15 秒自动刷新</span></div><div id="dq">' + skeleton(5) + '</div></div><div class="card"><div class="hd"><h3>需要关注</h3></div><div id="dw">' + skeleton(3) + "</div></div></div></div>"; },
    fill: function () {
      var o = S.overview; if (!o) return;
      var ac = o.accounts, px = o.proxies, ky = o.keys, tr = o.traffic || {};
      var cards = [
        ["users", "", "账号总数", num(ac.total), "运行中 " + ac.serving + " · 已停用 " + ac.disabled],
        ["alert", ac.error ? "r" : "g", "异常账号", num(ac.error), ac.error ? "需要处理" : "全部正常"],
        ["globe", px.failed ? "y" : "", "代理池", num(px.total), "可用 " + px.ok + " · 失败 " + px.failed + " · 未测试 " + px.untested],
        ["key", "", "网关密钥", num(ky.enabled), "共 " + ky.total + " 个，已启用 " + ky.enabled + " 个"],
        ["act", "g", "累计请求", num(tr.completed), "失败 " + num(tr.failed) + " · 复用 " + num(tr.reused)],
        ["zap", "", "进程池上限", o.pool && o.pool.max != null ? num(o.pool.max) : "—", "同时驻留的 agy 进程数"]
      ];
      $("#stats").innerHTML = cards.map(function (c) { return fmt('<div class="card stat"><div class="ico {c}">{!i}</div><div><div class="k">{k}</div><div class="v">{v}</div><div class="s">{s}</div></div></div>', { c: c[1], i: ic(c[0]), k: c[2], v: c[3], s: c[4] }); }).join("");
      var list = S.accounts.filter(function (a) { return !a.disabled; });
      $("#dq").innerHTML = list.length ? '<div class="list">' + list.map(function (a) {
        var st = accStatus(a);
        return fmt('<div class="row"><div class="grow cell"><b>{n}</b> <span class="tag {c}">{s}</span><div class="l2">{e}</div></div><div style="width:min(260px,50%)">{!q}</div></div>', { n: a.label || a.name, c: st[0], s: st[1], e: a.email || a.name, q: quotaRows(a.quota, 3) });
      }).join("") + "</div>" : empty("users", "还没有账号", "添加第一个 Antigravity 账号开始使用", '<button class="btn primary" data-go="accounts">' + ic("plus") + "添加账号</button>");
      var warn = [];
      S.accounts.forEach(function (a) {
        if (a.disabled) return;
        if (a.error) warn.push(["red", a.label || a.name, a.error]);
        else if (!a.email) warn.push(["yellow", a.label || a.name, "尚未登录，点击账号页完成授权"]);
      });
      if (px.failed) warn.push(["yellow", "代理池", px.failed + " 个代理最近一次测试失败"]);
      $("#dw").innerHTML = warn.length ? '<div class="list">' + warn.map(function (w) {
        return fmt('<div class="row"><span class="tag {c} plain">{!i}</span><div class="grow cell"><b>{n}</b><div class="l2">{m}</div></div></div>', { c: w[0], i: ic("alert"), n: w[1], m: w[2] });
      }).join("") + "</div>" : empty("check", "一切正常", "没有需要处理的账号或代理");
    }
  },

  accounts: {
    title: "账号管理", icon: "users", name: "账号",
    load: function () { return Promise.all([api("GET", "/api/accounts"), api("GET", "/api/proxies").catch(function () { return { proxies: S.proxies }; })]).then(function (r) { S.accounts = r[0].accounts; S.pool = r[0].pool || {}; S.proxies = r[1].proxies; S.loaded.proxies = true; }); },
    shell: function () {
      return '<div class="toolbar"><div class="search">' + ic("search") + '<input class="inp" id="aq" placeholder="搜索名称、备注、邮箱、代理" aria-label="搜索账号"></div>' +
        '<select class="sel" id="ast" style="width:130px" aria-label="状态筛选"><option value="all">全部状态</option><option value="ok">运行中</option><option value="err">异常</option><option value="login">待登录</option><option value="off">已停用</option></select>' +
        '<span class="sp"></span><button class="btn" id="aTest">' + ic("zap") + '检测全部</button><button class="btn primary" id="aAdd">' + ic("plus") + '添加账号</button></div>' +
        '<div class="card"><div class="tw" id="at">' + skeleton(5) + "</div></div>";
    },
    after: function () {
      $("#aq").value = S.f.q; $("#ast").value = S.f.st;
      $("#aq").oninput = function () { S.f.q = this.value; VIEWS.accounts.fill(); };
      $("#ast").onchange = function () { S.f.st = this.value; VIEWS.accounts.fill(); };
      $("#aAdd").onclick = function () { openWizard(); };
      $("#aTest").onclick = function (e) {
        busy(e.currentTarget, async function () {
          var names = S.accounts.filter(function (a) { return a.serving && !a.disabled; }).map(function (a) { return a.name; });
          var okc = 0; await Promise.all(names.map(function (n) { return api("POST", "/api/accounts/" + encodeURIComponent(n) + "/test").then(function (r) { if (r.ok) okc++; }, function () { return null; }); }));
          toast("检测完成：" + okc + " / " + names.length + " 个账号可用", okc === names.length ? "ok" : "err"); await refreshRoute(true);
        });
      };
    },
    fill: function () {
      var q = S.f.q.trim().toLowerCase(), st = S.f.st;
      var rows = S.accounts.filter(function (a) {
        var s = accStatus(a)[1], hit = !q || [a.name, a.label, a.email, a.proxy, proxyName(a.proxyId)].join(" ").toLowerCase().indexOf(q) >= 0;
        var okSt = st === "all" || (st === "ok" && a.serving && !a.disabled) || (st === "err" && a.error && !a.disabled) || (st === "login" && !a.email && !a.disabled) || (st === "off" && a.disabled);
        return hit && okSt && s;
      });
      var box = $("#at"); if (!box) return;
      if (!S.accounts.length) { box.innerHTML = empty("users", "还没有账号", "为每个账号绑定独立代理，再通过 Google 授权登录", '<button class="btn primary" id="aAdd2">' + ic("plus") + "添加账号</button>"); var b = $("#aAdd2"); if (b) b.onclick = function () { openWizard(); }; return; }
      if (!rows.length) { box.innerHTML = empty("search", "没有匹配的账号", "换个关键词或状态筛选试试"); return; }
      box.innerHTML = "<table><thead><tr><th>账号</th><th>出口代理</th><th>状态</th><th>额度</th><th>请求</th><th></th></tr></thead><tbody>" + rows.map(function (a) {
        var s = accStatus(a), h = a.health, pn = proxyName(a.proxyId);
        return fmt('<tr data-n="{n}"><td class="cell"><b>{t}</b> <span class="chip">{n}</span><div class="l2">{e}</div></td><td class="cell">{pn}<div class="l2 mono">{px}</div></td>' +
          '<td><span class="tag {c}" {tip}>{s}</span></td><td>{!q}</td><td class="cell">{!h}</td>' +
          '<td class="act"><button class="btn sm" data-a="test">{!z}测试</button> <span class="menu"><button class="icon-btn" data-a="menu" aria-label="更多操作" aria-haspopup="true">{!m}</button></span></td></tr>',
          { n: a.name, t: a.label || a.email || a.name, e: a.label && a.email ? a.email : (a.email ? "" : "未登录"), pn: pn || "", px: a.proxy || "未设置代理", c: s[0], s: s[1], tip: a.error ? 'title="' + esc(a.error) + '"' : "",
            q: quotaRows(a.quota, 2), h: h ? "<div>" + num(h.completed) + ' <span class="muted xs">成功</span></div><div class="l2">失败 ' + num(h.failed) + " · 进程 " + num(h.processes) + "</div>" : '<span class="muted">—</span>', z: ic("zap"), m: ic("more", 3) });
      }).join("") + "</tbody></table>";
    }
  },

  proxies: {
    title: "代理池", icon: "globe", name: "代理池",
    load: function () { return api("GET", "/api/proxies").then(function (r) { S.proxies = r.proxies; S.loaded.proxies = true; }); },
    shell: function () {
      return '<div class="toolbar"><div class="search">' + ic("search") + '<input class="inp" id="pq" placeholder="搜索名称、地址、备注" aria-label="搜索代理"></div><span class="sp"></span>' +
        '<button class="btn" id="pTest">' + ic("zap") + '全部测试</button><button class="btn" id="pImp">' + ic("upload") + '批量导入</button><button class="btn primary" id="pAdd">' + ic("plus") + "添加代理</button></div>" +
        '<div class="card"><div class="tw" id="pt">' + skeleton(5) + '</div></div><div class="note info" style="margin-top:16px">' + ic("alert") + "<div>每个账号应使用独立的出口 IP，添加账号时若出口 IP 与现有账号重复会被拒绝。支持 socks5 / socks5h / http / https 协议。</div></div>";
    },
    after: function () {
      $("#pq").oninput = function () { S.f.pq = this.value; VIEWS.proxies.fill(); }; $("#pq").value = S.f.pq || "";
      $("#pAdd").onclick = function () { openProxyModal(); }; $("#pImp").onclick = openImport;
      $("#pTest").onclick = function (e) { busy(e.currentTarget, async function () { var r = await api("POST", "/api/proxies/test-all"); S.proxies = r.proxies; var ok = r.proxies.filter(function (p) { return p.lastTest && p.lastTest.ok; }).length; toast("测试完成：" + ok + " / " + r.proxies.length + " 个代理可用", ok === r.proxies.length ? "ok" : "err"); VIEWS.proxies.fill(); }); };
    },
    fill: function () {
      var q = (S.f.pq || "").trim().toLowerCase(), box = $("#pt"); if (!box) return;
      var rows = S.proxies.filter(function (p) { return !q || [p.name, p.url, p.note, p.protocol].join(" ").toLowerCase().indexOf(q) >= 0; });
      if (!S.proxies.length) { box.innerHTML = empty("globe", "代理池是空的", "先添加代理，再用它们创建账号", '<button class="btn primary" id="pAdd2">' + ic("plus") + "添加代理</button>"); var b = $("#pAdd2"); if (b) b.onclick = function () { openProxyModal(); }; return; }
      if (!rows.length) { box.innerHTML = empty("search", "没有匹配的代理", "换个关键词试试"); return; }
      box.innerHTML = "<table><thead><tr><th>名称</th><th>地址</th><th>状态</th><th>出口 IP</th><th>延迟</th><th>使用账号</th><th></th></tr></thead><tbody>" + rows.map(function (p) {
        var t = p.lastTest, st = !t ? ["", "未测试"] : t.ok ? ["green", "可用"] : ["red", "失败"], used = p.usedBy || [];
        return fmt('<tr data-id="{id}"><td class="cell"><b>{n}</b><div class="l2">{note}</div></td><td class="cell"><span class="chip">{pr}</span><div class="l2 mono">{u}</div></td><td><span class="tag {c}" {tip}>{s}</span><div class="l2 muted">{at}</div></td>' +
          '<td class="mono">{ip}</td><td>{!lat}</td><td>{!us}</td><td class="act"><button class="btn sm" data-a="ptest">{!z}测试</button> <button class="icon-btn" data-a="pedit" aria-label="编辑">{!e}</button><button class="icon-btn" data-a="pdel" aria-label="删除" {dis}>{!d}</button></td></tr>',
          { id: p.id, n: p.name, note: p.note || "", pr: p.protocol, u: p.url, c: st[0], s: st[1], tip: t && t.error ? 'title="' + esc(t.error) + '"' : "", at: t ? rel(t.at) : "", ip: (t && t.exitIp) || "—",
            lat: t && t.latencyMs != null ? '<span class="tag ' + latCls(t.latencyMs) + '">' + t.latencyMs + " ms</span>" : '<span class="muted">—</span>',
            us: used.length ? used.map(function (n) { return '<span class="chip">' + esc(n) + "</span>"; }).join(" ") : '<span class="muted">未使用</span>', z: ic("zap"), e: ic("edit"), d: ic("trash"), dis: used.length ? 'disabled title="被账号使用中，无法删除"' : "" });
      }).join("") + "</tbody></table>";
    }
  },

  keys: {
    title: "API 密钥", icon: "key", name: "API 密钥",
    load: function () { return Promise.all([api("GET", "/api/keys"), api("GET", "/api/settings")]).then(function (r) { S.keys = r[0]; S.settings = r[1]; }); },
    shell: function () {
      return '<div class="stack"><div class="card"><div class="hd"><div><h3>网关密钥</h3><div class="muted xs">客户端使用同一把密钥访问，网关在允许的账号中轮询分配</div></div><span class="sp"></span><button class="btn primary" id="kAdd">' + ic("plus") + '创建密钥</button></div><div class="tw" id="kg">' + skeleton(3) + "</div></div>" +
        '<div class="card"><div class="hd"><div><h3>账号密钥</h3><div class="muted xs">每个账号一把专属密钥，请求只会路由到该账号（Sub2API 使用此类密钥）</div></div></div><div class="tw" id="ka">' + skeleton(3) + "</div></div>" +
        '<div class="card"><div class="hd"><h3>使用方法</h3></div><div class="bd"><div id="ku"></div></div></div></div>';
    },
    after: function () { $("#kAdd").onclick = openKeyModal; },
    fill: function () {
      var g = S.keys.gateway || [], ac = S.keys.accounts || [];
      $("#kg").innerHTML = g.length ? "<table><thead><tr><th>名称</th><th>密钥</th><th>范围</th><th>启用</th><th>请求数</th><th>最近使用</th><th>创建时间</th><th></th></tr></thead><tbody>" + g.map(function (k) {
        return fmt('<tr data-id="{id}"><td class="cell"><b>{n}</b></td><td class="mono">{p}</td><td>{!sc}</td><td><label class="sw"><input type="checkbox" data-a="ktoggle" {on} aria-label="启用"><i></i></label></td><td>{r}</td><td class="muted">{lu}</td><td class="muted">{c}</td><td class="act"><button class="icon-btn" data-a="kedit" aria-label="编辑范围">{!e}</button><button class="icon-btn" data-a="kdel" aria-label="删除">{!d}</button></td></tr>',
          { id: k.id, n: k.name, p: k.prefix, sc: k.scope === "all" ? '<span class="tag blue plain">全部账号</span>' : (k.accounts || []).map(function (n) { return '<span class="chip">' + esc(n) + "</span>"; }).join(" "), on: k.enabled ? "checked" : "", r: num(k.requests), lu: rel(k.lastUsedAt), c: dt(k.createdAt), e: ic("edit"), d: ic("trash") });
      }).join("") + "</tbody></table>" : empty("key", "还没有网关密钥", "创建一把密钥，让客户端通过轮询访问全部账号", '<button class="btn primary" id="kAdd2">' + ic("plus") + "创建密钥</button>");
      var b = $("#kAdd2"); if (b) b.onclick = openKeyModal;
      $("#ka").innerHTML = ac.length ? "<table><thead><tr><th>账号</th><th>密钥前缀</th><th></th></tr></thead><tbody>" + ac.map(function (k) {
        return fmt('<tr data-n="{n}"><td class="cell"><b>{n}</b></td><td class="mono">{p}</td><td class="act"><button class="btn sm" data-a="akcopy">{!c}复制</button> <button class="btn sm" data-a="akrot">{!r}重置</button></td></tr>', { n: k.account, p: k.prefix, c: ic("copy"), r: ic("refresh") });
      }).join("") + "</tbody></table>" : empty("users", "暂无账号", "先添加账号");
      var base = (S.settings && S.settings.baseUrl) || location.origin;
      $("#ku").innerHTML = '<div class="muted" style="margin-bottom:10px">网关兼容 Anthropic Messages 协议，把 Base URL 和密钥填入客户端即可：</div><pre class="code">' +
        esc("Base URL   " + base + "\nAPI Key    mk-xxxxxxxx（网关密钥）或账号密钥\n\ncurl " + base + "/v1/messages \\\n  -H \"x-api-key: $KEY\" -H \"anthropic-version: 2023-06-01\" -H \"content-type: application/json\" \\\n  -d '{\"model\":\"MODEL\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'") + "</pre>";
    }
  },

  settings: {
    title: "系统设置", icon: "sliders", name: "设置",
    load: function () { return Promise.all([api("GET", "/api/settings"), api("GET", "/api/overview")]).then(function (r) { S.settings = r[0]; S.overview = r[1]; }); },
    shell: function () { return '<div class="stack" style="max-width:860px"><div class="card"><div class="hd"><h3>运行信息</h3></div><div class="bd" id="sv">' + skeleton(5) + '</div></div><div class="card"><div class="hd"><div><h3>重新加载配置</h3><div class="muted xs">重新扫描账号目录：启动新增的账号、停止已移除或停用的账号</div></div><span class="sp"></span><button class="btn primary" id="sReload">' + ic("refresh") + '重新加载</button></div></div></div>'; },
    after: function () {
      $("#sReload").onclick = function (e) { busy(e.currentTarget, async function () { var r = await api("POST", "/api/reload"); toast("已重载：启动 " + (r.started || []).length + "，停止 " + (r.stopped || []).length + "，失败 " + (r.failed || []).length, (r.failed || []).length ? "err" : "ok"); }); };
    },
    fill: function () {
      var s = S.settings; if (!s) return; var sb = s.sub2api || {};
      var rows = [["版本", "v" + s.version], ["Base URL", s.baseUrl], ["账号目录", s.accountsDir], ["进程池上限", s.pool && s.pool.max != null ? s.pool.max : "未限制"],
        ["Sub2API 同步", sb.enabled ? "已启用" : "未启用"], ["Sub2API 地址", sb.base || "—"], ["Sub2API 模板 ID", sb.templateId != null ? sb.templateId : "—"]];
      $("#sv").innerHTML = '<div class="kv">' + rows.map(function (r) { return fmt("<div>{k}</div><div class=\"mono\">{v}</div>", { k: r[0], v: r[1] }); }).join("") + "</div>";
    }
  }
};
var ORDER = ["dashboard", "accounts", "proxies", "keys", "settings"];

/* ---------- shell ---------- */
function drawNav() {
  var err = S.accounts.filter(function (a) { return a.error && !a.disabled; }).length;
  $("#nav").innerHTML = '<div class="sec">管理</div>' + ORDER.map(function (k) {
    var v = VIEWS[k];
    return fmt('<a href="#/{k}" class="{on}" {cur}>{!i}<span>{n}</span>{!c}</a>', { k: k, on: S.route === k ? "on" : "", cur: S.route === k ? 'aria-current="page"' : "", i: ic(v.icon), n: v.name, c: k === "accounts" && err ? '<span class="cnt">' + err + "</span>" : "" });
  }).join("");
}
function routeFromHash() { var k = (location.hash.replace(/^#\/?/, "") || "dashboard").split("/")[0]; return VIEWS[k] ? k : "dashboard"; }
function show(k) {
  S.route = k; var v = VIEWS[k]; $("#title").textContent = v.title; document.title = v.title + " · Antigravity 网关管理";
  $("#view").innerHTML = v.shell(); if (v.after) v.after(); drawNav(); closeSide(); window.scrollTo(0, 0);
  return refreshRoute(false);
}
async function refreshRoute(quiet) {
  var k = S.route, v = VIEWS[k];
  try { await v.load(); } catch (e) { if (!quiet && S.token) toast(e.message, "err"); return; }
  if (S.route !== k) return; v.fill(); drawNav();
}
function closeSide() { $("#side").classList.remove("open"); $("#scrim").classList.remove("on"); }
function setTheme(t) { document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem(THEME, t); } catch (e) { return; } drawThemeBtn(); }
function drawThemeBtn() { $("#thBtn").innerHTML = ic(document.documentElement.getAttribute("data-theme") === "dark" ? "sun" : "moon"); }
function tick() { if (S.token && !document.hidden && !modals.length) refreshRoute(true); }

/* ---------- auth ---------- */
function setState(s) { document.body.setAttribute("data-state", s); }
function logout(expired) {
  S.token = ""; try { localStorage.removeItem(KEY); } catch (e) { S.token = ""; }
  clearInterval(S.timer); modals.slice().forEach(function (m) { m.close(); });
  setState("login"); $("#pw").value = ""; var er = $("#lerr");
  if (expired) { er.textContent = "登录已失效，请重新登录"; er.hidden = false; } else er.hidden = true;
  setTimeout(function () { $("#pw").focus(); }, 0);
}
async function enter(token) {
  S.token = token; var info = await api("GET", "/api/session");
  try { localStorage.setItem(KEY, token); } catch (e) { S.token = token; }
  $("#ver").textContent = "v" + (info.version || "?"); setState("app");
  clearInterval(S.timer); S.timer = setInterval(tick, 15000);
  await show(routeFromHash());
}
$("#lform").onsubmit = async function (e) {
  e.preventDefault(); var v = $("#pw").value.trim(), er = $("#lerr"), b = $("#lbtn"); if (!v) return;
  er.hidden = true; b.disabled = true; b.innerHTML = '<span class="spin"></span>';
  try { await enter(v); } catch (x) { S.token = ""; er.textContent = x.message === "Invalid or missing token" ? "口令不正确" : x.message; er.hidden = false; setState("login"); }
  finally { b.disabled = false; b.textContent = "登录"; }
};
$("#pwEye").innerHTML = ic("eye");
$("#pwEye").onclick = function () { var p = $("#pw"), h = p.type === "password"; p.type = h ? "text" : "password"; this.innerHTML = ic(h ? "eyeoff" : "eye"); };
$("#outBtn").innerHTML = ic("logout"); $("#outBtn").onclick = function () { logout(false); };
$("#refBtn").innerHTML = ic("refresh"); $("#refBtn").onclick = function (e) { busy(e.currentTarget, function () { return refreshRoute(false); }); };
$("#menuBtn").innerHTML = ic("menu"); $("#menuBtn").onclick = function () { $("#side").classList.add("open"); $("#scrim").classList.add("on"); };
$("#scrim").onclick = closeSide;
$("#thBtn").onclick = function () { setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"); };
window.addEventListener("hashchange", function () { if (S.token) show(routeFromHash()); });

/* ---------- account wizard ---------- */
function proxyOptions(sel) {
  return S.proxies.map(function (p) {
    var t = p.lastTest, tag = !t ? "" : t.ok ? " · " + (t.exitIp || "可用") : " · 测试失败";
    return fmt('<option value="{id}" {s}>{n} — {u}{t}</option>', { id: p.id, s: p.id === sel ? "selected" : "", n: p.name, u: p.url, t: tag });
  }).join("");
}
async function openWizard(existing) {
  if (!S.loaded.proxies) { try { var pr = await api("GET", "/api/proxies"); S.proxies = pr.proxies; S.loaded.proxies = true; } catch (e) { toast(e.message, "err"); return; } }
  var w = { name: existing || null, step: existing ? 2 : 1, mode: S.proxies.length ? "pool" : "new", exitIp: null, url: null, result: null, tested: null };
  var m = modal({ title: existing ? "重新登录 " + existing : "添加账号", size: "", sticky: true, body: '<div id="wz"></div>', onClose: function () { refreshRoute(true); } });
  m.sticky = true; var root = $("#wz", m.el);
  function stepper() {
    var n = ["配置代理", "授权登录", "完成"];
    return '<div class="steps">' + n.map(function (t, i) { var c = w.step === i + 1 ? "on" : w.step > i + 1 ? "done" : ""; return (i ? '<span class="ln"></span>' : "") + '<span class="s ' + c + '"><b>' + (w.step > i + 1 ? ic("check", 3) : i + 1) + "</b>" + t + "</span>"; }).join("") + "</div>";
  }
  function draw() {
    var h = stepper();
    if (w.step === 1) {
      h += '<div class="seg" style="margin-bottom:14px"><button type="button" data-mode="pool" class="' + (w.mode === "pool" ? "on" : "") + '">从代理池选择</button><button type="button" data-mode="new" class="' + (w.mode === "new" ? "on" : "") + '">新增代理</button></div>';
      if (w.mode === "pool") {
        h += S.proxies.length ? '<div class="field"><label for="wzP">出口代理</label><select class="sel" id="wzP">' + proxyOptions() + '</select><div class="hint">每个账号需要独立出口 IP，已被占用的出口 IP 会被拒绝</div></div>'
          : '<div class="note">' + ic("alert") + "<div>代理池还是空的，请切换到「新增代理」。</div></div>";
      } else {
        h += '<div class="field"><label for="wzU">代理地址</label><div class="secret"><input class="inp mono" id="wzU" placeholder="socks5h://user:pass@host:port" autocomplete="off" spellcheck="false"><button type="button" class="btn" id="wzT">' + ic("zap") + '测试</button></div><div class="hint" id="wzR">测试通过后会显示出口 IP；该代理会同时保存到代理池</div></div>';
      }
      h += '<div class="field"><label for="wzL">备注（可选）</label><input class="inp" id="wzL" placeholder="例如：主号 / 小号 A" maxlength="40"></div>';
      h += '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px"><button class="btn" data-close>取消</button><button class="btn primary" id="wzN">创建账号并继续</button></div>';
    } else if (w.step === 2) {
      h += '<div class="note info" style="margin-bottom:14px">' + ic("link") + "<div>账号 <b>" + esc(w.name) + "</b>" + (w.exitIp ? " 已创建，出口 IP <span class=\"mono\">" + esc(w.exitIp) + "</span>" : "") + "。点击获取登录链接，用要添加的 Google 账号完成授权，再把页面显示的授权码粘贴回来。</div></div>";
      h += '<div id="wzLink">' + (w.url ? linkHtml() : '<button class="btn primary" id="wzG">' + ic("login") + "获取登录链接</button>") + "</div>";
      h += '<div id="wzCode" ' + (w.url ? "" : "hidden") + '><div class="field" style="margin-top:16px"><label for="wzC">授权码</label><input class="inp mono" id="wzC" placeholder="粘贴 Google 页面显示的授权码" autocomplete="off" spellcheck="false"></div><div style="display:flex;justify-content:flex-end;gap:10px"><button class="btn" data-close>稍后完成</button><button class="btn primary" id="wzS">提交授权码</button></div></div>';
    } else {
      var r = w.result || {}, bad = !!r.error;
      h += '<div style="text-align:center"><div class="okmark ' + (bad ? "bad" : "") + '">' + ic(bad ? "alert" : "check", 2.5) + "</div><h3 style=\"margin:0 0 4px\">" + (bad ? "已登录，但服务启动失败" : "账号添加成功") + "</h3><div class=\"muted\">" + esc(r.email || w.name) + "</div></div>" +
        '<div class="kv" style="margin-top:14px"><div>账号</div><div class="mono">' + esc(w.name) + "</div><div>运行状态</div><div>" + (r.serving ? '<span class="tag green">运行中</span>' : '<span class="tag red">未服务</span>') + "</div><div>Sub2API</div><div>" + sub2Text(r) + "</div></div>" +
        (r.error ? '<div class="note" style="margin-top:12px">' + ic("alert") + "<div>" + esc(r.error) + "</div></div>" : "") +
        '<div id="wzV" style="margin-top:12px">' + eligibilityHtml(r) + '</div>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn primary" data-close>完成</button></div>';
    }
    root.innerHTML = h; bind();
    if (w.step === 3) bindEligibility(w.name, $("#wzV", root));
  }
  function linkHtml() {
    return '<div class="field"><label>登录链接</label><div class="secret"><input class="inp" readonly value="' + esc(w.url) + '" aria-label="登录链接"><button class="btn" id="wzCp">' + ic("copy") + '复制</button><a class="btn" href="' + esc(w.url) + '" target="_blank" rel="noopener noreferrer">' + ic("ext") + "打开</a></div></div>";
  }
  function bind() {
    $$("[data-copy]", root).forEach(function (b) { b.onclick = function () { copyToast(b.dataset.copy); }; });
    $$("[data-mode]", root).forEach(function (b) { b.onclick = function () { w.mode = b.dataset.mode; draw(); }; });
    var t = $("#wzT", root), n = $("#wzN", root), g = $("#wzG", root), s = $("#wzS", root), cp = $("#wzCp", root);
    if (t) t.onclick = function () { var u = $("#wzU").value.trim(); if (!u) return toast("请输入代理地址", "err"); busy(t, async function () { var r = await api("POST", "/api/proxies/test", { url: u }); $("#wzR").innerHTML = r.ok ? '<span style="color:var(--gr)">连接成功 · 出口 IP ' + esc(r.exitIp) + " · " + esc(r.latencyMs) + " ms</span>" : '<span style="color:var(--rd)">测试失败：' + esc(r.error || "无响应") + "</span>"; }); };
    if (n) n.onclick = function () {
      var body = { label: $("#wzL").value.trim() || undefined };
      if (w.mode === "pool") { var pid = $("#wzP"); if (!pid) return toast("请先选择代理", "err"); body.proxyId = pid.value; }
      else { var u = $("#wzU").value.trim(); if (!u) return toast("请输入代理地址", "err"); body.proxy = u; }
      busy(n, async function () { var r = await api("POST", "/api/accounts", body); w.name = r.name; w.exitIp = r.exitIp; w.step = 2; S.loaded.proxies = false; draw(); });
    };
    if (g) g.onclick = function () { busy(g, async function () { var r = await api("POST", "/api/accounts/" + encodeURIComponent(w.name) + "/login"); w.url = r.url; $("#wzLink").innerHTML = linkHtml(); $("#wzCode").hidden = false; bind(); $("#wzC").focus(); }); };
    if (cp) cp.onclick = function () { copyToast(w.url); };
    if (s) { var go = function () { var c = $("#wzC").value.trim(); if (!c) return toast("请输入授权码", "err"); busy(s, async function () { w.result = await api("POST", "/api/accounts/" + encodeURIComponent(w.name) + "/code", { code: c }); w.step = 3; draw(); }); }; s.onclick = go; $("#wzC").onkeydown = function (e) { if (e.key === "Enter") go(); }; }
  }
  draw();
}

function eligibilityHtml(r) {
  if (r.eligible) return '<div class="note info">' + ic("check") + "<div>账号资格正常，可以使用。</div></div>";
  var u = r.verifyUrl;
  return '<div class="note">' + ic("alert") + '<div style="min-width:0;flex:1"><b>需要完成资格核验</b><div class="muted xs" style="margin:2px 0 8px">' + esc(r.message || "该账号尚未通过资格核验") + "</div>" +
    (u ? '<div class="secret"><input class="inp" readonly value="' + esc(u) + '" aria-label="资格核验地址"><button class="btn" data-copy="' + esc(u) + '">' + ic("copy") + '复制</button><a class="btn primary" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + ic("ext") + "打开核验地址</a></div>" : '<div class="muted xs">没有取到核验地址，请换一个个人 Google 账号重试。</div>') +
    '<div style="margin-top:8px"><button class="btn sm" data-recheck>' + ic("refresh") + "我已核验，重新检查</button></div></div></div>";
}
function sub2Text(r) {
  if (r.sub2apiStatus === "off") return "未启用同步";
  if (r.sub2apiStatus === "active") return '<span class="tag green">已同步并启用</span> #' + esc(r.sub2apiId);
  if (r.sub2apiStatus === "inactive") return '<span class="tag yellow">已停用，待核验</span> #' + esc(r.sub2apiId);
  return '<span class="tag yellow">待核验通过后自动添加</span>';
}
function bindEligibility(name, box) {
  $$("[data-copy]", box).forEach(function (b) { b.onclick = function () { copyToast(b.dataset.copy); }; });
  var rc = $("[data-recheck]", box);
  if (rc) rc.onclick = function () { box.innerHTML = '<div class="note info"><span class="spin"></span><div>正在重新检查，最长约 1 分钟…</div></div>'; checkEligibility(name, box); };
}
function checkEligibility(name, box) {
  api("POST", "/api/accounts/" + encodeURIComponent(name) + "/verify").then(function (r) {
    if (!box.isConnected) return; box.innerHTML = eligibilityHtml(r) + '<div class="muted xs" style="margin-top:8px">Sub2API：' + sub2Text(r) + "</div>"; bindEligibility(name, box);
  }, function (e) { if (box.isConnected) box.innerHTML = '<div class="note">' + ic("alert") + "<div>资格检查失败：" + esc(e.message) + "</div></div>"; });
}
/* ---------- account actions ---------- */
function openEditAccount(a) {
  var m = modal({ title: "编辑账号 " + a.name, body: '<div class="field"><label for="eL">备注</label><input class="inp" id="eL" maxlength="40" value="' + esc(a.label || "") + '" placeholder="例如：主号"></div>' +
    '<div class="field"><label for="eP">出口代理</label><select class="sel" id="eP">' + proxyOptions(a.proxyId) + '</select><div class="hint">更换代理会重启该账号，且新出口 IP 不能与其他账号重复</div></div>',
    foot: '<button class="btn" data-close>取消</button><button class="btn primary" id="eOk">保存</button>' });
  if (!S.proxies.length) $("#eP", m.el).innerHTML = '<option value="">（代理池为空）</option>';
  $("#eOk", m.el).onclick = function (e) {
    busy(e.currentTarget, async function () {
      var body = { label: $("#eL", m.el).value.trim() }, pid = $("#eP", m.el).value; if (pid && pid !== a.proxyId) body.proxyId = pid;
      await api("PATCH", "/api/accounts/" + encodeURIComponent(a.name), body); toast("已保存", "ok"); m.close(); refreshRoute(true);
    });
  };
}
function showSecret(title, secret, note) {
  var m = modal({ title: title, sticky: true, body: '<div class="note">' + ic("alert") + "<div>" + esc(note) + '</div></div><div class="field" style="margin-top:14px"><label>密钥</label><div class="secret"><input class="inp" id="sk" readonly value="' + esc(secret) + '" aria-label="密钥"><button class="btn" id="skC">' + ic("copy") + "复制</button></div></div>",
    foot: '<button class="btn primary" data-close>我已保存</button>' });
  m.sticky = true; $("#sk", m.el).onfocus = function () { this.select(); }; $("#skC", m.el).onclick = function () { copyToast(secret); };
}
async function accountAction(act, name, btn) {
  var a = S.accounts.filter(function (x) { return x.name === name; })[0], enc = encodeURIComponent(name);
  if (act === "test") return busy(btn, async function () {
    var r = await api("POST", "/api/accounts/" + enc + "/test");
    toast(r.ok ? name + " 正常" + (r.latencyMs != null ? " · " + r.latencyMs + " ms" : "") + (r.exitIp ? " · 出口 " + r.exitIp : "") : name + " 异常：" + (r.error || "未知错误"), r.ok ? "ok" : "err"); await refreshRoute(true);
  });
  if (act === "login") return openWizard(name);
  if (act === "verify") { var vm = modal({ title: "资格检查 · " + name, body: '<div id="vbox"><div class="note info"><span class="spin"></span><div>正在检查，最长约 1 分钟…</div></div></div>' }); return checkEligibility(name, $("#vbox", vm.el)); }
  if (act === "edit") return openEditAccount(a);
  if (act === "ip") return busy(btn, async function () { var r = await api("POST", "/api/accounts/" + enc + "/ip"); toast(name + " 出口 IP：" + r.exitIp, "ok"); });
  if (act === "copykey") { var r = await api("GET", "/api/accounts/" + enc + "/key"); return copyToast(r.key); }
  if (act === "rotate") {
    if (!(await confirmBox("重置 API 密钥", "重置后 " + name + " 的旧密钥立即失效，使用它的客户端（含 Sub2API）需要更新。继续吗？", "重置", true))) return;
    var k = await api("POST", "/api/accounts/" + enc + "/key/rotate"); showSecret("新的账号密钥", k.key, "请立即保存；旧密钥已失效。"); return refreshRoute(true);
  }
  if (act === "toggle") {
    var dis = !a.disabled;
    if (!(await confirmBox(dis ? "停用账号" : "启用账号", (dis ? "停用后 " : "启用后 ") + name + (dis ? " 将停止服务，并在 Sub2API 中标记为不可用。" : " 将重新开始服务。"), dis ? "停用" : "启用", dis)))
      return;
    await api("POST", "/api/accounts/" + enc + (dis ? "/disable" : "/enable")); toast((dis ? "已停用 " : "已启用 ") + name, "ok"); return refreshRoute(true);
  }
  if (act === "delete") {
    if (!(await confirmBox("删除账号", "将删除 " + name + "（" + (a.email || a.label || "未登录") + "）。账号目录会被移到回收区而非彻底清除。继续吗？", "删除", true))) return;
    await api("DELETE", "/api/accounts/" + enc); toast("已删除 " + name, "ok"); S.loaded.proxies = false; return refreshRoute(true);
  }
}
var MENU = [["login", "login", "重新登录"], ["verify", "check", "检查资格 / 核验地址"], ["edit", "edit", "编辑"], ["ip", "globe", "测出口 IP"], ["copykey", "copy", "复制 API 密钥"], ["rotate", "refresh", "重置 API 密钥"], ["toggle", "alert", ""], ["delete", "trash", "删除"]];
function openMenu(btn, name) {
  closeMenus(); var a = S.accounts.filter(function (x) { return x.name === name; })[0], pop = document.createElement("div"); pop.className = "pop"; pop.setAttribute("role", "menu");
  pop.innerHTML = MENU.map(function (it) {
    var label = it[0] === "toggle" ? (a.disabled ? "启用账号" : "停用账号") : it[2];
    return (it[0] === "delete" ? "<hr>" : "") + '<button data-m="' + it[0] + '" role="menuitem" class="' + (it[0] === "delete" ? "danger" : "") + '">' + ic(it[1]) + esc(label) + "</button>";
  }).join("");
  btn.parentNode.appendChild(pop);
  pop.onclick = function (e) { var b = e.target.closest("[data-m]"); if (!b) return; closeMenus(); accountAction(b.dataset.m, name, b).catch(function (x) { toast(x.message, "err"); }); };
}
function closeMenus() { $$(".pop").forEach(function (p) { p.remove(); }); }
document.addEventListener("click", function (e) { if (!e.target.closest(".menu")) closeMenus(); });

/* ---------- proxies ---------- */
function openProxyModal(p) {
  var m = modal({ title: p ? "编辑代理" : "添加代理", body: '<div class="field"><label for="xU">代理地址</label><input class="inp mono" id="xU" placeholder="socks5h://user:pass@host:port" autocomplete="off" spellcheck="false" ' + (p ? 'value="" ' : "") + '><div class="hint">' + (p ? "留空表示不修改地址（当前：" + esc(p.url) + "）；修改后使用它的账号会自动重启" : "支持 socks5 / socks5h / http / https") + "</div></div>" +
    '<div class="field"><label for="xN">名称</label><input class="inp" id="xN" maxlength="40" placeholder="例如：新加坡 01" value="' + esc(p ? p.name : "") + '"></div><div class="field"><label for="xO">备注</label><input class="inp" id="xO" maxlength="80" value="' + esc(p ? p.note || "" : "") + '"></div><div id="xR" class="hint"></div>',
    foot: '<button class="btn" data-close>取消</button><button class="btn" id="xT">' + ic("zap") + '先测试</button><button class="btn primary" id="xOk">' + (p ? "保存" : "添加") + "</button>" });
  $("#xT", m.el).onclick = function (e) { var u = $("#xU", m.el).value.trim(); if (!u) return toast(p ? "留空时无需测试，请用列表里的测试按钮" : "请输入代理地址", "err"); busy(e.currentTarget, async function () { var r = await api("POST", "/api/proxies/test", { url: u }); $("#xR", m.el).innerHTML = r.ok ? '<span style="color:var(--gr)">连接成功 · 出口 IP ' + esc(r.exitIp) + " · " + esc(r.latencyMs) + " ms</span>" : '<span style="color:var(--rd)">测试失败：' + esc(r.error || "无响应") + "</span>"; }); };
  $("#xOk", m.el).onclick = function (e) {
    busy(e.currentTarget, async function () {
      var body = { url: $("#xU", m.el).value.trim(), name: $("#xN", m.el).value.trim(), note: $("#xO", m.el).value.trim() };
      if (p) { if (!body.url) delete body.url; await api("PATCH", "/api/proxies/" + encodeURIComponent(p.id), body); } else { if (!body.url) return toast("请输入代理地址", "err"); await api("POST", "/api/proxies", body); }
      toast(p ? "已保存" : "已添加", "ok"); m.close(); refreshRoute(true);
    });
  };
}
function openImport() {
  var m = modal({ title: "批量导入代理", size: "lg", body: '<div class="field"><label for="iT">代理列表</label><textarea class="txa" id="iT" spellcheck="false" placeholder="每行一个：地址 [名称]\nsocks5h://user:pass@1.2.3.4:1080 新加坡-01\nhttp://5.6.7.8:3128\n# 以 # 开头的行会被忽略"></textarea></div><div id="iR"></div>',
    foot: '<button class="btn" data-close>关闭</button><button class="btn primary" id="iOk">' + ic("upload") + "导入</button>" });
  $("#iOk", m.el).onclick = function (e) {
    busy(e.currentTarget, async function () {
      var text = $("#iT", m.el).value; if (!text.trim()) return toast("请粘贴代理列表", "err");
      var r = await api("POST", "/api/proxies/import", { text: text }), sk = r.skipped || [];
      $("#iR", m.el).innerHTML = '<div class="note ' + (sk.length ? "" : "info") + '">' + ic(sk.length ? "alert" : "check") + "<div>已添加 <b>" + r.added.length + "</b> 个，跳过 <b>" + sk.length + "</b> 个</div></div>" +
        (sk.length ? '<pre class="code" style="margin-top:10px;max-height:160px">' + esc(sk.map(function (s) { return s.line + "  →  " + s.reason; }).join("\n")) + "</pre>" : "");
      if (r.added.length) { refreshRoute(true); if (!sk.length) setTimeout(function () { m.close(); }, 900); }
    });
  };
}
async function proxyAction(act, id, btn) {
  var p = S.proxies.filter(function (x) { return x.id === id; })[0];
  if (act === "ptest") return busy(btn, async function () { var r = await api("POST", "/api/proxies/" + encodeURIComponent(id) + "/test"); S.proxies = S.proxies.map(function (x) { return x.id === id ? r : x; }); VIEWS.proxies.fill(); var t = r.lastTest; toast(t && t.ok ? r.name + " 可用 · " + t.exitIp + " · " + t.latencyMs + " ms" : r.name + " 测试失败：" + ((t && t.error) || "无响应"), t && t.ok ? "ok" : "err"); });
  if (act === "pedit") return openProxyModal(p);
  if (act === "pdel") {
    if (!(await confirmBox("删除代理", "确定从代理池删除 " + p.name + " 吗？", "删除", true))) return;
    await api("DELETE", "/api/proxies/" + encodeURIComponent(id)); toast("已删除", "ok"); return refreshRoute(true);
  }
}

/* ---------- keys ---------- */
function openKeyModal(existing) {
  var edit = existing && existing.id ? existing : null;
  (S.accounts.length ? Promise.resolve() : api("GET", "/api/accounts").then(function (r) { S.accounts = r.accounts; })).then(function () {
    var sel = edit ? edit.accounts || [] : [], all = !edit || edit.scope === "all";
    var m = modal({ title: edit ? "编辑密钥范围" : "创建网关密钥", body: (edit ? "" : '<div class="field"><label for="kN">名称</label><input class="inp" id="kN" maxlength="40" placeholder="例如：Cursor / 团队 A"></div>') +
      '<div class="field"><label>可用账号范围</label><div class="radio"><label><input type="radio" name="ks" value="all" ' + (all ? "checked" : "") + '>全部账号</label><label><input type="radio" name="ks" value="acc" ' + (all ? "" : "checked") + '>指定账号</label></div>' +
      '<div class="checks" id="kC" ' + (all ? "hidden" : "") + ">" + S.accounts.map(function (a) { return fmt('<label><input type="checkbox" value="{n}" {c}>{n} <span class="muted xs">{e}</span></label>', { n: a.name, c: sel.indexOf(a.name) >= 0 ? "checked" : "", e: a.email || a.label || "" }); }).join("") + "</div></div>",
      foot: '<button class="btn" data-close>取消</button><button class="btn primary" id="kOk">' + (edit ? "保存" : "创建") + "</button>" });
    $$("input[name=ks]", m.el).forEach(function (r) { r.onchange = function () { $("#kC", m.el).hidden = this.value === "all"; }; });
    $("#kOk", m.el).onclick = function (e) {
      busy(e.currentTarget, async function () {
        var scopeAll = $("input[name=ks]:checked", m.el).value === "all", accs = scopeAll ? [] : $$("#kC input:checked", m.el).map(function (c) { return c.value; });
        if (!scopeAll && !accs.length) return toast("请至少选择一个账号", "err");
        if (edit) { await api("PATCH", "/api/keys/" + encodeURIComponent(edit.id), { accounts: accs }); toast("已保存", "ok"); m.close(); return refreshRoute(true); }
        var name = $("#kN", m.el).value.trim(); if (!name) return toast("请输入密钥名称", "err");
        var r = await api("POST", "/api/keys", { name: name, accounts: accs }); m.close(); showSecret("密钥已创建", r.secret, "这是唯一一次显示完整密钥，关闭后将无法再次查看，请立即复制保存。"); refreshRoute(true);
      });
    };
  }).catch(function (e) { toast(e.message, "err"); });
}
async function keyAction(act, id, row, input) {
  var k = (S.keys.gateway || []).filter(function (x) { return x.id === id; })[0];
  if (act === "ktoggle") { try { await api("PATCH", "/api/keys/" + encodeURIComponent(id), { enabled: input.checked }); toast(input.checked ? "已启用" : "已停用", "ok"); refreshRoute(true); } catch (e) { input.checked = !input.checked; toast(e.message, "err"); } return; }
  if (act === "kedit") return openKeyModal(k);
  if (act === "kdel") { if (!(await confirmBox("删除密钥", "删除 " + k.name + " 后，使用它的客户端将立即无法访问。继续吗？", "删除", true))) return; await api("DELETE", "/api/keys/" + encodeURIComponent(id)); toast("已删除", "ok"); return refreshRoute(true); }
}

/* ---------- delegated events ---------- */
$("#view").addEventListener("click", function (e) {
  var go = e.target.closest("[data-go]"); if (go) { location.hash = "#/" + go.dataset.go; return; }
  var b = e.target.closest("[data-a]"); if (!b || b.disabled) return; var tr = b.closest("tr"), a = b.dataset.a;
  if (!tr) return;
  if (a === "menu") { var open = b.parentNode.querySelector(".pop"); closeMenus(); if (!open) openMenu(b, tr.dataset.n); return; }
  if (a === "test") return accountAction("test", tr.dataset.n, b).catch(function (x) { toast(x.message, "err"); });
  if (a === "ptest" || a === "pedit" || a === "pdel") return proxyAction(a, tr.dataset.id, b).catch(function (x) { toast(x.message, "err"); });
  if (a === "kedit" || a === "kdel") return keyAction(a, tr.dataset.id, tr).catch(function (x) { toast(x.message, "err"); });
  if (a === "akcopy") return accountAction("copykey", tr.dataset.n, b).catch(function (x) { toast(x.message, "err"); });
  if (a === "akrot") return accountAction("rotate", tr.dataset.n, b).catch(function (x) { toast(x.message, "err"); });
});
$("#view").addEventListener("change", function (e) { var i = e.target.closest("[data-a=ktoggle]"); if (i) keyAction("ktoggle", i.closest("tr").dataset.id, null, i); });

/* ---------- boot ---------- */
drawThemeBtn();
var saved = ""; try { saved = localStorage.getItem(KEY) || ""; } catch (e) { saved = ""; }
if (saved) enter(saved).catch(function () { S.token = ""; setState("login"); }); else setState("login");
})();
</script></body></html>
`
