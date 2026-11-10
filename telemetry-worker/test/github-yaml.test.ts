// The reader for a repository's .github/genclass.yml (src/github/yaml.ts): a strict subset of YAML. Every rule of the
// subset and every refusal with its line number, the limits, a realistic settings file, random input (only a value or
// a YamlError ever comes back; what a small writer emits reads back as the same value) and 200 KB of hostile input,
// answered quickly.
import { describe, expect, it } from "vitest";
import { DEFAULT_YAML_LIMITS, parseYaml, YamlError, type YamlLimits, type YamlValue } from "../src/github/yaml.js";

type Limits = { [K in keyof YamlLimits]?: YamlLimits[K] | undefined };

/** A text as a failing assertion names it. */
const shown = (text: unknown): string =>
  typeof text === "string" ? JSON.stringify(text.length > 300 ? `${text.slice(0, 300)}...` : text) : String(text);

/** The YamlError a text is refused with (the test fails when it parses or throws anything else). */
function refusal(text: string, limits?: Limits): YamlError {
  try {
    parseYaml(text, limits);
  } catch (e) {
    expect(e, shown(text)).toBeInstanceOf(YamlError);
    return e as YamlError;
  }
  throw new Error(`should be refused, but parsed: ${shown(text)}`);
}

/** The text is refused on `line` (0: not on one line) with a message that holds `part` after its "line N: ". */
function refused(text: string, line: number, part: string, limits?: Limits): void {
  const e = refusal(text, limits);
  expect(e.message, shown(text)).toContain(part);
  expect(e.line, shown(text)).toBe(line);
  if (line > 0) expect(e.message.startsWith(`line ${line}: `), shown(text)).toBe(true);
  else expect(e.message, shown(text)).not.toMatch(/^line \d/);
}

const REALISTIC = `# .github/genclass.yml
reviews:
  auto: true
  drafts: false
  branches: [main, "release/*"]
  ignore_authors:
    - dependabot[bot]
    - renovate[bot]
comment: findings        # findings | always | never
check:
  enabled: true
  fail_on: reproducible
inline: true
min_seeds: 2
artifact: genclass-races
paths:
  ignore:
    - "docs/**"
    - '**/*.md'
commands:
  allow: write
issues:
  create: never
project: null
`;

describe("yaml: one document", () => {
  it("an empty, blank or comment-only file is null", () => {
    const nothing = ["", "\n", "   \n\n", "# only a comment", "# a\n\n  # b\n", "\t\n", " \t \n", "---", "---\n# nothing\n", "\uFEFF", "\uFEFF# c\n"];
    for (const text of nothing) expect(parseYaml(text), JSON.stringify(text)).toBeNull();
  });

  it("LF or CRLF line endings and an optional byte-order mark", () => {
    expect(parseYaml("a: 1\nb:\n  - x\n  - y\n")).toEqual({ a: 1, b: ["x", "y"] });
    expect(parseYaml("a: 1\r\nb:\r\n  - x\r\n  - y\r\n")).toEqual({ a: 1, b: ["x", "y"] });
    expect(parseYaml("a: 1\r\n\r\nb: 'two'")).toEqual({ a: 1, b: "two" });
    expect(parseYaml("a: 1\r\nb: two\r")).toEqual({ a: 1, b: "two" }); // a last line cut off after its CR
    expect(parseYaml("\uFEFFa: 1\n")).toEqual({ a: 1 });
    expect(parseYaml("\uFEFF---\r\na: 1\r\n")).toEqual({ a: 1 });
    // a carriage return anywhere else is not a line ending here
    refused("a: 1\rb: 2\n", 1, "a carriage return must be followed by a line feed");
    // lines are numbered by their line feeds, blank and comment lines included
    refused("a: 1\r\n\r\n# c\r\n\tb: 2\r\n", 4, "tabs are not allowed for indentation");
  });

  it("one leading --- line, also after comments and with a comment of its own", () => {
    expect(parseYaml("---\na: 1\n")).toEqual({ a: 1 });
    expect(parseYaml("# settings\n\n--- # start\na: 1\n")).toEqual({ a: 1 });
    expect(parseYaml("---   \n- x")).toEqual(["x"]);
    refused("--- a: 1\n", 1, "content on the --- line is not supported");
    refused('--- "text"\n', 1, "content on the --- line is not supported");
  });

  it("a second --- or a ... line is refused: multiple documents", () => {
    refused("a: 1\n---\nb: 2\n", 2, "multiple documents are not supported");
    refused("---\n---\na: 1\n", 2, "multiple documents are not supported");
    refused("---\na: 1\n--- # two\nb: 2\n", 3, "multiple documents are not supported");
    refused("---\na: 1\n...\n", 3, "multiple documents are not supported");
    refused("a:\n  b: 1\n... \n", 3, "multiple documents are not supported");
    refused("...\n", 1, "multiple documents are not supported");
    expect(refusal("a: 1\n---\n").message).toBe("line 2: multiple documents are not supported");
    // only a whole line in column 0 is a marker
    expect(parseYaml("---x")).toBe("---x");
    expect(parseYaml(" ---")).toBe("---");
    expect(parseYaml("a: ---\nb: ...\n...: c\n---: d\n")).toEqual({ a: "---", b: "...", "...": "c", "---": "d" });
    expect(parseYaml("- ---\n- ...\n")).toEqual(["---", "..."]);
  });

  it("directives are refused", () => {
    refused("%YAML 1.2\n---\na: 1\n", 1, "directives (%YAML, %TAG) are not supported");
    refused("%TAG !e! tag:example.com,2000:\n---\n", 1, "directives (%YAML, %TAG) are not supported");
    refused("a: 1\n%YAML 1.2\n", 2, "directives (%YAML, %TAG) are not supported");
  });

  it("the document may be a single scalar or flow collection, and then nothing follows it", () => {
    expect(parseYaml("42")).toBe(42);
    expect(parseYaml("hello world # c\n")).toBe("hello world");
    expect(parseYaml('"x: y"')).toBe("x: y");
    expect(parseYaml("'- x'")).toBe("- x");
    expect(parseYaml("true\n")).toBe(true);
    expect(parseYaml("~")).toBeNull();
    expect(parseYaml("[a, 1]\n")).toEqual(["a", 1]);
    expect(parseYaml("{}\n")).toEqual({});
    refused("hello\nworld\n", 2, "multi-line plain scalars are not supported");
    refused("hello\na: 1\n", 2, "unexpected content after the top-level value");
    refused("[a]\n- b\n", 2, "unexpected content after the top-level value");
    refused('"a"\nb\n', 2, "unexpected content after the top-level value");
  });

  it("control characters and unpaired surrogates are refused; other Unicode is text", () => {
    refused("a: 1\nb: \u0000\n", 2, "control characters are not allowed (U+0000)");
    refused("a: \u001b[31m\n", 1, "control characters are not allowed (U+001B)");
    refused("a: 1\n# c \u007f\n", 2, "control characters are not allowed (U+007F)");
    refused("a: \u0085\n", 1, "control characters are not allowed (U+0085)");
    refused("a: \u000c\n", 1, "control characters are not allowed (U+000C)");
    refused("a: \ud800\n", 1, "the text is not valid Unicode");
    refused("a: 1\nb: \udc00x\n", 2, "the text is not valid Unicode");
    expect(parseYaml('a: \ud83d\ude00\nb: "\ud83d\ude00 \u00e9"\n"\u00e9": z\n')).toEqual({ a: "\u{1F600}", b: "\u{1F600} \u00e9", "\u00e9": "z" });
    expect(parseYaml("a: \u00a0x\u2028y\u3000\n")).toEqual({ a: "\u00a0x\u2028y\u3000" }); // only space and tab are white space
  });
});

describe("yaml: comments and blank lines", () => {
  it("# starts a comment at the start of a line or after white space, not inside quotes or a word", () => {
    const text = [
      "# top",
      "a: 1 # one",
      "",
      "      # indented more than anything",
      "b: x#y",
      'c: "x # y" # z',
      "d: 'p # q'",
      "e: # nothing",
      "f:\t# after a tab",
      "\t# a comment after a tab is not indentation",
      "g: 1 #",
      "h: http://example.com/#top",
      "",
    ].join("\n");
    expect(parseYaml(text)).toEqual({ a: 1, b: "x#y", c: "x # y", d: "p # q", e: null, f: null, g: 1, h: "http://example.com/#top" });
    expect(parseYaml("- a # c\n- # c\n\n- [x, y] # c\n  # c\n- {} # c\n")).toEqual(["a", null, ["x", "y"], {}]);
    expect(parseYaml("a:\n\n  # between a key and its block\n\n  b: 1\n\n# back\n\n  c: 2\n")).toEqual({ a: { b: 1, c: 2 } });
    refused('a: "x"#y\n', 1, "unexpected text after a quoted scalar");
  });
});

