import { IBackend } from "../backend";
import { File, Ops } from "../sqlite-file";
import { FileOps } from "./file-ops";
import { FileOpsFallback } from "./file-ops-fallback";

export default class IndexedDBBackend implements IBackend {
  constructor(public onFallbackFailure: any) {}

  createFile(filename: string) {
    let ops: Ops;
    if (typeof SharedArrayBuffer !== "undefined") {
      // SharedArrayBuffer exists! We can run this fully
      ops = new FileOps(filename);
    } else {
      // SharedArrayBuffer is not supported. Use the fallback methods
      // which provide a somewhat working version, but doesn't
      // support mutations across connections (tabs)
      ops = new FileOpsFallback(filename, this.onFallbackFailure);
    }

    const file = new File(filename, ops);
    return file;
  }

  startProfile() {}

  stopProfile() {}
}
