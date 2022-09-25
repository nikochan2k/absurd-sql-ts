import { IBackend } from "./backend";
import { File } from "./sqlite-file";
import { DEFAULT_BLOCK_SIZE, LOCK_TYPES } from "./sqlite-types";

interface ErrornoErrorConstructor {
  new (errno: number): any;
}

interface FS {
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  ErrnoError: ErrornoErrorConstructor;
  lookupPath(path: string): { node: Node };
  lookupNode(parent: Node, name: string): Node;
  createNode(
    parent: Node | null,
    name: string,
    mode: number,
    dev: number
  ): Node;
}

interface Attr {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  blksize: number;
  blocks: number;
}

interface NodeOps {
  mknod: (parent: Node, name: string, mode: number, dev: number) => void;
  lookup: (parent: Node, name: string) => void;
  rename?: (old_node: Node, new_dir: Node, new_name: string) => void;
  unlink: (parent: Node, name: string) => void;
  setattr: (node: Node, attr: Attr) => void;
  getattr?: (node: Node) => Attr;
  readdir?: (node: Node) => void;
  symlink?: (parent: Node, newname: string, oldpath: string) => void;
  readlink?: (node: Node) => void;
}

interface Stream {
  node: Node;
  position: number;
}

interface StreamOps {
  open?: (stream: Stream) => void;
  close?: (stream: Stream) => void;
  read?: (
    stream: Stream,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position: number
  ) => number;
  write?: (
    stream: Stream,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position: number
  ) => number;
  llseek?: (stream: Stream, offset: number, whence: number) => number;
  allocate?: (stream: Stream, offset: number, length: number) => void;
  mmap?: (
    stream: Stream,
    address: number,
    length: number,
    position: number,
    prot: number,
    flags: number
  ) => void;
  msync?: (
    stream: Stream,
    buffer: ArrayBufferLike,
    offset: number,
    length: number,
    mmapFlags: number
  ) => void;
  fsync?: (
    stream: Stream,
    buffer: ArrayBufferLike,
    offset: number,
    length: number,
    mmapFlags: number
  ) => void;
}

interface Node {
  id: number;
  node_ops: NodeOps;
  stream_ops?: StreamOps;
  mode: number;
  rdev: number;
  size: number;
  timestamp: number;
  contents?: File;
}

enum ERRNO_CODES {
  EPERM = 63,
  ENOENT = 44,
}

// This implements an emscripten-compatible filesystem that is means
// to be mounted to the one from `sql.js`. Example:
//
// let BFS = new SQLiteFS(SQL.FS, idbBackend);
// SQL.FS.mount(BFS, {}, '/blocked');
//
// Now any files created under '/blocked' will be handled by this
// filesystem, which creates a special file that handles read/writes
// in the way that we want.
export default class SQLiteFS {
  private node_ops: NodeOps;
  private stream_ops: StreamOps;