describe("yaml: block mappings", () => {
  it("nest by indentation; a key with no value takes the nested block, or null when nothing is nested", () => {
    expect(parseYaml("a:\n  b:\n    c: 1\n    d:\n  e: two\nf:\ng: 3\n")).toEqual({ a: { b: { c: 1, d: null }, e: "two" }, f: null, g: 3 });
    // every block picks its own indentation, and the document's block may be indented too
    expect(parseYaml("a:\n      b: 1\nc:\n d: 2\n")).toEqual({ a: { b: 1 }, c: { d: 2 } });
    expect(parseYaml("  a: 1\n  b:\n    c: 2\n")).toEqual({ a: 1, b: { c: 2 } });
    expect(parseYaml("a:")).toEqual({ a: null });
    expect(parseYaml("a:   \nb: # c\n")).toEqual({ a: null, b: null });
  });

  it("keys: plain [A-Za-z0-9_.-]+ or quoted, always strings; white space may stand before the colon", () => {
    expect(parseYaml('a_b.c-d9: 1\n"with space": 2\n\'it\'\'s\': 3\n"": 4\nspaced : 5\n-x: 6\n"esc\\tkey": 7\n-: 8\n"a: b" : 9\n')).toEqual({
      "a_b.c-d9": 1,
      "with space": 2,
      "it's": 3,
      "": 4,
      spaced: 5,
      "-x": 6,
      "esc\tkey": 7,
      "-": 8,
      "a: b": 9,
    });
    const typedLooking = parseYaml("1: a\ntrue: b\nnull: c\n1.5: d\n") as { [key: string]: YamlValue };
    expect(typedLooking).toEqual({ "1": "a", true: "b", null: "c", "1.5": "d" });
    expect(Object.keys(typedLooking).sort()).toEqual(["1", "1.5", "null", "true"]);
  });

  it("a key outside the plain characters must be quoted; an entry needs a key", () => {
    refused("my key: 1\n", 1, "must be quoted");
    refused("a/b: 1\n", 1, "must be quoted");
    refused("\u043a\u043b\u044e\u0447: 1\n", 1, "must be quoted");
    refused("a: 1\nb c: 2\n", 2, 'a key with characters other than letters, digits, "_", "." and "-" must be quoted');
    refused("- ok: 1\n- not ok: 2\n", 2, "must be quoted");
    refused(": 1\n", 1, "a key is missing before the colon");
    refused("a:\n  : 1\n", 2, "a key is missing before the colon");
    refused("- : 1\n", 1, "a key is missing before the colon");
    refused("[a, b]: 1\n", 1, "unexpected text after a flow sequence");
    refused("a: 1\n[b]: 2\n", 2, 'expected "key: value" here');
  });

  it("a line in a mapping must be key: value, with a space after the colon", () => {
    refused("a: 1\nb\n", 2, 'expected "key: value" here; a space must follow the colon');
    refused("a: 1\nb:2\n", 2, 'expected "key: value" here; a space must follow the colon');
    refused('a: 1\n"b"\n', 2, 'expected "key: value" here');
    expect(parseYaml("b:2")).toBe("b:2"); // on its own it is a plain scalar, as in YAML
  });

  it("a nested mapping or sequence cannot start on its key's line", () => {
    refused("a: b: c\n", 1, 'a plain scalar cannot contain ": " or end with ":"; quote it');
    refused("a: b:\n", 1, 'a plain scalar cannot contain ": " or end with ":"');
    refused("a: 1\nb: c: d # e\n", 2, 'a plain scalar cannot contain ": "');
    refused("a: - b\n", 1, "a sequence cannot start on the same line as its key");
    refused("a: -\n", 1, "a sequence cannot start on the same line as its key");
    expect(parseYaml('a: "b: c"\nd: e:f\n')).toEqual({ a: "b: c", d: "e:f" });
  });

  it("duplicate keys in one mapping are refused", () => {
    refused("a: 1\nb: 2\na: 3\n", 3, 'duplicate key "a"');
    refused('a: 1\n"a": 2\n', 2, 'duplicate key "a"');
    refused("x:\n  k: 1\n  k: 2\n", 3, 'duplicate key "k"');
    refused("- k: 1\n  k: 2\n", 2, 'duplicate key "k"');
    refused("a:\na:\n", 2, 'duplicate key "a"');
    refused("toString: 1\ntoString: 2\n", 2, 'duplicate key "toString"');
    expect(refusal("a: 1\na: 2\n").message).toBe('line 2: duplicate key "a"');
    // the same key in two mappings is not a duplicate
    expect(parseYaml("a:\n  k: 1\nb:\n  k: 2\n")).toEqual({ a: { k: 1 }, b: { k: 2 } });
    expect(parseYaml("- k: 1\n- k: 2\n")).toEqual([{ k: 1 }, { k: 2 }]);
  });

  it("__proto__, constructor and prototype are refused as keys; the result is plain objects with own properties", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      refused(`${key}: 1\n`, 1, `the key "${key}" is not allowed`);
      refused(`a:\n  "${key}": {}\n`, 2, `the key "${key}" is not allowed`);
      refused(`- '${key}':\n`, 1, `the key "${key}" is not allowed`);
      refused(`a: 1\n${key} :\n  x: 1\n`, 2, `the key "${key}" is not allowed`);
    }
    refused(String.raw`"\u005f_proto__": 1`, 1, 'the key "__proto__" is not allowed');

    const v = parseYaml("toString: 1\nhasOwnProperty: 2\nvalueOf:\n  __proto: 3\n_proto_: [4]\n") as { [key: string]: YamlValue };
    expect(Object.keys(v)).toEqual(["toString", "hasOwnProperty", "valueOf", "_proto_"]);
    expect(v.toString).toBe(1);
    expect(v.valueOf).toEqual({ __proto: 3 });
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(v.valueOf)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(v._proto_)).toBe(Array.prototype);
  });

  it("a tab in indentation is refused; elsewhere a tab is white space", () => {
    expect(refusal("a:\n\tb: 1\n").message).toBe("line 2: tabs are not allowed for indentation");
    const twelve = `${Array.from({ length: 10 }, (_, i) => `k${i}: ${i}`).join("\n")}\nlast:\n\tx: 1\n`;
    const e = refusal(twelve);
    expect(e.message).toBe("line 12: tabs are not allowed for indentation");
    expect(e.line).toBe(12);
    refused("\ta: 1\n", 1, "tabs are not allowed for indentation");
    refused("a:\n  \tb: 1\n", 2, "tabs are not allowed for indentation");
    refused("a:\n  b: 1\n \t c: 2\n", 3, "tabs are not allowed for indentation");
    // after a dash, the gap before a mapping that starts on the dash line is that mapping's indentation
    refused("- a\n-\tk: v\n", 2, "tabs are not allowed for indentation");
    refused("- \tk: v\n", 1, "tabs are not allowed for indentation");
    refused('-  \t "k": v\n', 1, "tabs are not allowed for indentation");
    expect(parseYaml("a:\t1\nb: x\ty\t\nc: 2\t# c\n \t\nd\t:\t[p,\tq]\t\n")).toEqual({ a: 1, b: "x\ty", c: 2, d: ["p", "q"] });
    expect(parseYaml("-\titem\n-\t\n")).toEqual(["item", null]);
  });
});

