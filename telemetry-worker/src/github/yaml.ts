// The reader for a repository's settings file, .github/genclass.yml (src/github/settings.ts): a deliberately small,
// strict subset of YAML, with no dependency. The file is written by the repository's owners but is untrusted input
// here, so anything outside the subset is refused with a line-numbered message the caller can show them, rather than
// read in a way they did not mean.
//
// The subset:
// - One document: LF or CRLF line endings, an optional byte-order mark, an optional leading "---" line. A second
//   "---" or a "..." line is refused (multiple documents). The document is a block mapping or sequence, or one
//   scalar or flow collection on a line; an empty or comment-only file is null.
// - Comments: "#" at the start of a line or after white space, outside quotes. Blank lines anywhere.
// - Block mappings, "key: value", nested by indentation with spaces. A key is plain ([A-Za-z0-9_.-]+) or quoted and
//   is always a string. A key with nothing after its colon takes the block nested under it (a mapping or a
//   sequence), or null when nothing is nested.
// - Block sequences, "- item". An item is a scalar, a flow sequence, a block on the following, deeper lines, or a
//   mapping that starts on the dash line ("- name: a", then keys aligned with "name"). A sequence that is a key's
//   value may be indented under the key or start in the key's own column.
// - Flow sequences of scalars on one line, [a, "b c", 3, true], and [] for an empty one; a comma may end the list.
//   {} is the only flow mapping.
// - Scalars on one line: double-quoted (escapes \\ \" \/ \n \t \r \0 \uXXXX), single-quoted ('' is one quote) or
//   plain. Only plain scalars are typed, by YAML's core schema in decimal: true and false, null and ~ and an empty
//   value, integers and floats. Hex, octal, exponents, a leading "+" or zero, .inf, .nan, dates and versions stay
//   strings. A number is a double: an integer past 2^53 loses digits, and one too large to be finite is refused.
// - A tab is white space like a space between tokens. It is refused where it would indent: before a line's first
//   token, and between a dash and the mapping that starts on its line.
// - Refused by name: anchors, aliases, tags, block scalars, merge keys, complex keys, directives, multi-line scalars
//   and flow sequences, flow mappings with content, nested flow collections, a sequence that starts on a dash line
//   ("- - a"), a scalar on a line of its own under its key, tabs in indentation, inconsistent indentation, duplicate
//   keys, the keys __proto__, constructor and prototype, control characters and unpaired surrogates.
//
// Invariants:
// - parseYaml throws only YamlError, whose message already names the line ("line 12: tabs are not allowed for
//   indentation").
// - An accepted text never gets another value than YAML 1.2 gives it, with the two differences listed above: plain
//   scalars are typed more narrowly than the core schema, and every key is a string. What YAML reads another way is
//   refused, not reread.
// - Work is bounded on hostile input. The text's length, the nesting depth and the number of values are capped
//   (YamlLimits); each line is read left to right a fixed number of times; the open blocks are kept in an array, so
//   nothing recurses whatever maxDepth is; and every regular expression is one character class or an anchored
//   pattern with no repeated group, so none can backtrack more than once along its input.
// - The result holds only plain objects, arrays, strings, finite numbers, booleans and null. A key is always an own
//   property, also when it is named like an inherited one (toString); the keys that would reach a prototype are
//   refused.
// - A message never repeats text from the file, except a key made only of [A-Za-z0-9_.-] (at most 40 characters).

/** What a file parses to: the JSON value types, in plain objects and arrays. */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/** A file outside the subset, or over a limit. `line` is 1-based (0 when the problem is not on one line). */
export class YamlError extends Error {
  readonly line: number;
  /** `message` is given without the line: "line N: " is put in front of it when `line` is 1 or more. */
  constructor(message: string, line: number) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = "YamlError";
    this.line = line;
  }
}

