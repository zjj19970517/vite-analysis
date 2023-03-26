import fs from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConfig } from '../config'
import { JS_TYPES_RE } from '../constants'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import {
  bareImportRE,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
} from '../utils'

type ResolveIdOptions = Parameters<PluginContainer['resolveId']>[2]
type Resolver = (
  id: string,
  importer?: string,
  options?: ResolveIdOptions,
) => Promise<string | undefined>
type Tasks = Promise<void>[]
export type Imports = Map<string, { id: string; resolved?: string }[]>

const htmlTypesRE = /\.(?:html|vue|svelte|astro|imba)$/

const importExportRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*(?:import|export)(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*(?:"([^"]+)"|'([^']+)')\s*(?=$|;|\/\/|\/\*)/gm

export async function scanImports(
  entries: string[],
  config: ResolvedConfig,
  imports: Record<string, string>,
  missing: Record<string, string>,
  scanContext?: { cancelled: boolean },
): Promise<void> {
  const tasks: Tasks = []
  const resolver = await createScanResolver(config, imports, missing)

  for (const entry of entries) {
    scanFile(entry, resolver, tasks, config.imports, scanContext)
  }

  // wait for all tasks to complete
  while (tasks.length) {
    const tasksLength = tasks.length
    await Promise.all(tasks)
    // if more tasks gets added, splice old tasks and wait for the new ones
    if (tasksLength !== tasks.length) {
      tasks.splice(0, tasksLength)
    } else {
      break
    }
  }
}

async function createScanResolver(
  config: ResolvedConfig,
  depImports: Record<string, string>,
  missing: Record<string, string>,
): Promise<Resolver> {
  const container = await createPluginContainer(config)
  const seen = new Map<string, string | undefined>()

  const include = config.optimizeDeps?.include
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env',
  ]

  return async (id, importer, options) => {
    if (moduleListContains(exclude, id)) {
      return undefined
    }
    if (depImports[id]) {
      return undefined
    }

    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }

    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      },
    )

    const res = resolved?.id
    seen.set(key, res)

    if (
      bareImportRE.test(id) &&
      id !== res &&
      !res?.includes('\0') &&
      !depImports[id] &&
      !missing[id] &&
      !moduleListContains(exclude, id)
    ) {
      if (res) {
        if (
          (res.includes('node_modules') || include?.includes(id)) &&
          isOptimizable(res, config.optimizeDeps)
        ) {
          depImports[id] = res
        }
      } else if (importer) {
        missing[id] = normalizePath(importer)
      }
    }

    return res
  }
}

function scanFile(
  filePath: string,
  resolver: Resolver,
  tasks: Tasks,
  imports: Imports,
  scanContext?: { cancelled: boolean },
) {
  if (imports.has(filePath)) return

  const importData: { id: string; resolved?: string }[] = []
  imports.set(filePath, importData)

  tasks.push(
    fs
      .readFile(filePath, 'utf-8')
      .then((code) => {
        if (scanContext?.cancelled) return

        let js = parseCode(code, filePath)
        if (!js) return

        js = js
          .replace(multilineCommentsRE, '/* */')
          .replace(singlelineCommentsRE, '')

        // search imports
        let m: RegExpExecArray | null
        importExportRE.lastIndex = 0
        while ((m = importExportRE.exec(js)) != null) {
          const importPath = m[1] || m[2]
          if (importPath) {
            tasks.push(
              resolver(importPath).then((resolved) => {
                if (scanContext?.cancelled) return

                importData.push({ id: importPath, resolved })

                if (
                  resolved &&
                  !resolved.includes('node_modules') &&
                  !imports.has(resolved) &&
                  isScannable(resolved)
                ) {
                  scanFile(resolved, resolver, tasks, imports)
                }
              }),
            )
          }
        }
      })
      .catch(() => {}),
  )
}

const scriptModuleRE =
  /<script\b[^>]+type\s*=\s*(?:"module"|'module')[^>]*>(.*?)<\/script>/gis
const scriptRE = /<script(?:\s[^>]*>|>)(.*?)<\/script>/gis

function parseCode(code: string, filePath: string) {
  if (JS_TYPES_RE.test(filePath)) {
    return code
  } else if (htmlTypesRE.test(filePath)) {
    let js = ''
    let m: RegExpExecArray | null
    const re = filePath.endsWith('.html') ? scriptModuleRE : scriptRE
    while ((m = re.exec(code))) {
      js += m[1]
    }
    return js
  }
}

function isScannable(id: string): boolean {
  return JS_TYPES_RE.test(id) || htmlTypesRE.test(id)
}