describe("yaml: block sequences", () => {
  it("items: scalars, flow sequences, {}, a nested block on the following lines, or null for a bare dash", () => {
    expect(parseYaml('- a\n- "b c"\n- 3\n- true\n- [x, 1]\n- {}\n-\n- ~\n')).toEqual(["a", "b c", 3, true, ["x", 1], {}, null, null]);
    expect(parseYaml("-\n  - a\n  - b\n-\n  k: v\n- c\n")).toEqual([["a", "b"], { k: "v" }, "c"]);
    expect(parseYaml("-\n     - a\n-\n - b\n")).toEqual([["a"], ["b"]]);
    expect(parseYaml("  - a\n  - b\n")).toEqual(["a", "b"]);
    expect(parseYaml("-")).toEqual([null]);
  });

  it("an item may be a mapping that starts on the dash line, with its next keys aligned with the first", () => {
    expect(parseYaml("- name: a\n  kind: b\n- name: c\n  nested:\n    deep: 1\n  list:\n  - x\n  - y\n  last: z\n")).toEqual([
      { name: "a", kind: "b" },
      { name: "c", nested: { deep: 1 }, list: ["x", "y"], last: "z" },
    ]);
    expect(parseYaml("-   wide: 1\n    more: 2\n")).toEqual([{ wide: 1, more: 2 }]);
    expect(parseYaml('- "q k": [1]\n  \'r\':\n')).toEqual([{ "q k": [1], r: null }]);
    expect(parseYaml("- a:\n    - b\n- c:\n")).toEqual([{ a: ["b"] }, { c: null }]);
    expect(parseYaml("k:\n  - a: 1\n    b: 2\n  - a: 3\n")).toEqual({ k: [{ a: 1, b: 2 }, { a: 3 }] });
    expect(parseYaml("-\n  - k: 1\n    m: 2\n  - n\n")).toEqual([[{ k: 1, m: 2 }, "n"]]);
  });

  it("a sequence that starts on a dash line is refused: its items go on the following lines", () => {
    refused("- - a\n  - b\n", 1, 'a sequence cannot start on a dash line ("- - item"); put its items on the following lines');
    refused("- a\n- - - c\n", 2, "a sequence cannot start on a dash line");
    refused("k:\n  - - k: 1\n", 2, "a sequence cannot start on a dash line");
    refused("- -\n", 1, "a sequence cannot start on a dash line");
    refused("-   - # c\n", 1, "a sequence cannot start on a dash line");
    expect(parseYaml("-\n  - a\n  - b\n-\n  -\n    - c\n")).toEqual([["a", "b"], [["c"]]]);
  });

  it("a key's sequence may be indented under the key or start in the key's own column", () => {
    const expected = { list: ["a", "b"], next: 1 };
    expect(parseYaml("list:\n  - a\n  - b\nnext: 1\n")).toEqual(expected);
    expect(parseYaml("list:\n- a\n- b\nnext: 1\n")).toEqual(expected);
    expect(parseYaml("list:\n- a\n- b\n")).toEqual({ list: ["a", "b"] });
    expect(parseYaml("a:\n  b:\n  - x\n  c: 1\n")).toEqual({ a: { b: ["x"], c: 1 } });
    expect(parseYaml("a:\n- b:\n  - c\n- d\ne: 2\n")).toEqual({ a: [{ b: ["c"] }, "d"], e: 2 });
    expect(parseYaml("k:\n-\n  x: 1\n- y\n-\nz:\n")).toEqual({ k: [{ x: 1 }, "y", null], z: null });
    expect(parseYaml("  a:\n  - x\n  b: 1\n")).toEqual({ a: ["x"], b: 1 });
    // a dash in a key's column belongs to the key above only while that key has no value
    expect(parseYaml("- a:\n- b\n")).toEqual([{ a: null }, "b"]);
    refused("a: 1\n- b\n", 2, 'expected "key: value" here, not a "- " sequence item');
    refused("k:\n  - a\n- b\n", 3, 'expected "key: value" here, not a "- " sequence item');
    refused("a:\n  b: 1\n- c\n", 3, 'expected "key: value" here, not a "- " sequence item');
  });

  it("a dash needs a space after it to be an item; a sequence is not mixed with other entries", () => {
    expect(parseYaml("a: -1\nb: -x\nc: --flag\n")).toEqual({ a: -1, b: "-x", c: "--flag" });
    expect(parseYaml("-1")).toBe(-1);
    expect(parseYaml("- -1\n- -x\n")).toEqual([-1, "-x"]);
    refused("- a\n-b\n", 2, 'expected a "- " sequence item here');
    refused("- a\nb: 1\n", 2, 'expected a "- " sequence item here');
    refused("- a\nb\n", 2, 'expected a "- " sequence item here');
    refused("k:\n  - a\n  b: 1\n", 3, 'expected a "- " sequence item here');
  });

  it("a scalar or flow sequence on a line of its own under its key or dash is refused", () => {
    refused("k:\n  value\n", 2, "a scalar or flow sequence must be on the same line as its key or dash");
    refused("k:\n  [a, b]\n", 2, "a scalar or flow sequence must be on the same line as its key or dash");
    refused('a: 1\nk:\n  "v"\n', 3, "a scalar or flow sequence must be on the same line as its key or dash");
    refused("-\n  value\n", 2, "a scalar or flow sequence must be on the same line as its key or dash");
  });
});

describe("yaml: flow sequences and {}", () => {
  it("scalars on one line between brackets, [] for none, and a comma may end the list", () => {
    expect(parseYaml('a: [a, "b c", 3, true]\n')).toEqual({ a: ["a", "b c", 3, true] });
    expect(parseYaml("a: []\nb: [ ]\nc: [x]\nd: [x,y]\ne: [ x , y , ]\nf: [1.5, -2, null, ~, False, 'it''s', \"q\\\"\"] # c\n")).toEqual({
      a: [],
      b: [],
      c: ["x"],
      d: ["x", "y"],
      e: ["x", "y"],
      f: [1.5, -2, null, null, false, "it's", 'q"'],
    });
    expect(parseYaml("- [\"a, b\", 'c]', \"[d\", e f, http://x/y, a:b, k#v, -1, -x, ?q, :r]\n")).toEqual([
      ["a, b", "c]", "[d", "e f", "http://x/y", "a:b", "k#v", -1, "-x", "?q", ":r"],
    ]);
    expect(parseYaml('["1", \'true\', "null", ""]')).toEqual(["1", "true", "null", ""]);
  });

  it("{} is the empty mapping, and the only flow mapping", () => {
    expect(parseYaml("a: {}\nb: { }\nc:\n  - {}\n")).toEqual({ a: {}, b: {}, c: [{}] });
    refused("a: {b: 1}\n", 1, "flow mappings are not supported, except {} for an empty mapping");
    refused("a: {\n", 1, "flow mappings are not supported");
    refused("a: {x}\n", 1, "flow mappings are not supported");
    refused("- {a: 1, b: 2}\n", 1, "flow mappings are not supported");
    refused("a: [b: c]\n", 1, "flow mappings are not supported");
    refused("a: [b:]\n", 1, "flow mappings are not supported");
    refused('a: ["b": c]\n', 1, "flow mappings are not supported");
    refused("a: {} b\n", 1, "unexpected text after {}");
  });

  it("nested flow collections are refused", () => {
    refused("a: [[b]]\n", 1, "nested flow collections are not supported");
    refused("a: 1\nb: [c, [d]]\n", 2, "nested flow collections are not supported");
    refused("a: [{}]\n", 1, "nested flow collections are not supported");
    refused("- [a, {b: 1}]\n", 1, "nested flow collections are not supported");
  });

  it("a flow sequence must close on its line and hold whole items", () => {
    refused("a: [b, c\n", 1, "multi-line flow sequences are not supported; the closing ] must be on the same line");
    refused("a: 1\nb: [c,\n  d]\n", 2, "multi-line flow sequences are not supported");
    refused("a: [b, c # d]\n", 1, "multi-line flow sequences are not supported");
    refused("a: [\n", 1, "multi-line flow sequences are not supported");
    refused("[a\n", 1, "multi-line flow sequences are not supported");
    refused('a: ["b"\n', 1, "multi-line flow sequences are not supported");
    refused("a: [b,, c]\n", 1, "a flow sequence has an empty item");
    refused("a: [,]\n", 1, "a flow sequence has an empty item");
    refused('a: ["b" "c"]\n', 1, "a comma is missing between the items of a flow sequence");
    refused("a: [b] c\n", 1, "unexpected text after a flow sequence");
    refused("a: [b]]\n", 1, "unexpected text after a flow sequence");
    refused("a: [b]#c\n", 1, "unexpected text after a flow sequence");
  });

  it("a plain item follows the rules of a plain scalar, and brackets inside it must be quoted", () => {
    refused("a: [b[c]]\n", 1, "a value that contains [ ] { or } must be quoted inside a flow sequence");
    refused("a: [b}]\n", 1, "must be quoted inside a flow sequence");
    refused("a: [dependabot[bot]]\n", 1, "must be quoted inside a flow sequence");
    refused("a: [*b]\n", 1, "aliases (*name) are not supported");
    refused("a: [&b c]\n", 1, "anchors (&name) are not supported");
    refused("a: [!t b]\n", 1, "tags (!name) are not supported");
    refused("a: [|]\n", 1, "block scalars (| and >) are not supported");
    refused("a: [@b]\n", 1, "a plain scalar cannot start with %, @ or `");
    refused("a: [- b]\n", 1, 'a value that is "-" or starts with "- " must be quoted inside a flow sequence');
    refused("a: [-]\n", 1, "must be quoted inside a flow sequence");
    refused("a: [? b]\n", 1, "complex keys (?) are not supported");
    expect(parseYaml('a: ["dependabot[bot]", "- b", "*"]\n')).toEqual({ a: ["dependabot[bot]", "- b", "*"] });
  });

  it("a plain scalar that starts with [ or { must be a whole flow form", () => {
    refused("a: [bot] name\n", 1, "unexpected text after a flow sequence");
    refused("- [x\n", 1, "multi-line flow sequences are not supported");
    refused("a: {name}\n", 1, "flow mappings are not supported");
    expect(parseYaml("- dependabot[bot]\n- a{b}c\n- x]\n")).toEqual(["dependabot[bot]", "a{b}c", "x]"]);
  });
});

