// @ts-check
import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default [
  { ignores: ['dist/', 'coverage/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
]
