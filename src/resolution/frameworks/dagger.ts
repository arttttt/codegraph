/**
 * Dagger 2 / Hilt resolver
 *
 * Mirrors `springResolver`: per-file `extract` parses `@Module` classes
 * and emits a synthetic `binding` node for each `@Provides Iface m(Impl
 * impl) { return impl; }` (identity body) or `@Binds abstract Iface
 * m(Impl impl)` declaration, plus a `references` ref from the binding
 * node to the impl class — to be resolved by the standard name-matcher
 * chain. `@Provides` factory bodies (`return new Foo()` etc.) share the
 * Interface(Impl) shape but are NOT bindings; the body-identity check
 * filters them.
 */

import { Node, Edge } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import type { QueryBuilder } from '../../db/queries';

const DAGGER_IMPORT_RE = /^import\s+dagger\./m;
// `@Inject` itself lives in `javax.inject.Inject` (Dagger 2) or
// `jakarta.inject.Inject` (newer projects). Files using `@Inject` for
// constructor injection typically don't `import dagger.*` themselves.
const INJECT_IMPORT_RE = /^import\s+(?:dagger|javax\.inject|jakarta\.inject)\./m;

// `@Module … (class|object|abstract class) Name { … }` — match the class
// name + body line range. Comments are stripped so a `// @Module` doesn't
// pull in random class bodies.
const MODULE_CLASS_RE =
  /@Module\b[\s\S]*?\b(?:class|object|abstract\s+class)\s+(\w+)\s*(?:\([^)]*\))?\s*(?::[\s\S]*?)?\{/g;

// `@Provides` / `@Binds` followed by the method head. Allows extra
// annotations/modifiers between annotation and signature. Two heads —
// Java (return-type-first) and Kotlin (`fun`-first). The lazy `[\s\S]*?`
// inside `(...)` allows nested `@Anno(...)` annotations on params; the
// trailing `\)\s*[;{]` (Java) / `\)\s*:` (Kotlin) disambiguates the
// method's closing `)` from any annotation `)`.
const JAVA_BINDING_RE =
  /@(Provides|Binds)\b[\s\S]*?(?:public|private|protected|abstract|static|final|default|\s)*\b([\w.<>]+)\s+(\w+)\s*\(([\s\S]*?)\)\s*[;{]/g;
const KOTLIN_BINDING_RE =
  /@(Provides|Binds)\b[\s\S]*?\bfun\s+(\w+)\s*\(([\s\S]*?)\)\s*:\s*([\w.<>?]+)/g;

/** Strip generics and dotted qualifiers down to the bare type name. */
function bareTypeName(t: string): string {
  return (t.replace(/<.*$/, '').replace(/\?$/, '').split('.').pop() ?? t).trim();
}

/** 1-indexed line number of `index` in `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Walk to the `}` that closes the `{` at `openIdx`. Returns -1 if unbalanced. */
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Return the body of the binding method whose head match ends at `headEndIdx`.
 * Clamped to the method's own braces — without this, a 1500-char fixed window
 * bleeds into the NEXT method's body and a `new X(...)` there gets attributed
 * to the wrong binding's iface (real bug seen on janishar: `provideBlogAdapter`'s
 * window reached into `provideLinearLayoutManager` and emitted `BlogAdapter->LinearLayoutManager`).
 *
 * Java head match ends AT `{` or `;` (abstract @Binds). Kotlin head ends at
 * the return type; the body that follows is `= expr` (expression body) or
 * `{ block }`.
 */
function bodyOf(text: string, headEndIdx: number, language: 'java' | 'kotlin'): string {
  if (language === 'java') {
    if (text[headEndIdx - 1] !== '{') return '';
    const closeIdx = findMatchingBrace(text, headEndIdx - 1);
    if (closeIdx < 0) return text.slice(headEndIdx, headEndIdx + 1500);
    return text.slice(headEndIdx, closeIdx);
  }
  let i = headEndIdx;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] === '{') {
    const closeIdx = findMatchingBrace(text, i);
    if (closeIdx < 0) return text.slice(i + 1, i + 1 + 1500);
    return text.slice(i + 1, closeIdx);
  }
  if (text[i] === '=') {
    let j = i + 1;
    let depth = 0;
    while (j < text.length) {
      const c = text[j]!;
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && c === '\n') break;
      j++;
    }
    // Include the leading `=` so identity/factory regexes can anchor on it.
    return text.slice(i, j);
  }
  return '';
}

