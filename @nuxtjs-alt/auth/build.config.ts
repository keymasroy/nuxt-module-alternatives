import type { NuxtModule } from '@nuxt/schema'
import { existsSync, promises as fsp } from 'fs'
import { defineBuildConfig } from 'unbuild'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
import { fdir } from 'fdir'

export default defineBuildConfig({
    declaration: true,
    entries: [
        'src/module',
        { input: 'src/types/', outDir: 'dist/types', ext: 'mjs' },
        { input: 'src/runtime/', outDir: 'dist/runtime', ext: 'mjs' },
        { input: 'src/utils/', outDir: 'dist/utils', ext: 'mjs' },
        { input: 'src/providers/', outDir: 'dist/providers', ext: 'mjs' },
    ],
    rollup: {
        emitCJS: false,
        cjsBridge: true,
    },
    externals: [
        '@nuxt/schema',
        '@nuxt/schema-edge',
        '@nuxt/kit',
        '@nuxt/kit-edge',
        'nuxt',
        'nuxt-edge',
        'nuxt3',
        'vue'
    ],
    hooks: {
        async 'rollup:dts:build'(ctx) {
            const api = new fdir().withFullPaths().glob('./**/*.mjs').crawl(ctx.options.outDir + '/types').withPromise();

            api.then((files) => {
                // @ts-ignore
                files.forEach(async (file: any) => {
                    await fsp.unlink(file)
                });
            });
        },
        async 'rollup:done'(ctx) {
            // Generate CommonJS stup
            await writeCJSStub(ctx.options.outDir)

            // Load module meta
            const moduleEntryPath = resolve(ctx.options.outDir, 'module.mjs')
            const moduleFn: Required<NuxtModule<any>> = await import(
                pathToFileURL(moduleEntryPath).toString()
            ).then(r => r.default || r).catch((err) => {
                console.error(err)
                console.error('Cannot load module. Please check dist:', moduleEntryPath)
                return null
            })
            if (!moduleFn) {
                return
            }
            const moduleMeta = await moduleFn.getMeta()

            // Enhance meta using package.json
            if (ctx.pkg) {
                if (!moduleMeta.name) {
                    moduleMeta.name = ctx.pkg.name
                }
                if (!moduleMeta.version) {
                    moduleMeta.version = ctx.pkg.version
                }
            }

            // Write meta
            const metaFile = resolve(ctx.options.outDir, 'module.json')
            await fsp.writeFile(metaFile, JSON.stringify(moduleMeta, null, 2), 'utf8')
        }
    }
});

async function writeCJSStub(distDir: string) {
    const cjsStubFile = resolve(distDir, 'module.cjs')
    if (existsSync(cjsStubFile)) {
        return
    }

    const cjsStub =
        `module.exports = function(...args) {
    return import('./module.mjs').then(m => m.default.call(this, ...args))
}

const _meta = module.exports.meta = require('./module.json')
module.exports.getMeta = () => Promise.resolve(_meta)`

    await fsp.writeFile(cjsStubFile, cjsStub, 'utf8')
}
