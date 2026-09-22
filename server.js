import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./src/store.js";
import {
  DomainError,
  registerSample,
  completeMaterials,
  unsealSample,
  recordConclusion,
  retestSample,
  arbitrateSample,
  correctConclusion,
  settleRace,
  isFrozen,
  effectiveConclusion,
  missingMaterials
} from "./src/adjudication.js";

// 入口层：HTTP 路由与页面。存储见 src/store.js，判定规则见 src/adjudication.js。

const __dirname = dirname(fileURLToPath(import.meta.url));
const store = createStore(join(__dirname, "data", "pigeons.json"));
const port = Number(process.env.PORT || 3024);

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

function sampleView(sample) {
  return { ...sample, effective: effectiveConclusion(sample), missing: missingMaterials(sample) };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽药检样本封存与结果冻结台</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2f7d4f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.danger { background:var(--red); } button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; align-content:start; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { color:var(--green); border-color:var(--green); } .pill.bad { color:var(--red); border-color:var(--red); } .pos { color:var(--red); }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .checks { display:flex; gap:12px; margin:10px 0; } .checks label { margin:0; display:flex; gap:4px; align-items:center; color:var(--ink); font-size:13px; } .checks input { width:auto; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; } .actions button { padding:7px 10px; font-size:13px; }
    aside { display:grid; gap:22px; align-content:start; }
    pre { background:#0f1c26; color:#d7e3ee; padding:12px; border-radius:8px; overflow:auto; max-height:320px; font-size:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽药检样本封存与结果冻结台</h1><div class="meta">采样登记 · 封存判定 · 阳性冻结 · 复检仲裁 · 更正快照</div></div><button id="reload">刷新</button></header>
  <main>
    <aside>
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
      <form id="sampleForm">
        <h2>采样登记</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>封存号</label><input name="sealNo" required>
        <label>采样人</label><input name="sampler" required>
        <div class="checks">
          <label><input type="checkbox" name="hasSample">样本已采</label>
          <label><input type="checkbox" name="hasSubmissionForm">送检单齐全</label>
          <label><input type="checkbox" name="hasOwnerConfirm">鸽主已确认</label>
        </div>
        <button>登记样本</button>
        <div class="meta">样本、送检单、鸽主确认缺一项仅可留检；封存号在未解封样本中唯一，重复或并发登记沿用首次结果并返回 409。</div>
      </form>
    </aside>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="panel section" id="freezes"></div>
      <div class="section"><h2>药检样本</h2><div class="grid" id="samples"></div></div>
      <div class="section"><div class="panel" id="snapshots"></div></div>
      <div class="section"><h2>鸽只档案</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const sampleForm = document.querySelector("#sampleForm");
    const cards = document.querySelector("#cards");
    const samplesEl = document.querySelector("#samples");
    const freezesEl = document.querySelector("#freezes");
    const snapshotsEl = document.querySelector("#snapshots");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const STATUS_LABEL = { held: "留检", sealed: "已封存待检", unsealed: "已解封" };
    const STAGE_LABEL = { none: "未检", initial: "初检", confirmed: "复检确认", contested: "待仲裁", final: "仲裁终局", corrected: "已更正" };
    const CONCL_LABEL = { positive: "阳性", negative: "阴性" };
    const CONCL_INPUT = { "阳性": "positive", "阴性": "negative", positive: "positive", negative: "negative" };
    let pigeons = [], samples = [], currentRing = null;
    async function api(path, options) {
      const res = await fetch(path, options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.message || data.error || "请求失败"); err.data = data; throw err; }
      return data;
    }
    const post = obj => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj || {}) });
    const enc = encodeURIComponent;
    function renderCards() {
      cards.innerHTML = pigeons.map(p => '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button></article>').join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        await api('/api/pigeons/'+enc(ringNo)+'/transfers', post({ to })); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        await api('/api/pigeons/'+enc(ringNo)+'/races', post({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) })); await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      const races = p.races.map((r, i) => {
        const state = r.settled ? "已结算" : r.frozen ? "冻结中" : "未结算";
        const btn = !r.settled && !r.frozen ? ' <button class="ghost" data-settle="'+i+'">结算</button>' : "";
        return r.event+" 第"+r.rank+"名["+state+"]"+btn;
      }).join(" / ") || "暂无";
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+races+'</div>';
      document.querySelectorAll("[data-settle]").forEach(btn => btn.onclick = async () => {
        try { await api('/api/pigeons/'+enc(p.ringNo)+'/races/'+btn.dataset.settle+'/settle', post({})); await load(); }
        catch (err) { alert(err.message); }
      });
    }
    function renderSamples() {
      samplesEl.innerHTML = samples.map(s => {
        const mats = [["sample","样本"],["submissionForm","送检单"],["ownerConfirm","鸽主确认"]].map(pair =>
          '<span class="pill '+(s.materials[pair[0]] ? "ok" : "bad")+'">'+pair[1]+(s.materials[pair[0]] ? "✓" : "✗")+'</span>').join(" ");
        let concl = "";
        if (s.conclusion) {
          concl = '<div>结论：<b class="'+(s.effective === "positive" ? "pos" : "")+'">'+CONCL_LABEL[s.conclusion]+'</b>（'+STAGE_LABEL[s.stage]+'）'
            + (s.stage === "contested" ? '<span class="meta"> 仲裁前暂按'+CONCL_LABEL[s.effective]+'执行</span>' : "")
            + '<div class="meta">检验人：'+(s.analyst || "-")+(s.arbitrator ? " · 仲裁人："+s.arbitrator : "")+'</div></div>';
        }
        let actions = "";
        if (s.status === "held") actions = '<button data-act="materials" data-seal="'+s.sealNo+'">补齐材料</button>';
        else if (s.status === "sealed") actions = '<button data-act="unseal" data-seal="'+s.sealNo+'">解封</button>';
        else if (!s.conclusion) actions = '<button data-act="conclusion" data-c="negative" data-seal="'+s.sealNo+'">初检阴性</button><button class="danger" data-act="conclusion" data-c="positive" data-seal="'+s.sealNo+'">初检阳性</button>';
        if (s.conclusion && s.stage !== "contested") actions += '<button class="ghost" data-act="retest" data-mode="same" data-seal="'+s.sealNo+'">复检·维持</button><button class="ghost" data-act="retest" data-mode="opposite" data-seal="'+s.sealNo+'">复检·相反</button><button class="ghost" data-act="correct" data-seal="'+s.sealNo+'">更正结论</button>';
        if (s.stage === "contested") actions += '<button class="danger" data-act="arbitrate" data-c="positive" data-seal="'+s.sealNo+'">仲裁阳性</button><button data-act="arbitrate" data-c="negative" data-seal="'+s.sealNo+'">仲裁阴性</button>';
        return '<article class="card"><h3>封存号 '+s.sealNo+' <span class="pill">'+STATUS_LABEL[s.status]+'</span></h3>'
          + '<div class="meta">'+s.ringNo+' · 采样人 '+s.sampler+' · '+s.sampledAt+'</div>'
          + '<div>'+mats+'</div>' + concl
          + (actions ? '<div class="actions">'+actions+'</div>' : "")
          + (s.history && s.history.length ? '<div class="meta">'+s.history.map(h => h.detail || h.action).join(" → ")+'</div>' : "")
          + '</article>';
      }).join("") || '<p class="meta">暂无样本，请在左侧登记采样。</p>';
      document.querySelectorAll("[data-act]").forEach(btn => btn.onclick = () => sampleAction(btn));
    }
    async function sampleAction(btn) {
      const seal = btn.dataset.seal, act = btn.dataset.act;
      try {
        if (act === "materials") await api("/api/samples/"+enc(seal)+"/materials", post({ all: true }));
        if (act === "unseal") {
          const operator = prompt("解封人："); if (operator === null) return;
          await api("/api/samples/"+enc(seal)+"/unseal", post({ operator }));
        }
        if (act === "conclusion") {
          const analyst = prompt("检验人："); if (!analyst) return;
          await api("/api/samples/"+enc(seal)+"/conclusion", post({ analyst, conclusion: btn.dataset.c }));
        }
        if (act === "retest") {
          const analyst = prompt("复检人（须与初检人不同）："); if (!analyst) return;
          const sample = samples.find(x => x.sealNo === seal);
          const conclusion = btn.dataset.mode === "same" ? sample.conclusion : (sample.conclusion === "positive" ? "negative" : "positive");
          await api("/api/samples/"+enc(seal)+"/retest", post({ analyst, conclusion, originalSealNo: seal }));
        }
        if (act === "arbitrate") {
          const arbitrator = prompt("仲裁人："); if (!arbitrator) return;
          await api("/api/samples/"+enc(seal)+"/arbitrate", post({ arbitrator, conclusion: btn.dataset.c }));
        }
        if (act === "correct") {
          const input = prompt("新结论（阳性/阴性）："); if (!input) return;
          const conclusion = CONCL_INPUT[input.trim()]; if (!conclusion) return alert("结论须为 阳性 或 阴性");
          const reason = prompt("更正原因："); if (!reason) return;
          const operator = prompt("更正人："); if (!operator) return;
          await api("/api/samples/"+enc(seal)+"/correct", post({ conclusion, reason, operator }));
        }
        await load();
      } catch (err) { alert(err.message); }
    }
    function renderFreezes(data) {
      freezesEl.innerHTML = '<h2>成绩冻结</h2>' + (data.rings.length
        ? '<div>冻结足环：'+data.rings.map(r => '<span class="pill bad">'+r+'</span>').join(" ")+'</div>'
          + '<div class="meta">冻结中成绩（未结算）：'+(data.races.map(r => r.ringNo+" "+r.event+" 第"+r.rank+"名").join("；") || "无")+'</div>'
          + '<div class="meta">已结算名次保留，不在冻结范围。</div>'
          + '<div class="meta">最近变动：'+(data.log.slice(0, 5).map(l => (l.action === "freeze" ? "冻结 " : "解冻 ")+l.ringNo+"（"+l.reason+"）").join("；") || "无")+'</div>'
        : '<p class="meta">当前无冻结。样本判定阳性后，本鸽及三代内后代的未结算成绩将被冻结。</p>');
    }
    function renderSnapshots(list) {
      snapshotsEl.innerHTML = '<h2>结论快照（仲裁/更正前的旧状态）</h2>'
        + (list.length
          ? list.map(s => '<div class="small"><b>'+s.id+'</b> · '+s.at+' · '+s.reason+' · 经手 '+(s.operator || "-")+' <button class="ghost" data-snap="'+s.id+'">查看</button></div>').join("")
          : '<p class="meta">暂无快照。仲裁或更正改变结论时，会自动留存旧结论与旧冻结状态。</p>')
        + '<pre id="snapView" style="display:none"></pre>';
      document.querySelectorAll("[data-snap]").forEach(btn => btn.onclick = async () => {
        const snap = await api("/api/snapshots/"+enc(btn.dataset.snap));
        const view = document.querySelector("#snapView");
        view.style.display = "block";
        view.textContent = JSON.stringify(snap, null, 2);
      });
    }
    async function load() {
      pigeons = await api("/api/pigeons");
      samples = await api("/api/samples");
      renderCards(); renderSamples();
      renderFreezes(await api("/api/freezes"));
      renderSnapshots(await api("/api/snapshots"));
      if (currentRing) {
        try { renderRelation(await api('/api/pigeons/'+enc(currentRing)+'/relation')); }
        catch (err) { renderRelation(null); }
      } else renderRelation(null);
    }
    document.querySelector("#searchBtn").onclick = async () => { currentRing = search.value.trim(); await load(); };
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", post(Object.fromEntries(new FormData(form).entries())));
      form.reset(); await load();
    };
    sampleForm.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(sampleForm);
      try {
        await api("/api/samples", post({
          ringNo: fd.get("ringNo"), sealNo: fd.get("sealNo"), sampler: fd.get("sampler"),
          hasSample: !!fd.get("hasSample"), hasSubmissionForm: !!fd.get("hasSubmissionForm"), hasOwnerConfirm: !!fd.get("hasOwnerConfirm")
        }));
        sampleForm.reset(); await load();
      } catch (err) {
        if (err.data && err.data.first) {
          const first = err.data.first;
          alert(err.message + "\\n首次登记：采样人 " + first.sampler + "，时刻 " + first.sampledAt + "，状态 " + STATUS_LABEL[first.status]);
        } else alert(err.message);
      }
    };
    load();
  </script>
