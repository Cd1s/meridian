// Fork patch: page of the multi-account admin panel (antigravityAdmin.ts serves it at /).
export const agAdminPageHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Antigravity 账号</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c1f24;--mut:#6b7280;--bd:#e3e6ea;--ac:#2563eb;--ok:#16a34a;--bad:#dc2626;--off:#9ca3af;--bar:#e5e7eb}
@media(prefers-color-scheme:dark){:root{--bg:#111316;--card:#1a1d21;--fg:#e6e8eb;--mut:#9aa3ae;--bd:#2c3036;--ac:#5b8cff;--ok:#34d399;--bad:#f87171;--off:#6b7280;--bar:#2c3036}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0}
header{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:12px}
.sp{flex:1}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chip{background:var(--card);border:1px solid var(--bd);border-radius:99px;padding:2px 10px;font-size:12px;color:var(--mut)}
.chip b{color:var(--fg)}
button{font:inherit;padding:5px 12px;border:1px solid var(--bd);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--ac)}button.pri{background:var(--ac);border-color:var(--ac);color:#fff}
button:disabled{opacity:.5;cursor:wait}
input{font:inherit;width:100%;padding:6px 8px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--fg)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
@media(max-width:400px){.grid{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;min-width:0}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.nm{font-weight:600}.mut{color:var(--mut);font-size:12px;word-break:break-all}
.badge{font-size:12px;padding:1px 8px;border-radius:99px;color:#fff}
.ok{background:var(--ok)}.bad{background:var(--bad)}.off{background:var(--off)}
.err{color:var(--bad);font-size:12px;word-break:break-all}
.q{margin-top:6px}.q .t{display:flex;justify-content:space-between;gap:8px;font-size:12px;flex-wrap:wrap}
.bar{height:5px;background:var(--bar);border-radius:3px;overflow:hidden;margin:2px 0}.bar i{display:block;height:100%;background:var(--ok)}
.acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
dialog{border:1px solid var(--bd);border-radius:10px;background:var(--card);color:var(--fg);width:min(460px,calc(100vw - 24px));padding:16px}
dialog::backdrop{background:rgba(0,0,0,.45)}
dialog h2{font-size:16px;margin:0 0 10px}.stp{margin:10px 0;padding-top:10px;border-top:1px solid var(--bd)}
.sec{display:flex;flex-direction:column;gap:8px}
#toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:calc(100vw - 32px);background:var(--fg);color:var(--bg);padding:8px 14px;border-radius:8px;display:none;z-index:9;word-break:break-all}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--bd);border-top-color:var(--ac);border-radius:50%;animation:r .8s linear infinite;vertical-align:-2px;margin-right:4px}
@keyframes r{to{transform:rotate(360deg)}}
#login{max-width:320px;margin:20vh auto 0}
a{color:var(--ac);word-break:break-all}
</style></head><body><main>
<div id="login" class="card sec" hidden>
  <h1>Antigravity 账号</h1>
  <input id="pw" type="password" placeholder="管理口令" autocomplete="current-password">
  <button class="pri" id="loginBtn">登录</button>
</div>
<div id="app" hidden>
  <header>
    <h1>Antigravity 账号</h1><span class="sp"></span>
    <button class="pri" id="addBtn">添加账号</button>
    <button id="refBtn">刷新</button>
    <button id="reloadBtn">重新加载配置</button>
    <button id="outBtn">退出</button>
  </header>
  <div class="chips" id="chips"></div>
  <div class="grid" id="grid"></div>
</div>
<dialog id="dlg"></dialog>
<div id="toast"></div>
</main>
<script>
var KEY = "agyAdminToken", token = "", accounts = [], toastT;
function $(s) { return document.querySelector(s); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function toast(m) { var t = $("#toast"); t.textContent = m; t.style.display = "block"; clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = "none"; }, 5000); }
function showLogin() { $("#app").hidden = true; $("#login").hidden = false; $("#pw").focus(); }
async function api(method, path, body) {
  var res = await fetch(path, { method: method, headers: { Authorization: "Bearer " + token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  var data = null;
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401) { showLogin(); throw new Error((data && data.error) || "未授权，请重新登录"); }
  if (!res.ok) throw new Error((data && data.error) || ("请求失败 " + res.status));
  return data;
}
function pad(n) { return (n < 10 ? "0" : "") + n; }
function fmtReset(ms) {
  var d = new Date(ms), left = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return "重置 " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + " (还剩 " + Math.floor(left / 60) + "h " + left % 60 + "m)";
}
function quotaHtml(q) {
  if (!q) return '<div class="q mut">额度未知</div>';
  var h = "";
  if (q.error) h += '<div class="q err">额度错误：' + esc(q.error) + "</div>";
  (q.windows || []).forEach(function (w) {
    var p = Math.max(0, Math.min(100, Math.round(w.utilization * 100)));
    h += '<div class="q"><div class="t"><span>' + esc(w.group + " · " + w.type) + "</span><span>已用 " + p + "%</span></div>" +
      '<div class="bar"><i style="width:' + p + "%;background:" + (p >= 90 ? "var(--bad)" : "var(--ok)") + '"></i></div>' +
      '<div class="mut">' + esc(fmtReset(w.resetsAt)) + "</div></div>";
  });
  if (!h) h = '<div class="q mut">额度未知</div>';
  return h;
}
function card(a) {
  var st = a.disabled ? ["off", "停用"] : a.error ? ["bad", "异常"] : a.serving ? ["ok", "服务中"] : ["off", "未服务"];
  var hl = a.health, hh = hl ? "完成 " + hl.completed + " · 失败 " + hl.failed + " · 复用 " + hl.reused + " · 预热命中 " + hl.prewarmed + " · 进程 " + hl.processes + " · 待命 " + (hl.spareReady ? "✓" : "–") : "健康信息未知";
  return '<div class="card" data-n="' + esc(a.name) + '"><div class="row"><div><span class="nm">' + esc(a.name) + "</span> " +
    esc(a.email || "未登录") + '</div><span class="badge ' + st[0] + '">' + st[1] + "</span></div>" +
    '<div class="mut">端口 ' + a.port + (a.sub2apiId != null ? " · Sub2API #" + a.sub2apiId : "") + " · " + esc(a.proxy) + "</div>" +
    (a.error ? '<div class="err">' + esc(a.error) + "</div>" : "") +
    '<div class="mut" style="margin-top:6px">' + esc(hh) + "</div>" + quotaHtml(a.quota) +
    '<div class="acts"><button data-a="ip">测出口IP</button><button data-a="login">重新登录</button><button data-a="toggle">' +
    (a.disabled ? "启用" : "停用") + '</button><span class="mut ipout"></span></div></div>';
}
function render(r) {
  accounts = r.accounts || [];
  var n = accounts.length, ok = accounts.filter(function (a) { return a.serving && !a.disabled; }).length,
    bad = accounts.filter(function (a) { return a.error && !a.disabled; }).length, off = accounts.filter(function (a) { return a.disabled; }).length;
  var c = [["账号数", n], ["服务中", ok], ["异常", bad], ["停用", off]];
  if (r.pool && r.pool.max != null) c.push(["池上限", r.pool.max]);
  $("#chips").innerHTML = c.map(function (x) { return '<span class="chip">' + x[0] + " <b>" + x[1] + "</b></span>"; }).join("");
  $("#grid").innerHTML = accounts.map(card).join("") || '<div class="mut">暂无账号</div>';
}
async function load(quiet) {
  if (!token) return showLogin();
  try { var r = await api("GET", "/api/accounts"); $("#login").hidden = true; $("#app").hidden = false; render(r); }
  catch (e) { if (!quiet) toast(e.message); }
}
async function busy(btn, label, fn) {
  var old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>' + label;
  try { return await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.innerHTML = old; }
}
// ---- dialog wizard ----
var dlg = $("#dlg");
function openWizard(name) {
  dlg.innerHTML = '<h2>' + (name ? "重新登录 " + esc(name) : "添加账号") + '</h2><div id="s1"></div><div id="s2"></div><div id="s3"></div><div class="stp"><button id="close">' + "关闭" + "</button></div>";
  $("#close").onclick = closeWizard;
  if (name) step2(name);
  else {
    $("#s1").innerHTML = '<div class="sec"><label>代理地址</label><input id="px" placeholder="socks5h://user:pass@host:port"><div class="mut">每个账号使用独立代理/独立出口 IP</div><button class="pri" id="n1">下一步</button><div id="r1" class="mut"></div></div>';
    $("#n1").onclick = function (e) {
      var v = $("#px").value.trim(); if (!v) return toast("请输入代理地址");
      busy(e.target, "创建中…", async function () {
        var r = await api("POST", "/api/accounts", { proxy: v });
        $("#r1").textContent = "账号名 " + r.name + " · 端口 " + r.port + " · 出口IP " + r.exitIp;
        $("#px").disabled = true; e.target.hidden = true; step2(r.name);
      });
    };
  }
  if (!dlg.open) dlg.showModal();
}
function closeWizard() { dlg.close(); load(true); }
dlg.addEventListener("cancel", function () { setTimeout(function () { load(true); }, 0); });
function step2(name) {
  $("#s2").innerHTML = '<div class="stp sec"><button class="pri" id="n2">获取登录链接</button><div id="r2"></div></div>';
  $("#n2").onclick = function (e) {
    busy(e.target, "获取中（最长约30秒）…", async function () {
      var r = await api("POST", "/api/accounts/" + encodeURIComponent(name) + "/login");
      $("#r2").innerHTML = '<div class="mut" style="margin-bottom:6px">用要添加的 Google 账号登录，把页面显示的授权码粘贴到下面</div><a href="' + esc(r.url) + '" target="_blank" rel="noopener">打开登录链接</a> <button id="cp">复制</button>';
      $("#cp").onclick = function () {
        if (navigator.clipboard) navigator.clipboard.writeText(r.url).then(function () { toast("已复制"); }, function () { toast("复制失败，请手动复制"); });
        else toast("请长按链接复制");
      };
      step3(name);
    });
  };
}
function step3(name) {
  $("#s3").innerHTML = '<div class="stp sec"><input id="cd" placeholder="授权码" autocomplete="off"><button class="pri" id="n3">提交</button><div id="r3"></div></div>';
  $("#n3").onclick = function (e) {
    var v = $("#cd").value.trim(); if (!v) return toast("请输入授权码");
    busy(e.target, "提交中（最长约40秒）…", async function () {
      var r = await api("POST", "/api/accounts/" + encodeURIComponent(name) + "/code", { code: v });
      $("#r3").innerHTML = "邮箱 " + esc(r.email || "未知") + " · 服务中 " + (r.serving ? "是" : "否") + " · Sub2API " + esc(r.sub2apiId != null ? "#" + r.sub2apiId : "无") +
        (r.error ? '<div class="err">' + esc(r.error) + "</div>" : "");
      $("#close").textContent = "完成";
    });
  };
}
// ---- events ----
$("#grid").onclick = function (e) {
  var b = e.target.closest("button[data-a]"); if (!b) return;
  var c = b.closest(".card"), n = c.dataset.n, a = accounts.filter(function (x) { return x.name === n; })[0], act = b.dataset.a;
  if (act === "login") openWizard(n);
  else if (act === "ip") busy(b, "测试中…", async function () { var r = await api("POST", "/api/accounts/" + encodeURIComponent(n) + "/ip"); c.querySelector(".ipout").textContent = "出口IP " + r.exitIp; });
  else if (act === "toggle") {
    var dis = !(a && a.disabled);
    if (!confirm("确定要" + (dis ? "停用 " : "启用 ") + n + " 吗？")) return;
    busy(b, "处理中…", async function () { await api("POST", "/api/accounts/" + encodeURIComponent(n) + (dis ? "/disable" : "/enable")); toast((dis ? "已停用 " : "已启用 ") + n); await load(); });
  }
};
$("#addBtn").onclick = function () { openWizard(); };
$("#refBtn").onclick = function (e) { busy(e.target, "刷新", function () { return load(); }); };
$("#reloadBtn").onclick = function (e) {
  busy(e.target, "加载中…", async function () {
    var r = await api("POST", "/api/reload");
    toast("已重载：启动 " + (r.started || []).length + "，停止 " + (r.stopped || []).length + "，失败 " + (r.failed || []).length);
    await load();
  });
};
$("#outBtn").onclick = function () { try { localStorage.removeItem(KEY); } catch (e) {} token = ""; showLogin(); };
function doLogin() {
  var v = $("#pw").value.trim(); if (!v) return;
  token = v; try { localStorage.setItem(KEY, v); } catch (e) {}
  $("#pw").value = ""; load();
}
$("#loginBtn").onclick = doLogin;
$("#pw").onkeydown = function (e) { if (e.key === "Enter") doLogin(); };
try { token = localStorage.getItem(KEY) || ""; } catch (e) {}
load();
setInterval(function () { if (token && !dlg.open && !document.hidden) load(true); }, 15000);
</script></body></html>
`;
