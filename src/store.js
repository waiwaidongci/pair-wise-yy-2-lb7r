import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// 业务错误：携带 HTTP 状态码与响应体，由 server 统一捕获
export function bizError(status, body) {
  const error = new Error(body.message || body.error || "biz_error");
  error.status = status;
  error.body = body;
  return error;
}

// 存储层：负责持久化、旧数据迁移，并用 Promise 链串行化写入，
// 保证并发请求逐个落库（如并发登记同一封存号时，后者能读到首次结果）
export function createStore(dbPath, seed) {
  let queue = Promise.resolve();

  function migrate(db) {
    db.pigeons = Array.isArray(db.pigeons) ? db.pigeons : [];
    for (const pigeon of db.pigeons) {
      pigeon.vaccines = Array.isArray(pigeon.vaccines) ? pigeon.vaccines : [];
      pigeon.transfers = Array.isArray(pigeon.transfers) ? pigeon.transfers : [];
      pigeon.races = (Array.isArray(pigeon.races) ? pigeon.races : []).map(race => ({ settled: false, frozen: false, ...race }));
    }
    db.lab = db.lab && typeof db.lab === "object" ? db.lab : {};
    db.lab.samples = Array.isArray(db.lab.samples) ? db.lab.samples : [];
    db.lab.freezes = Array.isArray(db.lab.freezes) ? db.lab.freezes : [];
    db.lab.seq = Number(db.lab.seq || 0);
    return db;
  }

  async function loadFresh() {
    if (!existsSync(dbPath)) {
      await mkdir(dirname(dbPath), { recursive: true });
      await writeFile(dbPath, JSON.stringify(seed, null, 2));
    }
    return migrate(JSON.parse(await readFile(dbPath, "utf8")));
  }

  // 读操作排在待完成的写之后，避免读到写了一半的文件
  function read() {
    return queue.then(loadFresh);
  }

  // 写操作串行执行：fn 抛错时本次修改整体丢弃，不落库
  function transact(fn) {
    const run = queue.then(async () => {
      const db = await loadFresh();
      const result = await fn(db);
      await writeFile(dbPath, JSON.stringify(db, null, 2));
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { read, transact };
}
