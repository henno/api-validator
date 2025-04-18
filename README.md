# bun-api-tester

A Bun-based TypeScript project for generating and running automated API tests from OpenAPI/Swagger specs.

## Prerequisites
- [Bun](https://bun.sh) v1.2.8 or newer must be installed.

## Installation
Install dependencies with:

```bash
bun install
```

## Usage

Run **all project operations** via the interactive menu:

```bash
bun run index.ts
```

This will present a menu where you can:
- Run the main test suite (`generated_student_test.ts`)
- Generate a new test file (using `generate.ts`)
- List and run any other `test.*.ts` files
- Exit

You no longer need to remember or run different entry points directly. Everything is accessible from the menu.

## Project Structure
- `generated_student_test.ts`: Main test suite (default entry for test runs)
- `generate.ts`: Script to generate new test files for students/APIs
- `test_helpers.ts`: Helper functions and test utilities
- `index.ts`: Minimal entry point (prints a hello message)

## Notes
- This project was created using `bun init` in bun v1.2.8. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
- TypeScript is used; see `tsconfig.json` for configuration.
- Dependencies are managed via Bun (see `package.json`).
