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

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

const DAGGER_IMPORT_RE = /^import\s+dagger\./m;

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
    out.push({
      annotation,
      methodName,
      ifaceName,
      implName,
      paramName,
      line: bodyStartLine + lineOf(moduleBody, m.index) - 1,
      body,
    });
  }
  return out;
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
        const bindingNode: Node = {
          id: bindingId,
          kind: 'binding',
          name: `${p.ifaceName}->${p.implName}`,
          qualifiedName: `${filePath}::binding:${p.ifaceName}->${p.implName}`,
          filePath,
          startLine: p.line,
          endLine: p.line,
          startColumn: 0,
          endColumn: 0,
          language,
          signature: `@${p.annotation} ${p.ifaceName} ${p.methodName}(${p.implName})`,
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
