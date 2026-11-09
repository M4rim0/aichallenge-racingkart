import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { VerificationApp } from './verification/VerificationApp'

const root = document.getElementById('root')
if (!root) throw new Error('root element not found')

createRoot(root).render(
  <StrictMode>
    <VerificationApp />
  </StrictMode>
)
