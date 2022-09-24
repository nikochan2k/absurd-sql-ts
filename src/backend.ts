import { File } from "./sqlite-file";

export interface IBackend {
  createFile(filename: string): File;
  startProfile(): void;
  stopProfile(): void;
}