describe("yaml: scalars", () => {
  it(String.raw`double-quoted: the escapes \\ \" \/ \n \t \r \0 \uXXXX, and nothing is typed or trimmed`, () => {
    expect(parseYaml(String.raw`a: "back\\slash quote\" slash\/ nl\n tab\t cr\r nul\0 e\u00e9 \u263A"`)).toEqual({
      a: 'back\\slash quote" slash/ nl\n tab\t cr\r nul\0 e\u00e9 \u263A',
    });
    expect(parseYaml(String.raw`a: "\ud83d\ude00"`)).toEqual({ a: "\u{1F600}" });
    expect(parseYaml(String.raw`a: "\uD83D\uDE00 \u0041"`)).toEqual({ a: "\u{1F600} A" });
    expect(parseYaml('a: "true"\nb: "1"\nc: "null"\nd: ""\ne: "~"\nf: "  x  "\ng: "#"\nh: "a: b"\ni: "\ttab"\n')).toEqual({
      a: "true",
      b: "1",
      c: "null",
      d: "",
      e: "~",
      f: "  x  ",
      g: "#",
      h: "a: b",
      i: "\ttab",
    });
    for (const esc of ["x41", "a", "b", "e", "f", "v", "N", "_", "L", "P", " ", "U0001F600", "'", "1", "\t", "#"]) {
      refused(`a: 1\nb: "\\${esc}"\n`, 2, 'unsupported escape in a double-quoted scalar; the escapes are \\\\ \\" \\/ \\n \\t \\r \\0 \\uXXXX');
    }
    refused(String.raw`a: "\u12G4"`, 1, String.raw`\u in a double-quoted scalar must be followed by four hex digits`);
    refused(String.raw`a: "\u12"`, 1, "must be followed by four hex digits");
    refused(String.raw`a: "\u"`, 1, "must be followed by four hex digits");
    refused(String.raw`a: "\ud83d"`, 1, "half of a surrogate pair");
    refused(String.raw`a: "\ude00\ud83d"`, 1, "half of a surrogate pair");
    refused(String.raw`"\ud83d x": 1`, 1, "half of a surrogate pair");
    refused('a: "x" y\n', 1, "unexpected text after a quoted scalar");
    refused('a: "x""y"\n', 1, "unexpected text after a quoted scalar");
  });

  it("single-quoted: '' is a quote and nothing else is an escape", () => {
    expect(parseYaml("a: 'it''s'\nb: ''\nc: ''''\nd: 'back\\slash \\n \"dq\" #x'\ne: '  s  '\nf: 'true'\ng: '1'\n")).toEqual({
      a: "it's",
      b: "",
      c: "'",
      d: 'back\\slash \\n "dq" #x',
      e: "  s  ",
      f: "true",
      g: "1",
    });
    refused("a: 'x'y\n", 1, "unexpected text after a quoted scalar");
    refused("a: 'x' 'y'\n", 1, "unexpected text after a quoted scalar");
  });

  it("plain: trimmed, with spaces, quotes and colons inside", () => {
    expect(
      parseYaml(
        [
          "a:   two words   ",
          "b: a:b",
          "c: http://x.y/z?q=1#frag",
          "d: 12:30",
          "e: it's",
          'f: say "hi"',
          "g: a, b",
          "h: x]y}",
          "i: a|b>c&d*e!f%g@h`i",
          "j: :x",
          "k: ?x",
          "l: dependabot[bot]",
          "m: a - b",
          "n: a ? b",
        ].join("\n"),
      ),
    ).toEqual({
      a: "two words",
      b: "a:b",
      c: "http://x.y/z?q=1#frag",
      d: "12:30",
      e: "it's",
      f: 'say "hi"',
      g: "a, b",
      h: "x]y}",
      i: "a|b>c&d*e!f%g@h`i",
      j: ":x",
      k: "?x",
      l: "dependabot[bot]",
      m: "a - b",
      n: "a ? b",
    });
    refused("a: x:\n", 1, 'a plain scalar cannot contain ": " or end with ":"');
    refused("a: ,x\n", 1, "a value that starts with , ] or } must be quoted");
    refused("a: ]\n", 1, "a value that starts with , ] or } must be quoted");
    refused("- }x\n", 1, "a value that starts with , ] or } must be quoted");
  });

  it("a plain scalar cannot start with & * ! | > % @ or a backtick", () => {
    const reserved: [string, string][] = [
      ["&", "anchors (&name) are not supported"],
      ["*", "aliases (*name) are not supported; quote a value that starts with *"],
      ["!", "tags (!name) are not supported; quote a value that starts with !"],
      ["|", "block scalars (| and >) are not supported"],
      [">", "block scalars (| and >) are not supported"],
      ["%", "a plain scalar cannot start with %, @ or `; quote it"],
      ["@", "a plain scalar cannot start with %, @ or `; quote it"],
      ["`", "a plain scalar cannot start with %, @ or `; quote it"],
    ];
    for (const [c, message] of reserved) {
      refused(`a: ${c}x\n`, 1, message);
      refused(`a: ${c}\n`, 1, message);
      refused(`- ok\n- ${c}x\n`, 2, message);
      refused(`a:\n  - ok\n  - ${c}x y\n`, 3, message);
      refused(`a: [ok, ${c}x]\n`, 1, message);
      if (c !== "%") refused(`${c}x\n`, 1, message); // in column 0, % is a directive
      expect(parseYaml(`a: "${c}x"\nb: '${c}'\nc: x${c}\n`)).toEqual({ a: `${c}x`, b: c, c: `x${c}` });
    }
    expect(parseYaml("paths:\n  - '**/*.md'\n  - \"*.ts\"\n")).toEqual({ paths: ["**/*.md", "*.ts"] });
  });

  it("only plain scalars are typed, by the core schema in decimal; everything else stays a string", () => {
    const cases: [string, YamlValue][] = [
      ["true", true],
      ["True", true],
      ["TRUE", true],
      ["false", false],
      ["False", false],
      ["FALSE", false],
      ["null", null],
      ["Null", null],
      ["NULL", null],
      ["~", null],
      ["0", 0],
      ["7", 7],
      ["-7", -7],
      ["1234567890", 1234567890],
      ["-0", 0],
      ["0.5", 0.5],
      ["-0.25", -0.25],
      ["3.0", 3],
      ["10.125", 10.125],
      ["0.000001", 0.000001],
      ["-0.0", 0],
      ["1.2", 1.2],
    ];
    const strings = [
      "tRUE", "yes", "no", "on", "off", "y", "n", "nULL", "~x", "nil", "none",
      "+1", "01", "-01", "00", "1.", ".5", "-.5", "+1.5", "1e3", "1E3", "1.5e3", "1.5e-3", "0x1F", "0o17", "017", "0b11", "1_000",
      ".inf", "-.inf", "+.inf", ".Inf", ".INF", ".nan", ".NaN", ".NAN", "Infinity", "-Infinity", "NaN",
      "2026-11-09", "2026-11-09T10:00:00Z", "12:30", "1.2.3", "v1.2", "1.2-beta", "1 2", "--1", "1-", "1.2.", "1..2", "0.5.",
    ];
    for (const s of strings) cases.push([s, s]);
    for (const [text, value] of cases) {
      expect(parseYaml(`a: ${text}\n`), `a: ${text}`).toEqual({ a: value });
      expect(parseYaml(`- ${text}   # c\n`), `- ${text}`).toEqual([value]);
      expect(parseYaml(`[${text}, ${text}]\n`), `[${text}]`).toEqual([value, value]);
      expect(parseYaml(`${text}\n`), text).toEqual(value);
      // quoted, the same text is always a string
      expect(parseYaml(`a: "${text}"\nb: '${text}'\n`), `"${text}"`).toEqual({ a: text, b: text });
    }
    expect(parseYaml("a: 1,000\n")).toEqual({ a: "1,000" });
    expect(parseYaml("a:\nb: # c\nc: ~\n")).toEqual({ a: null, b: null, c: null });
    // there is no negative zero
    expect(Object.is(parseYaml("-0"), 0)).toBe(true);
    expect(Object.is(parseYaml("-0.0"), 0)).toBe(true);
  });

  it("a number is a double, never infinite", () => {
    expect(parseYaml("a: 9007199254740993\n")).toEqual({ a: 9007199254740992 }); // past 2^53: quote an id
    expect(parseYaml(`a: 0.${"0".repeat(400)}1\n`)).toEqual({ a: 0 });
    refused(`a: 1\nb: ${"9".repeat(400)}\n`, 2, "a number is too large");
    refused(`[-${"9".repeat(400)}.5]\n`, 1, "a number is too large");
    expect(parseYaml(`a: "${"9".repeat(400)}"\n`)).toEqual({ a: "9".repeat(400) });
  });
});

