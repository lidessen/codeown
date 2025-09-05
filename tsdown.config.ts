import { defineConfig } from "tsdown";
import { readFileSync } from "fs";
import { join } from "path";

const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf-8")
);

export default defineConfig([
  {
    entry: ["./src/cli.ts"],
    dts: true,
    format: "esm",
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
  },
]);
