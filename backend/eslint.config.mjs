// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },

  /**
   * navigate() is the ONLY sanctioned way to load a page.
   *
   * It carries robots gating, the per-host throttle, the post-block cooldown
   * check, block detection, and the bounded reload/interstitial-wait loop. Every
   * one of those was learned expensively — the interstitial handling alone cost a
   * 900s throttle hold to get wrong — and all of it is bypassed by a single
   * `driver.get()` written somewhere else.
   *
   * The realistic way that happens is not malice but convenience: a step that
   * needs "the same page again" reaches for `.refresh()`, or a new adapter copies
   * a line from a probe script. Amazon's post-address reload is exactly such a
   * line, and if it stopped going through navigate() the Dogs-of-Amazon page would
   * stop being retried and start costing a full BLOCK instead.
   *
   * Scoped to the adapter tree, and deliberately NOT applied to the base (which
   * owns the one legitimate call) or to specs (whose fake drivers define `get`).
   */
  {
    files: ['src/crawler/adapters/**/*.ts'],
    ignores: [
      'src/crawler/adapters/selenium-adapter.base.ts',
      '**/*.spec.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='get'][callee.object.name=/([Dd]river|^d)$/]",
          message:
            'Do not call driver.get() directly — use navigate() (or StepRuntime.navigate), ' +
            'which applies robots, throttle, cooldown and block detection.',
        },
        {
          selector: "CallExpression[callee.object.callee.property.name='navigate']",
          message:
            'Do not use driver.navigate() — use the adapter navigate() (or ' +
            'StepRuntime.navigate) so the load is throttled and block-checked.',
        },
        {
          selector: "CallExpression[callee.property.name='refresh']",
          message:
            'Do not refresh() the page — re-navigate through navigate() so the ' +
            'reload is throttled and block-checked like any other request.',
        },
      ],
    },
  },
);
