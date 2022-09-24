export interface Backend {}

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
