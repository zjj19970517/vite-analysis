import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('./', import.meta.url))

setup()

export async function setup() {
  const resolveJsDir = path.resolve(__dirname, 'src/resolve-js')
  await fs.mkdir(resolveJsDir, { recursive: true })
  await Promise.all(
    Array.from({ length: 1000 }).map((_, i) => {
      return fs.writeFile(
        path.resolve(resolveJsDir, `${i}.js`),
        `import './${i + 1}'`,
        'utf-8',
      )
    }),
  )
  await fs.writeFile(
    path.resolve(resolveJsDir, '1000.js'),
    `document.querySelector('.resolve-js').innerHTML = '[success] resolve-js'`,
    'utf-8',
  )

  const resolveJsxDir = path.resolve(__dirname, 'src/resolve-jsx')
  await fs.mkdir(resolveJsxDir, { recursive: true })
  await Promise.all(
    Array.from({ length: 1000 }).map((_, i) => {
      return fs.writeFile(
        path.resolve(resolveJsxDir, `${i}.jsx`),
        `\
import { Component as Comp } from './${i + 1}'
import { useState } from 'react'

export function Component({ num }) {
  const [bold, setBold] = useState(false)
  return (
    <>
      <button onClick={() => setBold(!bold)}>{bold ? <strong>{num}</strong> : num}</button>
      <Comp num={num + 1} />
    </>
  )
}

${
  i === 0
    ? `\
import { render } from 'react-dom'
render(<Component num={0} />, document.querySelector('.resolve-jsx'))
`
    : ''
}
`,
        'utf-8',
      )
    }),
  )
  await fs.writeFile(
    path.resolve(resolveJsxDir, '1000.jsx'),
    `export const Component = () => <div>[success] resolve-jsx</div>`,
    'utf-8',
  )
}
