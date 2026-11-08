/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_TARGET?: 'intake' | 'service';
  readonly VITE_REVIEW_SERVICE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
