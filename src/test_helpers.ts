// test_helpers.ts
import { inspect } from "util";

/* ------------------------------------------------------------------ *\
 * Globals
\* ------------------------------------------------------------------ */


export const state: Record<string, any> = {};
export const DIVIDER = "-".repeat(70);

/**
 * Test DSL: queue-based, no await required.
 * Usage in test file:
 *   t("GET /profile", false, 401);
 *   t("PATCH /profile", true, 204, { password: "baz" });
 *   runQueuedTests();
 */
export type QueuedTest = [
  url: string,
  auth: boolean,
  expStatus: number,
  body?: any,
  save?: (res: any, ctx: Record<string, any>) => void | Promise<void>
];
const queuedTests: QueuedTest[] = [];
export const ctx: Record<string, any> = {};

export function t(
  url: string,
  auth: boolean,
  expStatus: number,
  body: any = null,
  save?: (res: any, ctx: Record<string, any>) => void | Promise<void>
) {
  queuedTests.push([url, auth, expStatus, body, save]);
}

function lockEmoji(auth: boolean) {
  return auth ? "🔒" : "🔓";
}

export async function runQueuedTests() {
  for (const [url, auth, expStatus, body = null, save] of queuedTests) {
    const lock = lockEmoji(auth);
    const title = `${lock} ${url} → ${expStatus}`;
    // interpolate $placeholders from ctx
    const path = url.replace(/\$([a-z]\w*)/gi, (_, k) => ctx[k]);
    // Auth header
    const headers = auth && ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {};
    const res = await req(path, { body, headers });
    if (res.status === expStatus) {
      console.log(`PASS  ▸ ${title}`);
      if (save) await save(res, ctx);
      continue;
    }
    const bodyDesc = body != null ? ` | body: ${JSON.stringify(body)}` : "";
    console.error(
      `FAIL  ▸ ${lock} ${url} expected ${expStatus}, got ${res.status}${bodyDesc}`
    );
    process.exit?.(1);
    throw new Error(`Test failed: ${title}`); // fallback for environments w/o process
  }
  process.exit?.(0);
}

/* ------------------------------------------------------------------ *\
 * Types
\* ------------------------------------------------------------------ */

export type ReqResponse = { status: number; body: any };

type PrimitiveCtor = StringConstructor | NumberConstructor | BooleanConstructor;
export type Structure =
    | PrimitiveCtor
    | typeof Array
    | typeof Object
    | { [key: string]: Structure };

/* “type constants” so tests can say TString etc. */
export const TString = String;
export const TNumber = Number;
export const TBoolean = Boolean;
export const TArray = Array;
export const TObject = Object;

/* ------------------------------------------------------------------ */

export class SkipTest extends Error {
    constructor(msg = "Condition not met") {
        super(msg);
        this.name = "SkipTest";
    }
}

/* ------------------------------------------------------------------ *\
 * fetch wrapper
\* ------------------------------------------------------------------ */

export async function req(
    methodPath: string,
    body?: any,
    headers?: Record<string, string>,
    params?: Record<string, string>,
): Promise<ReqResponse> {
    /* parse “GET /foo” */
    const [method = "", path = ""] = methodPath.split(" ", 2);
    if (!method || !path) return { status: 0, body: `Invalid methodPath: ${methodPath}` };

    /* build url */
    // Support ESM: get BASE_URL from globalThis
    const baseUrl = typeof globalThis.BASE_URL !== 'undefined' ? globalThis.BASE_URL : (typeof BASE_URL !== 'undefined' ? BASE_URL : undefined);
    if (typeof baseUrl === 'undefined') {
        throw new Error('BASE_URL is not defined. Please define `const BASE_URL = "...";` at the top of your test file.');
    }
    const url = new URL(path, baseUrl);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));


    /* headers & body */
    const h = new Headers(headers);
    let payload: RequestInit["body"] | null = null;
    if (body != null) {
        if (body instanceof FormData) payload = body;
        else if (typeof body === "object" && !h.has("Content-Type")) {
            h.set("Content-Type", "application/json");
            payload = JSON.stringify(body);
        } else {
            payload = String(body);
        }
    }

    /* tiny one‑liner log */
    console.log(`>>> ${method.toUpperCase()} ${url.pathname}${url.search}`);

    try {
        const res = await fetch(url, { method, headers: h, body: payload, redirect: "follow" });
        const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
        const resBody = isJson ? await res.json() : await res.text();
        console.log(`<<< ${res.status} ${isJson ? inspect(resBody, false, 2, true) : resBody}`);
        return { status: res.status, body: resBody };
    } catch (e: any) {
        console.error(`⚠️  fetch error: ${e.message}`);
        return { status: 0, body: e.message };
    }
}

