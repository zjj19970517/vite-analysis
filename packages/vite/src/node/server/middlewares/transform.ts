import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Connect } from 'dep-types/connect'
import colors from 'picocolors'
import type { ViteDevServer } from '..'
import {
  cleanUrl,
  createDebugger,
  ensureVolumeInPath,
  fsPathFromId,
  injectQuery,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  unwrapId,
} from '../../utils'
import { send } from '../send'
import { ERR_LOAD_URL, transformRequest } from '../transformRequest'
import { isHTMLProxy } from '../../plugins/html'
import {
  DEP_VERSION_RE,
  FS_PREFIX,
  NULL_BYTE_PLACEHOLDER,
} from '../../constants'
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest,
} from '../../plugins/css'
import {
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
  ERR_OUTDATED_OPTIMIZED_DEP,
} from '../../plugins/optimizedDeps'
import { getDepsOptimizer } from '../../optimizer'

const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

const knownIgnoreList = new Set(['/', '/favicon.ico'])

export function transformMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  const {
    config: { root, logger },
    moduleGraph,
  } = server

  return async function viteTransformMiddleware(req, res, next) {
    // 仅仅处理 GET 请求 && 过滤黑名单的请求，比如 / /favicon.ico
    if (req.method !== 'GET' || knownIgnoreList.has(req.url!)) {
      return next()
    }

    let url: string
    try {
      // url 处理：移除参数中的时间戳 + decodeURI + 替换 __x00__
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER, // __x00__
        '\0',
      )
    } catch (e) {
      return next(e)
    }

    // 移除 url 中的 query 参数和 hash
    const withoutQuery = cleanUrl(url)

    try {
      // 是否为 sourcemap 文件
      const isSourceMap = withoutQuery.endsWith('.map')
      if (isSourceMap) {
        // sourcemap 文件需要特殊处理
        const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
        if (depsOptimizer?.isOptimizedDepUrl(url)) {
          // If the browser is requesting a source map for an optimized dep, it
          // means that the dependency has already been pre-bundled and loaded
          const mapFile = url.startsWith(FS_PREFIX)
            ? fsPathFromId(url)
            : normalizePath(
                ensureVolumeInPath(path.resolve(root, url.slice(1))),
              )
          try {
            const map = await fs.readFile(mapFile, 'utf-8')
            return send(req, res, map, 'json', {
              headers: server.config.server.headers,
            })
          } catch (e) {
            // Outdated source map request for optimized deps, this isn't an error
            // but part of the normal flow when re-optimizing after missing deps
            // Send back an empty source map so the browser doesn't issue warnings
            const dummySourceMap = {
              version: 3,
              file: mapFile.replace(/\.map$/, ''),
              sources: [],
              sourcesContent: [],
              names: [],
              mappings: ';;;;;;;;;',
            }
            return send(req, res, JSON.stringify(dummySourceMap), 'json', {
              cacheControl: 'no-cache',
              headers: server.config.server.headers,
            })
          }
        } else {
          const originalUrl = url.replace(/\.map($|\?)/, '$1')
          const map = (await moduleGraph.getModuleByUrl(originalUrl, false))
            ?.transformResult?.map
          if (map) {
            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers,
            })
          } else {
            return next()
          }
        }
      }

      // 标准化处理 publicDir 目录 path
      const publicDir = normalizePath(server.config.publicDir)
      // 标准化处理 root 目录 path
      const rootDir = normalizePath(server.config.root)
      // 如果 publicDir 是 rootDir 的子目录
      if (publicDir.startsWith(rootDir)) {
        const publicPath = `${publicDir.slice(rootDir.length)}/`
        if (url.startsWith(publicPath)) {
          // 我们访问的请求，是 publicDir 目录下的文件，给出相关警告
          let warning: string

          if (isImportRequest(url)) {
            const rawUrl = removeImportQuery(url)

            warning =
              'Assets in public cannot be imported from JavaScript.\n' +
              `Instead of ${colors.cyan(
                rawUrl,
              )}, put the file in the src directory, and use ${colors.cyan(
                rawUrl.replace(publicPath, '/src/'),
              )} instead.`
          } else {
            warning =
              `files in the public directory are served at the root path.\n` +
              `Instead of ${colors.cyan(url)}, use ${colors.cyan(
                url.replace(publicPath, '/'),
              )}.`
          }

          logger.warn(colors.yellow(warning))
        }
      }

      // 下面是这个中间件的核心逻辑，需要满足如下条件：
      if (
        // JS 请求，文件后缀，比如 .js .jsx .ts .tsx .svelte .vue 等都是 JS 请求
        isJSRequest(url) ||
        // 带有 ?import 参数的请求
        isImportRequest(url) ||
        // CSS 请求，后缀文件，比如：.css .less .sass .scss .styl .stylus .pcss .postcss .sss
        isCSSRequest(url) ||
        // HTTP 代理请求
        isHTMLProxy(url)
      ) {
        // 剔除 ?import 参数
        url = removeImportQuery(url)
        // TODO: 以 /@id/ 开头的请求，将 __x00__ 替换为 \0，具体干啥，还不清楚
        url = unwrapId(url)

        // 对于 CSS，我们需要区分普通的 CSS 请求和导入请求
        if (
          isCSSRequest(url) &&
          !isDirectRequest(url) &&
          req.headers.accept?.includes('text/css')
        ) {
          url = injectQuery(url, 'direct')
        }
        // 总之前面都是对于 url 的脱壳处理，得到一个纯粹的 url，方便后续的识别

        // 存在 if-none-match header
        const ifNoneMatch = req.headers['if-none-match']
        if (
          // 存在这个 header 头
          ifNoneMatch &&
          // 并且 moduleGraph 中存在这个 url 对应的模块的编译转换结果
          // 并且 etag 与 if-none-match 相等
          (await moduleGraph.getModuleByUrl(url, false))?.transformResult
            ?.etag === ifNoneMatch
        ) {
          // 304 协商缓存生效
          isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
          res.statusCode = 304
          return res.end()
        }

        // 这里是核心逻辑，对于 JS 和 CSS 请求，我们需要进行编译转换
        // 以此完成 resolve、load、 transform 三个阶段的编译处理过程
        const result = await transformRequest(url, server, {
          html: req.headers.accept?.includes('text/html'),
        })

        if (result) {
          const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
          // 文件类型，js 或者 css
          const type = isDirectCSSRequest(url) ? 'css' : 'js'
          // 是否经过依赖预构建处理后
          const isDep =
            DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url)

          // 最终将编译转换结果返回给浏览器
          return send(req, res, result.code, type, {
            etag: result.etag, // 设置 etag
            // 如果是依赖预构建处理后的结果，设置缓存时间为 1 年
            cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache',
            // 设置自定义的 header
            headers: server.config.server.headers,
            // sourcemap
            map: result.map,
          })
        }
      }
    } catch (e) {
      // 针对的异常处理
      if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Optimize Deps Processing Error'
          res.end()
        }
        // This timeout is unexpected
        logger.error(e.message)
        return
      }
      if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Outdated Optimize Dep'
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      if (e?.code === ERR_LOAD_URL) {
        // Let other middleware handle if we can't load the url via transformRequest
        return next()
      }
      return next(e)
    }

    next()
  }
}
