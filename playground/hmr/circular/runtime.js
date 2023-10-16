let state = {}

export const render = (newState) => {
  state = newState
  apply()
}

export const rerender = (updates) => {
  state = { ...state, ...updates }
  apply()
}

const apply = () => {
  document.querySelector('.circular').textContent =
    Object.values(state).join(':')
}
