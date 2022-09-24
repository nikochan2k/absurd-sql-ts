import { Ops } from "../sqlite-file";
import { Block, FileAttr } from "../sqlite-types";
import { LOCK_TYPES } from "../sqlite-util";
import { Reader, Writer } from "./shared-channel";

function positionToKey(pos: number, blockSize: number) {
  // We are forced to round because of floating point error. `pos`
  // should always be divisible by `blockSize`
  return Math.round(pos / blockSize);
}

function startWorker(reader: any, writer: any) {
  // In a normal world, we'd spawn the worker here as a child worker.
  // However Safari doesn't support nested workers, so we have to
  // proxy them through the main thread
  self.postMessage({
    type: "__absurd:spawn-idb-worker",
    argBuffer: writer.buffer,
    resultBuffer: reader.buffer,
  });

  self.addEventListener("message", (e) => {
    switch (e.data.type) {
      // Normally you would use `postMessage` control the profiler in
      // a worker (just like this worker go those events), and the
      // perf library automatically handles those events. We don't do
      // that for the special backend worker though because it's
      // always blocked when it's not processing. Instead we forward
      // these events by going through the atomics layer to unblock it
      // to make sure it starts immediately
      case "__perf-deets:start-profile":
        writer.string("profile-start");
        writer.finalize();
        reader.int32();
        reader.done();
        break;

      case "__perf-deets:stop-profile":
        writer.string("profile-stop");
        writer.finalize();
        reader.int32();
        reader.done();
        break;
    }
  });
}

export class FileOps implements Ops {
  reader?: Reader;
  writer?: Writer;
  storeName: string;

  constructor(public filename: string) {
    this.storeName = this.filename.replace(/\//g, "-");
  }

  invokeWorker(
    method: string,
    args: {
      name: string;
      positions?: number[];
      blockSize?: number;
      writes?: any[];
      meta?: FileAttr;
      lockType?: LOCK_TYPES;
    }
  ) {
    if (this.reader == null || this.writer == null) {
      throw new Error(
        `Attempted ${method} on ${this.filename} but file not open`
      );
    }

    let reader = this.reader;
    let writer = this.writer;

    switch (method) {
      case "readBlocks": {
        let { name, positions, blockSize } = args;

        let res = [];
        for (let pos of positions!) {
          writer.string("readBlock");
          writer.string(name);
          writer.int32(positionToKey(pos, blockSize!));
          writer.finalize();

          let data = reader.bytes();
          reader.done();
          res.push({
            pos,
            // If th length is 0, the block didn't exist. We return a
            // blank block in that case
            data: data.byteLength === 0 ? new ArrayBuffer(blockSize!) : data,
          });
        }

        return res;
      }

      case "writeBlocks": {
        const { name, writes, blockSize } = args;
        writer.string("writeBlocks");
        writer.string(name);
        for (const write of writes!) {
          writer.int32(positionToKey(write.pos, blockSize!));
          writer.bytes(write.data);
        }
        writer.finalize();

        const res = reader.int32();
        reader.done();
        return res;
      }

      case "readMeta": {
        writer.string("readMeta");
        writer.string(args.name);
        writer.finalize();

        let size = reader.int32();
        let blockSize = reader.int32();
        reader.done();
        return size === -1 ? {} : { size, blockSize };
      }

      case "writeMeta": {
        let { name, meta } = args;
        writer.string("writeMeta");
        writer.string(name);
        writer.int32(meta!.size!);
        // writer.int32(meta.blockSize);
        writer.finalize();

        let res = reader.int32();
        reader.done();
        return res;
      }

      case "closeFile": {
        writer.string("closeFile");
        writer.string(args.name);
        writer.finalize();

        let res = reader.int32();
        reader.done();
        return res;
      }

      case "lockFile": {
        writer.string("lockFile");
        writer.string(args.name);
        writer.int32(args.lockType!);
        writer.finalize();

        let res = reader.int32();
        reader.done();
        return res === 0;
      }

      case "unlockFile": {
        writer.string("unlockFile");
        writer.string(args.name);
        writer.int32(args.lockType!);
        writer.finalize();

        let res = reader.int32();
        reader.done();
        return res === 0;
      }
    }
  }

  lock(lockType: LOCK_TYPES) {
    return this.invokeWorker("lockFile", {
      name: this.storeName,
      lockType,
    }) as boolean;
  }

  unlock(lockType: LOCK_TYPES) {
    return this.invokeWorker("unlockFile", {
      name: this.storeName,
      lockType,
    });
  }

  delete() {
    // Close the file if it's open
    if (this.reader || this.writer) {
      this.close();
    }

    // We delete it here because we can't do it in the worker; the
    // worker is stopped when the file closes. If we didn't do that,
    // workers would leak in the case of closing a file but not
    // deleting it. We could potentially restart the worker here if
    // needed, but for now just assume that the deletion is a success
    let req = globalThis.indexedDB.deleteDatabase(this.storeName);
    req.onerror = () => {
      console.warn(`Deleting ${this.filename} database failed`);
    };
    req.onsuccess = () => {};
  }

  open() {
    let argBuffer = new SharedArrayBuffer(4096 * 9);
    this.writer = new Writer(argBuffer, {
      name: "args (backend)",
      debug: false,
    });

    let resultBuffer = new SharedArrayBuffer(4096 * 9);
    this.reader = new Reader(resultBuffer, {
      name: "results",
      debug: false,
    });

    // TODO: We could pool workers and reuse them so opening files
    // aren't so slow
    startWorker(this.reader, this.writer);
  }

  close() {
    this.invokeWorker("closeFile", { name: this.storeName });
    delete this.reader;
    delete this.writer;
  }

  readMeta() {
    return this.invokeWorker("readMeta", {
      name: this.storeName,
    }) as FileAttr;
  }

  writeMeta(meta: FileAttr) {
    return this.invokeWorker("writeMeta", { name: this.storeName, meta });
  }

  readBlocks(positions: number[], blockSize: number) {
    return this.invokeWorker("readBlocks", {
      name: this.storeName,
      positions,
      blockSize,
    }) as Block[];
  }

  writeBlocks(writes: any[], blockSize: number) {
    return this.invokeWorker("writeBlocks", {
      name: this.storeName,
      writes,
      blockSize,
    }) as number;
  }
}