/** The caps on one file. A file over any of them is refused with a YamlError. */
export interface YamlLimits {
  /** The longest text read, counted in UTF-16 code units of the string (for ASCII, its bytes). */
  maxBytes: number;
  /** How deep collections may nest: 1 is a mapping or a sequence that holds scalars only. */
  maxDepth: number;
  /** How many values the file may hold: every scalar, sequence and mapping counts one. */
  maxNodes: number;
}

/** The limits parseYaml uses for every field its caller leaves out. */
export const DEFAULT_YAML_LIMITS: YamlLimits = { maxBytes: 16 * 1024, maxDepth: 6, maxNodes: 500 };

// --------------------------------------------------------------------------------------------- messages

// Fixed sentences without a full stop or a capital, so that a caller can put one inside a sentence of its own.

const TABS = "tabs are not allowed for indentation";
const MANY_DOCUMENTS = "multiple documents are not supported";
const MARKER_CONTENT = "content on the --- line is not supported; start on the next line";
const AFTER_DOCUMENT = "unexpected content after the top-level value";
const MULTI_LINE_PLAIN = "multi-line plain scalars are not supported";
const MULTI_LINE_QUOTED = "multi-line quoted scalars are not supported; the closing quote must be on the same line";
const MULTI_LINE_FLOW = "multi-line flow sequences are not supported; the closing ] must be on the same line";
const FLOW_MAPPING = "flow mappings are not supported, except {} for an empty mapping";
const NESTED_FLOW = "nested flow collections are not supported";
const FLOW_DASH = 'a value that is "-" or starts with "- " must be quoted inside a flow sequence';
const FLOW_BRACKET = "a value that contains [ ] { or } must be quoted inside a flow sequence";
const COMPLEX_KEY = "complex keys (?) are not supported";
const DEDENTED = "inconsistent indentation: this line is indented less than the block above it but matches no enclosing block";
const DEEPER = "inconsistent indentation: this line is indented more than the entry above it, which already has a value";
const OWN_LINE = "a scalar or flow sequence must be on the same line as its key or dash";
const DASH_ON_DASH = 'a sequence cannot start on a dash line ("- - item"); put its items on the following lines';
const DASH_AFTER_KEY = "a sequence cannot start on the same line as its key; put its items on the following lines";
const EXPECTED_ENTRY = 'expected "key: value" here; a space must follow the colon';
const EXPECTED_ITEM = 'expected a "- " sequence item here';
const ITEM_AFTER_VALUE = 'expected "key: value" here, not a "- " sequence item';

// --------------------------------------------------------------------------------------------- characters

/** Control characters other than tab (a line holds no LF, and the CR of a CRLF is gone), and unpaired surrogates. */
const UNREADABLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uD800-\uDFFF]/u;
/** A surrogate without its other half (with the u flag, a pair is one character and does not match). */
const UNPAIRED = /[\uD800-\uDFFF]/u;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
/** A decimal integer or float of the core schema, without "+", leading zeros or an exponent. */
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
/** A key that a message may repeat. */
const SHOWN_KEY = /^[A-Za-z0-9_.-]{1,40}$/;

