import { bizError } from "./store.js";

// 入口层：采样登记与资料补齐。采样绑定足环、时刻、封存号和采样人。

export function isComplete(sample) {
  return Boolean(sample.hasSample && sample.hasManifest && sample.ownerConfirmed);
}

export function missingItems(sample) {
  const missing = [];
  if (!sample.hasSample) missing.push("样本");
  if (!sample.hasManifest) missing.push("送检单");
  if (!sample.ownerConfirmed) missing.push("鸽主确认");
  return missing;
}

// 未解封样本（留检/已封存/已判定/待仲裁）才占用封存号；阴性解封后号可再用
export function activeSampleBySeal(db, sealNo) {
  return db.lab.samples.find(sample => sample.sealNo === sealNo && sample.status !== "released") || null;
}

// 按内部编号或封存号查样本；封存号命中多条时优先未解封的那条
export function findSample(db, key) {
  return db.lab.samples.find(sample => sample.id === key)
    || activeSampleBySeal(db, key)
    || db.lab.samples.find(sample => sample.sealNo === key)
    || null;
}

export function intakeSample(db, input) {
  const sealNo = String(input.sealNo || "").trim();
  const ringNo = String(input.ringNo || "").trim();
  const sampler = String(input.sampler || "").trim();
  if (!sealNo || !ringNo || !sampler) throw bizError(400, { error: "missing_fields", need: ["sealNo", "ringNo", "sampler"], message: "封存号、足环号、采样人必填" });
  if (!db.pigeons.some(pigeon => pigeon.ringNo === ringNo)) throw bizError(404, { error: "pigeon_not_found", ringNo, message: "足环号未登记" });
  // 重复或并发登记同一封存号：沿用首次结果返回 409
  const first = activeSampleBySeal(db, sealNo);
  if (first) throw bizError(409, { error: "seal_in_use", message: "封存号已被未解封样本占用，沿用首次登记结果", first });
  const sample = {
    id: `LAB-${String(++db.lab.seq).padStart(4, "0")}`,
    sealNo,
    ringNo,
    sampledAt: input.sampledAt || new Date().toISOString(),
    sampler,
    hasSample: Boolean(input.hasSample),
    hasManifest: Boolean(input.hasManifest),
    ownerConfirmed: Boolean(input.ownerConfirmed),
    status: "held",
    verdict: null,
    judgedBy: null,
    judgedAt: null,
    corrected: false,
    tests: [],
    history: [],
    createdAt: new Date().toISOString()
  };
  // 样本、送检单、鸽主确认缺一项只能留检
  sample.status = isComplete(sample) ? "sealed" : "held";
  db.lab.samples.unshift(sample);
  return sample;
}

// 留检样本补齐资料，三项齐全后转为已封存
export function completeSample(db, key, input) {
  const sample = findSample(db, key);
  if (!sample) throw bizError(404, { error: "sample_not_found", message: "样本不存在" });
  if (sample.status !== "held") throw bizError(409, { error: "not_held", status: sample.status, message: "仅留检样本可补齐资料" });
  for (const field of ["hasSample", "hasManifest", "ownerConfirmed"]) {
    if (field in input) sample[field] = Boolean(input[field]);
  }
  if (isComplete(sample)) sample.status = "sealed";
  return sample;
}
