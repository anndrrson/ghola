import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
  ]),
  {
    rules: {
      // The current app intentionally initializes state from browser-only
      // APIs and auth stores in effects. Keep lint focused on bugs we can
      // enforce across the existing surface.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      // Auth links intentionally hit API redirect endpoints.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
]);

export default eslintConfig;
