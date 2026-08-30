/**
 * Build the browser half (src/client) into lib/client.js in the web shell's
 * lazy-CJS bundle format: window.__ModuleLoader__.load({ id, factory }).
 * External specifiers (react, react-dom/*, @deepseek-ai/*) stay shared
 * requires resolved by the shell's module table at runtime.
 */
import { build } from "esbuild";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";

const outBundle = "lib/client.bundle.js";
await rm(outBundle, { force: true });
await mkdir("lib", { recursive: true });
await build({
  entryPoints: ["src/client/index.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  outfile: outBundle,
  jsx: "automatic",
  target: "es2022",
  sourcemap: false,
  external: ["react", "react-dom/*", "react/jsx-runtime", "@deepseek-ai/*"],
  logLevel: "info"
});
const body = await readFile(outBundle, "utf8");
const wrapped = [
  "window.__ModuleLoader__.load({",
  "\tid: \"dsh-proactive\",",
  "\tfactory: (require) => {",
  "\t\tvar module = { exports: {} };",
  "\t\tvar exports = module.exports;",
  "\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });",
  body,
  "\t\treturn module.exports;",
  "\t}",
  "});"
].join("\n");
await writeFile("lib/client.js", wrapped, "utf8");
await rm(outBundle, { force: true });
await mkdir("lib/types/client", { recursive: true });
// Hand-write the client-facing type declaration (the package `files` list ships
// lib/, so a committed d.ts is not an option — build must produce it).
const dts = [
  "export declare const inject: string[];",
  "export declare function apply(ctx: import(\"@deepseek-ai/dsh-client-runtime/client\").ClientContext): void;",
  "/** The settings.section component (owner props: close). */",
  "export declare const ProactivePanel: (props: { close: () => void }) => import(\"react\").ReactElement;",
  "export {};",
  ""
].join("\n");
await writeFile("lib/types/client/index.d.ts", dts, "utf8");
console.log("lib/client.js written:", wrapped.length, "chars");