import { defineConfig } from "vite";

export default defineConfig({
  // When hosted at https://<user>.github.io/mtgslop/ ensure assets resolve from subpath
  base: "/mtgslop/",
  server: {
    port: 5173,
  },
});
