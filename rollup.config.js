import path from "path";
import resolve from "@rollup/plugin-node-resolve";
import multi from "@rollup/plugin-multi-entry";
import typescript from "@rollup/plugin-typescript";
import { terser } from "rollup-plugin-terser";
import replace from "@rollup/plugin-replace";
import commonjs from "@rollup/plugin-commonjs";

const browserTestBuild = {
  input: "./test/**/*_test.ts",
  output: [
    {
      file: "dist/test-suite.js",
      format: "iife",
      sourcemap: true,
      globals: {
        intern: "intern",
      },
    },
  ],
  plugins: [
    multi(),
    resolve({
      mainFields: ["browser", "module", "main"],
      preferBuiltins: true,
    }),
    typescript({
      target: "es2019",
      types: ["intern"],
    }),
    replace({
      __dirname: JSON.stringify(path.join(__dirname, "test")),
      "process.env.TEST_KINTO_SERVER": JSON.stringify(
        process.env.TEST_KINTO_SERVER ? process.env.TEST_KINTO_SERVER : ""
      ),
      "process.env.SERVER": JSON.stringify(
        process.env.SERVER ? process.env.SERVER : ""
      ),
      "process.env.KINTO_PROXY_SERVER": JSON.stringify(
        process.env.SERVER ? process.env.SERVER : "http://localhost:8899"
      ),
      "http://0.0.0.0": "http://localhost",
    }),
    commonjs(),
  ],
};

const build = {
  input: "./src/index.ts",
  output: {
    file: "./dist/minto.js",
    format: "es",
    sourcemap: true,
  },
  plugins: [resolve(), typescript(), terser()],
};

const bundles = process.env.BROWSER_TESTING ? [browserTestBuild] : [build];

export default bundles;