describe("yaml: features outside the subset are refused by name", () => {
  it("anchors, aliases, tags, block scalars, merge keys, complex keys", () => {
    const cases: [string, number, string][] = [
      ["a: 1\nb: &anchor x\n", 2, "anchors (&name) are not supported"],
      ["a: 1\n&anchor b: 2\n", 2, "anchors (&name) are not supported"],
      ["base: &base\n  a: 1\n", 1, "anchors (&name) are not supported"],
      ["a: 1\nb: *anchor\n", 2, "aliases (*name) are not supported"],
      ["- 1\n- *anchor\n", 2, "aliases (*name) are not supported"],
      ["*anchor : 1\n", 1, "aliases (*name) are not supported"],
      ["a: !custom x\n", 1, "tags (!name) are not supported"],
      ["a: !!str 1\n", 1, "tags (!name) are not supported"],
      ["!!map\na: 1\n", 1, "tags (!name) are not supported"],
      ["- !!int 3\n", 1, "tags (!name) are not supported"],
      ["a: |\n  text\n", 1, "block scalars (| and >) are not supported"],
      ["a: >-\n  text\n", 1, "block scalars (| and >) are not supported"],
      ["a: 1\nb: |2\n    text\n", 2, "block scalars (| and >) are not supported"],
      ["- |+\n  text\n", 1, "block scalars (| and >) are not supported"],
      ["base: 1\nx:\n  <<: *base\n", 3, "merge keys (<<) are not supported"],
      ["<<: {}\n", 1, "merge keys (<<) are not supported"],
      ["<< : x\n", 1, "merge keys (<<) are not supported"],
      ["- <<: [a, b]\n", 1, "merge keys (<<) are not supported"],
      ["? a\n: b\n", 1, "complex keys (?) are not supported"],
      ["a: 1\n?\n", 2, "complex keys (?) are not supported"],
      ["- ? a\n", 1, "complex keys (?) are not supported"],
      ["a: ? b\n", 1, "complex keys (?) are not supported"],
      ["? [a, b]\n: c\n", 1, "complex keys (?) are not supported"],
    ];
    for (const [text, line, message] of cases) refused(text, line, message);
    expect(parseYaml('"<<": 1\n"?": 2\n')).toEqual({ "<<": 1, "?": 2 }); // quoted, they are ordinary keys
  });

  it("multi-line plain scalars", () => {
    refused("a: some text\n  that continues\nb: 1\n", 2, "multi-line plain scalars are not supported");
    refused("- some text\n  that continues\n", 2, "multi-line plain scalars are not supported");
    refused("a:\n  b: some text\n      that continues\n", 3, "multi-line plain scalars are not supported");
    // whatever the next line holds, it is named as the scalar's second line
    refused("a: text\n  and more: words\n", 2, "multi-line plain scalars are not supported");
    refused("a: see\n  *below*\n", 2, "multi-line plain scalars are not supported");
    refused('a: true\n  "quoted"\n', 2, "multi-line plain scalars are not supported");
    refused("word\n  more words\n", 2, "multi-line plain scalars are not supported");
    expect(refusal("a: b\n  c\n").message).toBe("line 2: multi-line plain scalars are not supported");
  });

  it("multi-line quoted scalars", () => {
    refused('a: "open\n', 1, "multi-line quoted scalars are not supported; the closing quote must be on the same line");
    refused('a: 1\nb: "two\n  lines"\n', 2, "multi-line quoted scalars are not supported");
    refused('a: "ends with a backslash\\\n  next"\n', 1, "multi-line quoted scalars are not supported");
    refused("a: 'open\n", 1, "multi-line quoted scalars are not supported");
    refused("- ok\n- 'two\n  lines'\n", 2, "multi-line quoted scalars are not supported");
    refused('"key\n": 1\n', 1, "multi-line quoted scalars are not supported");
    refused("a: ['x, y]\n", 1, "multi-line quoted scalars are not supported");
    refused("a: 'it''s\n", 1, "multi-line quoted scalars are not supported");
  });

  it("inconsistent indentation: a line to the left of its block that matches no enclosing block", () => {
    refused("a:\n    b: 1\n  c: 2\n", 3, "inconsistent indentation");
    refused("a:\n  b: 1\n c: 2\n", 3, "inconsistent indentation");
    refused("  a: 1\nb: 2\n", 2, "inconsistent indentation");
    refused("- a: 1\n b: 2\n", 2, "inconsistent indentation");
    refused("a:\n  - x\n - y\n", 3, "inconsistent indentation");
    refused("a:\n  b:\n      c: 1\n    d: 2\n", 4, "inconsistent indentation");
    expect(refusal("a:\n    b: 1\n  c: 2\n").message).toBe(
      "line 3: inconsistent indentation: this line is indented less than the block above it but matches no enclosing block",
    );
  });

  it("inconsistent indentation: a line deeper than an entry that already has its value", () => {
    refused("a: 1\n  b: 2\n", 2, "inconsistent indentation");
    refused("a:\n  b: 1\n    c: 2\n", 3, "inconsistent indentation");
    refused("- a\n  - b\n", 2, "inconsistent indentation");
    refused("- a: 1\n   b: 2\n", 2, "inconsistent indentation");
    refused('a: "x"\n  y\n', 2, "inconsistent indentation");
    refused("a: [x]\n  - y\n", 2, "inconsistent indentation");
    refused("a: {}\n  b: 1\n", 2, "inconsistent indentation");
    expect(refusal("reviews:\n  auto: true\n    drafts: false\n").message).toBe(
      "line 3: inconsistent indentation: this line is indented more than the entry above it, which already has a value",
    );
  });
});

describe("yaml: limits", () => {
  /** A file of exactly `n` code units. */
  const sized = (n: number): string => `a: 1\n${"#".repeat(n - 5)}`;
  /** `n` mappings, each inside the one before. */
  const nested = (n: number, value = "1"): string => `${Array.from({ length: n }, (_, i) => `${"  ".repeat(i)}k${i}:`).join("\n")} ${value}\n`;
  /** `n` sequences, each the only item of the one before, around one scalar. */
  const dashes = (n: number): string => `${Array.from({ length: n }, (_, i) => `${" ".repeat(i)}-`).join("\n")} x\n`;
  /** A sequence of `n` scalars. */
  const items = (n: number): string => Array.from({ length: n }, (_, i) => `- ${i}`).join("\n");

  it("the defaults", () => {
    expect(DEFAULT_YAML_LIMITS).toEqual({ maxBytes: 16 * 1024, maxDepth: 6, maxNodes: 500 });
  });

  it("maxBytes: a longer text is refused before it is read, counted in UTF-16 code units", () => {
    expect(parseYaml(sized(16 * 1024))).toEqual({ a: 1 });
    const e = refusal(sized(16 * 1024 + 1));
    expect(e.message).toBe("file is larger than 16384 bytes");
    expect(e.line).toBe(0);
    refused("a: 1\n", 0, "file is larger than 4 bytes", { maxBytes: 4 });
    expect(parseYaml("a: 1", { maxBytes: 4 })).toEqual({ a: 1 });
    expect(parseYaml("a: \u{1F600}", { maxBytes: 5 })).toEqual({ a: "\u{1F600}" });
    refused("a: \u{1F600}", 0, "file is larger than 4 bytes", { maxBytes: 4 });
    refused("\t\u0000 not even looked at", 0, "file is larger than 3 bytes", { maxBytes: 3 });
    expect(parseYaml(sized(16 * 1024 + 1), { maxBytes: 16 * 1024 + 1 })).toEqual({ a: 1 });
  });

  it("maxDepth: collections nest at most that deep, flow collections included", () => {
    expect(parseYaml(nested(6))).toEqual({ k0: { k1: { k2: { k3: { k4: { k5: 1 } } } } } });
    refused(nested(7), 7, "nesting is deeper than 6 levels");
    expect(parseYaml(dashes(6))).toEqual([[[[[["x"]]]]]]);
    refused(dashes(7), 7, "nesting is deeper than 6 levels");
    // a mapping, its key's sequence, that sequence's mapping, and so on
    expect(parseYaml("a:\n- b:\n  - c:\n    - d\n")).toEqual({ a: [{ b: [{ c: ["d"] }] }] });
    refused("a:\n- b:\n  - c:\n    - d: 1\n", 4, "nesting is deeper than 6 levels");
    expect(parseYaml(nested(5, "[a]"))).toEqual({ k0: { k1: { k2: { k3: { k4: ["a"] } } } } });
    refused(nested(6, "[a]"), 6, "nesting is deeper than 6 levels");
    refused(nested(6, "[]"), 6, "nesting is deeper than 6 levels");
    refused(nested(6, "{}"), 6, "nesting is deeper than 6 levels");
    expect(parseYaml(nested(7), { maxDepth: 7 })).toEqual({ k0: { k1: { k2: { k3: { k4: { k5: { k6: 1 } } } } } } });
    expect(parseYaml("a: 1\nb: two\n", { maxDepth: 1 })).toEqual({ a: 1, b: "two" });
    refused("a: 1\nb:\n  c: 2\n", 3, "nesting is deeper than 1 levels", { maxDepth: 1 });
    refused("a: [x]\n", 1, "nesting is deeper than 1 levels", { maxDepth: 1 });
    refused("-\n  - x\n", 2, "nesting is deeper than 1 levels", { maxDepth: 1 });
    refused("- k: v\n", 1, "nesting is deeper than 1 levels", { maxDepth: 1 });
    expect(parseYaml("42", { maxDepth: 0 })).toBe(42);
    refused("a: 1\n", 1, "nesting is deeper than 0 levels", { maxDepth: 0 });
    refused("[]\n", 1, "nesting is deeper than 0 levels", { maxDepth: 0 });
  });

  it("maxNodes: every scalar, sequence and mapping counts one", () => {
    expect((parseYaml(items(499)) as YamlValue[]).length).toBe(499); // 1 sequence and 499 scalars
    refused(items(500), 500, "the file has more than 500 values");
    expect((parseYaml(items(500), { maxNodes: 501 }) as YamlValue[]).length).toBe(500);
    // a mapping, a sequence, two scalars
    expect(parseYaml("a:\n  - 1\n  - 2\n", { maxNodes: 4 })).toEqual({ a: [1, 2] });
    refused("a:\n  - 1\n  - 2\n", 3, "the file has more than 3 values", { maxNodes: 3 });
    expect(parseYaml("a: [1, 2]\n", { maxNodes: 4 })).toEqual({ a: [1, 2] });
    refused("a: [1, 2]\n", 1, "the file has more than 3 values", { maxNodes: 3 });
    expect(parseYaml("- k: v\n", { maxNodes: 3 })).toEqual([{ k: "v" }]);
    refused("- k: v\n", 1, "the file has more than 2 values", { maxNodes: 2 });
    // a null counts as a scalar; keys do not count
    expect(parseYaml("a:\nb:\n", { maxNodes: 3 })).toEqual({ a: null, b: null });
    refused("a:\nb:\n", 2, "the file has more than 2 values", { maxNodes: 2 });
    expect(parseYaml("x", { maxNodes: 1 })).toBe("x");
    refused("x", 1, "the file has more than 0 values", { maxNodes: 0 });
    expect(parseYaml("# nothing\n", { maxNodes: 0 })).toBeNull();
  });

  it("a limit that is left out, or is not a number from 0 up, is the default: never no limit", () => {
    refused(nested(7), 7, "nesting is deeper than 6 levels", { maxBytes: 1 << 20 });
    refused(items(500), 500, "the file has more than 500 values", { maxDepth: 2 });
    for (const bad of [undefined, NaN, -1, "9999999" as unknown as number, null as unknown as number]) {
      expect(refusal(sized(16 * 1024 + 1), { maxBytes: bad }).message).toBe("file is larger than 16384 bytes");
      refused(nested(7), 7, "nesting is deeper than 6 levels", { maxDepth: bad });
      refused(items(500), 500, "the file has more than 500 values", { maxNodes: bad });
    }
    expect(refusal(sized(16 * 1024 + 1), null as unknown as Limits).message).toBe("file is larger than 16384 bytes");
  });
});