const ESCAPES = new Map<string, string>([
  ["\\", "\\"],
  ['"', '"'],
  ["/", "/"],
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["0", "\0"],
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isWs = (c: string | undefined): boolean => c === " " || c === "\t";

/** The first index at or after `i` that holds neither a space nor a tab. */
const skipWs = (s: string, i: number): number => {
  while (isWs(s[i])) i++;
  return i;
};

/** Whether an indicator before `i` stands alone: the line ends there or white space follows ("- a", not "-a"). */
const breaks = (s: string, i: number): boolean => i >= s.length || isWs(s[i]);

/** A sequence item's "-" at `i`. */
const isDash = (s: string, i: number): boolean => s[i] === "-" && breaks(s, i + 1);

/** A mapping entry's ":" at `i`. */
const isColon = (s: string, i: number): boolean => s[i] === ":" && breaks(s, i + 1);

/** [A-Za-z0-9_.-], the characters of a plain key. */
const isKeyChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45;

/** The index past the run of plain-key characters that starts at `i`. */
const keyEnd = (s: string, i: number): number => {
  while (isKeyChar(s.charCodeAt(i))) i++;
  return i;
};

/** Whether the text at `i` starts an entry, "- " or a plain "key:", rather than reading as more words of a scalar. */
const startsEntry = (s: string, i: number): boolean => {
  if (isDash(s, i)) return true;
  const j = keyEnd(s, i);
  return j > i && isColon(s, skipWs(s, j));
};

/** The error for a character UNREADABLE matched. */
function unreadable(c: string, line: number): YamlError {
  const code = c.charCodeAt(0);
  if (code === 13) return new YamlError("a carriage return must be followed by a line feed (line endings are LF or CRLF)", line);
  if (code >= 0xd800) return new YamlError("the text is not valid Unicode (an unpaired surrogate)", line);
  return new YamlError(`control characters are not allowed (U+${code.toString(16).toUpperCase().padStart(4, "0")})`, line);
}

// --------------------------------------------------------------------------------------------- scalars

interface Quoted {
  value: string;
  /** The index past the closing quote. */
  end: number;
}

/** The double-quoted scalar that opens at `i`. */
function readDouble(s: string, i: number, line: number): Quoted {
  let out = "";
  let from = i + 1;
  let surrogate = false;
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (c === '"') {
      out += s.slice(from, k);
      if (surrogate && UNPAIRED.test(out)) throw new YamlError("a \\u escape in a double-quoted scalar is half of a surrogate pair", line);
      return { value: out, end: k + 1 };
    }
    if (c !== "\\") continue;
    out += s.slice(from, k);
    if (++k >= s.length) break; // a backslash that ends the line continues the scalar on the next one
    if (s[k] === "u") {
      const hex = s.slice(k + 1, k + 5);
      if (!HEX4.test(hex)) throw new YamlError("\\u in a double-quoted scalar must be followed by four hex digits", line);
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdfff) surrogate = true;
      out += String.fromCharCode(code);
      k += 4;
    } else {
      const escaped = ESCAPES.get(s.charAt(k));
      if (escaped === undefined) {
        throw new YamlError('unsupported escape in a double-quoted scalar; the escapes are \\\\ \\" \\/ \\n \\t \\r \\0 \\uXXXX', line);
      }
      out += escaped;
    }
    from = k + 1;
  }
  throw new YamlError(MULTI_LINE_QUOTED, line);
}

/** The single-quoted scalar that opens at `i`. */
function readSingle(s: string, i: number, line: number): Quoted {
  let out = "";
  let from = i + 1;
  for (let k = from; k < s.length; k++) {
    if (s[k] !== "'") continue;
    out += s.slice(from, k);
    if (s[k + 1] !== "'") return { value: out, end: k + 1 };
    out += "'";
    from = ++k + 1;
  }
  throw new YamlError(MULTI_LINE_QUOTED, line);
}

/** Refuse a plain scalar or key that starts with a character YAML reserves, by the name of what it would be. */
function refuseIndicator(c: string | undefined, line: number): void {
  if (c === "&") throw new YamlError("anchors (&name) are not supported", line);
  if (c === "*") throw new YamlError("aliases (*name) are not supported; quote a value that starts with *", line);
  if (c === "!") throw new YamlError("tags (!name) are not supported; quote a value that starts with !", line);
  if (c === "|" || c === ">") throw new YamlError("block scalars (| and >) are not supported", line);
  if (c === "%" || c === "@" || c === "`") throw new YamlError("a plain scalar cannot start with %, @ or `; quote it", line);
}

/** The value of a plain scalar: a boolean, null or a number where the core schema says so, else the text itself. */
function typed(text: string, line: number): YamlValue {
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (text === "null" || text === "Null" || text === "NULL" || text === "~") return null;
  if (!NUMBER.test(text)) return text;
  const n = Number(text);
  if (!Number.isFinite(n)) throw new YamlError("a number is too large", line);
  return n === 0 ? 0 : n; // no negative zero
}

