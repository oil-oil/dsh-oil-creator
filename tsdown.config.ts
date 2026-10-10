import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = "dsh-oil-creator";
const CSS_PREFIX = "\0dsh-oil-creator-css:";
const CSS_SUFFIX = ".mjs";
const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-client-connection/client",
] as const;

function inlineCssPlugin() {
  return {
    name: "dsh-oil-creator-inline-css",
    resolveId(source: string, importer?: string) {
      if (!source.endsWith(".css")) return null;
      const file =
        importer === undefined ? source : resolve(dirname(importer), source);
      return `${CSS_PREFIX}${relative(PROJECT_ROOT, file).replaceAll("\\", "/")}${CSS_SUFFIX}`;
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null;
      const file = resolve(PROJECT_ROOT, id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length));
      const css = await readFile(file, "utf8");
      const tagId = `${PLUGIN_ID}/${basename(file)}`;
      const registry = resolve(dirname(fileURLToPath(import.meta.url)), "src/client/pluginCss.ts");
      return [
        `import { registerPluginCss } from ${JSON.stringify(registry)};`,
        `registerPluginCss(${JSON.stringify(tagId)}, ${JSON.stringify(css)});`,
        "export default {};",
      ].join("\n");
    },
  };
}

export default defineConfig([
  {
    name: `${PLUGIN_ID}/host`,
    entry: { index: "src/index.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/typert`,
    entry: { "typert.host": "src/typert.host.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: "src/client/index.tsx" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    target: "es2022",
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id: string) =>
        CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number])
          ? undefined
          : true,
      onlyBundle: false,
    },
    plugins: [inlineCssPlugin()],
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);
