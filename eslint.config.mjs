import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';

const nodeGlobals = {
  Buffer: 'readonly',
  console: 'readonly',
  process: 'readonly'
};

const browserGlobals = {
  AbortController: 'readonly',
  Blob: 'readonly',
  CSSStyleSheet: 'readonly',
  EventSource: 'readonly',
  HTMLButtonElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLSelectElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  HTMLElement: 'readonly',
  KeyboardEvent: 'readonly',
  Response: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  confirm: 'readonly',
  console: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  navigator: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  window: 'readonly'
};

const localPlugin = {
  rules: {
    'import-extensions': {
      meta: {
        type: 'problem',
        messages: {
          missingExtension: 'Relative imports must include a file extension.'
        }
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const source = node.source.value;
            if (
              typeof source === 'string' &&
              source.startsWith('.') &&
              !/\.[\w-]+$/.test(source)
            ) {
              context.report({ node: node.source, messageId: 'missingExtension' });
            }
          }
        };
      }
    }
  }
};

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/dist/**',
      'build/**',
      '**/build/**',
      'coverage/**',
      '**/coverage/**',
      '**/*.min.js',
      'specs/new-layouts/**/wireframes/*.jsx',
      'specs/new-layouts/**/project/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,cjs,mjs,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals
    },
    plugins: {
      local: localPlugin
    },
    rules: {
      'local/import-extensions': 'error',
      'no-useless-assignment': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '*.ts',
            '*.tsx'
          ]
        }
      ]
    }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs'
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off'
    }
  },
  {
    files: [
      'frontend/src/**/*.{js,jsx,ts,tsx}',
      'frontend/tests/**/*.{js,jsx,ts,tsx}'
    ],
    languageOptions: {
      globals: browserGlobals
    }
  }
];
