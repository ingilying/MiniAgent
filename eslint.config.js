// @ts-check
import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default [
  { ignores: ['dist/', 'coverage/'] },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Layer rule: core (`agent`, `session`, `models`, `commands`,
    // `logging`) never imports from `app` or `plugins`. `app` composes
    // everything; `plugins` see core and plugin types only.
    files: [
      'src/agent/**/*.ts',
      'src/session/**/*.ts',
      'src/models/**/*.ts',
      'src/commands/**/*.ts',
      'src/logging/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/app/**', '**/plugins/**'],
              message: 'Core modules must not import from app or plugins. See README Architecture.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/plugins/**/*.ts', 'src/plugins/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/app/**',
                '**/cli.js',
                '../index.js',
                '../../index.js',
                '../../../index.js',
              ],
              message: 'Plugins must not import from app, cli, or index. See README Architecture.',
            },
          ],
        },
      ],
    },
  },
]
