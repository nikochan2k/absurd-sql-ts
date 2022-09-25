import { IBackend } from "../backend";
import { File } from "../sqlite-file";
import { Block, FileAttr, Ops } from "../sqlite-types";

class FileOps implements Ops {
  public locked = false;

  constructor(
    public filename: string,
    public meta: FileAttr,
    public data: ArrayBufferLike = new ArrayBuffer(0)
  ) {}

  lock() {
    return true;
  }

  unlock() {
    return true;
  }

  open() {}

  close() {
    return true;
  }

  delete() {
    // in-memory noop
  }

  startStats() {}
  stats() {}

  readMeta() {
    return this.meta;
  }

  writeMeta(meta: FileAttr) {
    if (this.meta == null) {
      this.meta = {};
    }
    this.meta.size = meta.size;
    this.meta.blockSize = meta.blockSize;
  }

  readBlocks(positions: number[], blockSize: number) {
    // console.log('_reading', this.filename, positions);
    let data = this.data;

    return positions.map((pos) => {
      let buffer = new ArrayBuffer(blockSize);

      if (pos < data.byteLength) {
        new Uint8Array(buffer).set(
          new Uint8Array(data, pos, Math.min(blockSize, data.byteLength - pos))
        );
      }

      return { pos, data: buffer };
    });
  }

  writeBlocks(writes: Block[], blockSize: number) {
    // console.log('_writing', this.filename, writes);
    let data = this.data;

    // console.log("writes", writes.length);
    let i = 0;
    let written = 0;
    for (let write of writes) {
      if (i % 1000 === 0) {
        console.log("write");
      }
      i++;
      let fullLength = write.pos + write.data.byteLength;

      if (fullLength > data.byteLength) {
        // Resize file
        let buffer = new ArrayBuffer(fullLength);
        new Uint8Array(buffer).set(new Uint8Array(data));
        this.data = data = buffer;
      }

      new Uint8Array(data).set(new Uint8Array(write.data), write.pos);
    }

    return writes.length; // TODO
  }
}

export default class MemoryBackend implements IBackend {
  defaultBlockSize = 4096;
  fileData: { [name: string]: ArrayBufferLike } = {};
  files: { [name: string]: File } = {};

  constructor(fileData: Map<string, ArrayBufferLike>) {
    for (const [name, data] of Object.entries(fileData)) {
      this.fileData[name] = data;
    }
  }

  createFile(filename: string) {
    if (this.files[filename] == null) {
      let data = this.fileData[filename];

      this.files[filename] = new File(
        filename,
        new FileOps(
          filename,
          data
            ? {
                size: data.byteLength,
                blockSize: this.defaultBlockSize,
              }
            : {}
        )
      );
    }
    return this.files[filename];
  }

  getFile(filename: string) {
    return this.files[filename];
  }

  startProfile() {}

  stopProfile() {}
}
