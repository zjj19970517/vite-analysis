import { promises as fs } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import getEtag from 'etag'
import convertSourceMap from 'convert-source-map'
import type { SourceDescription, SourceMap } from 'rollup'
import colors from 'picocolors'
import type { ModuleNode, ViteDevServer } from '..'
import {
  blankReplacer,
  cleanUrl,
  createDebugger,
  ensureWatchedFile,
  isObject,
  prettifyUrl,
  removeTimestampQuery,
  timeFrom,
} from '../utils'
import { checkPublicFile } from '../plugins/asset'
import { getDepsOptimizer } from '../optimizer'
import { injectSourcesContent } from './sourcemap'
import { isFileServingAllowed } from './middlewares/static'

export const ERR_LOAD_URL = 'ERR_LOAD_URL'
export const ERR_LOAD_PUBLIC_URL = 'ERR_LOAD_PUBLIC_URL'

const debugLoad = createDebugger('vite:load')
const debugTransform = createDebugger('vite:transform')
const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

export interface TransformResult {
  code: string
  map: SourceMap | null
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}

export interface TransformOptions {
  ssr?: boolean
  html?: boolean
}

/** 请求编译构建处理，该方法返回的是一个处理 request 的异步函数 */
export function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {},
): Promise<TransformResult | null> {
  // 构建一个缓存 key，通常就是请求的这个 url
  const cacheKey = (options.ssr ? 'ssr:' : options.html ? 'html:' : '') + url

  // 保存一个请求开始处理的时间戳，后面将其与该模块上次失效的时间进行比较
  // 获取一个当前请求的时间戳
  const timestamp = Date.now()

  // 判断该模块 url 是否已在请求中了，是否为 pending 了
  // 如果已经在处理中了，那么自然就不需要再重复发起请求了
  const pending = server._pendingRequests.get(cacheKey)
  if (pending) {
    // 首先获取到 url 对应的 ModuleNode
    return server.moduleGraph
      .getModuleByUrl(removeTimestampQuery(url), options.ssr)
      .then((module) => {
        // 这里的 module 就是我们想要获取到的 ModuleNode 节点
        
        if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
          // 如果 pending 中的请求，时间戳要 > 模块的最后一次失效时间
          // 可以使用 pending 中的请求，进行重用
          return pending.request
        } else {
          // pending 中的请求取消，将会重新发起
          pending.abort()
          return transformRequest(url, server, options)
        }
      })
  }

  // 开始编译处理（在这个函数中完成核心的 resolve、load、transform 处理）
  const request = doTransform(url, server, options, timestamp)

  let cleared = false
  // 清空缓存的函数
  const clearCache = () => {
    if (!cleared) {
      server._pendingRequests.delete(cacheKey)
      cleared = true
    }
  }

  // 将 url 对应的请求，设置到请求队列中，或者说是缓存起来
  server._pendingRequests.set(cacheKey, {
    request,
    timestamp,
    abort: clearCache,
  })
  // request 是一个异步函数，当他执行完毕后，需要执行清楚缓存（或移出请求队列）的操作
  request.then(clearCache, clearCache)

  // 最终返回出这个 request 异步执行函数
  return request
}

/** 执行编译处理 */
async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number,
) {
  // 移除时间戳查询参数
  url = removeTimestampQuery(url)

  const { config, pluginContainer } = server
  const prettyUrl = isDebug ? prettifyUrl(url, config.root) : ''
  const ssr = !!options.ssr

  // 第一步：通过 url 获取模块 ModuleNode 
  // getModuleByUrl 内部会调用路径解析工厂函数 resolveId
  const module = await server.moduleGraph.getModuleByUrl(url, ssr)

  // 从模块信息中获取 transformResult 转换结果
  const cached =
    module && (ssr ? module.ssrTransformResult : module.transformResult)
  if (cached) {
    // 如果有缓存结果，说明已经编译处理过了，直接返回
    isDebug && debugCache(`[memory] ${prettyUrl}`)
    return cached
  }

  // 第二步：使用 pluginContainer 调度执行所有插件的 resolveId Hook 钩子函数
  // 解析出 url 对应的模块
  const id =
    (await pluginContainer.resolveId(url, undefined, { ssr }))?.id || url

  // ⭐️ loadAndTransform 方法完成 load 和 transform
  const result = loadAndTransform(id, url, server, options, timestamp)

  getDepsOptimizer(config, ssr)?.delayDepsOptimizerUntil(id, () => result)

  return result
}

