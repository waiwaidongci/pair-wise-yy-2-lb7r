import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, bizError } from "./src/store.js";
import { intakeSample, completeSample, findSample } from "./src/intake.js";
import { judgeSample, retestSample, correctSample, sampleHistory } from "./src/adjudication.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3024);

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ],
  lab: { samples: [], freezes: [], seq: 0 }
};

const store = createStore(join(__dirname, "data", "pigeons.json"), seed);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽登记站 · 药检样本封存与结果冻结台</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .lab { display:grid; gap:22px; padding:0 28px 22px; } .labgrid { display:grid; grid-template-columns:320px 1fr; gap:18px; align-items:start; }
    table { width:100%; border-collapse:collapse; } th,td { border-bottom:1px solid var(--line); padding:8px; text-align:left; font-size:14px; vertical-align:top; }
    th { color:var(--muted); font-size:12px; } .check { display:flex; align-items:center; gap:8px; color:var(--ink); } .check input { width:auto; }
    .ops { display:flex; flex-wrap:wrap; gap:6px; } .ops select { width:auto; padding:6px; } .ops button { padding:6px 10px; }
    .opbar { display:grid; grid-template-columns:80px 1fr; gap:10px; align-items:center; margin-bottom:10px; } .opbar label { margin:0; }
    .msg { margin-top:10px; font-size:13px; color:var(--red); } .snap { display:grid; gap:10px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} .lab{padding:0 16px 16px;} .labgrid{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽登记站 · 药检样本封存与结果冻结台</h1><div class="meta">档案血统 · 样本封存 · 结论判定 · 成绩冻结</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <button>保存档案</button>
    </form>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <section class="lab">
    <div class="panel">
      <h2>药检样本封存与结果冻结台</h2>
      <div class="labgrid">
        <form id="sampleForm">
          <h2>采样登记</h2>
          <label>封存号</label><input name="sealNo" required>
          <label>足环号</label><select name="ringNo" id="ringPick" required></select>
          <label>采样人</label><input name="sampler" required>
          <label>采样时刻</label><input name="sampledAt" type="datetime-local">
          <label class="check"><input type="checkbox" name="hasSample"> 样本已采集</label>
          <label class="check"><input type="checkbox" name="hasManifest"> 送检单齐全</label>
          <label class="check"><input type="checkbox" name="ownerConfirmed"> 鸽主已确认</label>
          <div class="section"><button>登记封存</button></div>
          <div class="msg" id="sampleMsg"></div>
        </form>
        <div>
          <div class="opbar"><label>操作人</label><input id="operator" placeholder="判定 / 复检 / 更正人姓名"></div>
          <table id="sampleTable"></table>
        </div>
      </div>
    </div>
    <div class="panel">
      <h2>成绩冻结清单</h2>
      <table id="freezeTable"></table>
    </div>
    <div class="panel" id="historyPanel"><h2>更正快照</h2><p class="meta">点击样本行的“快照”查看更正前的旧结论。</p></div>
  </section>
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const sampleForm = document.querySelector("#sampleForm");
    const sampleTable = document.querySelector("#sampleTable");
    const freezeTable = document.querySelector("#freezeTable");
    const historyPanel = document.querySelector("#historyPanel");
    const sampleMsg = document.querySelector("#sampleMsg");
    const ringPick = document.querySelector("#ringPick");
    const STATUS_LABEL = { held: "留检", sealed: "已封存", judged: "阳性·已判定", released: "阴性·已解封", arbitration: "待仲裁" };
    const VERDICT_LABEL = { positive: "阳性", negative: "阴性" };
    const KIND_LABEL = { initial: "初检", retest: "复检", correction: "更正" };
    let pigeons = [];
    let samples = [];
    let freezes = [];
    let currentRing = null;
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.message || data.error || "请求失败"); err.data = data; throw err; }
      return data;
    }
    function renderCards() {
      cards.innerHTML = pigeons.map(p => '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button></article>').join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      const races = p.races.map((r, i) => {
        const state = r.frozen ? '已冻结('+(r.frozenBy || "")+')' : (r.settled ? "已结算" : "未结算");
        const btn = (!r.settled && !r.frozen) ? ' <button data-settle="'+i+'">结算</button>' : "";
        return r.event+" 第"+r.rank+"名 ["+state+"]"+btn;
      }).join("<br>") || "暂无";
      const lab = samples.filter(s => s.ringNo === p.ringNo).map(s => s.sealNo+"("+(STATUS_LABEL[s.status] || s.status)+")").join("、") || "暂无";
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：<br>'+races+'</div><div class="meta">药检：'+lab+'</div>';
      detail.querySelectorAll("[data-settle]").forEach(btn => btn.onclick = async () => {
        try { await api('/api/pigeons/'+encodeURIComponent(currentRing)+'/races/'+btn.dataset.settle+'/settle', { method:"POST" }); } catch (e) { alert(e.message); }
        await load();
      });
    }
    function renderRingPick() {
      const current = ringPick.value;
      ringPick.innerHTML = pigeons.map(p => '<option value="'+p.ringNo+'">'+p.ringNo+'</option>').join("");
      if (current) ringPick.value = current;
    }
    function rowActions(s) {
      const sel = '<select data-verdict="'+s.id+'"><option value="negative">阴性</option><option value="positive">阳性</option></select>';
      const parts = [];
      if (s.status === "held") parts.push('<button data-complete="'+s.id+'">补齐资料</button>');
      if (s.status === "sealed") parts.push(sel+'<button data-judge="'+s.id+'">判定</button>');
      if (s.status === "judged" || s.status === "released") parts.push(sel+'<button data-retest="'+s.id+'">复检</button><button data-correct="'+s.id+'">更正</button>');
      if (s.status === "arbitration") parts.push(sel+'<button data-correct="'+s.id+'">仲裁更正</button>');
      parts.push('<button data-history="'+s.id+'">快照</button>');
      return '<div class="ops">'+parts.join("")+'</div>';
    }
    function renderSamples() {
      const head = '<tr><th>封存号</th><th>足环</th><th>状态</th><th>结论</th><th>采样人</th><th>判定人</th><th>操作</th></tr>';
      sampleTable.innerHTML = head + (samples.map(s => '<tr><td>'+s.sealNo+'</td><td>'+s.ringNo+'</td><td>'+(STATUS_LABEL[s.status] || s.status)+(s.corrected ? "·已更正" : "")+'</td><td>'+(s.verdict ? VERDICT_LABEL[s.verdict] : "—")+'</td><td>'+s.sampler+'</td><td>'+(s.judgedBy || "—")+'</td><td>'+rowActions(s)+'</td></tr>').join("") || '<tr><td colspan="7" class="meta">暂无样本</td></tr>');
      bindSampleActions();
    }
    function renderFreezes() {
      const head = '<tr><th>封存号</th><th>足环</th><th>世代</th><th>赛事</th><th>冻结时间</th><th>状态</th></tr>';
      freezeTable.innerHTML = head + (freezes.map(f => '<tr><td>'+f.sealNo+'</td><td>'+f.ringNo+'</td><td>'+(f.generation === 0 ? "本鸽" : "第"+f.generation+"代")+'</td><td>'+(f.event || "—")+'</td><td>'+String(f.frozenAt).slice(0,19).replace("T"," ")+'</td><td>'+(f.liftedAt ? "已解除" : "冻结中")+'</td></tr>').join("") || '<tr><td colspan="6" class="meta">暂无冻结记录</td></tr>');
    }
    function operator() { return document.querySelector("#operator").value.trim(); }
    function verdictOf(id) { return document.querySelector('[data-verdict="'+id+'"]').value; }
    function sealOf(id) { const s = samples.find(item => item.id === id); return s ? s.sealNo : ""; }
    async function run(task) {
      try { await task(); sampleMsg.textContent = ""; }
      catch (e) { sampleMsg.textContent = e.message; }
      await load();
    }
    function bindSampleActions() {
      document.querySelectorAll("[data-complete]").forEach(btn => btn.onclick = () => run(async () => {
        await api('/api/lab/samples/'+btn.dataset.complete+'/complete', { method:"POST", body: JSON.stringify({ hasSample:true, hasManifest:true, ownerConfirmed:true }) });
      }));
      document.querySelectorAll("[data-judge]").forEach(btn => btn.onclick = () => run(async () => {
        const id = btn.dataset.judge;
        await api('/api/lab/samples/'+id+'/judge', { method:"POST", body: JSON.stringify({ tester: operator(), verdict: verdictOf(id) }) });
      }));
      document.querySelectorAll("[data-retest]").forEach(btn => btn.onclick = () => run(async () => {
        const id = btn.dataset.retest;
        await api('/api/lab/samples/'+id+'/retest', { method:"POST", body: JSON.stringify({ tester: operator(), verdict: verdictOf(id), originalSealNo: sealOf(id) }) });
      }));
      document.querySelectorAll("[data-correct]").forEach(btn => btn.onclick = () => run(async () => {
        const id = btn.dataset.correct;
        await api('/api/lab/samples/'+id+'/correct', { method:"POST", body: JSON.stringify({ tester: operator(), verdict: verdictOf(id), reason: "仲裁/更正定夺" }) });
      }));
      document.querySelectorAll("[data-history]").forEach(btn => btn.onclick = () => showHistory(btn.dataset.history));
    }
    async function showHistory(id) {
      const data = await api('/api/lab/samples/'+id+'/history');
      const cur = data.current;
      let html = '<h2>更正快照 · '+data.sealNo+'</h2><div class="meta">当前：'+(STATUS_LABEL[cur.status] || cur.status)+(cur.verdict ? " / "+VERDICT_LABEL[cur.verdict] : "")+(cur.corrected ? "（已更正 by "+(cur.correctedBy || "—")+"）" : "")+'</div>';
      if (!data.history.length) html += '<p class="meta">暂无历史快照。</p>';
      html += '<div class="snap section">'+data.history.map((h, i) => {
        const s = h.snapshot;
        const tests = (s.tests || []).map(t => "第"+t.round+"次 "+(KIND_LABEL[t.kind] || t.kind)+" "+t.tester+" "+(VERDICT_LABEL[t.verdict] || t.verdict)).join("；");
        return '<div class="small"><b>快照 '+(i+1)+'</b> · '+h.at+' · '+h.reason+' · 操作人 '+h.by+'<br>旧结论：'+(VERDICT_LABEL[s.verdict] || "无")+' · 旧状态：'+(STATUS_LABEL[s.status] || s.status)+'<br><span class="meta">检测记录：'+(tests || "无")+'</span><br><span class="meta">当时冻结 '+( (s.freezes || []).length )+' 条</span></div>';
      }).join("")+'</div>';
      historyPanel.innerHTML = html;
    }
    async function loadLab() {
      samples = await api("/api/lab/samples");
      freezes = await api("/api/lab/freezes");
      renderSamples();
      renderFreezes();
      renderRingPick();
    }
    async function load(){
      pigeons = await api("/api/pigeons");
      renderCards();
      await loadLab();
      if (currentRing) {
        try { renderRelation(await api('/api/pigeons/'+encodeURIComponent(currentRing)+'/relation')); }
        catch (e) { renderRelation(null); }
      } else renderRelation(null);
    }
    document.querySelector("#searchBtn").onclick = async () => { currentRing = search.value.trim(); renderRelation(await api('/api/pigeons/'+encodeURIComponent(currentRing)+'/relation')); };
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    sampleForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(sampleForm).entries());
      const payload = {
        sealNo: data.sealNo,
        ringNo: data.ringNo,
        sampler: data.sampler,
        hasSample: sampleForm.hasSample.checked,
        hasManifest: sampleForm.hasManifest.checked,
        ownerConfirmed: sampleForm.ownerConfirmed.checked
      };
      if (data.sampledAt) payload.sampledAt = new Date(data.sampledAt).toISOString();
      try {
        const s = await api("/api/lab/samples", { method:"POST", body: JSON.stringify(payload) });
        sampleMsg.textContent = "已登记 "+s.sealNo+"（"+(STATUS_LABEL[s.status] || s.status)+"）";
        sampleForm.reset();
      } catch (e) {
        const first = e.data && e.data.first;
        sampleMsg.textContent = e.message + (first ? "：首次登记为 "+first.sampler+" 于 "+String(first.createdAt).slice(0,19).replace("T"," ")+"，状态 "+(STATUS_LABEL[first.status] || first.status) : "");
      }
      await loadLab();
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && path === "/api/pigeons") return sendJson(res, 200, (await store.read()).pigeons);
    if (req.method === "POST" && path === "/api/pigeons") {
      const input = await body(req);
      const pigeon = await store.transact(db => {
        if (db.pigeons.some(item => item.ringNo === input.ringNo)) throw bizError(409, { error: "ring_exists", message: "足环号已登记" });
        const created = { ...input, vaccines: [], transfers: [], races: [] };
        db.pigeons.unshift(created);
        return created;
      });
      return sendJson(res, 201, pigeon);
    }
    const relationMatch = path.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(await store.read(), decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    const settleMatch = path.match(/^\/api\/pigeons\/(.+)\/races\/(\d+)\/settle$/);
    if (settleMatch && req.method === "POST") {
      const pigeon = await store.transact(db => {
        const found = db.pigeons.find(item => item.ringNo === decodeURIComponent(settleMatch[1]));
        if (!found) throw bizError(404, { error: "pigeon_not_found" });
        const race = found.races[Number(settleMatch[2])];
        if (!race) throw bizError(404, { error: "race_not_found" });
        if (race.frozen) throw bizError(409, { error: "race_frozen", frozenBy: race.frozenBy, message: "成绩已冻结，待药检结论" });
        race.settled = true;
        return found;
      });
      return sendJson(res, 200, pigeon);
    }
    const actionMatch = path.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const input = await body(req);
      const pigeon = await store.transact(db => {
        const found = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
        if (!found) throw bizError(404, { error: "pigeon_not_found" });
        if (actionMatch[2] === "transfers") {
          found.transfers.push({ date: input.date || new Date().toISOString().slice(0, 10), from: found.owner, to: input.to });
          found.owner = input.to;
        }
        if (actionMatch[2] === "races") found.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0), settled: Boolean(input.settled), frozen: false });
        if (actionMatch[2] === "vaccines") found.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
        return found;
      });
      return sendJson(res, 200, pigeon);
    }
    // 药检台：入口（登记/补齐）、判定（判定/复检/更正）、存储（样本/冻结/快照）
    if (req.method === "GET" && path === "/api/lab/samples") return sendJson(res, 200, (await store.read()).lab.samples);
    if (req.method === "POST" && path === "/api/lab/samples") {
      const input = await body(req);
      const sample = await store.transact(db => intakeSample(db, input));
      return sendJson(res, 201, sample);
    }
    if (req.method === "GET" && path === "/api/lab/freezes") return sendJson(res, 200, (await store.read()).lab.freezes);
    const historyMatch = path.match(/^\/api\/lab\/samples\/([^/]+)\/history$/);
    if (historyMatch && req.method === "GET") return sendJson(res, 200, sampleHistory(await store.read(), decodeURIComponent(historyMatch[1])));
    const labAction = path.match(/^\/api\/lab\/samples\/([^/]+)\/(complete|judge|retest|correct)$/);
    if (labAction && req.method === "POST") {
      const input = await body(req);
      const key = decodeURIComponent(labAction[1]);
      const handlers = { complete: completeSample, judge: judgeSample, retest: retestSample, correct: correctSample };
      const sample = await store.transact(db => handlers[labAction[2]](db, key, input));
      return sendJson(res, 200, sample);
    }
    const labSampleMatch = path.match(/^\/api\/lab\/samples\/([^/]+)$/);
    if (labSampleMatch && req.method === "GET") {
      const sample = findSample(await store.read(), decodeURIComponent(labSampleMatch[1]));
      return sample ? sendJson(res, 200, sample) : sendJson(res, 404, { error: "sample_not_found" });
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, error.status || 500, error.body || { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry & lab freeze app listening on http://localhost:${port}`));
