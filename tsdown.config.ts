import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@chenchen4396/dsh-squad'
const CSS_PREFIX = '\0agent-team-css:'
const CSS_SUFFIX = '.mjs'

const cssModulesPlugin = {
  name: 'agent-team-css-modules',
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    return `${CSS_PREFIX}${resolve(dirname(importer), source)}${CSS_SUFFIX}`
  },
  async load(id: string) {
    if (!id.startsWith(CSS_PREFIX)) return null
    const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
    const source = await readFile(file)
    const result = transform({
      filename: file,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classes = Object.fromEntries(
      Object.entries(result.exports ?? {}).map(([local, value]) => [local, value.name]),
    )
    const tagId = `${PACKAGE_NAME}/${basename(file)}`
    return [
      `const css = ${JSON.stringify(result.code.toString())};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
      '  const tag = document.createElement("style");',
      `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classes)};`,
    ].join('\n')
  },
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    platform: 'node',
    format: 'esm',
    fixedExtension: false,
    outDir: 'lib',
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    // DeepSeek Harness does not load Web plugins as native ESM. It fetches
    // client.js and expects the bundle to register a CommonJS-style factory
    // in the browser's frozen module table.
    entry: { client: 'src/client/index.tsx' },
    platform: 'browser',
    format: 'cjs',
    fixedExtension: false,
    outDir: 'lib',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: [
        'react',
        'react/jsx-runtime',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
    },
    plugins: [cssModulesPlugin],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    // Keep the public ./client type entry as client.d.ts while the executable
    // browser artifact above remains a wrapped CommonJS factory.
    entry: { client: 'src/client/index.tsx' },
    platform: 'browser',
    format: 'esm',
    fixedExtension: false,
    outDir: 'lib',
    dts: { emitDtsOnly: true },
    clean: false,
    sourcemap: false,
  },
])
