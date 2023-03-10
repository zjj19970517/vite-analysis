// for each packags in the benchmark folder, run the _setup file, then build them
// and run the benchmark

import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execaCommandSync } from 'execa'

const currentDir = fileURLToPath(new URL('./', import.meta.url))
main()
async function main() {
  const dirents = await fs.readdir(currentDir, { withFileTypes: true })
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      const setupFile = new URL(`./${dirent.name}/_setup.ts`, import.meta.url)
      if (fsSync.existsSync(setupFile)) {
        execaCommandSync(`tsx ${fileURLToPath(setupFile)}`, {
          cwd: currentDir,
        })
      }
    }
  }
}
