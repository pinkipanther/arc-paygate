/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_TESTNET_PAYGATE?: string;
  readonly VITE_TESTNET_DEPLOY_BLOCK?: string;
  readonly VITE_MAINNET_PAYGATE?: string;
  readonly VITE_MAINNET_DEPLOY_BLOCK?: string;
  readonly VITE_LOCAL_PAYGATE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
