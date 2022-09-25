import * as perf from "perf-deets";
import { IBackend } from "../backend";
import { File } from "../sqlite-file";
import { Ops } from "../sqlite-types";
import { FileOps } from "./file-ops";
import { FileOpsFallback } from "./file-ops-fallback";

export default class IndexedDBBackend implements IBackend {
  private _files = new Set<File>();

  constructor(private onFallbackFailure: () => void) {}

  public createFile(filename: string) {
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

    // If we don't need perf data, there's no reason for us to hold a
    // reference to the files. If we did we'd have to worry about
    // memory leaks
    if (process.env["NODE_ENV"] !== "production" || process.env["PERF_BUILD"]) {
      this._files.add(file);
    }

    return file;
  }

  public startProfile() {
    perf.start();
    for (let file of this._files) {
      // If the writer doesn't exist, that means the file has been deleted
      const { reader, writer } = file.ops;
      if (reader && writer) {
        writer.string("profile-start");
        writer.finalize();
        reader.int32();
        reader.done();
      }
    }
  }

  public stopProfile() {
    perf.stop();
    for (let file of this._files) {
      const { reader, writer } = file.ops;
      if (reader && writer) {
        writer.string("profile-stop");
        writer.finalize();
        reader.int32();
        reader.done();
      }
    }
  }
}