/* ------------------------------------------------------------------ *\
 * Assertions
\* ------------------------------------------------------------------ */

export function expect(cond: boolean, msg = ""): true {
    if (!cond) throw new Error(`FAIL: ${msg}`);
    console.log(`✅ ${msg}`);
    return true;
}

export function has_structure(data: any, shape: Structure): boolean {
    if (shape === TString) return typeof data === "string";
    if (shape === TNumber) return typeof data === "number";
    if (shape === TBoolean) return typeof data === "boolean";
    if (shape === TArray) return Array.isArray(data);
    if (shape === TObject) return typeof data === "object" && data !== null && !Array.isArray(data);
    if (typeof shape === "object" && shape !== null) {
        return (
            typeof data === "object" &&
            data !== null &&
            !Array.isArray(data) &&
            Object.entries(shape).every(([k, v]) => has_structure(data[k], v))
        );
    }
    return false;
}

export function expect_struct(data: any, shape: Structure): true {
    return expect(has_structure(data, shape), `structure matches ${inspect(shape)}`);
}

// --- Status Code Assertion Helper ---
export function expect_status(res: { status: number }, expected: number) {
    return expect(res.status === expected, `Expected status ${expected}, got ${res.status}`);
}

// --- Field Existence Assertion Helper ---
export function expect_field(obj: any, field: string) {
    return expect(obj && typeof obj === 'object' && field in obj, `Expected field '${field}' in object, got: ${JSON.stringify(obj)}`);
}

// --- Field Value Regex Assertion Helper ---
export function expect_field_match(obj: any, field: string, regex: RegExp) {
    const value = obj && typeof obj === 'object' ? obj[field] : undefined;
    return expect(typeof value === 'string' && regex.test(value), `Expected field '${field}' to match ${regex}, got: ${value}`);
}

/* ------------------------------------------------------------------ *\
 * Minimal test‑runner
\* ------------------------------------------------------------------ */

type TestFn = () => void | Promise<void>;
const tests: { desc: string; fn: TestFn }[] = [];
export const test_results = { passed: 0, failed: 0, skipped: 0 };

export function test(desc: string, fn: TestFn) {
    tests.push({ desc, fn });
}

async function runSingle({ desc, fn }: { desc: string; fn: TestFn }) {
    console.log(`\n${DIVIDER}\n🧪 ${desc}`);
    try {
        await fn();
        console.log("▶️ PASSED");
        test_results.passed++;
        return 'pass';
    } catch (e) {
        if (e instanceof SkipTest) {
            console.warn(`⏭️  SKIPPED: ${e.message}`);
            test_results.skipped++;
            return 'skip';
        } else {
            console.error(`❌ FAILED: ${e instanceof Error ? e.message : e}`);
            test_results.failed++;
            return 'fail';
        }
    }
}

export async function runTests() {
    for (const t of tests) {
        const result = await runSingle(t);
        if (result === 'fail') break;
    }
    printSummary();
}

/* ------------------------------------------------------------------ */

export function log_state(k: string, v: any) {
    state[k] = v;
    console.log(`💾 ${k} = ${inspect(v, false, 1, true)}`);
}

export function printSummary() {
    console.log(
        `\n${DIVIDER}\nPassed: ${test_results.passed} | Failed: ${test_results.failed} | Skipped: ${test_results.skipped} | Total: ${test_results.passed + test_results.failed + test_results.skipped
        }\n${DIVIDER}`,
    );
}
