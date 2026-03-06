export const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
export const platformModifier = isMac ? 'Cmd' : 'Ctrl'
export const platformAlt = isMac ? 'Option' : 'Alt'