  constructor(private fs: FS, private backend: IBackend) {
    this.node_ops = {
      getattr: (node) => {
        const fileattr = fs.isFile(node.mode)
          ? (node.contents as File).getattr()
          : undefined;

        const size = fileattr
          ? fileattr.size!
          : fs.isDir(node.mode)
          ? DEFAULT_BLOCK_SIZE
          : 0;
        const blksize = fileattr ? fileattr.blockSize! : DEFAULT_BLOCK_SIZE;
        const attr: Attr = {
          dev: 1,
          ino: node.id,
          mode: fileattr ? fileattr.mode! : node.mode,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: node.rdev,
          size,
          atime: new Date(0),
          mtime: new Date(0),
          ctime: new Date(0),
          blksize,
          blocks: Math.ceil(size / blksize),
        };
        return attr;
      },
      setattr: (node, attr) => {
        if (this.fs.isFile(node.mode)) {
          (node.contents as File).setattr(attr);
        } else {
          if (attr.mode != null) {
            node.mode = attr.mode;
          }
          if (attr.size != null) {
            node.size = attr.size;
          }
        }
      },
      lookup: () => {
        throw new this.fs.ErrnoError(ERRNO_CODES.ENOENT);
      },
      mknod: (parent, name, mode, dev) => {
        if (name.endsWith(".lock")) {
          throw new Error("Locking via lockfiles is not supported");
        }

        return this.createNode(parent, name, mode, dev);
      },
      rename: () => {
        throw new Error("rename not implemented");
      },
      unlink: (parent, name) => {
        const node = this.fs.lookupNode(parent, name);
        (node.contents as File).delete();
      },
      readdir: () => {
        // We could list all the available databases here if `node` is
        // the root directory. However Firefox does not implemented
        // such a methods. Other browsers do, but since it's not
        // supported on all browsers users will need to track it
        // separate anyway right now

        throw new Error("readdir not implemented");
      },
      symlink: () => {
        throw new Error("symlink not implemented");
      },
      readlink: () => {
        throw new Error("symlink not implemented");
      },
    };

    this.stream_ops = {
      open: (stream) => {
        if (this.fs.isFile(stream.node.mode)) {
          (stream.node.contents as File).open();
        }
      },

      close: (stream) => {
        if (this.fs.isFile(stream.node.mode)) {
          (stream.node.contents as File).close();
        }
      },

      read: (stream, buffer, offset, length, position) => {
        // console.log('read', offset, length, position)
        return (stream.node.contents as File).read(
          buffer,
          offset,
          length,
          position
        );
      },

      write: (stream, buffer, offset, length, position) => {
        // console.log('write', offset, length, position);
        return (stream.node.contents as File).write(
          buffer,
          offset,
          length,
          position
        );
      },

      llseek: (stream, offset, whence) => {
        // Copied from MEMFS
        var position = offset;
        if (whence === 1) {
          position += stream.position;
        } else if (whence === 2) {
          if (fs.isFile(stream.node.mode)) {
            position += (stream.node.contents as File).getattr().size!;
          }
        }
        if (position < 0) {
          throw new this.fs.ErrnoError(28);
        }
        return position;
      },
      allocate: (stream, offset, length) => {
        (stream.node.contents as File).setattr({ size: offset + length });
      },
      mmap: () => {
        throw new Error("mmap not implemented");
      },
      msync: () => {
        throw new Error("msync not implemented");
      },
      fsync: (stream) => {
        (stream.node.contents as File).fsync();
      },
    };
  }

  mount() {
    return this.createNode(null, "/", 16384 /* dir */ | 511 /* 0777 */, 0);
  }

  lock(path: string, lockType: LOCK_TYPES) {
    const { node } = this.fs.lookupPath(path);
    return (node.contents as File).lock(lockType);
  }

  unlock(path: string, lockType: LOCK_TYPES) {
    const { node } = this.fs.lookupPath(path);
    return (node.contents as File).unlock(lockType);
  }

  createNode(parent: Node | null, name: string, mode: number, dev: number) {
    // Only files and directories supported
    if (!(this.fs.isDir(mode) || this.fs.isFile(mode))) {
      throw new this.fs.ErrnoError(ERRNO_CODES.EPERM);
    }

    var node = this.fs.createNode(parent, name, mode, dev);
    if (this.fs.isDir(node.mode)) {
      node.node_ops = {
        mknod: this.node_ops.mknod,
        lookup: this.node_ops.lookup,
        unlink: this.node_ops.unlink,
        setattr: this.node_ops.setattr,
      };
      // node.stream_ops = {};
      // node.contents = {};
    } else if (this.fs.isFile(node.mode)) {
      node.node_ops = this.node_ops;
      node.stream_ops = this.stream_ops;

      // Create file!
      node.contents = this.backend.createFile(name);
    }

    // add the new node to the parent
    if (parent) {
      // (parent.contents as { [name: string]: Node })[name] = node;
      parent.timestamp = node.timestamp;
    }

    return node;
  }
}
