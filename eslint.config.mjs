import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import firebaseRulesPlugin from "@firebase/eslint-plugin-security-rules";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  firebaseRulesPlugin.configs["flat/recommended"],
  globalIgnores([
    ".next/**",
    ".open-next/**",
    "out/**",
    "dist/**",
    "build/**",
    "node_modules/**",
    ".playwright-cli/**",
    "next-env.d.ts",
  ]),
]);
