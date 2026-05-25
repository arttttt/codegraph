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
// Java (return-type-first) and Kotlin (`fun`-first).
const JAVA_BINDING_RE =
  /@(Provides|Binds)\b[\s\S]*?(?:public|private|protected|abstract|static|final|default|\s)*\b([\w.<>]+)\s+(\w+)\s*\(\s*(?:@\w+(?:\([^)]*\))?\s+)?([\w.<>]+)\s+(\w+)\s*[,)]/g;
const KOTLIN_BINDING_RE =
  /@(Provides|Binds)\b[\s\S]*?\bfun\s+(\w+)\s*\(\s*(\w+)\s*:\s*([\w.<>?]+)[\s\S]*?\)\s*:\s*([\w.<>?]+)/g;

/** Strip generics and dotted qualifiers down to the bare type name. */
function bareTypeName(t: string): string {
  return (t.replace(/<.*$/, '').replace(/\?$/, '').split('.').pop() ?? t).trim();
}

/** 1-indexed line number of `index` in `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Find the body that immediately follows the method head ending at `headEndIdx`. */
function bodyAfter(text: string, headEndIdx: number): string {
  // For Java: `{ … }`; for Kotlin: either `{ … }` or `= expr`. Read up to
  // the first balanced `}` or, for expression bodies, up to the end of the
  // following statement (newline / `}` / EOF). Conservative — we just need
  // to see whether the body literally returns the param.
  const slice = text.slice(headEndIdx, headEndIdx + 400);
  return slice;
}

/** Does the body look like `return paramName;` (Java) or `= paramName` / `return paramName` (Kotlin)? */
function isIdentityBody(body: string, paramName: string): boolean {
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:return\\s+|=\\s*)${escaped}\\s*(?:[;\\n}]|$)`).test(body);
}

// Multibinding contributors (`@IntoMap` / `@IntoSet`) share an interface
// across many impls — the runtime injection point is `Map<K, V>` or
// `Set<V>`, NEVER bare V. So we still emit a binding node (the
// contribution IS a binding) but we tag it so the `@Inject` lookup
// doesn't fan one bare-V injection out to every contributor.
const MULTIBINDING_RE = /@(?:IntoMap|IntoSet|ElementsIntoSet)\b/;

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
    let implName: string;
    let paramName: string;
    if (language === 'kotlin') {
      // groups: 1=anno, 2=methodName, 3=paramName, 4=paramType, 5=returnType
      methodName = m[2]!;
      paramName = m[3]!;
      implName = bareTypeName(m[4]!);
      ifaceName = bareTypeName(m[5]!);
    } else {
      // groups: 1=anno, 2=returnType, 3=methodName, 4=paramType, 5=paramName
      ifaceName = bareTypeName(m[2]!);
      methodName = m[3]!;
      implName = bareTypeName(m[4]!);
      paramName = m[5]!;
    }
    if (!ifaceName || !implName || ifaceName === implName) continue;
    const headEndIdx = m.index + m[0].length;
    const body = bodyAfter(moduleBody, headEndIdx);
    // `@Binds` is always pure (abstract). `@Provides` must literally return
    // the param to count as a binding — anything else is a factory.
    if (annotation === 'Provides' && !isIdentityBody(body, paramName)) continue;
    // Multibinding contributors carry `@IntoMap`/`@IntoSet` within the
    // captured annotation+head span.
    const multibinding = MULTIBINDING_RE.test(m[0]);
    out.push({
      annotation,
      methodName,
      ifaceName,
      implName,
      paramName,
      line: bodyStartLine + lineOf(moduleBody, m.index) - 1,
      body,
      multibinding,
    });
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

function parseCtorParamTypes(paramList: string, language: 'java' | 'kotlin'): string[] {
  const out: string[] = [];
  for (let p of paramList.split(',')) {
    p = p.trim();
    if (!p) continue;
    if (language === 'kotlin') {
      // `[val|var] [@Anno] name: Type[ = default]`
      const m = /:\s*([\w.<>?]+)/.exec(p);
      if (m) out.push(bareTypeName(m[1]!));
    } else {
      // Java: `[final] [@Anno(...)] Type name`
      const cleaned = p.replace(/^(?:final\s+|@\w+(?:\([^)]*\))?\s+)+/g, '');
      const m = /^([\w.<>]+)\s+\w+/.exec(cleaned);
      if (m) out.push(bareTypeName(m[1]!));
    }
  }
  return out;
}

/** Pull every `@Inject` field type out of a class body. */
function parseInjectFieldTypes(classBody: string, language: 'java' | 'kotlin'): string[] {
  const out: string[] = [];
  const RE = language === 'kotlin' ? INJECT_FIELD_KOTLIN_RE : INJECT_FIELD_JAVA_RE;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(classBody))) out.push(bareTypeName(m[1]!));
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
    const iface = b.name.slice(0, arrow);
    for (const e of queries.getOutgoingEdges(b.id, ['references'])) {
      const impl = queries.getNodeById(e.target);
      if (!impl) continue;
      const arr = ifaceToImpls.get(iface);
      if (arr) arr.push(impl); else ifaceToImpls.set(iface, [impl]);
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
  const emit = (cls: Node, paramType: string) => {
    const impls = ifaceToImpls.get(paramType);
    if (!impls) return;
    for (const impl of impls) {
      if (impl.id === cls.id) continue;
      const key = `${cls.id}>${impl.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: cls.id,
        target: impl.id,
        kind: 'references',
        line: cls.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'dagger-inject', via: paramType },
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
      for (const t of parseCtorParamTypes(m[1]!, lang)) emit(cls, t);
    }

    for (const t of parseInjectFieldTypes(body, lang)) emit(cls, t);
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
        const bindingId = `dagger-binding:${filePath}:${p.line}:${p.ifaceName}->${p.implName}`;
        const sigPrefix = `@${p.annotation}${p.multibinding ? ' @IntoMap/Set' : ''}`;
        const bindingNode: Node = {
          id: bindingId,
          kind: 'binding',
          name: `${p.ifaceName}->${p.implName}`,
          // `multibinding:` prefix lets the `@Inject` lookup tell map/set
          // contributors apart from regular interface bindings without an
          // extra DB column.
          qualifiedName: `${filePath}::${p.multibinding ? 'multibinding' : 'binding'}:${p.ifaceName}->${p.implName}`,
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
