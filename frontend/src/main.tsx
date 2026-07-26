import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './App.js';
import './styles/index.css';

document.body.classList.add('atb');

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
