import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { SignIn } from './components/SignIn.tsx'
import { redeemLoginLink, needsSignIn } from './lib/session.ts'
import { startUiScale } from './lib/ui-scale.ts'

startUiScale()   // before the first paint, so the page never flashes at the small size

async function boot(): Promise<void> {
  await redeemLoginLink()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {needsSignIn() ? <SignIn /> : <App />}
    </StrictMode>,
  )
}

void boot()
