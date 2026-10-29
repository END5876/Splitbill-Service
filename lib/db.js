'use strict';
/**
 * 🆕 [SQLite] 分帳資料的持久層。
 * -----------------------------------------------------------------
 * 取代原本整包重寫的 data/splitbill.json。這個檔案只負責「把資料安全地放進／
 * 拿出 SQLite」，不認識行程的業務規則（修復、權限、廣播都在 storage.js）。
 *
 * 用 Node 內建的 node:sqlite（Node ≥ 22.13 不需要旗標），不需要安裝原生模組，
 * node:22-slim 映像不用額外裝編譯工具。所有 SQL 都集中在這裡，之後若要換成
 * better-sqlite3，只需要改這一個檔案（兩者 API 幾乎相同）。
 *
 * 資料表：
 *   meta           key/value：schema 版本、是否已初始化（含 JSON 匯入）
 *   trips          一個行程一列；data 是完整的行程 JSON，guild_id/owner_id/updated_at
 *                  是冗餘欄位，方便直接用 sqlite3 指令維運查詢
 *   guilds         一個 Discord 伺服器一列（defaultTripId、activeTripByUser）
 *   trip_revisions 每次行程內容版本（updatedAt）變動時留一份不含憑證的快照，
 *                  每個行程只保留最近 N 份；網頁的「歷史版本」可以整份還原
 *   trip_activity  操作紀錄：同一個版本「誰、改了什麼」（見 lib/activity.js），
 *                  每個行程保留最近 N 筆；支出／轉帳的變動帶完整內容，可以單筆還原
 */
const fs = require('fs');
const path = require('path');
const { MIGRATIONS } = require('./migrations');

// 資料形狀有變動時加 1，並在 lib/migrations.js 加上對應的遷移（見那個檔案開頭的說明）。
// 資料庫的版本比這個數字大＝資料是較新的程式寫的，openStore() 會拒絕啟動。
const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT,
  owner_id   TEXT,
  updated_at INTEGER,
  created_at INTEGER,
  data       TEXT NOT NULL CHECK (json_valid(data))
);
CREATE INDEX IF NOT EXISTS trips_guild_id ON trips(guild_id);
CREATE INDEX IF NOT EXISTS trips_owner_id ON trips(owner_id);
CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  data     TEXT NOT NULL CHECK (json_valid(data))
);
CREATE TABLE IF NOT EXISTS trip_revisions (
  trip_id    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  saved_at   INTEGER NOT NULL,
  data       TEXT    NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (trip_id, updated_at)
);
CREATE TABLE IF NOT EXISTS trip_activity (
  trip_id    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  data       TEXT    NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (trip_id, updated_at)
);
CREATE TABLE IF NOT EXISTS revoked_sessions (
  sid        TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (err) {
    throw new Error(`[splitbill-db] 這個 Node 版本沒有內建 node:sqlite（目前 ${process.version}，需要 22.13 以上）：${err.message}`);
  }
}

/**
 * 開啟（必要時建立）資料庫。任何問題（檔案損毀、權限、磁碟）都直接丟例外，
 * 讓服務啟動失敗——絕不在讀不到資料時用空資料繼續跑。
 * @param {string} file  資料庫檔案路徑
 * @param {{ journalMode?: string, revisionsToKeep?: number, activityToKeep?: number, backupDir?: string }} [opts]
 *   backupDir：執行 schema 遷移前，先把資料庫備份到這個目錄
 */
