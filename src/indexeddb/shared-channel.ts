let FINALIZED = 0xdeadbeef;

let WRITEABLE = 0;
let READABLE = 1;

interface Params {
  initialOffset?: number;
  useAtomics?: boolean;
  stream?: boolean;
  debug?: boolean;
  name?: string;
}

export class Stream {
  atomicView: Int32Array;
  offset: number;
  useAtomics: boolean;
  stream: boolean;
  debug: boolean;
  name: string;

  constructor(public buffer: ArrayBufferLike, params: Params) {
    this.atomicView = new Int32Array(buffer);
    this.offset = params.initialOffset ?? 4;
    this.useAtomics = params.useAtomics ?? true;
    this.stream = params.stream ?? true;
    this.debug = params.debug ?? false;
    this.name = params.name ?? "undefined";
  }

  log(...args: any[]) {
    if (this.debug) {
      console.log(`[${this.constructor.name}: ${this.name}]`, ...args);
    }
  }
}

export class Reader extends Stream {
  peekOffset?: number;

  constructor(public buffer: ArrayBufferLike, params: Params) {
    super(buffer, params);
  }

  waitWrite(name: string, timeout?: number) {
    if (this.useAtomics) {
      this.log(`waiting for ${name}`);

      while (Atomics.load(this.atomicView, 0) === WRITEABLE) {
        if (timeout != null) {
          if (
            Atomics.wait(this.atomicView, 0, WRITEABLE, timeout) === "timed-out"
          ) {
            throw new Error("timeout");
          }
        }

        Atomics.wait(this.atomicView, 0, WRITEABLE, 500);
      }

      this.log(`resumed for ${name}`);
    } else {
      if (this.atomicView[0] !== READABLE) {
        throw new Error("`waitWrite` expected array to be readable");
      }
    }
  }

  flip() {
    this.log("flip");
    if (this.useAtomics) {
      let prev = Atomics.compareExchange(
        this.atomicView,
        0,
        READABLE,
        WRITEABLE
      );

      if (prev !== READABLE) {
        throw new Error("Read data out of sync! This is disastrous");
      }

      Atomics.notify(this.atomicView, 0);
    } else {
      this.atomicView[0] = WRITEABLE;
    }

    this.offset = 4;
  }

  done() {
    this.waitWrite("done");

    let dataView = new DataView(this.buffer, this.offset);
    let done = dataView.getUint32(0) === FINALIZED;

    if (done) {
      this.log("done");
      this.flip();
    }

    return done;
  }

  peek(fn: () => void) {
    this.peekOffset = this.offset;
    let res = fn();
    this.offset = this.peekOffset;
    delete this.peekOffset;
    return res;
  }

  string(timeout?: number) {
    this.waitWrite("string", timeout);

    let byteLength = this._int32();
    let length = byteLength / 2;

    let dataView = new DataView(this.buffer, this.offset, byteLength);
    let chars: number[] = [];
    for (let i = 0; i < length; i++) {
      chars.push(dataView.getUint16(i * 2));
    }
    let str = String.fromCharCode.apply(null, chars);
    this.log("string", str);

    this.offset += byteLength;

    if (this.peekOffset == null) {
      this.flip();
    }
    return str;
  }

  _int32() {
    let byteLength = 4;

    let dataView = new DataView(this.buffer, this.offset);
    let num = dataView.getInt32(0);
    this.log("_int32", num);

    this.offset += byteLength;
    return num;
  }

  int32() {
    this.waitWrite("int32");
    let num = this._int32();
    this.log("int32", num);

    if (this.peekOffset == null) {
      this.flip();
    }
    return num;
  }

  bytes(): ArrayBufferLike {
    this.waitWrite("bytes");

    let byteLength = this._int32();

    let bytes = new ArrayBuffer(byteLength);
    new Uint8Array(bytes).set(
      new Uint8Array(this.buffer, this.offset, byteLength)
    );
    this.log("bytes", bytes);

    this.offset += byteLength;

    if (this.peekOffset == null) {
      this.flip();
    }
    return bytes;
  }
}

export class Writer extends Stream {
  constructor(public buffer: ArrayBufferLike, params: Params) {
    super(buffer, params);

    if (this.useAtomics) {
      // The buffer starts out as writeable
      Atomics.store(this.atomicView, 0, WRITEABLE);
    } else {
      this.atomicView[0] = WRITEABLE;
    }
  }

  waitRead(name: string) {
    if (this.useAtomics) {
      this.log(`waiting for ${name}`);
      // Switch to writable
      // Atomics.store(this.atomicView, 0, 1);

      let prev = Atomics.compareExchange(
        this.atomicView,
        0,
        WRITEABLE,
        READABLE
      );

      if (prev !== WRITEABLE) {
        throw new Error(
          "Wrote something into unwritable buffer! This is disastrous"
        );
      }

      Atomics.notify(this.atomicView, 0);

      while (Atomics.load(this.atomicView, 0) === READABLE) {
        // console.log('waiting to be read...');
        Atomics.wait(this.atomicView, 0, READABLE, 500);
      }

      this.log(`resumed for ${name}`);
    } else {
      this.atomicView[0] = READABLE;
    }

    this.offset = 4;
  }

  finalize() {
    this.log("finalizing");
    let dataView = new DataView(this.buffer, this.offset);
    dataView.setUint32(0, FINALIZED);
    this.waitRead("finalize");
  }

  string(str: string) {
    this.log("string", str);

    let byteLength = str.length * 2;
    this._int32(byteLength);

    let dataView = new DataView(this.buffer, this.offset, byteLength);
    for (let i = 0; i < str.length; i++) {
      dataView.setUint16(i * 2, str.charCodeAt(i));
    }

    this.offset += byteLength;
    this.waitRead("string");
  }

  _int32(num: number) {
    let byteLength = 4;

    let dataView = new DataView(this.buffer, this.offset);
    dataView.setInt32(0, num);

    this.offset += byteLength;
  }

  int32(num: number) {
    this.log("int32", num);
    this._int32(num);
    this.waitRead("int32");
  }

  bytes(buffer: ArrayBufferLike) {
    this.log("bytes", buffer);

    let byteLength = buffer.byteLength;
    this._int32(byteLength);
    new Uint8Array(this.buffer, this.offset).set(new Uint8Array(buffer));

    this.offset += byteLength;
    this.waitRead("bytes");
  }
}