describe("yaml: YamlError", () => {
  it("is an Error whose message already names the line, when there is one", () => {
    const e = new YamlError("tabs are not allowed for indentation", 12);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(YamlError);
    expect(e.name).toBe("YamlError");
    expect(e.message).toBe("line 12: tabs are not allowed for indentation");
    expect(e.line).toBe(12);
    const whole = new YamlError("file is larger than 16384 bytes", 0);
    expect(whole.message).toBe("file is larger than 16384 bytes");
    expect(whole.line).toBe(0);
  });

  it("is all parseYaml throws, also for something that is not text", () => {
    for (const notText of [undefined, null, 42, {}, ["a: 1"], new Uint8Array(4)]) {
      const e = refusal(notText as unknown as string);
      expect(e.message).toBe("the file is not text");
      expect(e.line).toBe(0);
    }
  });

  it("a message repeats nothing from the file but a key of [A-Za-z0-9_.-], at most 40 characters", () => {
    const secret = "<img src=x> @octocat [l](http://e.example)";
    const long = "k".repeat(41);
    const texts = [
      `"${secret}": 1\n"${secret}": 2\n`,
      `a: ${secret}: x\n`,
      `${secret}: 1\n`,
      `a: "${secret}" tail\n`,
      `a: [${secret}, [x]]\n`,
      `a: 1\n  ${secret}\n`,
      `a: &${secret}\n`,
      `a: "\\q${secret}"\n`,
      `a: '${secret}\n`,
      `- ${secret}\n${secret}\n`,
      `${long}: 1\n${long}: 2\n`,
    ];
    for (const text of texts) {
      const m = refusal(text).message;
      for (const part of ["octocat", "<img", "http", long]) expect(m, text).not.toContain(part);
      expect(m, text).toMatch(/^[\x20-\x7e]{1,160}$/);
    }
    expect(refusal(`"${secret}": 1\n"${secret}": 2\n`).message).toBe("line 2: duplicate key");
    expect(refusal(`${long}: 1\n${long}: 2\n`).message).toBe("line 2: duplicate key");
    expect(refusal(`${"k".repeat(40)}: 1\n${"k".repeat(40)}: 2\n`).message).toBe(`line 2: duplicate key "${"k".repeat(40)}"`);
  });
});

describe("yaml: a realistic .github/genclass.yml", () => {
  const expected = {
    reviews: { auto: true, drafts: false, branches: ["main", "release/*"], ignore_authors: ["dependabot[bot]", "renovate[bot]"] },
    comment: "findings",
    check: { enabled: true, fail_on: "reproducible" },
    inline: true,
    min_seeds: 2,
    artifact: "genclass-races",
    paths: { ignore: ["docs/**", "**/*.md"] },
    commands: { allow: "write" },
    issues: { create: "never" },
    project: null,
  };

  it("parses to the obvious object, with its keys in the file's order", () => {
    const v = parseYaml(REALISTIC);
    expect(v).toEqual(expected);
    const order = ["reviews", "comment", "check", "inline", "min_seeds", "artifact", "paths", "commands", "issues", "project"];
    expect(Object.keys(v as object)).toEqual(order);
    expect(JSON.parse(JSON.stringify(v))).toEqual(expected);
    // a plain scalar that holds brackets but does not start with one stays a string
    expect((v as { reviews: { ignore_authors: YamlValue[] } }).reviews.ignore_authors[0]).toBe("dependabot[bot]");
  });

  it("the same with CRLF line endings, a byte-order mark, a --- line, or its sequences in the keys' own columns", () => {
    expect(parseYaml(REALISTIC.replaceAll("\n", "\r\n"))).toEqual(expected);
    expect(parseYaml(`\uFEFF${REALISTIC}`)).toEqual(expected);
    expect(parseYaml(`---\n${REALISTIC}`)).toEqual(expected);
    expect(parseYaml(REALISTIC.replaceAll("    - ", "  - "))).toEqual(expected);
  });

  it("a mistake in it is refused on its line", () => {
    refused(REALISTIC.replace("  drafts: false", "\tdrafts: false"), 4, "tabs are not allowed for indentation");
    refused(REALISTIC.replace("    - '**/*.md'", "    - **/*.md"), 19, "aliases (*name) are not supported; quote a value that starts with *");
    refused(REALISTIC.replace("  fail_on: reproducible", "   fail_on: reproducible"), 12, "inconsistent indentation");
    refused(REALISTIC.replace("inline: true", "check: {}"), 13, 'duplicate key "check"');
    refused(REALISTIC.replace('"release/*"]', '"release/*"'), 5, "multi-line flow sequences are not supported");
  });
});

// --------------------------------------------------------------------------------------------- random input

/** mulberry32: a small seeded generator, so a failing case can be replayed from its number. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rand: () => number, from: readonly T[]): T => from[Math.floor(rand() * from.length)]!;

/** What YAML gives meaning to, and a few whole tokens so that deeper structure turns up often. */
const SIGNIFICANT = [
  "a", "b", "k", "0", "1", "-1", "1.5", " ", "  ", "\n", "\n", "\n", "\n  ", "\n    ", "\n ", "\t", "\r\n", "\r",
  ":", ": ", "- ", "-", "#", " #", "[", "]", "{", "}", ",", ", ", '"', "'", "\\", "\\n", "\\u00e9", "\\x",
  "&", "*", "!", "!!", "|", ">", "%", "@", "`", "?", "? ", "<<", "<<: ", "---", "...", "~", "null", "true", ".",
  "\u00e9", "\u{1F600}", "\ud800", "\u0000", "\ufeff", "key: ", "k:", "- x", "\n- ", "\n  - ", "[a, b]", "[]", "{}", "''", '""',
];

