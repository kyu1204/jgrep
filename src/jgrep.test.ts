import { test, expect } from "bun:test";
import { chunk, diffChunks, buildRequest, jgrep } from "./jgrep";
process.env.JGREP_NO_MAIN = "1";
const { parse } = await import("./cli");

const src = `import a from "a";
import b from "b";

export function one() {
  try { save() } catch (e) {}
}

export function two() {
  try { save() } catch (e) { log(e); throw e }
}
`;

test("chunk splits at column-0 boundaries after minLines", () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 });
  expect(cs.map((c) => `${c.start}-${c.end}`)).toEqual(["1-3", "4-7", "8-11"]);
  expect(cs[1].text).toContain("function one");
});

test("chunk enforces maxLines", () => {
  const cs = chunk("f.txt", Array.from({ length: 130 }, (_, i) => `  line ${i}`).join("\n"), { minLines: 5, maxLines: 60 });
  expect(cs.map((c) => c.end - c.start + 1)).toEqual([60, 60, 10]);
});

test("diffChunks parses hunks with file and new-side line range", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ export function f() {
   const x = 1;
+  const y = 2;
   return x;
 }
@@ -30 +31,2 @@
-old
+new
+newer
diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-bye
`;
  const cs = diffChunks(diff);
  expect(cs.map((c) => [c.file, c.start, c.end])).toEqual([["src/a.ts", 10, 13], ["src/a.ts", 31, 32]]);
  expect(cs[0].text).toContain("+  const y = 2;");
  expect(buildRequest("q", cs, "diff").state.chunks[0]).toHaveProperty("diff");
});

test("jgrep batches, routes answers by id, uses cache", async () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 });
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    const answers: any = {};
    for (const c of req.state.chunks) answers[c.id] = { type: "noul", noul: c.code.includes("catch (e) {}") ? 0.95 : 0.05 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), { status: 200 });
  }) as any;
  const cache: Record<string, number> = {};
  const q = "swallows errors";
  const r = await jgrep(q, cs, { threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", fetchImpl, cache });
  expect(calls.length).toBe(2); // 3 chunks, batch 2
  expect(r.hits.map((h) => h.start)).toEqual([4]);
  expect(r.tokens).toBe(200);

  const r2 = await jgrep(q, cs, { threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", fetchImpl, cache });
  expect(calls.length).toBe(2); // all cached, no new requests
  expect(r2.cached).toBe(3);
});

test("cli parse: --diff with and without ref, flags anywhere", () => {
  expect(parse(["--diff", "q"])).toMatchObject({ diff: [], question: "q" });
  expect(parse(["--diff", "origin/main", "q"])).toMatchObject({ diff: ["origin/main"], question: "q" });
  expect(parse(["q", "--diff", "origin/main"])).toMatchObject({ diff: ["origin/main"], question: "q" });
  expect(parse(["--diff", "--staged", "q"])).toMatchObject({ diff: ["--staged"], question: "q" });
  expect(parse(["-t", "0.9", "-C", "q", "src/", "lib/"])).toMatchObject({ threshold: 0.9, show: true, question: "q", paths: ["src/", "lib/"] });
});

test("cli parse: unknown option errors instead of becoming the question", () => {
  expect(() => parse(["-x", "q"])).toThrow(/unknown option -x/);
});

test("installSkills copies SKILL.md only into agent homes that exist", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { installSkills } = await import("./jgrep");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-"));
  fs.mkdirSync(path.join(home, ".claude"));
  const src = path.join(home, "SKILL.md");
  fs.writeFileSync(src, "---\nname: jgrep\n---\n");
  const dirs = installSkills(src, home, ["claude", "codex"]);
  expect(dirs).toEqual([path.join(home, ".claude", "skills", "jgrep")]);
  expect(fs.readFileSync(path.join(dirs[0], "SKILL.md"), "utf8")).toContain("name: jgrep");
});

test("rows: csv parser handles quotes, commas and newlines inside quotes", async () => {
  const { parseCsv } = await import("./rows");
  const r = parseCsv('handle,bio\n@a,"skincare, daily ""GRWM""\nSeoul"\n@b,makeup\n');
  expect(r.columns).toEqual(["handle", "bio"]);
  expect(r.rows).toEqual([{ handle: "@a", bio: 'skincare, daily "GRWM"\nSeoul' }, { handle: "@b", bio: "makeup" }]);
});

test("rows: request keys, batching cap, cache and flatten", async () => {
  const { buildRowsRequest, scoreRows, flatten, MAX_QUESTIONS_PER_REQUEST } = await import("./rows");
  const rows = Array.from({ length: 40 }, (_, i) => ({ handle: `@u${i}`, bio: i % 2 ? "skincare" : "cars" }));
  const questions = {
    beauty: { type: "noul" as const, instructions: "beauty content?" },
    cat: { type: "choice" as const, instructions: "category?", criteria: { skincare: "skin", other: "else" } },
    fit: { type: "score" as const, instructions: "fit?", criteria: ["none", "some", "great"] },
  };
  const req = buildRowsRequest(rows.slice(0, 2), questions);
  expect(Object.keys(req.questions)).toEqual(["r0.beauty", "r0.cat", "r0.fit", "r1.beauty", "r1.cat", "r1.fit"]);
  expect((req.questions["r1.cat"] as any).criteria).toEqual({ skincare: "skin", other: "else" });
  const calls: any[] = [];
  const fetchImpl = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body); calls.push(body);
    const answers: any = {};
    body.state.rows.forEach((r: any) => {
      const s = r.bio === "skincare";
      answers[`${r.id}.beauty`] = { type: "noul", noul: s ? 0.9 : 0.1 };
      answers[`${r.id}.cat`] = { type: "choice", choice: s ? "skincare" : "other", confidence: 0.8, probabilities: { skincare: s ? 0.85 : 0.1, other: s ? 0.15 : 0.9 } };
      answers[`${r.id}.fit`] = { type: "score", score: s ? 1.7 : 0.2, confidence: 0.6, probabilities: {} };
    });
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as any;
  const cache = {};
  const r = await scoreRows(rows, questions, { batch: 16, concurrency: 4, apiKey: "k", fetchImpl, cache });
  const per = Math.min(16, Math.floor(MAX_QUESTIONS_PER_REQUEST / 3)); // batch cap wins: 16 rows per request
  expect(calls.every((c) => Object.keys(c.questions).length <= MAX_QUESTIONS_PER_REQUEST)).toBe(true);
  expect(r.requests).toBe(Math.ceil(40 / per));
  expect(flatten(r.answers[1])).toEqual({ beauty: 0.9, cat: "skincare", cat_p: 0.85, fit: 1.7, fit_conf: 0.6 });
  const r2 = await scoreRows(rows, questions, { batch: 16, concurrency: 4, apiKey: "k", fetchImpl, cache });
  expect(r2.requests).toBe(0);
  expect(r2.cached).toBe(40);
});

test("costOf prefers provider-reported cost and falls back to list price", async () => {
  const { costOf } = await import("./jgrep");
  expect(costOf({ input_tokens: 274, cost: 0.00002 })).toBe(0.00002);
  expect(costOf({ input_tokens: 1_000_000 })).toBeCloseTo(0.042, 10);
  expect(costOf(undefined)).toBe(0);
});
