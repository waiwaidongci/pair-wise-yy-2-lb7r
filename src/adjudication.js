import { bizError } from "./store.js";
import { findSample, missingItems } from "./intake.js";

// 判定层：结论判定、成绩冻结、复检仲裁、更正重算。

const MAX_GENERATION = 3; // 阳性冻结范围：本鸽及三代内后代
const VERDICTS = ["positive", "negative"];

// 沿父/母足环向下找三代内后代，返回 [{ ringNo, generation }]
export function descendantsWithin(db, ringNo, maxGeneration = MAX_GENERATION) {
  const seen = new Set([ringNo]);
  const result = [];
  let frontier = [ringNo];
  for (let generation = 1; generation <= maxGeneration; generation += 1) {
    const next = db.pigeons
      .filter(pigeon => frontier.includes(pigeon.fatherRing) || frontier.includes(pigeon.motherRing))
      .map(pigeon => pigeon.ringNo)
      .filter(ring => !seen.has(ring));
    for (const ring of next) {
      seen.add(ring);
      result.push({ ringNo: ring, generation });
    }
    frontier = next;
  }
  return result;
}

// 冻结本鸽及三代内后代的未结算成绩；已结算名次保留不动
function freezeUnsettled(db, sample) {
  const now = new Date().toISOString();
  const targets = [{ ringNo: sample.ringNo, generation: 0 }, ...descendantsWithin(db, sample.ringNo)];
  for (const { ringNo, generation } of targets) {
    const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
    if (!pigeon) continue;
    pigeon.races.forEach((race, raceIndex) => {
      if (race.settled || race.frozen) return;
      race.frozen = true;
      race.frozenBy = sample.sealNo;
      db.lab.freezes.push({ sealNo: sample.sealNo, sampleId: sample.id, ringNo, generation, raceIndex, event: race.event || "", frozenAt: now, liftedAt: null });
    });
  }
}

// 解除本封存号名下的全部冻结（冻结清单保留并标记解除时间，便于审计）
function liftFreezes(db, sample) {
  const now = new Date().toISOString();
  for (const pigeon of db.pigeons) {
    for (const race of pigeon.races) {
      if (race.frozenBy === sample.sealNo) {
        race.frozen = false;
        delete race.frozenBy;
      }
    }
  }
  for (const freeze of db.lab.freezes) {
    if (freeze.sealNo === sample.sealNo && !freeze.liftedAt) freeze.liftedAt = now;
  }
}

// 按结论落地：阳性冻结并维持封存；阴性解封，封存号释放
function applyConclusion(db, sample, verdict) {
  if (verdict === "positive") {
    sample.status = "judged";
    freezeUnsettled(db, sample);
  } else {
    liftFreezes(db, sample);
    sample.status = "released";
  }
}

function requireSample(db, key) {
  const sample = findSample(db, key);
  if (!sample) throw bizError(404, { error: "sample_not_found", message: "样本不存在" });
  return sample;
}

function requireVerdict(input) {
  if (!VERDICTS.includes(input.verdict)) throw bizError(400, { error: "invalid_verdict", need: VERDICTS, message: "结论须为 positive 或 negative" });
  return input.verdict;
}

function requireTester(input) {
  const tester = String(input.tester || "").trim();
  if (!tester) throw bizError(400, { error: "missing_tester", message: "操作人必填" });
  return tester;
}

// 初判：仅已封存样本可判定，留检样本缺项不得判定
export function judgeSample(db, key, input) {
  const sample = requireSample(db, key);
  const verdict = requireVerdict(input);
  const tester = requireTester(input);
  if (sample.status === "held") throw bizError(409, { error: "sample_incomplete", missing: missingItems(sample), message: "样本、送检单或鸽主确认缺项，只能留检" });
  if (sample.status !== "sealed") throw bizError(409, { error: "not_judgeable", status: sample.status, message: "当前状态不可判定" });
  sample.tests.push({ round: sample.tests.length + 1, kind: "initial", tester, verdict, at: new Date().toISOString() });
  sample.verdict = verdict;
  sample.judgedBy = tester;
  sample.judgedAt = new Date().toISOString();
  applyConclusion(db, sample, verdict);
  return sample;
}

// 复检：须换人并引用原封存号；结论一致维持原判，相反则待仲裁
export function retestSample(db, key, input) {
  const sample = requireSample(db, key);
  const verdict = requireVerdict(input);
  const tester = requireTester(input);
  if (!input.originalSealNo || input.originalSealNo !== sample.sealNo) throw bizError(400, { error: "original_seal_required", message: "复检须引用原封存号" });
  if (!sample.verdict) throw bizError(409, { error: "not_judged_yet", message: "尚未判定，不能复检" });
  if (sample.status === "arbitration") throw bizError(409, { error: "pending_arbitration", message: "相反结论待仲裁，请先更正定夺" });
  if (tester === sample.judgedBy) throw bizError(409, { error: "retester_must_differ", message: "复检须换人" });
  sample.tests.push({ round: sample.tests.length + 1, kind: "retest", tester, verdict, originalSealNo: input.originalSealNo, at: new Date().toISOString() });
  if (verdict === sample.verdict) {
    sample.confirmedBy = tester;
  } else {
    sample.status = "arbitration";
    sample.pendingVerdict = verdict;
    sample.pendingTester = tester;
  }
  return sample;
}

// 更正：留存旧快照后按新结论重算（先撤旧冻结，再按新结论落地）
export function correctSample(db, key, input) {
  const sample = requireSample(db, key);
  const verdict = requireVerdict(input);
  const tester = requireTester(input);
  if (!sample.verdict) throw bizError(409, { error: "not_judged_yet", message: "尚未判定，不能更正" });
  const now = new Date().toISOString();
  sample.history.push({
    at: now,
    reason: String(input.reason || "更正"),
    by: tester,
    snapshot: {
      status: sample.status,
      verdict: sample.verdict,
      judgedBy: sample.judgedBy,
      judgedAt: sample.judgedAt,
      tests: sample.tests.map(test => ({ ...test })),
      freezes: db.lab.freezes.filter(freeze => freeze.sealNo === sample.sealNo).map(freeze => ({ ...freeze }))
    }
  });
  liftFreezes(db, sample);
  sample.tests.push({ round: sample.tests.length + 1, kind: "correction", tester, verdict, at: now });
  sample.verdict = verdict;
  sample.corrected = true;
  sample.correctedBy = tester;
  sample.correctedAt = now;
  delete sample.pendingVerdict;
  delete sample.pendingTester;
  applyConclusion(db, sample, verdict);
  return sample;
}

// 旧快照可查：当前结论 + 历次更正前的完整快照
export function sampleHistory(db, key) {
  const sample = requireSample(db, key);
  return {
    id: sample.id,
    sealNo: sample.sealNo,
    current: { status: sample.status, verdict: sample.verdict, judgedBy: sample.judgedBy, judgedAt: sample.judgedAt, corrected: sample.corrected, correctedBy: sample.correctedBy || null },
    history: sample.history
  };
}
