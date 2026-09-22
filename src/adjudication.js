// 判定层：药检样本生命周期、阳性冻结、复检仲裁与更正重算的全部规则。
// 不触碰文件与 HTTP，只操作传入的 db 对象；持久化见 src/store.js。

export class DomainError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const MATERIAL_LABELS = { sample: "样本", submissionForm: "送检单", ownerConfirm: "鸽主确认" };
const CONCLUSION_LABELS = { positive: "阳性", negative: "阴性" };

const now = () => new Date().toISOString();

function mustSample(db, sealNo) {
  const sample = db.samples.find(item => item.sealNo === sealNo);
  if (!sample) throw new DomainError(404, "sample_not_found", `封存号 ${sealNo} 不存在`);
  return sample;
}

function mustConclusion(value) {
  const conclusion = String(value || "").trim().toLowerCase();
  if (!CONCLUSION_LABELS[conclusion]) {
    throw new DomainError(400, "bad_conclusion", "结论须为 positive（阳性）或 negative（阴性）");
  }
  return conclusion;
}

function mustPerson(value, label) {
  const person = String(value || "").trim();
  if (!person) throw new DomainError(400, "missing_person", `${label}不能为空`);
  return person;
}

export function missingMaterials(sample) {
  return Object.entries(MATERIAL_LABELS)
    .filter(([key]) => !sample.materials[key])
    .map(([, label]) => label);
}

// 待仲裁期间维持初检结论的效力，其余阶段以当前结论为准
export function effectiveConclusion(sample) {
  if (!sample.conclusion) return null;
  return sample.stage === "contested" ? sample.initialConclusion : sample.conclusion;
}

// 本鸽 + 三代内后代（子一代、孙一代、曾孙一代）
export function descendantsWithin(db, ringNo, maxDepth = 3) {
  const result = new Set([ringNo]);
  let frontier = [ringNo];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const pigeon of db.pigeons) {
      if (result.has(pigeon.ringNo)) continue;
      if (frontier.includes(pigeon.fatherRing) || frontier.includes(pigeon.motherRing)) {
        result.add(pigeon.ringNo);
        next.push(pigeon.ringNo);
      }
    }
    frontier = next;
  }
  return [...result];
}

export function isFrozen(db, ringNo) {
  return (db.frozenRings || []).includes(ringNo);
}

// 按全部样本的现行结论重算冻结：阳性鸽及其三代内后代的未结算成绩冻结，已结算名次保留
export function recomputeFreezes(db, reason = "") {
  const frozen = new Set();
  for (const sample of db.samples) {
    if (effectiveConclusion(sample) === "positive") {
      for (const ring of descendantsWithin(db, sample.ringNo, 3)) frozen.add(ring);
    }
  }
  const before = new Set(db.frozenRings || []);
  db.frozenRings = [...frozen];
  for (const pigeon of db.pigeons) {
    const pigeonFrozen = frozen.has(pigeon.ringNo);
    for (const race of pigeon.races) {
      race.frozen = pigeonFrozen && !race.settled;
    }
  }
  const at = now();
  for (const ringNo of frozen) {
    if (!before.has(ringNo)) db.freezeLog.push({ at, action: "freeze", ringNo, reason });
  }
  for (const ringNo of before) {
    if (!frozen.has(ringNo)) db.freezeLog.push({ at, action: "unfreeze", ringNo, reason });
  }
  return db.frozenRings;
}

// 结论被仲裁/更正改变前，留存旧结论与旧冻结状态，供事后查询
function snapshotState(db, reason, sealNo, operator) {
  const snap = {
    id: `SNAP-${String(db.snapshots.length + 1).padStart(4, "0")}`,
    at: now(),
    reason,
    sealNo,
    operator: operator || "",
    conclusions: db.samples
      .filter(item => item.conclusion)
      .map(item => ({
        sealNo: item.sealNo,
        ringNo: item.ringNo,
        conclusion: item.conclusion,
        stage: item.stage,
        effective: effectiveConclusion(item)
      })),
    frozenRings: [...(db.frozenRings || [])],
    races: db.pigeons.flatMap(pigeon =>
      pigeon.races
        .map((race, index) => ({
          ringNo: pigeon.ringNo,
          index,
          event: race.event,
          rank: race.rank,
          settled: !!race.settled,
          frozen: !!race.frozen
        }))
        .filter(race => race.frozen || race.settled)
    )
  };
  db.snapshots.push(snap);
  return snap;
}

