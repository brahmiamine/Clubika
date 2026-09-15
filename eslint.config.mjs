import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Existing repository debt: keep these diagnostics visible while allowing
    // feature PRs to use lint as a blocking gate for new correctness errors.
    // The warning budget is ratcheted via `pnpm lint` (`--max-warnings` in
    // package.json, issue #286) rather than by disabling these rules.
    // Issue #31: block raw console.* except the documented exceptions below
    // (tests, e2e, CLI scripts, scraper, service worker). Application code must
    // use @/lib/observability/log or client-log.
    rules: {
      "react/no-unescaped-entities": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "warn",
      "no-console": "error",
      "no-restricted-imports": ["error", {
        paths: [
          { name: "pino", message: "Use @/lib/observability/log (issue #31)." },
          { name: "winston", message: "Use @/lib/observability/log (issue #31)." },
          { name: "bunyan", message: "Use @/lib/observability/log (issue #31)." },
        ],
      }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "e2e/**/*.ts", "scripts/**/*.{ts,mjs,js}", "scraper.js", "public/sw.js"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: [
      "app/components/events/EventCard.tsx",
      "app/components/events/EventListItem.tsx",
    ],
    // These two legacy wrappers return an existing specialised match component
    // before their editable-event hooks. Preserve the warning until that UI is
    // split into separate components instead of weakening the rule globally.
    rules: {
      "react-hooks/rules-of-hooks": "warn",
    },
  },
  {
    // Playwright test fixtures use a `use()` callback parameter (test.extend), which
    // the react-hooks plugin misidentifies as a React Hook by naming convention alone —
    // this directory contains no React code at all.
    files: ["e2e/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
