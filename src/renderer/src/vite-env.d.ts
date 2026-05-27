/// <reference types="vite/client" />

import type { OssApi } from '@shared/ipc';

declare global {
  interface Window {
    ossApi: OssApi;
  }
}
