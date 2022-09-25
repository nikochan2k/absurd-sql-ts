import { nodeResolve } from "@rollup/plugin-node-resolve";
import { terser } from "rollup-plugin-terser";
import webWorkerLoader from "rollup-plugin-web-worker-loader";

function getConfig(entry, filename) {
  // Remove the extension
  let basename = filename.replace(/\.[^.]*/, "");

  return {
    input: entry,
    output: {
      dir: "dist",
      entryFileNames: filename,
      chunkFileNames: `${basename}-[name]-[hash].js`,
      format: "esm",
      exports: "named",
    },
    plugins: [
      webWorkerLoader({
        pattern: /.*\/worker\.js/,
        targetPlatform: "browser",
        external: [],
        plugins: [terser()],
      }),
      nodeResolve(),
    ],
  };
}

export default [
  getConfig("lib/index.js", "index.js"),
  getConfig("lib/memory/backend.js", "memory-backend.js"),
  getConfig("lib/indexeddb/backend.js", "indexeddb-backend.js"),
  getConfig("lib/indexeddb/main-thread.js", "indexeddb-main-thread.js"),
];
