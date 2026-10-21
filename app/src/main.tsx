import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { SignIn } from './components/SignIn.tsx'
import { redeemLoginLink, needsSignIn } from './lib/session.ts'

async function boot(): Promise<void> {
  await redeemLoginLink()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {needsSignIn() ? <SignIn /> : <App />}
    </StrictMode>,
  )
}

void boot()
