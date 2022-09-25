import { Block, FileAttr, LOCK_TYPES, Ops } from "./sqlite-types";
import { getPageSize } from "./sqlite-util";

function range(start: number, end: number, step: number) {
  const r: number[] = [];
  for (let i = start; i <= end; i += step) {
    r.push(i);
  }
  return r;
}

export function getBoundaryIndexes(
  blockSize: number,
  start: number,
  end: number
) {
  const startC = start - (start % blockSize);
  const endC = end - 1 - ((end - 1) % blockSize);

  return range(startC, endC, blockSize);
}

export function readChunks(chunks: Block[], start: number, end: number) {
  const buffer = new ArrayBuffer(end - start);
  const bufferView = new Uint8Array(buffer);

  let cursor = 0;
  for (const chunk of chunks) {
    // TODO: jest has a bug where we can't do `instanceof ArrayBuffer`
    if (chunk.data.constructor.name !== "ArrayBuffer") {
      throw new Error("Chunk data is not an ArrayBuffer");
    }

    let cstart = 0;
    let cend = chunk.data.byteLength;

    if (start > chunk.pos) {
      cstart = start - chunk.pos;
    }
    if (end < chunk.pos + chunk.data.byteLength) {
      cend = end - chunk.pos;
    }

    if (cstart > chunk.data.byteLength || cend < 0) {
      continue;
    }

    let len = cend - cstart;

    bufferView.set(
      new Uint8Array(chunk.data, cstart, len),
      chunk.pos - start + cstart
    );
    cursor += len;
  }

  return buffer;
}

export function writeChunks(
  bufferView: ArrayBufferView,
  blockSize: number,
  start: number,
  end: number
): Block[] {
  const indexes = getBoundaryIndexes(blockSize, start, end);
  let cursor = 0;

  const result: Block[] = [];
  for (const index of indexes) {
    let cstart = 0;
    let cend = blockSize;
    if (start > index && start < index + blockSize) {
      cstart = start - index;
    }
    if (end > index && end < index + blockSize) {
      cend = end - index;
    }

    if (start > index + blockSize || end <= index) {
      continue;
    }

    const off = bufferView.byteOffset + cursor;

    const available = bufferView.buffer.byteLength - off;
    if (available <= 0) {
      continue;
    }

    const len = cend - cstart;
    const chunkBuffer = new ArrayBuffer(blockSize);

    const readLength = Math.min(len, available);

    new Uint8Array(chunkBuffer).set(
      new Uint8Array(bufferView.buffer, off, readLength),
      cstart
    );
    cursor += readLength;

    result.push({
      pos: index,
      data: chunkBuffer,
      offset: cstart,
      length: readLength,
    });
  }
  return result;
}

export class File {
  private buffer = new Map<number, Block>();
  private _metaDirty = false;
  private writeLock = false;
  private _recordingLock = false;
  private openHandles = 0;

  constructor(
    public filename: string,
    public ops: Ops,
    private meta?: FileAttr
  ) {}

  bufferChunks(chunks: Block[]) {
    for (const chunk of chunks) {
      this.buffer.set(chunk.pos, chunk);
    }
  }

  open() {
    this.openHandles++;

    // Don't open the file again if it's already open
    if (this.openHandles === 1) {
      this.ops.open();
      let meta = this.ops.readMeta();

      // It's possible that `setattr` has already been called if opening
      // the file in a mode that truncates it to 0
      if (this.meta == null) {
        if (meta == null) {
          // New file

          meta = { size: 0 };
        }

        this.meta = meta;
      }
    }

    return this.meta;
  }

  close() {
    this.fsync();

    this.openHandles = Math.max(this.openHandles - 1, 0);

    // Only close it if there are no existing open handles
    if (this.openHandles === 0) {
      this.ops.close();
    }
  }

  delete() {
    this.ops.delete();
  }

