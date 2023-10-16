import { render, rerender } from './runtime'
import { msg as _msg } from './mod-a'

render({ msg: _msg })

if (import.meta.hot) {
  import.meta.hot.accept('./mod-a', (newMod) => {
    rerender({ msg: newMod.msg })
  })
}
