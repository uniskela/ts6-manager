import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { evaluateSafeUiLatch } from '@/lib/safe-ui';
import './styles/globals.css';

// Latch ?safe-ui=1 for this document before React mounts or custom CSS can inject.
evaluateSafeUiLatch();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
