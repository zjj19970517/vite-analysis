import fs from 'node:fs'
import path from 'node:path'
import type { ViteDevServer } from '..'
import type { ResolvedConfig } from '../config'
import { FS_PREFIX } from '../constants'
import type { Plugin } from '../plugin'
import { transformRequest } from '../server/transformRequest'
import { cleanUrl } from '../utils'

/**
 * eagerly pre transform file imports based on scanner metadata
 */
export function eagerTransformPlugin(config: ResolvedConfig): Plugin {
  let server: ViteDevServer

  function normalizeIdToUrl(id: string) {
    // e.g. `import 'foo'` -> `import '/@fs/.../node_modules/foo/index.js'`
    if (id.startsWith(config.root + '/')) {
      // in root: infer short absolute path from root
      return id.slice(config.root.length)
    } else if (fs.existsSync(cleanUrl(id))) {
      // a regular file exists but is out of root: rewrite to absolute /@fs/ paths
      return path.posix.join(FS_PREFIX, id)
    } else {
      return id
    }
  }

  return {
    name: 'vite:eager-transform',

    configureServer(_server) {
      server = _server
    },

    load(id, opts) {
      const imports = config.fileImportsMetadata.get(id)
      if (imports) {
        // next time this will likely be stale, so delete
        config.fileImportsMetadata.delete(id)
        for (const importId of imports) {
          const url = normalizeIdToUrl(importId)
          transformRequest(url, server, { ssr: opts?.ssr }).catch((e) => {
            // Unexpected error, log the issue but avoid an unhandled exception
            config.logger.error(e.message)
          })
        }
      }
    },

    handleHotUpdate({ file }) {
      config.fileImportsMetadata.delete(file)
    },
  }
}
