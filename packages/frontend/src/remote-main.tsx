import React from 'react';
import ReactDOM from 'react-dom/client';
import { installRemoteTokenCapture } from '@/lib/listener-remote-launch';
import ListenerRemote from '@/pages/ListenerRemote';
import './styles/globals.css';

installRemoteTokenCapture();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ListenerRemote />
  </React.StrictMode>,
);