/**
 * Check a parsed value against what the reader promises: plain objects and arrays, finite numbers, no refused key.
 * Returns how many values it holds and how deep its collections nest (0 for a scalar).
 */
function measure(v: YamlValue): { nodes: number; depth: number } {
  if (v === null || typeof v === "string" || typeof v === "boolean") return { nodes: 1, depth: 0 };
  if (typeof v === "number") {
    expect(Number.isFinite(v)).toBe(true);
    expect(Object.is(v, -0)).toBe(false);
    return { nodes: 1, depth: 0 };
  }
  expect(typeof v).toBe("object");
  expect(Object.getPrototypeOf(v)).toBe(Array.isArray(v) ? Array.prototype : Object.prototype);
  const children: YamlValue[] = [];
  if (Array.isArray(v)) children.push(...v);
  else {
    for (const key of Object.keys(v)) {
      expect(["__proto__", "constructor", "prototype"]).not.toContain(key);
      children.push(v[key]!);
    }
  }
  let nodes = 1;
  let depth = 0;
  for (const child of children) {
    const m = measure(child);
    nodes += m.nodes;
    depth = Math.max(depth, m.depth);
  }
  return { nodes, depth: depth + 1 };
}

/**
 * What must hold for a text that parsed to `value`: it is within the limits, it is JSON, it parses the same again, and
 * the limits count exactly what came back, so that nothing was counted twice, dropped or overwritten on the way.
 */
function checkParsed(text: string, value: YamlValue, label: string): void {
  const { nodes, depth } = measure(value);
  expect(nodes, label).toBeLessThanOrEqual(DEFAULT_YAML_LIMITS.maxNodes);
  expect(depth, label).toBeLessThanOrEqual(DEFAULT_YAML_LIMITS.maxDepth);
  expect(JSON.parse(JSON.stringify(value)), label).toEqual(value);
  expect(parseYaml(text, { maxNodes: nodes, maxDepth: depth }), label).toEqual(value);
  // an empty file is null without a value having been read; any other null is one value
  if (value !== null) expect(refusal(text, { maxNodes: nodes - 1 }).message, label).toContain(`the file has more than ${nodes - 1} values`);
  if (depth > 0) expect(refusal(text, { maxDepth: depth - 1 }).message, label).toContain(`nesting is deeper than ${depth - 1} levels`);
}

/** Parse, and check whichever way it ends: a value as checkParsed wants it, or a YamlError on a line of the text. */
function parseChecked(text: string, label: string): void {
  let value: YamlValue;
  try {
    value = parseYaml(text);
  } catch (e) {
    if (!(e instanceof YamlError)) throw new Error(`${label}: threw ${String(e)} for ${JSON.stringify(text)}`);
    const lines = text.split("\n").length;
    expect(Number.isInteger(e.line) && e.line >= 0 && e.line <= lines, `${label}: line ${e.line} of ${lines}`).toBe(true);
    expect(e.message, label).toMatch(/^[\x20-\x7e]{1,160}$/);
    expect(e.message.startsWith(`line ${e.line}: `), label).toBe(e.line > 0);
    return;
  }
  checkParsed(text, value, `${label}: ${JSON.stringify(text)}`);
}

describe("yaml: random input", () => {
  it("strings of YAML-significant characters only ever parse or throw a YamlError", () => {
    const rand = prng(0x9e3779b9);
    let parsed = 0;
    let refusedCount = 0;
    for (let i = 0; i < 1500; i++) {
      let text = "";
      for (let n = 1 + Math.floor(rand() * 24); n > 0; n--) text += pick(rand, SIGNIFICANT);
      try {
        parseYaml(text);
        parsed++;
      } catch {
        refusedCount++;
      }
      parseChecked(text, `case ${i}`);
    }
    // the alphabet is not so hostile that nothing parses, nor so tame that nothing is refused
    expect(parsed).toBeGreaterThan(50);
    expect(refusedCount).toBeGreaterThan(50);
  });

  it("a realistic file with random edits only ever parses or throws a YamlError", () => {
    const rand = prng(20261109);
    for (let i = 0; i < 600; i++) {
      let text = REALISTIC;
      for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
        const at = Math.floor(rand() * (text.length + 1));
        const kind = rand();
        if (kind < 0.4) text = text.slice(0, at) + pick(rand, SIGNIFICANT) + text.slice(at);
        else if (kind < 0.7) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 3));
        else if (kind < 0.85) text = text.slice(0, at) + pick(rand, SIGNIFICANT) + text.slice(at + 1);
        else {
          const lines = text.split("\n");
          const from = Math.floor(rand() * lines.length);
          const to = Math.floor(rand() * lines.length);
          lines.splice(to, 0, ...lines.splice(from, 1));
          text = lines.join("\n");
        }
      }
      parseChecked(text, `edit ${i}`);
    }
  });

  // A small writer for the subset, to read back: every way the subset can spell a value, picked at random.
  const STRINGS = [
    "", " ", "a", "plain", "two words", "true", "null", "~", "1", "-1.5", "#hash", "a # b", "a: b", "- x", "[x]", "{}", "it's", 'say "hi"',
    "back\\slash", "tab\there", "line\nbreak", "cr\rhere", "nul\0", "\u00e9t\u00e9", "\u{1F600}", "*star", "&amp", "!bang", "|", ">", "%p", "@at",
    "`tick`", "?", "? x", ":", "x:", "-", "---", "...", " lead", "trail ", "a,b", "a]", "<<", "0x1F", "1e3", ".5", "dependabot[bot]", "docs/**",
    "__proto__", "a/b",
  ];
  const KEYS = [
    "a", "key", "k_1", "x.y", "a-b", "0", "-", "true", "null", "---", "...",
    "with space", 'quo"te', "it's", "", "\u043a\u043b\u044e\u0447", "a: b", "#", "[k]", "<<", "?", "tab\t",
  ];

  function randomValue(rand: () => number, depth: number): YamlValue {
    if (depth >= 4 || rand() < (depth === 0 ? 0.1 : 0.4)) {
      const s = rand();
      if (s < 0.1) return null;
      if (s < 0.2) return rand() < 0.5;
      if (s < 0.35) return Math.floor(rand() * 2001) - 1000;
      if (s < 0.45) return (Math.floor(rand() * 2001) - 1000) / 8;
      return pick(rand, STRINGS);
    }
    const n = Math.floor(rand() * 4) + (depth === 0 ? 1 : 0);
    if (rand() < 0.5) return Array.from({ length: n }, () => randomValue(rand, depth + 1));
    const map: { [key: string]: YamlValue } = {};
    for (let i = 0; i < n; i++) {
      let key = pick(rand, KEYS);
      while (Object.hasOwn(map, key)) key += String(i);
      map[key] = randomValue(rand, depth + 1);
    }
    return map;
  }

  const isScalar = (v: YamlValue): v is string | number | boolean | null => v === null || typeof v !== "object";
  const isEmpty = (v: YamlValue): boolean => !isScalar(v) && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);

  function doubleQuoted(s: string, rand: () => number): string {
    const raw = rand() < 0.5; // leave what may stand unescaped as it is
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      const code = c.charCodeAt(0);
      if (c === "\\") out += "\\\\";
      else if (c === '"') out += '\\"';
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\0") out += "\\0";
      else if (c === "\t") out += raw ? "\t" : "\\t";
      else if (c === "/") out += raw ? "/" : "\\/";
      else if (code < 0x20 || (code >= 0x7f && !raw)) {
        // by code unit, so a character outside the BMP is written as its two surrogates
        const hex = code.toString(16).padStart(4, "0");
        out += `\\u${rand() < 0.5 ? hex.toUpperCase() : hex}`;
      } else out += c;
    }
    return `${out}"`;
  }

  function quoted(s: string, rand: () => number): string {
    // single quotes cannot hold a control character on one line
    return rand() < 0.5 && !/[\u0000-\u001f]/.test(s.replace(/\t/g, "")) ? `'${s.replaceAll("'", "''")}'` : doubleQuoted(s, rand);
  }

  function scalarText(v: string | number | boolean | null, rand: () => number): string {
    if (v === null) return pick(rand, ["null", "~", "Null", "NULL"]);
    if (typeof v === "boolean") return pick(rand, v ? ["true", "True", "TRUE"] : ["false", "False", "FALSE"]);
    if (typeof v === "number") return String(v);
    const plain = /^[a-z][a-z0-9_./-]*( [a-z0-9_./-]+)*$/.test(v) && !["true", "false", "null"].includes(v);
    return plain && rand() < 0.6 ? v : quoted(v, rand);
  }

  function keyText(k: string, rand: () => number): string {
    const plain = /^[A-Za-z0-9_.-]+$/.test(k) && rand() < 0.7;
    // "- :" is a sequence item and "--- :" in column 0 a document marker, in YAML too: no space after those
    const indicator = plain && (k === "-" || k.startsWith("---") || k.startsWith("..."));
    return (plain ? k : quoted(k, rand)) + (!indicator && rand() < 0.15 ? " " : "");
  }
  const tail = (rand: () => number): string => pick(rand, ["", "", "", "  ", " # note", "\t#"]);

  /** The lines of one entry: `head` is its key with the colon, or its dash. */
  function entryLines(head: string, v: YamlValue, indent: number, isKey: boolean, rand: () => number): string[] {
    if (isScalar(v)) return [v === null && rand() < 0.4 ? head + tail(rand) : `${head} ${scalarText(v, rand)}${tail(rand)}`];
    if (isEmpty(v)) return [`${head} ${Array.isArray(v) ? pick(rand, ["[]", "[ ]"]) : pick(rand, ["{}", "{ }"])}${tail(rand)}`];
    if (Array.isArray(v) && v.every(isScalar) && rand() < 0.4) {
      return [`${head} [${v.map((x) => scalarText(x, rand)).join(pick(rand, [", ", ",", " , "]))}${rand() < 0.2 ? "," : ""}]${tail(rand)}`];
    }
    if (isKey) {
      // under the key, or for a sequence in the key's own column
      const flush = Array.isArray(v) && rand() < 0.4;
      return [head + tail(rand), ...blockLines(v, flush ? indent : indent + 1 + Math.floor(rand() * 4), rand)];
    }
    // an item's block goes on the following lines; a mapping may also start on the dash line
    if (Array.isArray(v) || rand() < 0.4) return [head + tail(rand), ...blockLines(v, indent + 1 + Math.floor(rand() * 4), rand)];
    // on the dash line: the mapping's first key follows the dash, its other lines keep that key's column
    const gap = 1 + Math.floor(rand() * 3);
    const lines = blockLines(v, indent + 1 + gap, rand);
    lines[0] = head + " ".repeat(gap) + lines[0]!.slice(indent + 1 + gap);
    return lines;
  }

  /** The lines of a mapping or sequence with entries, as a block in column `indent`. */
  function blockLines(v: YamlValue, indent: number, rand: () => number): string[] {
    const pad = " ".repeat(indent);
    const out: string[] = [];
    const between = (): void => {
      if (out.length > 0 && rand() < 0.15) out.push(pick(rand, ["", "   ", `${" ".repeat(Math.floor(rand() * 8))}# a comment`, "\t# after a tab"]));
    };
    if (Array.isArray(v)) {
      for (const item of v) {
        between();
        out.push(...entryLines(`${pad}-`, item, indent, false, rand));
      }
    } else if (!isScalar(v)) {
      for (const key of Object.keys(v)) {
        between();
        out.push(...entryLines(`${pad}${keyText(key, rand)}:`, v[key]!, indent, true, rand));
      }
    }
    return out;
  }

  function write(v: YamlValue, rand: () => number): string {
    const start = pick(rand, ["", "", "---\n", "# settings\n\n", "\uFEFF", "\uFEFF# c\n--- # start\n"]);
    let body: string;
    if (isScalar(v)) body = scalarText(v, rand);
    else if (isEmpty(v)) body = Array.isArray(v) ? "[]" : "{}";
    else if (Array.isArray(v) && v.every(isScalar) && rand() < 0.2) body = `[${v.map((x) => scalarText(x, rand)).join(", ")}]`;
    else body = blockLines(v, rand() < 0.8 ? 0 : 2, rand).join("\n");
    return start + body + pick(rand, ["", "\n", "\n\n# end\n"]);
  }

  it("what a small writer for the subset emits reads back as the same value, with LF or CRLF", () => {
    const rand = prng(47357);
    for (let i = 0; i < 500; i++) {
      const value = randomValue(rand, 0);
      const text = write(value, rand);
      const label = `value ${i}: ${JSON.stringify(text)}`;
      let back: YamlValue;
      try {
        back = parseYaml(text);
      } catch (e) {
        throw new Error(`${label} was refused: ${String(e)}`);
      }
      expect(back, label).toEqual(value);
      expect(parseYaml(text.replaceAll("\n", "\r\n")), label).toEqual(value);
      checkParsed(text, back, label);
    }
  });
});