/** Does the body look like `return paramName;` (Java) or `= paramName` / `return paramName` (Kotlin)? */
function isIdentityBody(body: string, paramName: string): boolean {
  if (!paramName) return false;
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:return\\s+|=\\s*)${escaped}\\s*(?:[;\\n}]|$)`).test(body);
}

/** Walk to the `)` that closes the `(` at `openIdx`. Returns -1 if unbalanced or truncated. */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// `return new Impl(...)` (Java) — covers ternary alternates too (`?` / `:`
// before `new` instead of `return`).
const JAVA_FACTORY_NEW_RE =
  /(?:\breturn\b|[?:])\s*new\s+([\w.]+(?:<[^<>]*>)?)\s*\(/g;
// Kotlin block-body return: `return Impl(...)` only. Local-var assignments
// (`val x = Impl(...)`) also start with `=`, so the `=` anchor would
// false-positive any locally constructed value inside a block body — bug
// seen on Plaid's `SourcesRepositoryModule`.
const KOTLIN_FACTORY_RETURN_RE =
  /(?:\breturn\b|[?:])\s*([A-Z][\w.]*(?:<[^<>]*>)?)\s*\(/g;
// Kotlin expression-body: `= Impl(...)` at body start (the `=` is included
// in the body slice for expression-body methods; see `bodyOf`).
const KOTLIN_FACTORY_EXPR_RE =
  /^\s*=\s*([A-Z][\w.]*(?:<[^<>]*>)?)\s*\(/;

/**
 * Find Iface→Impl factory bindings inside a `@Provides` body. Returns the bare
 * names of types whose constructor sits in tail-return position. Skips:
 *  - Builder chains (`new X().build()`, `X().build()`) — the `.method` after
 *    the closing `)` reveals the value is not the constructed `X` itself.
 *  - Lowercase callees (`Factory.create()`, `foo.bar()`) — those are static or
 *    instance method calls, not constructors.
 *  - The interface itself (caller already filters `ifaceName === implName`).
 *  - Local-var assignments in Kotlin block bodies (only `return Impl()` is
 *    treated as the binding target there; expression bodies match a SEPARATE
 *    anchor `^=` since the entire body IS the return).
 */
function extractFactoryImpls(body: string, language: 'java' | 'kotlin', ifaceName: string): string[] {
  const impls: string[] = [];
  const seen = new Set<string>();

  const tryEmit = (raw: string, openParenIdx: number): void => {
    const closeParenIdx = findMatchingParen(body, openParenIdx);
    if (closeParenIdx < 0) return;
    let i = closeParenIdx + 1;
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] === '.') return;
    const bare = bareTypeName(raw);
    if (!bare || bare === ifaceName) return;
    if (!/^[A-Z]/.test(bare)) return;
    if (seen.has(bare)) return;
    seen.add(bare);
    impls.push(bare);
  };

  if (language === 'java') {
    JAVA_FACTORY_NEW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = JAVA_FACTORY_NEW_RE.exec(body))) {
      tryEmit(m[1]!, m.index + m[0].length - 1);
    }
    return impls;
  }

  // Kotlin: try expression-body first (only matches if body starts with `=`).
  const exprMatch = KOTLIN_FACTORY_EXPR_RE.exec(body);
  if (exprMatch) {
    tryEmit(exprMatch[1]!, exprMatch.index + exprMatch[0].length - 1);
    return impls;
  }
  KOTLIN_FACTORY_RETURN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KOTLIN_FACTORY_RETURN_RE.exec(body))) {
    tryEmit(m[1]!, m.index + m[0].length - 1);
  }
  return impls;
}

/** Pull the first param's type and name out of a captured param list. */
function parseFirstParam(paramList: string, language: 'java' | 'kotlin'): { type: string; name: string } | null {
  const trimmed = paramList.trim();
  if (!trimmed) return null;
  // Split on top-level commas only — annotation args like `@Named("a,b")` would
  // break a naive split, but the substring up to the first `,` is good enough
  // here since binding param annotations rarely contain commas.
  const first = trimmed.split(',')[0]!.trim();
  if (!first) return null;
  if (language === 'kotlin') {
    const m = /(?:(?:val|var)\s+)?(?:@\w+(?:\([^)]*\))?\s+)*(\w+)\s*:\s*([\w.<>?]+)/.exec(first);
    if (m) return { type: bareTypeName(m[2]!), name: m[1]! };
  } else {
    const cleaned = first.replace(/^(?:final\s+|@\w+(?:\([^)]*\))?\s+)+/g, '');
    const m = /^([\w.<>]+)\s+(\w+)/.exec(cleaned);
    if (m) return { type: bareTypeName(m[1]!), name: m[2]! };
  }
  return null;
}

// Multibinding contributors (`@IntoMap` / `@IntoSet`) share an interface
// across many impls — the runtime injection point is `Map<K, V>` or
// `Set<V>`, NEVER bare V. So we still emit a binding node (the
// contribution IS a binding) but we tag it so the `@Inject` lookup
// doesn't fan one bare-V injection out to every contributor.
const MULTIBINDING_RE = /@(?:IntoMap|IntoSet|ElementsIntoSet)\b/;
// Standard `javax.inject.@Named("...")` and `@Named(CONSTANT)`. Custom
// `@Qualifier` annotations (project-defined) would need a whole-graph
// scan to discover; for now we cover `@Named` which is by far the most
// common qualifier in real codebases (WordPress: hundreds of usages).
const NAMED_QUALIFIER_RE = /@Named\s*\(\s*([^)]+?)\s*\)/;

interface Parsed {
  annotation: 'Provides' | 'Binds';
  methodName: string;
  ifaceName: string;
  implName: string;
  paramName: string;
  /** 1-indexed line of the binding (line of `@Provides`/`@Binds`). */
  line: number;
  /** Source-text body that follows the method head (for identity check). */
  body: string;
  /** True if the binding is `@IntoMap`/`@IntoSet` (multibinding contributor). */
  multibinding: boolean;
  /** `@Named` qualifier value (raw — quote-stripped), or empty string. */
  qualifier: string;
  /** True if `implName` was extracted from a factory body (`return new Impl()`),
   *  not from an identity body (`return param`). Same lookup behavior, but the
   *  `signature` reflects the distinction so audits can spot factory bindings. */
  factory: boolean;
}

/** Build the lookup key for the iface→impls map, optionally with a qualifier. */
function makeKey(ifaceName: string, qualifier: string): string {
  return qualifier ? `${ifaceName}@${qualifier}` : ifaceName;
}

/** Strip quotes around a `@Named` arg value (`"prod"` → `prod`). */
function normalizeQualifier(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '');
}

/** Parse one Dagger module's body (between its opening `{` and its file end). */
function parseBindings(moduleBody: string, bodyStartLine: number, language: 'java' | 'kotlin'): Parsed[] {
  const out: Parsed[] = [];
  const RE = language === 'kotlin' ? KOTLIN_BINDING_RE : JAVA_BINDING_RE;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(moduleBody))) {
    const annotation = m[1] as 'Provides' | 'Binds';
    let methodName: string;
    let ifaceName: string;
    let paramList: string;
    if (language === 'kotlin') {
      // groups: 1=anno, 2=methodName, 3=paramList, 4=returnType
      methodName = m[2]!;
      paramList = m[3]!;
      ifaceName = bareTypeName(m[4]!);
    } else {
      // groups: 1=anno, 2=returnType, 3=methodName, 4=paramList
      ifaceName = bareTypeName(m[2]!);
      methodName = m[3]!;
      paramList = m[4]!;
    }
    if (!ifaceName) continue;
    const firstParam = parseFirstParam(paramList, language);

    const headEndIdx = m.index + m[0].length;
    const body = bodyOf(moduleBody, headEndIdx, language);

    // Annotations adjacent to a binding can sit BEFORE or AFTER
    // `@Provides`/`@Binds`. The match span starts AT `@Provides`/`@Binds`,
    // so multibinding / qualifier annotations placed above (the common
    // Java style) need a small lookback window. Trim it to AFTER the
    // previous declaration's `;` or `}` so a neighboring binding's
    // qualifier doesn't bleed into this one.
    let lookback = moduleBody.slice(Math.max(0, m.index - 240), m.index);
    const lastEnd = Math.max(lookback.lastIndexOf(';'), lookback.lastIndexOf('}'));
    if (lastEnd >= 0) lookback = lookback.slice(lastEnd + 1);
    // Restrict qualifier/multibinding scan to BEFORE the param list — a
    // `@Named` on a *parameter* applies to that param's injection point,
    // NOT to the binding itself (WordPress's `IInAppUpdateManager` mistakenly
    // picked up its first param's `@Named(APPLICATION_SCOPE)`). The method's
    // `(` follows the method name; `indexOf('(')` alone is wrong because an
    // annotation like `@Named("regular")` introduces an earlier `(`.
    const nameIdx = m[0].lastIndexOf(methodName);
    const paramOpen = nameIdx >= 0 ? m[0].indexOf('(', nameIdx) : m[0].indexOf('(');
    const headOnly = paramOpen >= 0 ? m[0].slice(0, paramOpen) : m[0];
    const annoSpan = lookback + headOnly;
    const multibinding = MULTIBINDING_RE.test(annoSpan);
    const qm = NAMED_QUALIFIER_RE.exec(annoSpan);
    const qualifier = qm ? normalizeQualifier(qm[1]!) : '';
    const line = bodyStartLine + lineOf(moduleBody, m.index) - 1;
    const common = { annotation, methodName, ifaceName, line, body, multibinding, qualifier };

    // `@Binds` is abstract by definition — the first param's type IS the impl.
    if (annotation === 'Binds') {
      if (!firstParam || !firstParam.type || firstParam.type === ifaceName) continue;
      out.push({ ...common, implName: firstParam.type, paramName: firstParam.name, factory: false });
      continue;
    }

    // `@Provides` identity body: `return paramName` (Java) or `= paramName` (Kotlin).
    if (firstParam && firstParam.type && firstParam.type !== ifaceName && isIdentityBody(body, firstParam.name)) {
      out.push({ ...common, implName: firstParam.type, paramName: firstParam.name, factory: false });
      continue;
    }

    // `@Provides` factory body: `return new Impl(...)` (Java) / `= Impl()` (Kotlin),
    // possibly multiple impls in a ternary.
    for (const impl of extractFactoryImpls(body, language, ifaceName)) {
      out.push({ ...common, implName: impl, paramName: '', factory: true });
    }
  }
  return out;
}

/**
 * Post-resolution pass: for each class with an `@Inject constructor`,
 * link the class to the impl chosen by each of its parameter types'
 * Dagger bindings. Without this, an `@Inject Repo repo` parameter only
 * has the existing `type_of` edge to the `Repo` *interface* — the
 * actual impl Dagger injects at runtime is invisible to the graph.
 *
 * The pass consumes `binding` nodes emitted by `extract()`: each one
 * carries the `Iface->Impl` shape in its name plus an outgoing
 * `references` edge to the impl class. So for parameter type `Repo`,
 * we look up bindings whose name starts with `Repo->` and follow the
 * binding's outgoing edge to its impl.
 */
// `@Inject` followed by a `(…)` — constructor or method injection.
const INJECT_CTOR_PARAMS_RE = /@Inject\b[^;{(]*?\(([^)]*)\)/g;
// `@Inject` followed by a Java field declaration — no `(`, ends at `=` or `;`.
// Skips modifier/annotation noise between `@Inject` and the type.
const INJECT_FIELD_JAVA_RE =
  /@Inject\b(?:\s+(?:public|private|protected|final|transient|volatile|static|@\w+(?:\([^)]*\))?))*\s+([\w.<>]+)\s+\w+\s*[=;]/g;
// Kotlin field/property injection — `@Inject [lateinit] var/val name: Type`.
const INJECT_FIELD_KOTLIN_RE =
  /@Inject\b(?:\s+@\w+(?:\([^)]*\))?)*\s+(?:lateinit\s+)?(?:var|val)\s+\w+\s*:\s*([\w.<>?]+)/g;

interface InjectPoint {
  /** Bare type at the injection site (after generics/dotted-name stripping). */
  type: string;
  /** `@Named("…")` value at the injection site, or empty. */
  qualifier: string;
}

function parseCtorParamTypes(paramList: string, language: 'java' | 'kotlin'): InjectPoint[] {
  const out: InjectPoint[] = [];
  for (let p of paramList.split(',')) {
    p = p.trim();
    if (!p) continue;
    const qm = NAMED_QUALIFIER_RE.exec(p);
    const qualifier = qm ? normalizeQualifier(qm[1]!) : '';
    if (language === 'kotlin') {
      // `[val|var] [@Anno] name: Type[ = default]`
      const m = /:\s*([\w.<>?]+)/.exec(p);
      if (m) out.push({ type: bareTypeName(m[1]!), qualifier });
    } else {
      // Java: `[final] [@Anno(...)] Type name`
      const cleaned = p.replace(/^(?:final\s+|@\w+(?:\([^)]*\))?\s+)+/g, '');
      const m = /^([\w.<>]+)\s+\w+/.exec(cleaned);
      if (m) out.push({ type: bareTypeName(m[1]!), qualifier });
    }
  }
  return out;
}

/** Pull every `@Inject` field type (plus qualifier) out of a class body. */
function parseInjectFieldTypes(classBody: string, language: 'java' | 'kotlin'): InjectPoint[] {
  const out: InjectPoint[] = [];
  const RE = language === 'kotlin' ? INJECT_FIELD_KOTLIN_RE : INJECT_FIELD_JAVA_RE;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(classBody))) {
    const qm = NAMED_QUALIFIER_RE.exec(m[0]);
    out.push({ type: bareTypeName(m[1]!), qualifier: qm ? normalizeQualifier(qm[1]!) : '' });
  }
  return out;
}

/** Does the class body contain an `@Inject` constructor (Dagger self-binds it)? */
function hasInjectConstructor(classBody: string): boolean {
  return /@Inject\b[^;{(]*?\(/.test(classBody);
}

export function daggerInjectEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  // Index `binding` nodes by interface name → impl node. Skip multibinding
  // contributors (`@IntoMap`/`@IntoSet`) — fanning every `@Inject ViewModel`
  // out to all 86 ViewModel impls produces noise edges; the real injection
  // shape for multibindings is `Map<K,V>`/`Set<V>`, not bare V.
  const ifaceToImpls = new Map<string, Node[]>();
  for (const b of queries.getNodesByKind('binding')) {
    if (b.qualifiedName.includes('::multibinding:')) continue;
    const arrow = b.name.indexOf('->');
    if (arrow <= 0) continue;
    // Binding nodes encode the qualifier in their name as `Iface@<qualifier>->Impl`.
    // The slice up to `->` is already the qualified lookup key.
    const key = b.name.slice(0, arrow);
    for (const e of queries.getOutgoingEdges(b.id, ['references'])) {
      const impl = queries.getNodeById(e.target);
      if (!impl) continue;
      const arr = ifaceToImpls.get(key);
      if (arr) arr.push(impl); else ifaceToImpls.set(key, [impl]);
    }
  }

  // First pass: any class with an `@Inject` constructor is Dagger-known and
  // can be self-bound (`@Inject FooService foo` resolves to `FooService`
  // directly, no `@Provides`/`@Binds` required). Add this to the lookup
  // table BEFORE the second pass uses it.
  const classes = queries.getNodesByKind('class').filter(
    (c) => c.language === 'java' || c.language === 'kotlin'
  );
  type Scan = { cls: Node; content: string; body: string };
  const scans: Scan[] = [];
  for (const cls of classes) {
    const content = ctx.readFile(cls.filePath);
    if (!content || !INJECT_IMPORT_RE.test(content)) continue;
    const body = sliceLines(content, cls.startLine, cls.endLine);
    if (!body || !/@Inject\b/.test(body)) continue;
    scans.push({ cls, content, body });
    if (hasInjectConstructor(body)) {
      const arr = ifaceToImpls.get(cls.name);
      if (arr) {
        if (!arr.some((n) => n.id === cls.id)) arr.push(cls);
      } else {
        ifaceToImpls.set(cls.name, [cls]);
      }
    }
  }

  if (ifaceToImpls.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const emit = (cls: Node, point: InjectPoint) => {
    // Strict qualifier match — `@Inject @Named("prod") Foo` must hit a
    // `Foo@prod->…` binding. Bare `@Inject Foo` only hits `Foo->…`.
    // Falling back to unqualified would silently link the wrong impl.
    const lookupKey = makeKey(point.type, point.qualifier);
    const impls = ifaceToImpls.get(lookupKey);
    if (!impls) return;
    for (const impl of impls) {
      if (impl.id === cls.id) continue;
      const dedupe = `${cls.id}>${impl.id}>${lookupKey}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      edges.push({
        source: cls.id,
        target: impl.id,
        kind: 'references',
        line: cls.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'dagger-inject', via: lookupKey },
      });
    }
  };

  // Second pass: harvest constructor params + field types from each
  // already-scanned class, emit edges using the lookup table.
  for (const { cls, body } of scans) {
    const lang = cls.language as 'java' | 'kotlin';

    INJECT_CTOR_PARAMS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INJECT_CTOR_PARAMS_RE.exec(body))) {
      for (const p of parseCtorParamTypes(m[1]!, lang)) emit(cls, p);
    }

    for (const p of parseInjectFieldTypes(body, lang)) emit(cls, p);
  }
  return edges;
}

