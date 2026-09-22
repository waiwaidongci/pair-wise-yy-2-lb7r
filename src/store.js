import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// 存储层：数据文件的读写、旧库迁移与串行化写入。
// 判定规则见 src/adjudication.js，HTTP 入口见 server.js。

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚",
      vaccines: [{ date: "2026-04-01", name: "新城疫" }],
      transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }],
      races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18, settled: false, frozen: false }] },
    { ringNo: "CHN-2027-101", owner: "北岸棚", fatherRing: "CHN-2026-001", motherRing: "", color: "灰", loft: "北岸A棚",
      vaccines: [], transfers: [],
      races: [{ date: "2026-08-15", event: "200公里资格赛", distance: 200, returnTime: "13:05", rank: 3, settled: false, frozen: false }] },
    { ringNo: "CHN-2028-201", owner: "北岸棚", fatherRing: "CHN-2027-101", motherRing: "", color: "雨点", loft: "北岸B棚",
      vaccines: [], transfers: [],
      races: [
        { date: "2026-07-20", event: "150公里热身", distance: 150, returnTime: "11:20", rank: 5, settled: true, settledAt: "2026-07-25T00:00:00.000Z", frozen: false },
        { date: "2026-09-10", event: "300公里预赛", distance: 300, returnTime: "15:48", rank: 2, settled: false, frozen: false }
      ] },
    { ringNo: "CHN-2029-301", owner: "北岸棚", fatherRing: "", motherRing: "CHN-2028-201", color: "红轮", loft: "北岸B棚",
      vaccines: [], transfers: [],
      races: [{ date: "2026-09-12", event: "100公里训放", distance: 100, returnTime: "09:58", rank: 7, settled: false, frozen: false }] },
    { ringNo: "CHN-2030-401", owner: "北岸棚", fatherRing: "CHN-2029-301", motherRing: "", color: "灰", loft: "北岸C棚",
      vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ],
  samples: [],
  snapshots: [],
  freezeLog: [],
  frozenRings: []
};

// 旧库补齐药检所需字段
function migrate(db) {
  db.samples ||= [];
  db.snapshots ||= [];
  db.freezeLog ||= [];
  db.frozenRings ||= [];
  for (const pigeon of db.pigeons) {
    pigeon.vaccines ||= [];
    pigeon.transfers ||= [];
    pigeon.races ||= [];
    for (const race of pigeon.races) {
      race.settled ??= false;
      race.frozen ??= false;
    }
  }
  return db;
}

export function createStore(dbPath) {
  let queue = Promise.resolve();

  async function save(db) {
    await mkdir(dirname(dbPath), { recursive: true });
    const tmp = join(dirname(dbPath), `pigeons.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dbPath);
  }

  async function load() {
    if (!existsSync(dbPath)) {
      const fresh = migrate(structuredClone(seed));
      await save(fresh);
      return fresh;
    }
    return migrate(JSON.parse(await readFile(dbPath, "utf8")));
  }

  // 串行执行“读-改-写”：并发登记同一封存号时，后者必然读到首次结果并走 409
  function update(mutator) {
    const run = queue.then(async () => {
      const db = await load();
      const result = await mutator(db);
      await save(db);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { read: load, update };
}