// 采样登记：绑定足环、时刻、封存号、采样人；材料缺项只能留检
export function registerSample(db, input) {
  const ringNo = String(input.ringNo || "").trim();
  const sealNo = String(input.sealNo || "").trim();
  const sampler = mustPerson(input.sampler, "采样人");
  if (!ringNo) throw new DomainError(400, "missing_ring", "足环号不能为空");
  if (!sealNo) throw new DomainError(400, "missing_seal", "封存号不能为空");
  if (!db.pigeons.some(item => item.ringNo === ringNo)) {
    throw new DomainError(404, "pigeon_not_found", `足环号 ${ringNo} 未登记`);
  }
  // 封存号在未解封样本中唯一；重复或并发登记沿用首次结果，由入口返回 409
  const first = db.samples.find(item => item.sealNo === sealNo && item.status !== "unsealed");
  if (first) {
    throw new DomainError(409, "seal_conflict", `封存号 ${sealNo} 已登记且未解封，沿用首次结果`, { first });
  }
  const materials = {
    sample: !!input.hasSample,
    submissionForm: !!input.hasSubmissionForm,
    ownerConfirm: !!input.hasOwnerConfirm
  };
  const at = now();
  const sample = {
    sealNo,
    ringNo,
    sampler,
    sampledAt: input.sampledAt || at,
    materials,
    status: "held",
    conclusion: null,
    initialConclusion: null,
    analyst: null,
    stage: "none",
    arbitrator: null,
    retests: [],
    corrections: [],
    history: [],
    createdAt: at,
    updatedAt: at
  };
  const missing = missingMaterials(sample);
  sample.status = missing.length ? "held" : "sealed";
  sample.history.push({
    at,
    action: "register",
    by: sampler,
    detail: missing.length ? `缺${missing.join("、")}，留检` : "样本、送检单、鸽主确认齐全，封存待检"
  });
  db.samples.unshift(sample);
  return sample;
}

// 留检样本补齐材料，齐全后转封存待检
export function completeMaterials(db, sealNo, input = {}) {
  const sample = mustSample(db, sealNo);
  if (sample.status !== "held") throw new DomainError(409, "not_held", "仅留检样本可补齐材料");
  const patch = { sample: input.hasSample, submissionForm: input.hasSubmissionForm, ownerConfirm: input.hasOwnerConfirm };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) sample.materials[key] = !!value;
  }
  if (input.all) {
    for (const key of Object.keys(sample.materials)) sample.materials[key] = true;
  }
  const missing = missingMaterials(sample);
  sample.status = missing.length ? "held" : "sealed";
  sample.history.push({
    at: now(),
    action: "complete_materials",
    by: String(input.operator || "").trim(),
    detail: missing.length ? `仍缺${missing.join("、")}，继续留检` : "材料补齐，转封存待检"
  });
  sample.updatedAt = now();
  return sample;
}

// 实验室解封；留检样本缺项不得解封
export function unsealSample(db, sealNo, input = {}) {
  const sample = mustSample(db, sealNo);
  if (sample.status === "held") {
    throw new DomainError(409, "incomplete_materials", `缺${missingMaterials(sample).join("、")}，只能留检，不得解封`);
  }
  if (sample.status === "unsealed") throw new DomainError(409, "already_unsealed", "样本已解封");
  sample.status = "unsealed";
  sample.unsealedAt = now();
  sample.unsealedBy = String(input.operator || "").trim();
  sample.history.push({ at: now(), action: "unseal", by: sample.unsealedBy, detail: "实验室解封" });
  sample.updatedAt = now();
  return sample;
}

// 初检判定：须先解封；阳性即刻触发冻结重算
export function recordConclusion(db, sealNo, input = {}) {
  const sample = mustSample(db, sealNo);
  if (sample.status === "held") {
    throw new DomainError(409, "incomplete_materials", `缺${missingMaterials(sample).join("、")}，只能留检，不得判定`);
  }
  if (sample.status !== "unsealed") throw new DomainError(409, "not_unsealed", "样本须先解封再判定");
  if (sample.conclusion) throw new DomainError(409, "conclusion_exists", "已有结论，请走复检或更正流程");
  const analyst = mustPerson(input.analyst, "检验人");
  const conclusion = mustConclusion(input.conclusion);
  sample.conclusion = conclusion;
  sample.initialConclusion = conclusion;
  sample.analyst = analyst;
  sample.stage = "initial";
  sample.history.push({ at: now(), action: "conclusion", by: analyst, detail: `初检${CONCLUSION_LABELS[conclusion]}` });
  sample.updatedAt = now();
  recomputeFreezes(db, `封存号 ${sealNo} 初检${CONCLUSION_LABELS[conclusion]}`);
  return sample;
}

