import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Ensure Tailwind class-based dark mode is active by default.
// This adds the `dark` class to the root element so components using
// `dark:` variants will render in dark mode. If your project toggles
// dark mode differently, remove this line.
try {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('dark')
  }
} catch (e) {
  // noop in non-browser environments
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