/** After a quoted scalar or a flow collection, only white space and a comment may follow on the line. */
function endOfValue(s: string, i: number, line: number, what: string): void {
  const k = skipWs(s, i);
  if (k < s.length && !(s[k] === "#" && k > i)) throw new YamlError(`unexpected text after ${what}`, line);
}

// --------------------------------------------------------------------------------------------- keys

interface Key {
  key: string;
  /** The index past the colon. */
  after: number;
}

/**
 * The key at `i`, when the text there is a mapping entry: a key, then a colon followed by white space or the end of
 * the line. null when it is something else (a scalar or a flow collection). Text that is an entry in YAML but has a
 * key outside the subset is refused here.
 */
function readKey(s: string, i: number, line: number): Key | null {
  const c = s[i];
  if (c === '"' || c === "'") {
    const q = c === '"' ? readDouble(s, i, line) : readSingle(s, i, line);
    const k = skipWs(s, q.end);
    return isColon(s, k) ? { key: q.value, after: k + 1 } : null;
  }
  if (c === "[" || c === "{") return null; // a flow collection: read, and refused as a key, where values are read
  const j = keyEnd(s, i);
  let k = skipWs(s, j);
  if (isColon(s, k)) {
    if (j === i) throw new YamlError("a key is missing before the colon", line);
    return { key: s.slice(i, j), after: k + 1 };
  }
  if (c === "?" && breaks(s, i + 1)) throw new YamlError(COMPLEX_KEY, line);
  refuseIndicator(c, line);
  // Not a plain key. With a ": " further on (before any comment) the line is still an entry in YAML, under a key that
  // has to be quoted here; without one it is a scalar.
  for (k = j; k < s.length; k++) {
    if (s[k] === "#" && k > i && isWs(s[k - 1])) break;
    if (!isColon(s, k)) continue;
    if (s.startsWith("<<", i) && skipWs(s, i + 2) === k) throw new YamlError("merge keys (<<) are not supported", line);
    throw new YamlError('a key with characters other than letters, digits, "_", "." and "-" must be quoted', line);
  }
  return null;
}

// --------------------------------------------------------------------------------------------- blocks

type YamlMap = { [key: string]: YamlValue };

/** One open block: the collection being filled and the column its entries start in. */
interface Frame {
  readonly indent: number;
  /** 1 for the document's own collection, one more for each collection inside it. */
  readonly depth: number;
  /** The mapping being filled, or null when the block is a sequence. */
  readonly map: YamlMap | null;
  /** The sequence being filled, or null when the block is a mapping. */
  readonly seq: YamlValue[] | null;
  /** A sequence that starts in its parent key's own column ("key:", then "- item" under the "k"). */
  readonly flush: boolean;
  /** A mapping's last key. */
  key: string;
  /** The last entry has nothing after its colon or dash: a block nested under it becomes its value (null so far). */
  open: boolean;
  /** The last entry's value is a plain scalar on its line, which a deeper line would continue in YAML. */
  plain: boolean;
}

/** Add an entry with a null value to the frame's collection: the next item, or `key` in a mapping. */
function add(f: Frame, key: string): void {
  if (f.seq) f.seq.push(null);
  else if (f.map) f.map[key] = null;
  f.key = key;
}

/** Give the frame's last entry its value. */
function fill(f: Frame, value: YamlValue): void {
  if (f.seq) f.seq[f.seq.length - 1] = value;
  else if (f.map) f.map[f.key] = value;
}

/** A limit as given, or the default when it is missing or not a number from 0 up (so a bad limit never lifts a cap). */
const limitOf = (given: number | undefined, fallback: number): number =>
  typeof given === "number" && given >= 0 ? given : fallback;

