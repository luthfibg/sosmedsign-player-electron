/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Base URL backend, mis. http://192.168.1.3/ (dev) atau https://cms.domain.com/ (produksi). */
  readonly MAIN_VITE_BACKEND_BASE_URL?: string
  /** Header Host khusus dev (Laravel Herd melayani beberapa site via virtual host). */
  readonly MAIN_VITE_BACKEND_HOST_HEADER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
