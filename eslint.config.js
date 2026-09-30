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
]
