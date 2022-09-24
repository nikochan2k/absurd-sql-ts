import { FileAttr } from "../sqlite-types";

export interface Item {
  key: number;
  value: ArrayBufferLike | FileAttr;
}