/**
 * Parses the subset described in the header. Throws only YamlError. An empty or comment-only file is null.
 * `limits` replaces the fields of DEFAULT_YAML_LIMITS it names.
 */
export function parseYaml(text: string, limits?: Partial<YamlLimits>): YamlValue {
  if (typeof text !== "string") throw new YamlError("the file is not text", 0);
  const max: YamlLimits = {
    maxBytes: limitOf(limits?.maxBytes, DEFAULT_YAML_LIMITS.maxBytes),
    maxDepth: limitOf(limits?.maxDepth, DEFAULT_YAML_LIMITS.maxDepth),
    maxNodes: limitOf(limits?.maxNodes, DEFAULT_YAML_LIMITS.maxNodes),
  };
  if (text.length > max.maxBytes) throw new YamlError(`file is larger than ${max.maxBytes} bytes`, 0);

  const stack: Frame[] = [];
  let root: YamlValue | undefined; // undefined until the document has a value
  let single = false; // the document is a scalar or a flow collection on one line: nothing may follow it
  let singlePlain = false;
  let nodes = 0;

  const count = (line: number): void => {
    if (++nodes > max.maxNodes) throw new YamlError(`the file has more than ${max.maxNodes} values`, line);
  };
  const within = (depth: number, line: number): void => {
    if (depth > max.maxDepth) throw new YamlError(`nesting is deeper than ${max.maxDepth} levels`, line);
  };

  /** Open a block in column `indent` as the value of `parent`'s last entry, or as the document without a parent. */
  const open = (parent: Frame | undefined, sequence: boolean, indent: number, flush: boolean, line: number): Frame => {
    const depth = parent ? parent.depth + 1 : 1;
    within(depth, line);
    const map: YamlMap | null = sequence ? null : {};
    const seq: YamlValue[] | null = sequence ? [] : null;
    const frame: Frame = { indent, depth, map, seq, flush, key: "", open: false, plain: false };
    const value: YamlValue = seq ?? map;
    if (parent) {
      fill(parent, value); // in place of the null its entry was counted with
      parent.open = false;
      parent.plain = false;
    } else {
      count(line);
      root = value;
    }
    stack.push(frame);
    return frame;
  };

  /** The flow sequence that opens at `i`: scalars between commas, closed on the same line. */
  const flow = (s: string, i: number, line: number): { value: YamlValue[]; end: number } => {
    const items: YamlValue[] = [];
    let k = i + 1;
    for (;;) {
      // at the start of an item, or at the "]" that ends the list
      k = skipWs(s, k);
      const c = s[k];
      if (c === "]") return { value: items, end: k + 1 };
      if (k >= s.length || c === "#") throw new YamlError(MULTI_LINE_FLOW, line);
      if (c === ",") throw new YamlError("a flow sequence has an empty item", line);
      if (c === "[" || c === "{") throw new YamlError(NESTED_FLOW, line);
      count(line);
      if (c === '"' || c === "'") {
        const q = c === '"' ? readDouble(s, k, line) : readSingle(s, k, line);
        items.push(q.value);
        k = skipWs(s, q.end);
      } else {
        refuseIndicator(c, line);
        const alone = breaks(s, k + 1) || s[k + 1] === "," || s[k + 1] === "]";
        if (c === "?" && alone) throw new YamlError(COMPLEX_KEY, line);
        if (c === "-" && alone) throw new YamlError(FLOW_DASH, line);
        const start = k;
        for (; k < s.length; k++) {
          const ch = s[k];
          if (ch === "," || ch === "]" || (ch === "#" && isWs(s[k - 1]))) break;
          if (ch === "[" || ch === "{" || ch === "}") throw new YamlError(FLOW_BRACKET, line);
          // "a: b", "a:" before a comma or the bracket: a mapping of one pair in YAML
          if (ch === ":" && (breaks(s, k + 1) || s[k + 1] === "," || s[k + 1] === "]")) throw new YamlError(FLOW_MAPPING, line);
        }
        let end = k;
        while (end > start && isWs(s[end - 1])) end--;
        items.push(typed(s.slice(start, end), line));
      }
      // after an item
      const d = s[k];
      if (d === ",") k++;
      else if (d === "]") return { value: items, end: k + 1 };
      else if (k >= s.length || d === "#") throw new YamlError(MULTI_LINE_FLOW, line);
      else if (d === ":") throw new YamlError(FLOW_MAPPING, line);
      else throw new YamlError("a comma is missing between the items of a flow sequence", line);
    }
  };

  /**
   * The value that starts at `i` and ends its line: a scalar, a flow sequence or {}. `depth` is the depth a
   * collection there has. `plain` says the value is a plain scalar.
   */
  const inline = (s: string, i: number, line: number, depth: number): { value: YamlValue; plain: boolean } => {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c === '"' ? readDouble(s, i, line) : readSingle(s, i, line);
      endOfValue(s, q.end, line, "a quoted scalar");
      return { value: q.value, plain: false };
    }
    if (c === "[") {
      within(depth, line);
      const f = flow(s, i, line);
      endOfValue(s, f.end, line, "a flow sequence");
      return { value: f.value, plain: false };
    }
    if (c === "{") {
      const k = skipWs(s, i + 1);
      if (s[k] !== "}") throw new YamlError(FLOW_MAPPING, line);
      within(depth, line);
      endOfValue(s, k + 1, line, "{}");
      return { value: {}, plain: false };
    }
    refuseIndicator(c, line);
    if (c === "," || c === "]" || c === "}") throw new YamlError("a value that starts with , ] or } must be quoted", line);
    if (c === "?" && breaks(s, i + 1)) throw new YamlError(COMPLEX_KEY, line);
    if (c === "-" && breaks(s, i + 1)) throw new YamlError(DASH_AFTER_KEY, line); // a dash item's own "- " never comes here
    let end = s.length;
    for (let k = i; k < s.length; k++) {
      const ch = s[k];
      if (ch === "#" && k > i && isWs(s[k - 1])) {
        end = k;
        break;
      }
      if (ch === ":" && breaks(s, k + 1)) throw new YamlError('a plain scalar cannot contain ": " or end with ":"; quote it', line);
    }
    while (end > i && isWs(s[end - 1])) end--;
    return { value: typed(s.slice(i, end), line), plain: true };
  };

  /** Start the entry `key` in the mapping `frame`. */
  const enter = (frame: Frame, key: Key, line: number): void => {
    count(line);
    if (FORBIDDEN_KEYS.has(key.key)) throw new YamlError(`the key "${key.key}" is not allowed`, line);
    if (frame.map !== null && Object.hasOwn(frame.map, key.key)) {
      throw new YamlError(SHOWN_KEY.test(key.key) ? `duplicate key "${key.key}"` : "duplicate key", line);
    }
    add(frame, key.key);
  };

  /**
   * Read the line from `from`, just past an entry's dash or colon, as the value of the frame's last entry: one scalar
   * or flow collection, or nothing, which leaves the entry null and open for a block on the following lines.
   */
  const rest = (frame: Frame, s: string, from: number, line: number): void => {
    const at = skipWs(s, from);
    frame.open = at >= s.length || s[at] === "#";
    frame.plain = false;
    if (frame.open) return;
    const v = inline(s, at, line, frame.depth + 1);
    fill(frame, v.value);
    frame.plain = v.plain;
  };

  /** Take one line of content: `indent` spaces, then text that is neither blank nor a comment. */
  const block = (s: string, indent: number, line: number): void => {
    // Where the line stands, before what it holds: close the blocks it is to the left of, and refuse a line that
    // belongs to none. `top` is then the innermost block still open.
    let top = stack.at(-1);
    let closed = false;
    while (top !== undefined && top.indent > indent) {
      stack.pop();
      closed = true;
      top = stack.at(-1);
    }
    if (top === undefined && root !== undefined) {
      if (!single) throw new YamlError(DEDENTED, line);
      throw new YamlError(singlePlain && !startsEntry(s, indent) ? MULTI_LINE_PLAIN : AFTER_DOCUMENT, line);
    }
    if (top !== undefined && top.indent < indent) {
      if (closed) throw new YamlError(DEDENTED, line);
      if (!top.open) throw new YamlError(top.plain && !startsEntry(s, indent) ? MULTI_LINE_PLAIN : DEEPER, line);
    }

    const dash = isDash(s, indent);
    const key = dash ? null : readKey(s, indent, line);
    const loose = !dash && key === null; // a scalar or a flow collection on a line of its own: no "- ", no "key:"
    if (top === undefined) {
      if (loose) {
        count(line);
        const v = inline(s, indent, line, 1);
        root = v.value;
        single = true;
        singlePlain = v.plain;
        return;
      }
      top = open(undefined, dash, indent, false, line);
    } else if (top.indent < indent) {
      if (loose) throw new YamlError(OWN_LINE, line);
      top = open(top, dash, indent, false, line);
    } else if (dash) {
      if (top.map !== null) {
        // "- " in a mapping's column: the sequence of the key above, when that key has no value yet
        if (!top.open) throw new YamlError(ITEM_AFTER_VALUE, line);
        top = open(top, true, indent, true, line);
      }
    } else {
      if (top.seq !== null) {
        // a key in a sequence's column ends a sequence that sits in its parent key's column, and nothing else
        const below = top.flush ? stack.at(-2) : undefined;
        if (below === undefined) throw new YamlError(EXPECTED_ITEM, line);
        stack.pop();
        top = below;
      }
      if (key === null) throw new YamlError(EXPECTED_ENTRY, line);
    }

    // `top` is now the mapping that takes `key`, or without a key the sequence that takes this line's item.
    if (key !== null) {
      enter(top, key, line);
      rest(top, s, key.after, line);
      return;
    }
    count(line);
    add(top, "");
    const at = skipWs(s, indent + 1);
    if (isDash(s, at)) throw new YamlError(DASH_ON_DASH, line);
    const first = at < s.length && s[at] !== "#" ? readKey(s, at, line) : null;
    if (first === null) {
      rest(top, s, at, line);
      return;
    }
    // The item is a mapping that starts on the dash line ("- name: a"): its keys stand in the column of this first
    // one, so the gap after the dash is its indentation.
    if (s.slice(indent + 1, at).includes("\t")) throw new YamlError(TABS, line);
    const item = open(top, false, at, false, line);
    enter(item, first, line);
    rest(item, s, first.after, line);
  };

  let started = false; // a "---" line or content was read: another "---" would start a second document
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let line = 1; pos <= text.length; line++) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl;
    const s = text.slice(pos, end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end);
    pos = end + 1;
    const bad = UNREADABLE.exec(s);
    if (bad) throw unreadable(bad[0], line);
    let indent = 0;
    while (s[indent] === " ") indent++;
    if (indent >= s.length || s[indent] === "#") continue;
    if (s[indent] === "\t") {
      const k = skipWs(s, indent);
      if (k >= s.length || s[k] === "#") continue; // white space only, or a comment: nothing is indented
      throw new YamlError(TABS, line);
    }
    if (indent === 0) {
      if (s[0] === "%") throw new YamlError("directives (%YAML, %TAG) are not supported", line);
      if ((s.startsWith("---") || s.startsWith("...")) && breaks(s, 3)) {
        if (s[0] === "." || started) throw new YamlError(MANY_DOCUMENTS, line);
        started = true;
        const k = skipWs(s, 3);
        if (k < s.length && s[k] !== "#") throw new YamlError(MARKER_CONTENT, line);
        continue;
      }
    }
    started = true;
    block(s, indent, line);
  }
  return root ?? null;
}
