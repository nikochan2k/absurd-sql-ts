import idbReady from "safari-14-idb-fix";
import { Block, FileAttr, LOCK_TYPES, Ops } from "../sqlite-types";
import { getPageSize, isSafeToWrite } from "../sqlite-util";
import { Item } from "./types";

function positionToKey(pos: number, blockSize: number) {
  // We are forced to round because of floating point error. `pos`
  // should always be divisible by `blockSize`
  return Math.round(pos / blockSize);
}

async function openDb(name: string) {
  await idbReady();

  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = globalThis.indexedDB.open(name, 2);
    req.onsuccess = (event) => {
      const db = (event.target as any).result as IDBDatabase;

      db.onversionchange = () => {
        console.log("closing because version changed");
        db.close();
      };
      db.onclose = () => {};

      resolve(db);
    };
    req.onupgradeneeded = (event) => {
      const db = (event.target as any).result as IDBDatabase;
      if (!db.objectStoreNames.contains("data")) {
        db.createObjectStore("data");
      }
    };
    req.onblocked = (e) => console.log("blocked", e);
    req.onerror = (e) => reject((e.target as any).error);
  });
}

// Using a separate class makes it easier to follow the code, and
// importantly it removes any reliance on internal state in
// `FileOpsFallback`. That would be problematic since these method
// happen async; the args to `write` must be closed over so they don't
// change
class Persistance {
  private _openDb?: IDBDatabase;
  public hasAlertedFailure = false;

  constructor(public dbName: string, public onFallbackFailure: any) {}

  async getDb() {
    if (this._openDb) {
      return this._openDb;
    }

    this._openDb = await openDb(this.dbName);
    return this._openDb as IDBDatabase;
  }

  closeDb() {
    if (this._openDb) {
      this._openDb.close();
      delete this._openDb;
    }
  }

  // Both `readAll` and `write` rely on IndexedDB transactional
  // semantics to work, otherwise we'd have to coordinate them. If
  // there are pending writes, the `readonly` transaction in `readAll`
  // will block until they are all flushed out. If `write` is called
  // multiple times, `readwrite` transactions can only run one at a
  // time so it will naturally apply the writes sequentially (and
  // atomically)

  async readAll() {
    let db = await this.getDb();
    let blocks = new Map<number, ArrayBufferLike>();

    let trans = db.transaction(["data"], "readonly");
    let store = trans.objectStore("data");

    return new Promise<Map<number, ArrayBufferLike>>((resolve, reject) => {
      // Open a cursor and iterate through the entire file
      let req = store.openCursor(IDBKeyRange.lowerBound(-1));
      req.onerror = reject;
      req.onsuccess = (e) => {
        let cursor = (e.target as any).result as IDBCursorWithValue;
        if (cursor) {
          blocks.set(cursor.key as number, cursor.value);
          cursor.continue();
        } else {
          resolve(blocks);
        }
      };
    });
  }

  async write(
    writes: Item[],
    cachedFirstBlock: ArrayBufferLike,
    hasLocked: boolean
  ) {
    let db = await this.getDb();

    // We need grab a readwrite lock on the db, and then read to check
    // to make sure we can write to it
    let trans = db.transaction(["data"], "readwrite");
    let store = trans.objectStore("data");

    await new Promise<void>((resolve, reject) => {
      let req = store.get(0);
      req.onsuccess = (e) => {
        if (hasLocked) {
          if (!isSafeToWrite(req.result, cachedFirstBlock)) {
            if (this.onFallbackFailure && !this.hasAlertedFailure) {
              this.hasAlertedFailure = true;
              this.onFallbackFailure();
            }
            reject(new Error("Fallback mode unable to write file changes"));
            return;
          }
        }

        // Flush all the writes
        for (let write of writes) {
          store.put(write.value, write.key);
        }

        trans.oncomplete = () => resolve();
        trans.onerror = trans.onabort = () => reject();
      };
      req.onerror = reject;
    });
  }
}

export class FileOpsFallback implements Ops {
  dbName: string;
  cachedFirstBlock?: ArrayBufferLike;
  writeQueue: Item[] = [];
  blocks = new Map<number, ArrayBufferLike | FileAttr>();
  lockType = LOCK_TYPES.NONE;
  transferBlockOwnership = false;
  persistance: Persistance;

  constructor(public filename: string, onFallbackFailure: any) {
    this.dbName = this.filename.replace(/\//g, "-");
    this.persistance = new Persistance(this.dbName, onFallbackFailure);
  }

  async readIfFallback() {
    this.transferBlockOwnership = true;
    this.blocks = await this.persistance.readAll();

    return this.readMeta();
  }

  lock(lockType: LOCK_TYPES) {
    // Locks always succeed here. Essentially we're only working
    // locally (we can't see any writes from anybody else) and we just
    // want to track the lock so we know when it downgrades from write
    // to read
    this.cachedFirstBlock = this.blocks.get(0) as ArrayBufferLike;
    this.lockType = lockType;
    return true;
  }

  unlock(lockType: LOCK_TYPES) {
    if (this.lockType > LOCK_TYPES.SHARED && lockType === LOCK_TYPES.SHARED) {
      // Within a write lock, we delay all writes until the end of the
      // lock. We probably don't have to do this since we already
      // delay writes until an `fsync`, however this is an extra
      // measure to make sure we are writing everything atomically
      this.flush();
    }
    this.lockType = lockType;
    return true;
  }

  delete() {
    let req = globalThis.indexedDB.deleteDatabase(this.dbName);
    req.onerror = () => {
      console.warn(`Deleting ${this.filename} database failed`);
    };
    req.onsuccess = () => {};
  }

  open() {
    this.writeQueue = [];
    this.lockType = LOCK_TYPES.NONE;
  }

  close() {
    this.flush();

    if (this.transferBlockOwnership) {
      this.transferBlockOwnership = false;
    } else {
      this.blocks = new Map();
    }

    this.persistance.closeDb();
  }

  readMeta() {
    let metaBlock = this.blocks.get(-1) as FileAttr;
    if (metaBlock) {
      let block = this.blocks.get(0) as ArrayBufferLike;

      return {
        size: metaBlock.size,
        blockSize: getPageSize(new Uint8Array(block)),
      };
    }
    return {};
  }

  writeMeta(meta: FileAttr) {
    this.blocks.set(-1, meta);
    this.queueWrite(-1, meta);
  }

  readBlocks(positions: number[], blockSize: number) {
    let res: Block[] = [];
    for (let pos of positions) {
      res.push({
        pos,
        data: this.blocks.get(positionToKey(pos, blockSize)) as ArrayBufferLike,
      });
    }
    return res;
  }

  writeBlocks(writes: Block[], blockSize: number) {
    let writtenBytes = 0;
    for (const write of writes) {
      const key = positionToKey(write.pos, blockSize);
      const data = write.data;
      this.blocks.set(key, data);
      this.queueWrite(key, data);
      writtenBytes += data.byteLength;
    }

    // No write lock; flush them out immediately
    if (this.lockType <= LOCK_TYPES.SHARED) {
      this.flush();
    }

    return writtenBytes;
  }

  queueWrite(key: number, value: ArrayBufferLike | FileAttr) {
    this.writeQueue.push({ key, value });
  }

  flush() {
    if (this.writeQueue.length > 0) {
      this.persistance.write(
        this.writeQueue,
        this.cachedFirstBlock!,
        this.lockType > LOCK_TYPES.SHARED
      );
      this.writeQueue = [];
    }
    delete this.cachedFirstBlock;
  }
}
