import { test, expect } from "bun:test";
import { findTestFiles, signature, directMatches, changedFilesOf, compactDiff, selectTests } from "./tests";

test("findTestFiles matches common layouts across stacks", () => {
  const files = ["src/a.ts", "src/a.test.ts", "src/b.spec.tsx", "tests/unit/c.ts", "pkg/d_test.go", "app/test_e.py", "spec/f_spec.rb", "src/G.java", "src/GTest.java", "types/h.tst.ts", "types/i.test-d.ts", "README.md"];
  expect(findTestFiles(files)).toEqual(["src/a.test.ts", "src/b.spec.tsx", "tests/unit/c.ts", "pkg/d_test.go", "app/test_e.py", "spec/f_spec.rb", "src/GTest.java", "types/h.tst.ts", "types/i.test-d.ts"]);
});

test("signature keeps imports and test names only", () => {
  const sig = signature("x.test.ts", `import { chunk } from "./jgrep";\nconst x = 1;\ndescribe("chunk", () => {\n  it("splits", () => { expect(1).toBe(1); });\n});\n`);
  expect(sig.split("\n")).toEqual(['import { chunk } from "./jgrep";', 'describe("chunk", () => {', 'it("splits", () => { expect(1).toBe(1); });']);
});

test("directMatches pairs changed sources with same-stem tests and includes changed tests", () => {
  const changed = ["src/rows.ts", "src/cli.test.ts", "lib/parser.py"];
  const tests = ["src/rows.test.ts", "src/cli.test.ts", "src/init.test.ts", "tests/test_parser.py", "tests/test_other.py"];
  expect([...directMatches(changed, tests)].sort()).toEqual(["src/cli.test.ts", "src/rows.test.ts", "tests/test_parser.py"]);
});

test("compactDiff lists changed files, keeps changed lines only, drops lockfiles/docs, caps per file", () => {
  const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n ctx2\n+++ b/package-lock.json\n+" + "j".repeat(5000) + "\n+++ b/README.md\n+docs\n";
  const c = compactDiff(diff);
  expect(c.startsWith("changed files:\n  x.ts\n")).toBe(true);
  expect(c).toContain("+++ x.ts\n@@ -1,3 +1,3 @@\n-old\n+new");
  expect(c).not.toContain("package-lock"); expect(c).not.toContain("README");
  const big = "+++ b/a.ts\n+" + "a".repeat(5000) + "\n+++ b/b.ts\n+bbb\n";
  const cb = compactDiff(big, 3000);
  expect(cb).toContain("(truncated)"); expect(cb).toContain("+++ b.ts\n+bbb"); // b survives a's size
  expect(changedFilesOf(diff)).toEqual(["x.ts", "package-lock.json", "README.md"]);
});

test("importMatches selects tests importing a changed module without asking Jev", async () => {
  const { importMatches } = await import("./tests");
  const tests = [
    { file: "tests/unit/a.test.ts", signature: 'import { x } from "../../src/catalog/blocks/index";' },
    { file: "tests/unit/b.test.ts", signature: 'import { y } from "../../src/other";' },
    { file: "tests/unit/c.test.ts", signature: 'import fs from "node:fs";' },
  ];
  expect([...importMatches(["src/catalog/blocks/index.ts", "package-lock.json"], tests)]).toEqual(["tests/unit/a.test.ts"]);
});

test("selectTests: direct matches skip Jev, others are judged and cached", async () => {
  const diff = "diff --git a/src/rows.ts b/src/rows.ts\n--- a/src/rows.ts\n+++ b/src/rows.ts\n@@ -1 +1 @@\n-export function parseCsv(a) {}\n+export function parseCsv(a, b) {}\n";
  const tests = [
    { file: "src/rows.test.ts", signature: 'import { parseCsv } from "./rows";' },
    { file: "src/init.test.ts", signature: 'import { installSkills } from "./jgrep";' },
    { file: "src/cli.test.ts", signature: 'import { parse } from "./cli";\nit("rows --json uses parseCsv", () => {})' },
  ];
  const calls: any[] = [];
  const fetchImpl = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body); calls.push(body);
    const answers: any = {};
    for (const t of body.state.tests) answers[t.id] = { type: "noul", noul: /parseCsv|rows/.test(t.signature) ? 0.9 : 0.05 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), { status: 200 });
  }) as any;
  const cache = {};
  const r = await selectTests(diff, tests, { threshold: 0.5, batch: 16, concurrency: 2, apiKey: "k", fetchImpl, cache });
  expect(calls).toHaveLength(1);
  expect(calls[0].state.tests.map((t: any) => t.file)).toEqual(["src/init.test.ts", "src/cli.test.ts"]); // rows.test.ts was direct
  expect(calls[0].state.diff).toContain("+export function parseCsv(a, b)");
  expect(r.selected.map((s) => [s.file, s.reason])).toEqual([["src/rows.test.ts", "direct"], ["src/cli.test.ts", "jev"]]);
  const r2 = await selectTests(diff, tests, { threshold: 0.5, batch: 16, concurrency: 2, apiKey: "k", fetchImpl, cache });
  expect(calls).toHaveLength(1); expect(r2.cached).toBe(2);
});

test("directMatches treats type-test suffixes (.tst.ts, .test-d.ts) like .test.ts", () => {
  const tests = ["types/fastify.tst.ts", "types/router.test-d.ts", "src/other.test.ts"];
  expect([...directMatches(["src/fastify.ts", "lib/router.ts"], tests)].sort()).toEqual(["types/fastify.tst.ts", "types/router.test-d.ts"]);
});

test("directMatches accepts an underscore separator before the test suffix (foo_test.ts, foo_tst.ts)", () => {
  const tests = ["src/foo_test.ts", "types/bar_tst.ts", "types/baz_test-d.ts", "src/other_test.ts"];
  expect([...directMatches(["src/foo.ts", "src/bar.ts", "src/baz.ts"], tests)].sort()).toEqual(["src/foo_test.ts", "types/bar_tst.ts", "types/baz_test-d.ts"]);
});
