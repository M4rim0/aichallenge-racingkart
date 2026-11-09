import type { WgcApi } from '../shared/ipc-contract'

declare global {
  interface Window {
    wgc: WgcApi
  }
}
