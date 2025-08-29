/**
 * Minimal ESLint config for a strict TypeScript project without framework-specific rules.
 * Keep rules conservative to avoid massive churn; we can tighten incrementally.
 */
module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: false,
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  ignorePatterns: [
    "dist/",
    "src-tauri/target/",
    "node_modules/",
  ],
  rules: {
//     // Keep noise low; prefer gradual tightening.
    "@typescript-eslint/no-explicit-any": "off",
//   "no-console": ["warn", { allow: ["warn", "error"] }],
  "no-empty": ["warn", { allowEmptyCatch: true }],
//     "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
//     "eqeqeq": ["warn", "smart"],
//   "prefer-const": "warn",
//   "no-constant-condition": "warn",
//   "no-inner-declarations": "warn",
//     "no-unused-vars": "off",
//     "@typescript-eslint/no-unused-vars": [
//       "warn",
//       { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
//     ],
//   // Allow safe regex escapes until we refactor
//   "no-useless-escape": "warn",
//   // Style-only nits as warnings for now
//   "@typescript-eslint/ban-types": "warn",
  },
};