function openStore(file, opts = {}) {
  const { DatabaseSync } = loadSqlite();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // WAL：寫入中斷不會毀檔、讀寫互不阻塞。萬一 Volume 是不支援共享記憶體的網路
  // 檔案系統，可以用 SPLITBILL_SQLITE_JOURNAL=DELETE 退回傳統的 rollback journal。
  const journal = /^(WAL|DELETE|TRUNCATE|PERSIST)$/i.test(opts.journalMode || '') ? opts.journalMode.toUpperCase() : 'WAL';
  db.exec(`PRAGMA journal_mode = ${journal}`);
  // FULL：每次 commit 都確實寫進磁碟（含斷電）。這裡的寫入量很小，不值得為了速度冒險。
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');

  const check = db.prepare('PRAGMA quick_check').get();
  if (!check || check.quick_check !== 'ok') {
    db.close();
    throw new Error(`[splitbill-db] 資料庫完整性檢查失敗（${file}）：${JSON.stringify(check)}。請從 backups/ 還原。`);
  }

  db.exec(SCHEMA_SQL);
  const keep = Number.isInteger(opts.revisionsToKeep) && opts.revisionsToKeep >= 0 ? opts.revisionsToKeep : 50;
  const keepActivity = Number.isInteger(opts.activityToKeep) && opts.activityToKeep >= 0 ? opts.activityToKeep : 500;

  const st = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    allTrips: db.prepare('SELECT id, data FROM trips'),
    allGuilds: db.prepare('SELECT guild_id, data FROM guilds'),
    upsertTrip: db.prepare(`
      INSERT INTO trips (id, guild_id, owner_id, updated_at, created_at, data) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET guild_id = excluded.guild_id, owner_id = excluded.owner_id,
        updated_at = excluded.updated_at, created_at = excluded.created_at, data = excluded.data`),
    deleteTrip: db.prepare('DELETE FROM trips WHERE id = ?'),
    upsertGuild: db.prepare(`
      INSERT INTO guilds (guild_id, data) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data`),
    deleteGuild: db.prepare('DELETE FROM guilds WHERE guild_id = ?'),
    insertRevision: db.prepare('INSERT OR REPLACE INTO trip_revisions (trip_id, updated_at, saved_at, data) VALUES (?, ?, ?, ?)'),
    pruneRevisions: db.prepare(`
      DELETE FROM trip_revisions WHERE trip_id = ? AND updated_at NOT IN (
        SELECT updated_at FROM trip_revisions WHERE trip_id = ? ORDER BY updated_at DESC LIMIT ?)`),
    deleteRevisions: db.prepare('DELETE FROM trip_revisions WHERE trip_id = ?'),
    getRevision: db.prepare('SELECT data FROM trip_revisions WHERE trip_id = ? AND updated_at = ?'),
    listRevisions: db.prepare('SELECT updated_at, saved_at FROM trip_revisions WHERE trip_id = ? ORDER BY updated_at DESC'),
    dataVersion: db.prepare('PRAGMA data_version'),
    insertActivity: db.prepare('INSERT OR REPLACE INTO trip_activity (trip_id, updated_at, at, data) VALUES (?, ?, ?, ?)'),
    pruneActivity: db.prepare(`
      DELETE FROM trip_activity WHERE trip_id = ? AND updated_at NOT IN (
        SELECT updated_at FROM trip_activity WHERE trip_id = ? ORDER BY updated_at DESC LIMIT ?)`),
    deleteActivity: db.prepare('DELETE FROM trip_activity WHERE trip_id = ?'),
    listActivity: db.prepare('SELECT data FROM trip_activity WHERE trip_id = ? AND updated_at < ? ORDER BY updated_at DESC LIMIT ?'),
    getActivity: db.prepare('SELECT data FROM trip_activity WHERE trip_id = ? AND updated_at = ?'),
    revokeSession: db.prepare('INSERT OR REPLACE INTO revoked_sessions (sid, expires_at) VALUES (?, ?)'),
    pruneRevokedSessions: db.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?'),
    listRevokedSessions: db.prepare('SELECT sid, expires_at FROM revoked_sessions WHERE expires_at >= ?'),
  };
  const readDataVersion = () => Number(st.dataVersion.get().data_version);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      // 不用 db.isTransaction 判斷：那是 Node 22.16 才有的屬性，22.13～22.15 上是
      // undefined，會讓失敗的交易一直開著、之後每次寫入都失敗。交易已經被 SQLite
      // 自動回滾時 ROLLBACK 會丟錯，直接忽略即可。
      try { db.exec('ROLLBACK'); } catch (_) { /* 原始錯誤比較重要 */ }
      throw err;
    }
  }

  // ── schema 版本：資料比程式新就拒絕啟動；比程式舊就依序遷移 ──
  // 回滾到舊映像時，舊程式不認得新版本寫下的資料形狀，硬跑可能在第一次存檔時把新欄位
  // 剝掉。寧可啟動失敗（autodeploy 會留在舊版或換回 :prev），也不要默默改壞資料。
  // backup：遷移前先備份。剛匯入的資料不用（原始的 splitbill.json 已經改名保留）。
  function migrateSchema({ backup = true } = {}) {
    const initialized = !!st.getMeta.get('initialized_at');
    if (!initialized) return; // 全新的資料庫：initialize() 會直接寫入目前的版本
    const row = st.getMeta.get('schema_version');
    const current = row ? Number(row.value) : 1;
    if (!Number.isInteger(current) || current < 1) {
      throw new Error(`[splitbill-db] 無法辨識資料庫的 schema 版本（${row && row.value}），拒絕啟動。`);
    }
    if (current > SCHEMA_VERSION) {
      throw new Error(`[splitbill-db] 資料庫是較新版本的程式寫的（schema v${current}，這個版本只認得 v${SCHEMA_VERSION}），拒絕啟動以免改壞資料。`
        + '請部署較新的版本；一定要回到這個版本的話，請從 backups/ 裡遷移前的備份（splitbill-pre-v*.db）還原。');
    }
    if (current === SCHEMA_VERSION) return;
    if (backup && opts.backupDir) {
      const target = path.join(opts.backupDir, `splitbill-pre-v${current + 1}-${Date.now()}.db`);
      fs.mkdirSync(opts.backupDir, { recursive: true });
      db.prepare('VACUUM INTO ?').run(target);
      console.log(`[splitbill-db] schema v${current} → v${SCHEMA_VERSION}：遷移前已備份到 ${target}`);
    }
    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      transaction(() => {
        if (MIGRATIONS[v]) MIGRATIONS[v](db, { justImported: !backup });
        st.setMeta.run('schema_version', String(v));
      });
    }
  }
  try {
    migrateSchema();
  } catch (err) {
    db.close();
    throw err;
  }

  function writeTripRow(t) {
    st.upsertTrip.run(t.id, t.guildId || null, t.ownerId || null,
      typeof t.updatedAt === 'number' ? t.updatedAt : null,
      typeof t.createdAt === 'number' ? t.createdAt : null, t.json);
    if (t.revisionJson && typeof t.updatedAt === 'number' && keep > 0) {
      st.insertRevision.run(t.id, t.updatedAt, Date.now(), t.revisionJson);
      st.pruneRevisions.run(t.id, t.id, keep);
    }
    if (t.activityJson && typeof t.updatedAt === 'number' && keepActivity > 0) {
      st.insertActivity.run(t.id, t.updatedAt, Date.now(), t.activityJson);
      st.pruneActivity.run(t.id, t.id, keepActivity);
    }
  }

  return {
    file,

    /** 是否已經完成第一次初始化（含舊 JSON 匯入）。 */
    isInitialized() {
      return !!st.getMeta.get('initialized_at');
    },

    /**
     * 第一次啟動：在同一個交易裡寫入匯入的資料並標記已初始化。
     * 中途失敗整個回滾，下次啟動會重新嘗試。
     * schemaVersion：匯入資料的形狀版本（從舊 JSON 匯入的是 1），寫入後馬上遷移到最新版本。
     */
    initialize({ trips = [], guilds = [], source = 'empty', schemaVersion = SCHEMA_VERSION }) {
      transaction(() => {
        for (const t of trips) writeTripRow(t);
        for (const g of guilds) st.upsertGuild.run(g.guildId, g.json);
        st.setMeta.run('schema_version', String(schemaVersion));
        st.setMeta.run('initialized_from', source);
        st.setMeta.run('initialized_at', String(Date.now()));
      });
      migrateSchema({ backup: false });
    },

    /** 健康檢查用：資料庫還能不能讀。 */
    ping() {
      try {
        return !!db.prepare('SELECT 1 AS ok').get();
      } catch (_) {
        return false;
      }
    },

    /** 讀出全部資料（JSON 字串，由呼叫端 parse／修復）。 */
    readAll() {
      return {
        trips: st.allTrips.all().map((r) => ({ id: r.id, json: r.data })),
        guilds: st.allGuilds.all().map((r) => ({ guildId: r.guild_id, json: r.data })),
      };
    },

    /**
     * 這個連線看到的資料版本（PRAGMA data_version）。只有「其他連線」commit 時才會變，
     * 自己寫入不會變——用來偵測同一個資料庫檔被另一個服務實例同時寫入。
     */
    dataVersion() {
      return readDataVersion();
    },

    /**
     * 套用一批變更，全部成功或全部不生效。
     * @param {{ trips?: object[], deleteTrips?: string[], guilds?: object[], deleteGuilds?: string[] }} c
     *   trips[]：{ id, guildId, ownerId, updatedAt, createdAt, json, revisionJson? }
     *   guilds[]：{ guildId, json }
     * @param {{ expectedDataVersion?: number }} [opts]
     *   有帶的話，取得寫入鎖之後先確認期間沒有其他連線寫過；有的話丟出
     *   code='FOREIGN_WRITE' 的錯誤，什麼都不寫。
     */
    apply(c, opts = {}) {
      transaction(() => {
        if (typeof opts.expectedDataVersion === 'number' && readDataVersion() !== opts.expectedDataVersion) {
          const err = new Error('資料庫在這段期間被另一個服務實例寫入過');
          err.code = 'FOREIGN_WRITE';
          throw err;
        }
        for (const id of c.deleteTrips || []) {
          st.deleteTrip.run(id);
          st.deleteRevisions.run(id);
          st.deleteActivity.run(id);
        }
        for (const t of c.trips || []) writeTripRow(t);
        for (const gid of c.deleteGuilds || []) st.deleteGuild.run(gid);
        for (const g of c.guilds || []) st.upsertGuild.run(g.guildId, g.json);
      });
    },

    /** 取某行程在某個 updatedAt 版本時的內容（不含憑證）；沒有回傳 null。 */
    getRevision(tripId, updatedAt) {
      const row = st.getRevision.get(tripId, updatedAt);
      return row ? JSON.parse(row.data) : null;
    },

    /** 操作紀錄，新的在前；before 是 updatedAt 的上限（不含），用來往前翻頁。 */
    listActivity(tripId, before, limit) {
      return st.listActivity.all(tripId, before, limit).map((r) => JSON.parse(r.data));
    },

    getActivity(tripId, updatedAt) {
      const row = st.getActivity.get(tripId, updatedAt);
      return row ? JSON.parse(row.data) : null;
    },

    /** 記下一個已登出的 session（到 expiresAt 為止），順便清掉已經過期的紀錄。 */
    revokeSession(sid, expiresAt, now) {
      transaction(() => {
        st.revokeSession.run(sid, Math.floor(expiresAt));
        st.pruneRevokedSessions.run(Math.floor(now));
      });
    },

    listRevokedSessions(now) {
      return st.listRevokedSessions.all(Math.floor(now)).map((r) => ({ sid: r.sid, expiresAt: r.expires_at }));
    },

    listRevisions(tripId) {
      return st.listRevisions.all(tripId).map((r) => ({ updatedAt: r.updated_at, savedAt: r.saved_at }));
    },

    /**
     * 線上備份成一個獨立、完整的資料庫檔（VACUUM INTO 是一致的快照，不會備份到
     * 寫到一半的狀態）。先寫暫存檔再改名，備份目錄裡不會出現不完整的檔案。
     */
    backupTo(target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      try { fs.unlinkSync(tmp); } catch (_) { /* 沒有就算了 */ }
      db.prepare('VACUUM INTO ?').run(tmp);
      fs.renameSync(tmp, target);
    },

    close() {
      // 不靠 db.isOpen（較新的 Node 才有）；已經關閉時 close() 會丟錯，忽略即可
      try { db.close(); } catch (_) { /* 已經關閉 */ }
    },
  };
}

module.exports = { openStore, SCHEMA_VERSION };