</body>
</html>`;

const sampleActions = {
  materials: completeMaterials,
  unseal: unsealSample,
  conclusion: recordConclusion,
  retest: retestSample,
  arbitrate: arbitrateSample,
  correct: correctConclusion
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    // —— 鸽只档案（登记站原有功能）——
    if (req.method === "GET" && pathname === "/api/pigeons") {
      return sendJson(res, 200, (await store.read()).pigeons);
    }
    if (req.method === "POST" && pathname === "/api/pigeons") {
      const input = await body(req);
      if (!input.ringNo) return sendJson(res, 400, { error: "missing_ring", message: "足环号不能为空" });
      const pigeon = await store.update(db => {
        if (db.pigeons.some(item => item.ringNo === input.ringNo)) {
          throw new DomainError(409, "ring_exists", "足环号已登记");
        }
        const created = { ...input, vaccines: [], transfers: [], races: [] };
        db.pigeons.unshift(created);
        return created;
      });
      return sendJson(res, 201, pigeon);
    }
    const relationMatch = pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(await store.read(), decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    const settleMatch = pathname.match(/^\/api\/pigeons\/(.+)\/races\/(\d+)\/settle$/);
    if (settleMatch && req.method === "POST") {
      const race = await store.update(db => settleRace(db, decodeURIComponent(settleMatch[1]), Number(settleMatch[2])));
      return sendJson(res, 200, race);
    }
    const actionMatch = pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(actionMatch[1]);
      const input = await body(req);
      const pigeon = await store.update(db => {
        const found = db.pigeons.find(item => item.ringNo === ringNo);
        if (!found) throw new DomainError(404, "pigeon_not_found", "足环号未登记");
        if (actionMatch[2] === "transfers") {
          found.transfers.push({ date: input.date || new Date().toISOString().slice(0, 10), from: found.owner, to: input.to });
          found.owner = input.to;
        }
        if (actionMatch[2] === "races") {
          // 冻结中的鸽只新录成绩同样未结算，直接标记冻结
          found.races.push({
            date: input.date || new Date().toISOString().slice(0, 10),
            event: input.event,
            distance: Number(input.distance || 0),
            returnTime: input.returnTime || "",
            rank: Number(input.rank || 0),
            settled: false,
            frozen: isFrozen(db, ringNo)
          });
        }
        if (actionMatch[2] === "vaccines") {
          found.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
        }
        return found;
      });
      return sendJson(res, 200, pigeon);
    }

    // —— 药检样本：采样、留检补齐、解封、判定、复检、仲裁、更正 ——
    if (req.method === "GET" && pathname === "/api/samples") {
      const db = await store.read();
      const status = url.searchParams.get("status");
      return sendJson(res, 200, db.samples.filter(item => !status || item.status === status).map(sampleView));
    }
    if (req.method === "POST" && pathname === "/api/samples") {
      const input = await body(req);
      const sample = await store.update(db => registerSample(db, input));
      return sendJson(res, 201, sampleView(sample));
    }
    const sampleActionMatch = pathname.match(/^\/api\/samples\/(.+)\/(materials|unseal|conclusion|retest|arbitrate|correct)$/);
    if (sampleActionMatch && req.method === "POST") {
      const sealNo = decodeURIComponent(sampleActionMatch[1]);
      const input = await body(req);
      const sample = await store.update(db => sampleActions[sampleActionMatch[2]](db, sealNo, input));
      return sendJson(res, 200, sampleView(sample));
    }
    const sampleMatch = pathname.match(/^\/api\/samples\/(.+)$/);
    if (sampleMatch && req.method === "GET") {
      const db = await store.read();
      const sample = db.samples.find(item => item.sealNo === decodeURIComponent(sampleMatch[1]));
      return sample ? sendJson(res, 200, sampleView(sample)) : sendJson(res, 404, { error: "sample_not_found" });
    }

    // —— 冻结名单与历史快照 ——
    if (req.method === "GET" && pathname === "/api/freezes") {
      const db = await store.read();
      const races = [];
      for (const pigeon of db.pigeons) {
        pigeon.races.forEach((race, index) => {
          if (race.frozen) races.push({ ringNo: pigeon.ringNo, index, event: race.event, rank: race.rank, settled: !!race.settled });
        });
      }
      return sendJson(res, 200, { rings: db.frozenRings || [], races, log: (db.freezeLog || []).slice(-50).reverse() });
    }
    if (req.method === "GET" && pathname === "/api/snapshots") {
      const db = await store.read();
      return sendJson(res, 200, db.snapshots.map(({ id, at, reason, sealNo, operator }) => ({ id, at, reason, sealNo, operator })));
    }
    const snapshotMatch = pathname.match(/^\/api\/snapshots\/(.+)$/);
    if (snapshotMatch && req.method === "GET") {
      const db = await store.read();
      const snap = db.snapshots.find(item => item.id === decodeURIComponent(snapshotMatch[1]));
      return snap ? sendJson(res, 200, snap) : sendJson(res, 404, { error: "snapshot_not_found" });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof DomainError) {
      return sendJson(res, error.status, { error: error.code, message: error.message, ...error.extra });
    }
    sendJson(res, 500, { error: "internal_error", message: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon doping-control station listening on http://localhost:${port}`));
