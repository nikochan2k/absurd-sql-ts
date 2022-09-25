export enum LOCK_TYPES {
  NONE = 0,
  SHARED = 1,
  RESERVED = 2,
  PENDING = 3,
  EXCLUSIVE = 4,
}

export interface Block {
  data: ArrayBufferLike;
  pos: number;
  offset?: number;
  length?: number;
}

export interface FileAttr {
  mode?: number;
  blockSize?: number;
  size?: number;
}

export interface IReader {
  string(timeout?: number): string;
  int32(): number;
  done(): void;
  bytes(): ArrayBufferLike;
}

export interface IWriter {
  string(str: string): void;
  finalize(): void;
  int32(num: number): void;
  bytes(buffer: ArrayBufferLike): void;
}

export interface Ops {
  writer?: IWriter;
  reader?: IReader;
  readIfFallback?: () => Promise<FileAttr>;
  open(): void;
  readMeta(): FileAttr | undefined;
  close(): void;
  delete(): void;
  readBlocks(positions: number[], blockSize: number): Block[];
  writeMeta(meta: FileAttr): void;
  writeBlocks(blocks: Block[], blockSize: number): number;
  lock(lockType: LOCK_TYPES): boolean;
  unlock(lockType: LOCK_TYPES): void;
}