// --------------------------------------------------------------------------------------------- hostile input

describe("yaml: hostile input", () => {
  const SIZE = 200 * 1024;
  const filled = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  /** Lines that are each one column deeper than the last, about 200 KB of them. */
  const stairs = (line: string): string => Array.from({ length: 640 }, (_, i) => " ".repeat(i) + line).join("\n");

  const HOSTILE: { [name: string]: string } = {
    "dashes on one line": filled("- "),
    "dashes, each line one deeper": stairs("-"),
    "keys, each line one deeper": stairs("k:"),
    "a run of [": filled("["),
    "a run of [ after a key": `a: ${filled("[")}`,
    "a run of {": filled("{"),
    "flow items": `[${filled("a,")}`,
    "flow items with quotes": `[${filled("'a' ,")}`,
    "one line of spaces": filled(" "),
    "long lines of spaces": filled(`${" ".repeat(4095)}\n`),
    "spaces, then a key": `${filled(" ")}a: 1`,
    "spaces, then a tab": `${filled(" ")}\tx`,
    "keys on one line": filled("a: "),
    "an unclosed double quote": `a: "${filled("\\\\")}`,
    "an unclosed single quote": `a: '${filled("''")}`,
    "a quoted line without a colon": `"${filled("k")}"`,
    "quoted keys on one line": filled('"k": '),
    "a run of colons": filled(":"),
    "a plain scalar full of colons": `a: ${filled("b:c")}`,
    "a long key": `${filled("k")}: 1`,
    "a long text that is no key": `${filled("k ")}x`,
    "a long number": `a: ${filled("9")}`,
    "almost a number": `a: -1${filled("0")}.${filled("5")}x`,
    "empty lines": filled("\n"),
    "comment lines": filled("#\n"),
    "CRLF lines": filled("\r\n"),
    "the same key again and again": filled("k: v\n"),
    "many keys": Array.from({ length: 20000 }, (_, i) => `k${i}: ${i}`).join("\n"),
    "many items": filled("- 1\n"),
    "many items that are mappings": filled("- k: v\n  m: [a, b]\n  n:\n  - x\n"),
    "items that are mappings, each line two deeper": Array.from({ length: 450 }, (_, i) => `${" ".repeat(2 * i)}- k:`).join("\n"),
    "many flow sequences": filled("- [a, b, c]\n"),
    "question marks": filled("? "),
    "anchors and aliases": filled("&a *a "),
    "document markers": filled("---\n"),
    "a run of tabs": filled("\t"),
    "a run of backslashes in a key": `"${filled("\\")}`,
    "comment after a long gap": `a:${filled(" ")}# c`,
  };

  it("200 KB is over the default size limit: refused before a line is read", () => {
    for (const [name, text] of Object.entries(HOSTILE)) {
      expect(text.length, name).toBeGreaterThan(190 * 1024);
      const e = refusal(text);
      expect(e.message, name).toBe("file is larger than 16384 bytes");
    }
  });

  it("with the size limit lifted, 200 KB of each is still answered quickly, with the other limits or without any", () => {
    const run = (text: string, limits: Limits): number => {
      const t0 = performance.now();
      try {
        parseYaml(text, limits);
      } catch (e) {
        if (!(e instanceof YamlError)) throw e;
      }
      return performance.now() - t0;
    };
    for (const [name, text] of Object.entries(HOSTILE)) {
      // the reader is linear, so each takes a few milliseconds; the bound only has to catch a quadratic path
      expect(run(text, { maxBytes: Infinity }), `${name}, default depth and values`).toBeLessThan(1000);
      expect(run(text, { maxBytes: Infinity, maxDepth: Infinity, maxNodes: Infinity }), `${name}, no limits`).toBeLessThan(1000);
    }
  });

  it("with the depth limit lifted too, blocks nest as deep as 200 KB can spell: 640 sequences, 900 collections", () => {
    const unlimited = { maxBytes: Infinity, maxDepth: Infinity, maxNodes: Infinity };
    let v = parseYaml(`${HOSTILE["dashes, each line one deeper"]!} x`, unlimited);
    let depth = 0;
    while (Array.isArray(v)) {
      expect(v.length).toBe(1);
      v = v[0]!;
      depth++;
    }
    expect(depth).toBe(640);
    expect(v).toBe("x");
    // "- k:" in the column of the key above: a sequence and a mapping for every line
    v = parseYaml(HOSTILE["items that are mappings, each line two deeper"]!, unlimited);
    depth = 0;
    while (v !== null) {
      expect(Array.isArray(v) && v.length === 1).toBe(true);
      const item = (v as YamlValue[])[0] as { [key: string]: YamlValue };
      expect(Object.keys(item)).toEqual(["k"]);
      v = item.k!;
      depth += 2;
    }
    expect(depth).toBe(900);
  });
});