  load(indexes: number[] /* TODO */) {
    const status = indexes.reduce(
      (acc, b) => {
        const inMemory = this.buffer.get(b);
        if (inMemory) {
          acc.chunks.push(inMemory);
        } else {
          acc.missing.push(b);
        }
        return acc;
      },
      { chunks: [] as Block[], missing: [] as number[] }
    );

    let missingChunks: Block[] = [];
    if (status.missing.length > 0) {
      missingChunks = this.ops.readBlocks(
        status.missing,
        this.meta!.blockSize!
      );
    }
    return status.chunks.concat(missingChunks);
  }

  read(
    bufferView: ArrayBufferView,
    offset: number,
    length: number,
    position: number
  ) {
    // console.log('reading', this.filename, offset, length, position);
    const buffer = bufferView.buffer;

    if (length <= 0) {
      return 0;
    }
    if (position < 0) {
      // TODO: is this right?
      return 0;
    }
    if (position >= this.meta!.size!) {
      const view = new Uint8Array(buffer, offset);
      for (let i = 0; i < length; i++) {
        view[i] = 0;
      }

      return length;
    }

    position = Math.max(position, 0);
    const dataLength = Math.min(length, this.meta!.size! - position);

    const start = position;
    const end = position + dataLength;

    const indexes = getBoundaryIndexes(this.meta!.blockSize!, start, end);

    const chunks = this.load(indexes);
    const readBuffer = readChunks(chunks, start, end);

    if (buffer.byteLength - offset < readBuffer.byteLength) {
      throw new Error("Buffer given to `read` is too small");
    }
    const view = new Uint8Array(buffer);
    view.set(new Uint8Array(readBuffer), offset);

    // TODO: I don't need to do this. `unixRead` does this for us.
    for (let i = dataLength; i < length; i++) {
      view[offset + i] = 0;
    }

    return length;
  }

  write(
    bufferView: ArrayBufferView,
    offset: number,
    length: number,
    position: number
  ) {
    // console.log('writing', this.filename, offset, length, position);

    if (this.meta!.blockSize == null) {
      // We don't have a block size yet (an empty file). The first
      // write MUST be the beginning of the file. This is a new file
      // and the first block contains the page size which we need.
      // sqlite will write this block first, and if you are directly
      // writing a db file to disk you can't write random parts of it.
      // Just write the whole thing and we'll get the first block
      // first.

      const pageSize = getPageSize(
        new Uint8Array(bufferView.buffer, bufferView.byteOffset + offset)
      );

      // Page sizes must be a power of 2 between 512 and 65536.
      // These was generated by doing `Math.pow(2, N)` where N >= 9
      // and N <= 16.
      if (
        ![512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].includes(pageSize)
      ) {
        throw new Error(
          `File has invalid page size. (the first block of a new file must be written first): ${pageSize}`
        );
      }

      this.setattr({ blockSize: pageSize });
    }

    const buffer = bufferView.buffer;

    if (length <= 0) {
      return 0;
    }
    if (position < 0) {
      return 0;
    }
    if (buffer.byteLength === 0) {
      return 0;
    }

    length = Math.min(length, buffer.byteLength - offset);

    const writes = writeChunks(
      new Uint8Array(buffer, offset, length),
      this.meta!.blockSize!,
      position,
      position + length
    );

    // Find any partial chunks and read them in and merge with
    // existing data
    const { partialWrites, fullWrites } = writes.reduce(
      (state, write) => {
        if (write.length !== this.meta!.blockSize) {
          state.partialWrites.push(write);
        } else {
          state.fullWrites.push({
            pos: write.pos,
            data: write.data,
          });
        }
        return state;
      },
      { fullWrites: [] as Block[], partialWrites: [] as Block[] }
    );

    let reads: Block[] = [];
    if (partialWrites.length > 0) {
      reads = this.load(partialWrites.map((w) => w.pos));
    }

    const allWrites: Block[] = fullWrites.concat(
      reads.map((read) => {
        const write = partialWrites.find((w) => w.pos === read.pos) as Block;

        // MuTatIoN!
        new Uint8Array(read.data).set(
          new Uint8Array(write.data, write.offset, write.length),
          write.offset
        );

        return read;
      })
    );

    this.bufferChunks(allWrites);

    if (position + length > this.meta!.size!) {
      this.setattr({ size: position + length });
    }

    return length;
  }