async function loadAndTransform(
  id: string,
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number,
) {
  const { config, pluginContainer, moduleGraph, watcher } = server
  const { root, logger } = config
  const prettyUrl = isDebug ? prettifyUrl(url, config.root) : ''
  const ssr = !!options.ssr

  const file = cleanUrl(id)

  let code: string | null = null
  let map: SourceDescription['map'] = null

  // 第一步：完成模块的 load 加载
  const loadStart = isDebug ? performance.now() : 0
  // 使用 pluginContainer 调度执行所有插件的 load Hook 钩子函数
  const loadResult = await pluginContainer.load(id, { ssr })
  if (loadResult == null) {
    // 插件没有处理结果的情况下
    if (options.html && !id.endsWith('.html')) {
      return null
    }

    if (options.ssr || isFileServingAllowed(file, server)) {
      try {
        // 兜底策略：通过 fs 模块读取文件内容，完成加载
        code = await fs.readFile(file, 'utf-8')
        isDebug && debugLoad(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw e
        }
      }
    }
    
    if (code) {
      try {
        // 提取代码中的 source map
        map = (
          // 从一个已经包含了内联 source map 的 JS 代码内容中提取 source map
          convertSourceMap.fromSource(code) ||
          // 并不是从 JS 文件中提取内联的 source map，而是从文件中提取对外部 source map 文件的引用。
          (await convertSourceMap.fromMapFileSource(
            code,
            createConvertSourceMapReadMap(file),
          ))
        )?.toObject()
        // 将 code 的 source map 相关的注释内容去除
        code = code.replace(convertSourceMap.mapFileCommentRegex, blankReplacer)
      } catch (e) {
        logger.warn(`Failed to load source map for ${url}.`, {
          timestamp: true,
        })
      }
    }
  } else {
    // 插件有处理结果的情况下
    isDebug && debugLoad(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
    } else {
      code = loadResult
    }
  }
  // 处理没有 code 的情况，会抛出异常
  if (code == null) {
    const isPublicFile = checkPublicFile(url, config)
    const msg = isPublicFile
      ? `This file is in /public and will be copied as-is during build without ` +
        `going through the plugin transforms, and therefore should not be ` +
        `imported from source code. It can only be referenced via HTML tags.`
      : `Does the file exist?`
    const importerMod: ModuleNode | undefined = server.moduleGraph.idToModuleMap
      .get(id)
      ?.importers.values()
      .next().value
    const importer = importerMod?.file || importerMod?.url
    const err: any = new Error(
      `Failed to load url ${url} (resolved id: ${id})${
        importer ? ` in ${importer}` : ''
      }. ${msg}`,
    )
    err.code = isPublicFile ? ERR_LOAD_PUBLIC_URL : ERR_LOAD_URL
    throw err
  }
  // 第二步：初始化 Module Node
  const mod = await moduleGraph.ensureEntryFromUrl(url, ssr)
  // 确保文件被 watcher 观察上了
  ensureWatchedFile(watcher, mod.file, root)

  // 第三步：模块内容的转换处理
  // 使用 pluginContainer 调度执行所有插件的 transform Hook 钩子函数
  const transformStart = isDebug ? performance.now() : 0
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
    ssr,
  })
  const originalCode = code
  if (
    transformResult == null ||
    (isObject(transformResult) && transformResult.code == null)
  ) {
    // no transform applied, keep code as-is
    isDebug &&
      debugTransform(
        timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`),
      )
  } else {
    isDebug && debugTransform(`${timeFrom(transformStart)} ${prettyUrl}`)
    code = transformResult.code!
    // 转换后的结果中如果有 sourcemap 内容，那么会重新赋值 map
    map = transformResult.map
  }

  // 针对 sourcemap 的特殊处理，目前暂时先不关注这块内容了
  if (map && mod.file) {
    map = (typeof map === 'string' ? JSON.parse(map) : map) as SourceMap
    if (map.mappings && !map.sourcesContent) {
      await injectSourcesContent(map, mod.file, logger)
    }
    for (
      let sourcesIndex = 0;
      sourcesIndex < map.sources.length;
      ++sourcesIndex
    ) {
      const sourcePath = map.sources[sourcesIndex]
      if (!sourcePath) continue

      const sourcemapPath = `${mod.file}.map`
      const ignoreList = config.server.sourcemapIgnoreList(
        path.isAbsolute(sourcePath)
          ? sourcePath
          : path.resolve(path.dirname(sourcemapPath), sourcePath),
        sourcemapPath,
      )
      if (typeof ignoreList !== 'boolean') {
        logger.warn('sourcemapIgnoreList function must return a boolean.')
      }
      if (ignoreList) {
        if (map.x_google_ignoreList === undefined) {
          map.x_google_ignoreList = []
        }
        if (!map.x_google_ignoreList.includes(sourcesIndex)) {
          map.x_google_ignoreList.push(sourcesIndex)
        }
      }

      // Rewrite sources to relative paths to give debuggers the chance
      // to resolve and display them in a meaningful way (rather than
      // with absolute paths).
      if (path.isAbsolute(sourcePath) && path.isAbsolute(mod.file)) {
        map.sources[sourcesIndex] = path.relative(
          path.dirname(mod.file),
          sourcePath,
        )
      }
    }
  }

  // 第四步：返回转换后的结果内容 TransformResult，包括 code、map、etag
  const result =
    ssr && !server.config.experimental.skipSsrTransform
      ? await server.ssrTransform(code, map as SourceMap, url, originalCode)
      : ({
          code,
          map,
          etag: getEtag(code, { weak: true }),
        } as TransformResult)

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp) {
    if (ssr) mod.ssrTransformResult = result
    else mod.transformResult = result
  }

  return result
}

function createConvertSourceMapReadMap(originalFileName: string) {
  return (filename: string) => {
    return fs.readFile(
      path.resolve(path.dirname(originalFileName), filename),
      'utf-8',
    )
  }
}
