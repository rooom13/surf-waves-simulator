import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        animations: resolve(__dirname, 'animations.html'),
        secret: resolve(
          __dirname,
          'e98c882fd34b9b9770bfa7c3e393941f69088269d829f9f7bed14aae4caecc23/index.html'
        ),
      },
    },
  },
});
