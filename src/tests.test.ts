import { test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
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

test("packageMatches selects root-importing tests when the public surface changes", async () => {
  const { packageMatches } = await import("./tests");
  const files: Record<string, string> = {
    "pkg/package.json": '{"name":"zod"}', "pkg/src/index.ts": 'export * from "./schemas.js";\n',
    "flask/src/flask/__init__.py": "from .app import Flask\nfrom . import cli\n", "src/flask/x.py": "",
  };
  const has = (f: string) => f in files || f === "src/flask/__init__.py" || f === "src/flask/app.py";
  const read = (f: string) => files[f] ?? (f === "src/flask/__init__.py" ? files["flask/src/flask/__init__.py"] : "");
  const t = (file: string, signature: string) => ({ file, signature });
  const tests = [t("pkg/t/a.test.ts", 'import { z } from "zod"'), t("pkg/t/b.test.ts", 'import { z } from "../src"'), t("pkg/t/c.test.ts", 'import x from "lodash"'),
    t("tests/test_a.py", "import flask"), t("tests/test_b.py", "from flask import Flask"), t("tests/test_c.py", "import os")];
  expect([...packageMatches(["pkg/src/index.ts"], tests, read, has)].sort()).toEqual(["pkg/t/a.test.ts", "pkg/t/b.test.ts"]);
  expect([...packageMatches(["pkg/src/schemas.ts"], tests, read, has)]).toEqual([]);
  expect([...packageMatches(["src/flask/__init__.py"], tests, read, has)].sort()).toEqual(["tests/test_a.py", "tests/test_b.py"]);
  expect([...packageMatches(["src/flask/app.py"], tests, read, has)]).toEqual([]);
});

test("packageMatches resolves relative root imports from the test's own directory", async () => {
  const { packageMatches } = await import("./tests");
  const files = new Set(["packages/a/package.json", "packages/a/src/index.ts", "packages/b/package.json", "packages/b/src/index.ts"]);
  const read = (f: string) => (f.includes("/a/") ? '{"name":"a"}' : '{"name":"b"}');
  const has = (f: string) => files.has(f);
  const t = (file: string, signature: string) => ({ file, signature });
  const tests = [t("packages/a/test/x.test.ts", 'import { x } from "../src"'), t("packages/b/test/y.test.ts", 'import { y } from "../src"'),
    t("packages/a/test/h/d.test.ts", 'import { x } from "../index"'), t("packages/a/test/z.test.ts", 'import { x } from "../src/index.js"')];
  expect([...packageMatches(["packages/a/src/index.ts"], tests, read, has, "")].sort()).toEqual(["packages/a/test/x.test.ts", "packages/a/test/z.test.ts"]);
  // run from packages/a: test paths are cwd-relative, changed path is repo-relative
  const sub = [t("test/x.test.ts", 'import { x } from "../src"')];
  expect([...packageMatches(["packages/a/src/index.ts"], sub, read, has, "packages/a/")]).toEqual(["test/x.test.ts"]);
  expect([...packageMatches(["packages/b/src/index.ts"], sub, read, has, "packages/a/")]).toEqual([]);
});

test("packageMatches: dynamic imports, re-exports, nested __init__.py and Windows test paths", async () => {
  const { packageMatches, signature } = await import("./tests");
  const files = new Set(["pkg/package.json", "pkg/src/index.ts", "src/pkg/__init__.py", "src/pkg/sub/__init__.py"]);
  const has = (f: string) => files.has(f);
  const read = () => '{"name":"zod"}';
  const t = (file: string, text: string) => ({ file, signature: signature(file, text) });
  const tests = [
    t("pkg/t/dyn.test.ts", 'test("x", async () => {\n  const { z } = await import("zod");\n});'),
    t("pkg/t/reexp.test.ts", 'export * from "zod";'),
    t("pkg\\t\\win.test.ts", 'import { z } from "../src";'),
    t("pkg/t/other.test.ts", 'const m = await import("lodash");'),
    t("tests/test_sub.py", "from pkg.sub import thing"),
    t("tests/test_root.py", "import pkg"),
  ];
  expect([...packageMatches(["pkg/src/index.ts"], tests, read, has, "")].sort()).toEqual(["pkg/t/dyn.test.ts", "pkg/t/reexp.test.ts", "pkg\\t\\win.test.ts"]);
  expect([...packageMatches(["src/pkg/sub/__init__.py"], tests, read, has, "")]).toEqual(["tests/test_sub.py"]);
  // importing pkg.sub runs pkg/__init__.py first, so a root change selects both
  expect([...packageMatches(["src/pkg/__init__.py"], tests, read, has, "")].sort()).toEqual(["tests/test_root.py", "tests/test_sub.py"]);
});

test("packageMatches finds the repo root when run from a subdirectory", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const d = mkdtempSync(path.join(os.tmpdir(), "jgrep-f16-"));
  mkdirSync(path.join(d, "packages/a/src"), { recursive: true });
  writeFileSync(path.join(d, "packages/a/package.json"), '{"name":"a"}');
  writeFileSync(path.join(d, "packages/a/src/index.ts"), "");
  execFileSync("git", ["init", "-q"], { cwd: d });
  const script = `import { packageMatches } from ${JSON.stringify(path.resolve(import.meta.dir, "tests.ts"))};
    console.log([...packageMatches(["packages/a/src/index.ts"], [{ file: "test/x.test.ts", signature: 'import "../src"' }])].join());`;
  expect(execFileSync("bun", ["-e", script], { cwd: path.join(d, "packages/a"), encoding: "utf8" }).trim()).toBe("test/x.test.ts");
});

test("python and multi-line JS imports are recognized", async () => {
  const { packageMatches, signature } = await import("./tests");
  const t = (file: string, signature: string) => ({ file, signature });
  const has = (f: string) => f === "src/flask/__init__.py" || f === "src/flask/x.py";
  const tests = [t("a", "from flask.json import x"), t("b", "import os, flask"), t("c", "import os")];
  expect([...packageMatches(["src/flask/__init__.py"], tests, () => "", has, "")].sort()).toEqual(["a", "b"]);
  expect(signature("x.ts", 'import {\n  a,\n} from "zod";\nconst q = 1;')).toContain('} from "zod";');
});