// 复检：须引用原封存号且换人；结论相反则待仲裁，仲裁前维持初检结论效力
export function retestSample(db, sealNo, input = {}) {
  const sample = mustSample(db, sealNo);
  if (input.originalSealNo !== undefined && String(input.originalSealNo).trim() !== sealNo) {
    throw new DomainError(400, "seal_mismatch", "复检引用的原封存号与样本不符");
  }
  if (!sample.conclusion) throw new DomainError(409, "no_conclusion", "尚无初检结论，无法复检");
  if (sample.stage === "contested") throw new DomainError(409, "pending_arbitration", "结论待仲裁，须先仲裁");
  const analyst = mustPerson(input.analyst, "复检人");
  if (analyst === sample.analyst) {
    throw new DomainError(409, "same_analyst", "复检须换人，复检人不能与初检人相同");
  }
  const conclusion = mustConclusion(input.conclusion);
  sample.retests.push({ analyst, conclusion, originalSealNo: sealNo, at: now() });
  const opposite = conclusion !== sample.conclusion;
  sample.stage = opposite ? "contested" : "confirmed";
  sample.history.push({
    at: now(),
    action: "retest",
    by: analyst,
    detail: opposite ? `复检${CONCLUSION_LABELS[conclusion]}，与初检相反，待仲裁` : "复检维持原结论"
  });
  sample.updatedAt = now();
  recomputeFreezes(db, `封存号 ${sealNo} 复检`);
  return sample;
}

// 仲裁：仅待仲裁样本；按仲裁结论重算冻结，旧状态入快照
export function arbitrateSample(db, sealNo, input = {}) {
  const sample = mustSample(db, sealNo);
  if (sample.stage !== "contested") throw new DomainError(409, "not_contested", "仅复检结论相反、待仲裁的样本可仲裁");
  const arbitrator = mustPerson(input.arbitrator, "仲裁人");
  const conclusion = mustConclusion(input.conclusion);
  snapshotState(db, `仲裁改判为${CONCLUSION_LABELS[conclusion]}`, sealNo, arbitrator);
  sample.conclusion = conclusion;
  sample.stage = "final";
  sample.arbitrator = arbitrator;
  sample.history.push({ at: now(), action: "arbitrate", by: arbitrator, detail: `仲裁终局：${CONCLUSION_LABELS[conclusion]}` });
  sample.updatedAt = now();
  recomputeFreezes(db, `封存号 ${sealNo} 仲裁${CONCLUSION_LABELS[conclusion]}`);
  return sample;
}

// 更正：按新结论重算冻结，旧快照可查
export function correctConclusion(db, sealNo, input = {}) {
  const sample = mustSample(db, sealNo);
  if (!sample.conclusion) throw new DomainError(409, "no_conclusion", "尚无结论可更正");
  const operator = mustPerson(input.operator, "更正人");
  const reason = String(input.reason || "").trim();
  if (!reason) throw new DomainError(400, "missing_reason", "更正须填写原因");
  const conclusion = mustConclusion(input.conclusion);
  if (conclusion === effectiveConclusion(sample)) {
    throw new DomainError(409, "no_change", "新结论与现行结论一致，无需更正");
  }
  snapshotState(db, `更正：${reason}`, sealNo, operator);
  sample.corrections.push({ from: sample.conclusion, to: conclusion, reason, by: operator, at: now() });
  sample.conclusion = conclusion;
  sample.stage = "corrected";
  sample.history.push({ at: now(), action: "correct", by: operator, detail: `更正为${CONCLUSION_LABELS[conclusion]}：${reason}` });
  sample.updatedAt = now();
  recomputeFreezes(db, `封存号 ${sealNo} 更正为${CONCLUSION_LABELS[conclusion]}`);
  return sample;
}

// 成绩结算：冻结中的未结算成绩不得结算
export function settleRace(db, ringNo, raceIndex) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) throw new DomainError(404, "pigeon_not_found", "足环号未登记");
  const race = pigeon.races[raceIndex];
  if (!race) throw new DomainError(404, "race_not_found", "成绩不存在");
  if (race.settled) return race;
  if (race.frozen) {
    throw new DomainError(409, "race_frozen", "成绩未结算且处于冻结状态，须待药检结论解冻");
  }
  race.settled = true;
  race.settledAt = now();
  race.frozen = false;
  return race;
}
