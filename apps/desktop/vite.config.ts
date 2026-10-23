import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const DEV_BRIDGE_PATH = '/__regis-bridge';

function devBridgeProxy(): Record<string, ProxyOptions> | undefined {
  const port = process.env.REGIS_DEV_BRIDGE_PORT;
  const token = process.env.REGIS_DEV_BRIDGE_TOKEN;
  if (!port || !token) {
    return undefined;
  }
  return {
    [DEV_BRIDGE_PATH]: {
      target: `http://127.0.0.1:${port}`,
      rewrite: (path) => path.slice(DEV_BRIDGE_PATH.length),
      headers: { 'x-regis-bridge-token': token },
    },
  };
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, proxy: devBridgeProxy() },
  build: { outDir: 'dist', emptyOutDir: true },
});