  async readIfFallback() {
    if (this.ops.readIfFallback) {
      // Reset the meta
      const meta = await this.ops.readIfFallback();
      this.meta = meta || { size: 0 };
    }
  }

  lock(lockType: LOCK_TYPES) {
    if (!this._recordingLock) {
      this._recordingLock = true;
    }

    if (this.ops.lock(lockType)) {
      if (lockType >= LOCK_TYPES.RESERVED) {
        this.writeLock = true;
      }
      return true;
    }
    return false;
  }

  unlock(lockType: LOCK_TYPES) {
    if (lockType === LOCK_TYPES.NONE) {
      this._recordingLock = false;
    }

    if (this.writeLock) {
      // In certain cases (I saw this while running VACUUM after
      // changing page size) sqlite changes the size of the file
      // _after_ `fsync` for some reason. In our case, this is
      // critical because we are relying on fsync to write everything
      // out. If we just did some writes, do another fsync which will
      // check the meta and make sure it's persisted if dirty (all
      // other writes should already be flushed by now)
      this.fsync();
      this.writeLock = false;
    }

    return this.ops.unlock(lockType);
  }

  fsync() {
    if (this.buffer.size > 0) {
      // We need to handle page size changes which restructures the
      // whole db. We check if the page size is being written and
      // handle it
      const first = this.buffer.get(0);
      if (first) {
        const pageSize = getPageSize(new Uint8Array(first.data));

        if (pageSize !== this.meta!.blockSize) {
          // The page size changed! We need to reflect that in our
          // storage. We need to restructure all pending writes and
          // change our page size so all future writes reflect the new
          // size.
          const buffer = this.buffer;
          this.buffer = new Map();

          // We take all pending writes, concat them into a single
          // buffer, and rewrite it out with the new size. This would
          // be dangerous if the page size could be changed at any
          // point in time since we don't handle partial reads here.
          // However sqlite only ever actually changes the page size
          // in 2 cases:
          //
          // * The db is empty (no data yet, so nothing to read)
          // * A VACUUM command is rewriting the entire db
          //
          // In both cases, we can assume we have _all_ the needed
          // data in the pending buffer, and we don't have to worry
          // about overwriting anything.

          const writes = [...buffer.values()];
          const totalSize = writes.length * this.meta!.blockSize!;
          const buf = new ArrayBuffer(totalSize);
          const view = new Uint8Array(buf);

          for (const write of writes) {
            view.set(new Uint8Array(write.data), write.pos);
          }

          // Rewrite the buffer with the new page size
          this.bufferChunks(writeChunks(view, pageSize, 0, totalSize));

          // Change our page size
          this.setattr({ blockSize: pageSize });
        }
      }

      this.ops.writeBlocks([...this.buffer.values()], this.meta!.blockSize!);
    }

    if (this._metaDirty) {
      // We only store the size right now. Block size is already
      // stored in the sqlite file and we don't need the rest
      //
      // TODO: Currently we don't delete any extra blocks after the
      // end of the file. This isn't super important, and in fact
      // could cause perf regressions (sqlite doesn't compress files
      // either!) but what we probably should do is detect a VACUUM
      // command (the whole db is being rewritten) and at that point
      // delete anything after the end of the file
      this.ops.writeMeta({ size: this.meta!.size });
      this._metaDirty = false;
    }

    this.buffer = new Map();
  }

  setattr(attr: FileAttr) {
    if (this.meta == null) {
      this.meta = {};
    }

    // Size is the only attribute we actually persist. The rest are
    // stored in memory

    if (attr.mode != null) {
      this.meta.mode = attr.mode;
    }

    if (attr.blockSize != null) {
      this.meta.blockSize = attr.blockSize;
    }

    if (attr.size != null) {
      this.meta.size = attr.size;
      this._metaDirty = true;
    }
  }

  getattr(): FileAttr {
    return this.meta!;
  }
}