/** Slice a 1-indexed line range out of source content. */
function sliceLines(content: string, startLine: number, endLine: number): string | null {
  if (!startLine || !endLine) return null;
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

export const daggerResolver: FrameworkResolver = {
  name: 'dagger',
  languages: ['java', 'kotlin'],

  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('.java') && !file.endsWith('.kt')) continue;
      const content = context.readFile(file);
      if (content && DAGGER_IMPORT_RE.test(content)) return true;
    }
    return false;
  },

  resolve(): null {
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) return { nodes: [], references: [] };
    if (!DAGGER_IMPORT_RE.test(content)) return { nodes: [], references: [] };
    const language: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
    const safe = stripCommentsForRegex(content, 'java');

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    MODULE_CLASS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODULE_CLASS_RE.exec(safe))) {
      const moduleClassStart = m.index + m[0].length; // position right after the opening `{`
      const moduleStartLine = lineOf(safe, m.index);
      // The module body conservatively spans from the opening `{` to the
      // end of file — bindings further than the next `}` block bleed in,
      // but the @Provides/@Binds regexes still match correctly and the
      // bodyAfter window keeps the identity check local to each method.
      const moduleBody = safe.slice(moduleClassStart);
      const parsed = parseBindings(moduleBody, moduleStartLine, language);

      for (const p of parsed) {
        const qSuffix = p.qualifier ? `@${p.qualifier}` : '';
        const bindingId = `dagger-binding:${filePath}:${p.line}:${p.ifaceName}${qSuffix}->${p.implName}`;
        const sigPrefix = `@${p.annotation}${p.factory ? ' (factory)' : ''}${p.multibinding ? ' @IntoMap/Set' : ''}${p.qualifier ? ' @Named(' + p.qualifier + ')' : ''}`;
        const bindingNode: Node = {
          id: bindingId,
          kind: 'binding',
          name: `${p.ifaceName}${qSuffix}->${p.implName}`,
          // `multibinding:` prefix lets the `@Inject` lookup tell map/set
          // contributors apart from regular interface bindings without an
          // extra DB column.
          qualifiedName: `${filePath}::${p.multibinding ? 'multibinding' : 'binding'}:${p.ifaceName}${qSuffix}->${p.implName}`,
          filePath,
          startLine: p.line,
          endLine: p.line,
          startColumn: 0,
          endColumn: 0,
          language,
          signature: `${sigPrefix} ${p.ifaceName} ${p.methodName}(${p.implName})`,
          updatedAt: now,
        };
        nodes.push(bindingNode);
        references.push({
          fromNodeId: bindingId,
          referenceName: p.implName,
          referenceKind: 'references',
          line: p.line,
          column: 0,
          filePath,
          language,
        });
      }
    }

    return { nodes, references };
  },
};
