import type { ModuleOptions } from './types';
import { addImports, addPluginTemplate, addTemplate, createResolver, defineNuxtModule, installModule } from '@nuxt/kit';
import { name, version } from '../package.json';
import { resolveStrategies } from './resolve';
import { moduleDefaults } from './options';
import { getAuthDTS, getAuthPlugin } from './plugin';
import { defu } from 'defu';

const CONFIG_KEY = 'auth';

export default defineNuxtModule({
    meta: {
        name,
        version,
        configKey: CONFIG_KEY,
        compatibility: {
            nuxt: '^3.0.0-rc.9',
        },
    },
    defaults: moduleDefaults,
    async setup(moduleOptions, nuxt) {
        // Merge all option sources
        const options: ModuleOptions = defu({ ...moduleOptions, ...nuxt.options.runtimeConfig[CONFIG_KEY] }, moduleDefaults)

        // Resolver
        const resolver = createResolver(import.meta.url);

        // Resolve strategies
        const { strategies, strategyScheme } = await resolveStrategies(nuxt, options);
        delete options.strategies;

        // Resolve required imports
        const uniqueImports = new Set();
        const schemeImports = Object.values(strategyScheme).filter((i) => {
            if (uniqueImports.has(i.as)) {
                return false;
            }

            uniqueImports.add(i.as);
            return true;
        });

        // Set defaultStrategy
        options.defaultStrategy = options.defaultStrategy || strategies.length ? strategies[0].name : '';

        // Install http module if not in modules
        if (!nuxt.options.modules.includes('@nuxtjs-alt/http')) {
            installModule('@nuxtjs-alt/http')
        }

        // Add auth plugin
        addPluginTemplate({
            getContents: () => getAuthPlugin({ options, strategies, strategyScheme, schemeImports }),
            filename: 'auth.plugin.mjs',
        });

        addTemplate({
            getContents: () => getAuthDTS(),
            filename: 'auth.plugin.d.ts',
            write: true
        })

        // Add auto imports
        addImports([
            { from: resolver.resolve('runtime/composables'), name: 'useAuth' },
        ])

        // Runtime
        const runtime = resolver.resolve('runtime');
        nuxt.options.alias['#auth/runtime'] = runtime;

        // Utils
        const utils = resolver.resolve('utils');
        nuxt.options.alias['#auth/utils'] = utils;

        // Providers
        const providers = resolver.resolve('providers');
        nuxt.options.alias['#auth/providers'] = providers;

        // Transpile
        nuxt.options.build.transpile.push(runtime, providers, utils)

        // Middleware
        if (options.enableMiddleware) {
            nuxt.hook('app:resolve', (app) => {
                app.middleware.push({
                    name: 'auth',
                    path: resolver.resolve('runtime/core/middleware'),
                    global: options.globalMiddleware,
                });
            });
        }

        // Extend auth with plugins
        if (options.plugins) {
            options.plugins.forEach((p) => nuxt.options.plugins.push(p))
            delete options.plugins
        }
    }
});