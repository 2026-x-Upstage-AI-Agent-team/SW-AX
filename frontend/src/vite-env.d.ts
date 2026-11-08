/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_TARGET?: 'intake' | 'service';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
