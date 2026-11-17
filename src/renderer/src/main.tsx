import React from 'react';
import ReactDOM from 'react-dom/client';
import RootApp from './App';
import { initializeDesktopApi } from './desktop';

async function bootstrap(): Promise<void> {
  try {
    const dispose = await initializeDesktopApi();
    window.addEventListener('beforeunload', dispose, { once: true });
    if (import.meta.hot) import.meta.hot.dispose(dispose);
  } catch (error) {
    console.error('Desktop API initialization failed', error);
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <RootApp />
    </React.StrictMode>
  );
}
void bootstrap();
