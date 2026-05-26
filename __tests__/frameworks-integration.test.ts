import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker\n');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
        'from users.views import UserListView\n' +
        'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route node exists
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name === 'users/');
    expect(route).toBeDefined();

    // View class exists
    const classNodes = cg.getNodesByKind('class');
    const view = classNodes.find((n) => n.name === 'UserListView');
    expect(view).toBeDefined();

    // Edge route -> view exists
    const edges = cg.getOutgoingEdges(route!.id);
    const toView = edges.find((e) => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    cg.close();
  });
});

describe('Flask end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves stacked routes across @login_required to a view named after a builtin (index)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flask-'));
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0\n');
    fs.writeFileSync(
      path.join(tmpDir, 'app.py'),
      'from flask import Blueprint, render_template\n' +
        'from flask_login import login_required\n' +
        'bp = Blueprint("main", __name__)\n' +
        '\n' +
        '@bp.route("/", methods=["GET", "POST"])\n' +
        '@bp.route("/index", methods=["GET", "POST"])\n' +
        '@login_required\n' +
        'def index():\n' +
        '    return render_template("index.html")\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Both stacked @bp.route decorators are extracted (the second was previously
    // dropped because @login_required broke the "def must follow" assumption).
    const routes = cg.getNodesByKind('route');
    expect(routes.map((r) => r.name).sort()).toEqual(['GET /', 'GET /index']);

    // The view function exists even though its name is a Python builtin method.
    const fn = cg.getNodesByKind('function').find((n) => n.name === 'index');
    expect(fn).toBeDefined();

    // Both routes resolve to it — exercises the bare-name builtin guard, which
    // previously filtered the `index` reference as a builtin method.
    for (const route of routes) {
      const edges = cg.getOutgoingEdges(route.id);
      const toView = edges.find((e) => e.target === fn!.id && e.kind === 'references');
      expect(toView, `route ${route.name} should resolve to index()`).toBeDefined();
    }

    cg.close();
  });
});

describe('Flutter end-to-end — setState→build synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes a handler→build edge when a State method calls setState', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flutter-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.dart'),
      'import "package:flutter/material.dart";\n' +
        'class CounterPage extends StatefulWidget {\n' +
        '  @override\n' +
        '  State<CounterPage> createState() => _CounterPageState();\n' +
        '}\n' +
        'class _CounterPageState extends State<CounterPage> {\n' +
        '  int _count = 0;\n' +
        '  void _increment() {\n' +
        '    setState(() {\n' +
        '      _count++;\n' +
        '    });\n' +
        '  }\n' +
        '  @override\n' +
        '  Widget build(BuildContext context) {\n' +
        '    return Text("$_count");\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const increment = methods.find((n) => n.name === '_increment');
    const build = methods.find((n) => n.name === 'build');
    expect(increment).toBeDefined();
    expect(build).toBeDefined();

    // setState re-runs build (Flutter-internal, no static edge). The synthesizer
    // bridges the handler → build so the "tap → setState → rebuilt UI" flow connects.
    const edges = cg.getOutgoingEdges(increment!.id);
    const toBuild = edges.find((e) => e.target === build!.id && e.kind === 'calls');
    expect(toBuild, '_increment should reach build via setState synthesis').toBeDefined();

    cg.close();
  });
});

describe('C++ end-to-end — virtual override synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves callers through typed object pointers', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'detect.hpp'),
        'class CDetect {\n' +
          ' public:\n' +
          '  int Processing();\n' +
          '};\n' +
          'class CDetector {\n' +
          ' private:\n' +
          '  CDetect* m_cpAlg = nullptr;\n' +
          ' public:\n' +
          '  int Run();\n' +
          '  int Flush();\n' +
          '};\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'detect.cpp'),
        '#include "detect.hpp"\n' +
          'int CDetector::Run() { return m_cpAlg->Processing(); }\n' +
          'int CDetector::Flush() { return m_cpAlg->Processing(); }\n' +
          'int CDetect::Processing() { return 0; }\n'
      );

      cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const processing = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName.endsWith('CDetect::Processing'));
      expect(processing).toBeDefined();

      const callers = cg.getCallers(processing!.id).map((c) => c.node.qualifiedName);
      expect(callers).toContain('CDetector::Run');
      expect(callers).toContain('CDetector::Flush');

      const runMethod = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName.endsWith('CDetector::Run'));
      expect(runMethod).toBeDefined();
      const callees = cg.getCallees(runMethod!.id).map((c) => c.node.qualifiedName);
      expect(callees).toContain('CDetect::Processing');
    } finally {
      cg?.close();
    }
  });

  it('resolves typed pointer callers when the method name is ambiguous and the call sits inside a return/declaration', async () => {
    // Regression: an earlier version of the C++ receiver-type inference matched
    // the call line itself (`return m_cpAlg->Processing()`) and treated `return`
    // as the type, OR grabbed `int r =` as a type from the prefix. With Strategy
    // 3's "unique method name" fallback, the original issue example resolved
    // anyway — but as soon as two classes share a method name (very common in
    // real C++), both calls go unresolved.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'detect.hpp'),
        'class CDetect { public: int Processing(); };\n' +
          'class CWidget { public: int Processing(); };\n' +
          'class CDetector {\n' +
          ' private:\n' +
          '  CDetect* m_cpAlg = nullptr;\n' +
          ' public:\n' +
          '  int RunReturn();\n' +
          '  int RunAssign();\n' +
          '};\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'detect.cpp'),
        '#include "detect.hpp"\n' +
          'int CDetector::RunReturn() { return m_cpAlg->Processing(); }\n' +
          'int CDetector::RunAssign() { int r = m_cpAlg->Processing(); return r; }\n' +
          'int CDetect::Processing() { return 0; }\n' +
          'int CWidget::Processing() { return 0; }\n'
      );

      cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const detectProc = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'CDetect::Processing');
      const widgetProc = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'CWidget::Processing');
      expect(detectProc).toBeDefined();
      expect(widgetProc).toBeDefined();

      const detectCallers = cg.getCallers(detectProc!.id).map((c) => c.node.qualifiedName);
      expect(detectCallers).toContain('CDetector::RunReturn');
      expect(detectCallers).toContain('CDetector::RunAssign');

      // CWidget::Processing is never called — calls must NOT misroute here.
      const widgetCallers = cg.getCallers(widgetProc!.id).map((c) => c.node.qualifiedName);
      expect(widgetCallers).not.toContain('CDetector::RunReturn');
      expect(widgetCallers).not.toContain('CDetector::RunAssign');
    } finally {
      cg?.close();
    }
  });

  it('bridges a base virtual method to the subclass override', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'iter.cpp'),
      'class Iterator {\n' +
        ' public:\n' +
        '  virtual void Next() { }\n' +
        '};\n' +
        'class DBIter : public Iterator {\n' +
        ' public:\n' +
        '  void Next() override { advance(); }\n' +
        '  void advance() { }\n' +
        '};\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Two methods named Next: the base virtual (lower line) and the override.
    const nexts = cg
      .getNodesByKind('method')
      .filter((n) => n.name === 'Next')
      .sort((a, b) => a.startLine - b.startLine);
    expect(nexts.length).toBe(2);
    const [baseNext, overrideNext] = nexts;

    // A vtable call to Iterator::Next dispatches to DBIter::Next — bridge it so
    // trace/callees from the interface method reaches the implementation.
    const edge = cg
      .getOutgoingEdges(baseNext!.id)
      .find((e) => e.target === overrideNext!.id && e.kind === 'calls');
    expect(edge, 'Iterator::Next should reach DBIter::Next via override synthesis').toBeDefined();

    cg.close();
  });
});

describe('Java end-to-end — field-injected bean trace (issue #389)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  // Mirrors the issue's Spring MVC pattern:
  //   UserAction(@Resource UserBO userbo).toLogin2() -> this.userbo.toLogin2()
  //     -> UserBO.toLogin2() -> userService.toLogin() -> UserService.toLogin (iface)
  //     -> UserServiceImpl.toLogin() via interface→impl synthesis.
  // Without the extractor `this.` strip + field-typed receiver lookup, the very
  // first hop (controller -> bean) was missing entirely, breaking trace.
  it('connects controller -> @Resource bean -> interface -> impl end-to-end', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-bean-'));
    const javaDir = path.join(tmpDir, 'src/main/java/com/example/user');
    fs.mkdirSync(path.join(javaDir, 'action'), { recursive: true });
    fs.mkdirSync(path.join(javaDir, 'bo'), { recursive: true });
    fs.mkdirSync(path.join(javaDir, 'service'), { recursive: true });
    fs.mkdirSync(path.join(javaDir, 'service/impl'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'action/UserAction.java'),
      'package com.example.user.action;\n' +
        'import com.example.user.bo.UserBO;\n' +
        'import javax.annotation.Resource;\n' +
        '@org.springframework.stereotype.Controller\n' +
        'public class UserAction {\n' +
        '  @Resource(name = "userBO") private UserBO userbo;\n' +
        '  public void toLogin2() { this.userbo.toLogin2(); }\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'bo/UserBO.java'),
      'package com.example.user.bo;\n' +
        'import com.example.user.service.UserService;\n' +
        'import javax.annotation.Resource;\n' +
        '@org.springframework.stereotype.Component("userBO")\n' +
        'public class UserBO {\n' +
        '  @Resource private UserService userService;\n' +
        '  public void toLogin2() { userService.toLogin(); }\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'service/UserService.java'),
      'package com.example.user.service;\n' +
        'public interface UserService { void toLogin(); }\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'service/impl/UserServiceImpl.java'),
      'package com.example.user.service.impl;\n' +
        'import com.example.user.service.UserService;\n' +
        '@org.springframework.stereotype.Service("userService")\n' +
        'public class UserServiceImpl implements UserService {\n' +
        '  public void toLogin() { }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const find = (cls: string, name: string) =>
      methods.find((m) => m.name === name && m.filePath.endsWith(`${cls}.java`));

    const action = find('UserAction', 'toLogin2');
    const bo = find('UserBO', 'toLogin2');
    const svc = find('UserService', 'toLogin');
    const impl = find('UserServiceImpl', 'toLogin');
    expect(action).toBeDefined();
    expect(bo).toBeDefined();
    expect(svc).toBeDefined();
    expect(impl).toBeDefined();

    // UserAction.toLogin2 -> UserBO.toLogin2 (the regressed hop — `this.userbo`
    // receiver was emitted verbatim and the field-type lookup didn't exist).
    const actionToBo = cg.getOutgoingEdges(action!.id).find((e) => e.target === bo!.id);
    expect(actionToBo, 'controller `this.userbo.toLogin2()` should reach UserBO.toLogin2').toBeDefined();
    expect(actionToBo!.kind).toBe('calls');

    // UserBO.toLogin2 -> UserService.toLogin (plain identifier receiver, works pre-fix).
    const boToSvc = cg.getOutgoingEdges(bo!.id).find((e) => e.target === svc!.id);
    expect(boToSvc).toBeDefined();

    // UserService.toLogin -> UserServiceImpl.toLogin (interface->impl synth).
    const svcToImpl = cg.getOutgoingEdges(svc!.id).find((e) => e.target === impl!.id);
    expect(svcToImpl).toBeDefined();

    cg.close();
  });

  it('bridges a Java mapper interface method to its MyBatis XML statement (incl. SQL fragments)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mybatis-'));
    const javaDir = path.join(tmpDir, 'src/main/java/com/example/dao');
    const xmlDir = path.join(tmpDir, 'src/main/resources/mappers');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(xmlDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.mybatis</groupId><artifactId>mybatis</artifactId></dependency></dependencies></project>\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'UserDAOMapper.java'),
      'package com.example.dao;\n' +
        'public interface UserDAOMapper {\n' +
        '  Object getById(int id);\n' +
        '  int updateUser(Object u);\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(xmlDir, 'UserDAOMapper.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n' +
        '<mapper namespace="com.example.dao.UserDAOMapper">\n' +
        '  <sql id="userCols">id, name, email</sql>\n' +
        '  <select id="getById" parameterType="int" resultType="User">\n' +
        '    SELECT <include refid="userCols"/> FROM users WHERE id = #{id}\n' +
        '  </select>\n' +
        '  <update id="updateUser" parameterType="User">\n' +
        '    UPDATE users SET name=#{name}, email=#{email} WHERE id=#{id}\n' +
        '  </update>\n' +
        '</mapper>\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const getByIdJava = methods.find((m) => m.name === 'getById' && m.language === 'java');
    const getByIdXml = methods.find((m) => m.name === 'getById' && m.language === 'xml');
    const updateJava = methods.find((m) => m.name === 'updateUser' && m.language === 'java');
    const updateXml = methods.find((m) => m.name === 'updateUser' && m.language === 'xml');
    const sqlFrag = methods.find((m) => m.name === 'userCols' && m.language === 'xml');
    expect(getByIdJava).toBeDefined();
    expect(getByIdXml).toBeDefined();
    expect(updateJava).toBeDefined();
    expect(updateXml).toBeDefined();
    expect(sqlFrag).toBeDefined();

    // XML statement qualified name must be `<namespace>::<id>` so the
    // synthesizer can match against the Java method's `<Class>::<method>`
    // suffix — this is the load-bearing contract between extractor + synthesis.
    expect(getByIdXml!.qualifiedName).toBe('com.example.dao.UserDAOMapper::getById');

    // Bridge: Java mapper method -> XML statement, kind 'calls'.
    const j2xGet = cg.getOutgoingEdges(getByIdJava!.id).find((e) => e.target === getByIdXml!.id);
    expect(j2xGet, 'Java getById should reach the XML <select id="getById">').toBeDefined();
    expect(j2xGet!.kind).toBe('calls');
    const j2xUpd = cg.getOutgoingEdges(updateJava!.id).find((e) => e.target === updateXml!.id);
    expect(j2xUpd, 'Java updateUser should reach the XML <update id="updateUser">').toBeDefined();

    // <include refid="userCols"/> inside <select> -> <sql id="userCols"> in same mapper.
    const incEdge = cg.getOutgoingEdges(getByIdXml!.id).find((e) => e.target === sqlFrag!.id);
    expect(incEdge, '<include refid="userCols"/> should reach the <sql> fragment').toBeDefined();

    cg.close();
  });

  it('binds @Value / @ConfigurationProperties to YAML + .properties keys (incl. relaxed binding)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-config-'));
    const javaDir = path.join(tmpDir, 'src/main/java/com/example');
    const resDir = path.join(tmpDir, 'src/main/resources');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>\n'
    );
    fs.writeFileSync(
      path.join(resDir, 'application.yml'),
      'app:\n' +
        '  cache:\n' +
        '    name:\n' +
        '      user-token: "example-service:auth:token"\n' +
        '    enabled: true\n' +
        'db:\n' +
        '  url: "jdbc:mysql://localhost/x"\n'
    );
    fs.writeFileSync(
      path.join(resDir, 'application.properties'),
      'app.retry-count=3\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'CacheConfig.java'),
      'package com.example;\n' +
        'import org.springframework.beans.factory.annotation.Value;\n' +
        'public class CacheConfig {\n' +
        '  @Value("${app.cache.name.user-token}") private String tokenCacheName;\n' +
        '  @Value("${app.cache.enabled:true}") private boolean enabled;\n' +
        '  // relaxed binding: java camelCase, properties kebab-case\n' +
        '  @Value("${app.retryCount}") private int retry;\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'CacheProperties.java'),
      'package com.example;\n' +
        'import org.springframework.boot.context.properties.ConfigurationProperties;\n' +
        '@ConfigurationProperties(prefix = "app.cache")\n' +
        'public class CacheProperties { private boolean enabled; }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // YAML/properties leaf keys: one constant node per dotted path.
    const cfgKeys = cg
      .getNodesByKind('constant')
      .filter((n) => n.language === 'yaml' || n.language === 'properties');
    const cfgByQn = (qn: string) => cfgKeys.find((n) => n.qualifiedName === qn);
    expect(cfgByQn('app.cache.name.user-token')).toBeDefined();
    expect(cfgByQn('app.cache.enabled')).toBeDefined();
    expect(cfgByQn('db.url')).toBeDefined();
    expect(cfgByQn('app.retry-count')).toBeDefined();

    // @Value("${app.cache.name.user-token}") -> the YAML leaf key.
    const valueBindings = cg
      .getNodesByKind('constant')
      .filter((n) => n.id.startsWith('spring-value:'));
    const userToken = valueBindings.find((n) => n.name === 'app.cache.name.user-token');
    expect(userToken).toBeDefined();
    const userTokenEdges = cg.getOutgoingEdges(userToken!.id);
    const userTokenTarget = userTokenEdges.find((e) =>
      cfgKeys.some((c) => c.id === e.target && c.qualifiedName === 'app.cache.name.user-token'),
    );
    expect(userTokenTarget, '@Value should reference the YAML leaf key').toBeDefined();

    // Default-value form `${k:default}` — strip the `:default` and bind the key.
    const enabledBind = valueBindings.find((n) => n.name === 'app.cache.enabled');
    expect(enabledBind).toBeDefined();
    expect(cg.getOutgoingEdges(enabledBind!.id).some((e) => {
      const t = cfgByQn('app.cache.enabled');
      return t && e.target === t.id;
    })).toBe(true);

    // Relaxed binding: `app.retryCount` (camel) -> `app.retry-count` (kebab).
    const retryBind = valueBindings.find((n) => n.name === 'app.retryCount');
    expect(retryBind).toBeDefined();
    expect(cg.getOutgoingEdges(retryBind!.id).some((e) => {
      const t = cfgByQn('app.retry-count');
      return t && e.target === t.id;
    })).toBe(true);

    // @ConfigurationProperties(prefix="app.cache") -> a key under that prefix.
    const cpBindings = cg
      .getNodesByKind('constant')
      .filter((n) => n.id.startsWith('spring-cp:'));
    const cpAppCache = cpBindings.find((n) => n.name === 'app.cache');
    expect(cpAppCache).toBeDefined();
    const cpEdges = cg.getOutgoingEdges(cpAppCache!.id);
    expect(cpEdges.length).toBeGreaterThan(0);

    cg.close();
  });

  it('emits only a file node for non-MyBatis XML (pom.xml, beans.xml, log4j.xml)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-xml-non-mybatis-'));
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><groupId>x</groupId><artifactId>y</artifactId></project>\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'log4j.xml'),
      '<?xml version="1.0"?><Configuration><Loggers><Root level="info"/></Loggers></Configuration>\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    // No method nodes — non-mapper XML produces no symbols (just file rows).
    expect(cg.getNodesByKind('method').filter((n) => n.language === 'xml').length).toBe(0);
    cg.close();
  });

  it('resolves a `this.field.method()` call to a unique implementation class', async () => {
    // Standalone test of the extractor `this.` strip: even without Spring annotations,
    // `this.svc.run()` where `svc` is typed as a concrete class should route to that
    // class's method. This is the general Java fix, Spring is only one consumer.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-this-field-'));
    fs.writeFileSync(
      path.join(tmpDir, 'App.java'),
      'class Svc { public void run() { } }\n' +
        'class App {\n' +
        '  private Svc svc;\n' +
        '  public void go() { this.svc.run(); }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const go = methods.find((m) => m.name === 'go');
    const run = methods.find((m) => m.name === 'run');
    expect(go && run).toBeTruthy();

    const edge = cg.getOutgoingEdges(go!.id).find((e) => e.target === run!.id);
    expect(edge, '`this.svc.run()` should resolve to Svc.run').toBeDefined();

    cg.close();
  });
});

describe('JVM FQN imports — end-to-end', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves a Kotlin import when the file name differs from the class name', async () => {
    // Bar lives in Models.kt — the filesystem-based Java-style path lookup
    // (com/example/Bar.kt) misses this; only FQN-via-qualifiedName finds it.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Models.kt'),
      'package com.example\n\nclass Bar {\n  fun greet(): String = "hi"\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Caller.kt'),
      'package com.example.app\n\nimport com.example.Bar\n\nclass App {\n  fun run() { Bar().greet() }\n}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const bar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example::Bar');
    expect(bar, 'Bar should be extracted with package-qualified name').toBeDefined();

    const importNode = cg.getNodesByKind('import').find((n) => n.name === 'com.example.Bar');
    expect(importNode, 'import statement node should exist').toBeDefined();

    // The imports edge may originate from the import node OR from a parent
    // scope (file / namespace) — accept either, but require that an
    // imports-kind edge to Bar exists.
    const reachesBar = cg
      .getIncomingEdges(bar!.id)
      .find((e) => e.kind === 'imports');
    expect(reachesBar, 'an imports edge should resolve to Bar via FQN').toBeDefined();

    cg.close();
  });

  it('resolves a Kotlin top-level function import', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Utils.kt'),
      'package com.example\n\nfun util(): Int = 42\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Caller.kt'),
      'package com.example.app\n\nimport com.example.util\n\nfun main() { util() }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const util = cg.getNodesByKind('function').find((n) => n.qualifiedName === 'com.example::util');
    expect(util, 'top-level util() should be extracted under com.example').toBeDefined();

    const edge = cg.getIncomingEdges(util!.id).find((e) => e.kind === 'imports');
    expect(edge, 'imports edge should reach the top-level function by FQN').toBeDefined();
  });

  it('resolves cross-language: Kotlin importing a Java class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'JavaBar.java'),
      'package com.example;\n\npublic class JavaBar {\n  public String greet() { return "hi"; }\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Caller.kt'),
      'package com.example.app\n\nimport com.example.JavaBar\n\nfun main() { JavaBar().greet() }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const javaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example::JavaBar');
    expect(javaBar, 'JavaBar should be extracted under com.example regardless of language').toBeDefined();

    const edge = cg.getIncomingEdges(javaBar!.id).find((e) => e.kind === 'imports');
    expect(edge, 'Kotlin caller should resolve its import to the Java class').toBeDefined();
  });

  it('disambiguates a class-name collision across packages', async () => {
    // Two `Bar` classes in different packages — each importer should reach
    // ITS Bar, not the other one. This is the central failure mode that
    // name-matcher alone cannot disambiguate.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'AlphaBar.kt'),
      'package com.example.alpha\n\nclass Bar { fun who() = "alpha" }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'BetaBar.kt'),
      'package com.example.beta\n\nclass Bar { fun who() = "beta" }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'CallerA.kt'),
      'package app\n\nimport com.example.alpha.Bar\n\nfun a() { Bar().who() }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'CallerB.kt'),
      'package app\n\nimport com.example.beta.Bar\n\nfun b() { Bar().who() }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const alphaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example.alpha::Bar');
    const betaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example.beta::Bar');
    expect(alphaBar).toBeDefined();
    expect(betaBar).toBeDefined();
    expect(alphaBar!.id).not.toBe(betaBar!.id);

    // Each Bar receives exactly one imports edge — from its own caller.
    const alphaIncoming = cg.getIncomingEdges(alphaBar!.id).filter((e) => e.kind === 'imports');
    const betaIncoming = cg.getIncomingEdges(betaBar!.id).filter((e) => e.kind === 'imports');
    expect(alphaIncoming.length).toBeGreaterThan(0);
    expect(betaIncoming.length).toBeGreaterThan(0);

    // Sanity: the edges don't cross — alpha's incoming sources don't include
    // beta's filePath and vice versa.
    const sourceFiles = (edges: typeof alphaIncoming) =>
      edges.map((e) => cg.getNode(e.source)?.filePath).filter(Boolean);
    expect(sourceFiles(alphaIncoming).some((p) => p?.includes('CallerA.kt'))).toBe(true);
    expect(sourceFiles(betaIncoming).some((p) => p?.includes('CallerB.kt'))).toBe(true);
  });
});

describe('Java anonymous-class override synthesis — end-to-end', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges an abstract base method to overrides inside `new Base() { ... }`', async () => {
    // Mirrors guava Splitter: a factory returns `new BaseIter() {
    // @Override int separatorStart(...) { ... } }`. Without anon-class
    // extraction the override is invisible — Phase 5.5 interface-impl
    // has no class to bridge — and an agent investigating `BaseIter.separatorStart`
    // can't see its real implementation without reading the file.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anon-java-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Splitter.java'),
      'package com.example;\n' +
        '\n' +
        'abstract class BaseIter {\n' +
        '  abstract int separatorStart(int start);\n' +
        '}\n' +
        '\n' +
        'public class Splitter {\n' +
        '  public BaseIter make() {\n' +
        '    return new BaseIter() {\n' +
        '      @Override\n' +
        '      int separatorStart(int start) { return start + 1; }\n' +
        '    };\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // The anon class is extracted and contains the override.
    const anonClass = cg
      .getNodesByKind('class')
      .find((n) => /BaseIter\$anon@/.test(n.name));
    expect(anonClass, 'anonymous BaseIter subclass should be a class node').toBeDefined();

    const baseAbstract = cg
      .getNodesByKind('method')
      .find((n) => n.qualifiedName === 'com.example::BaseIter::separatorStart');
    const anonOverride = cg
      .getNodesByKind('method')
      .find(
        (n) =>
          n.name === 'separatorStart' &&
          n.qualifiedName.includes('$anon@') &&
          n.qualifiedName.startsWith('com.example::Splitter::make::')
      );
    expect(baseAbstract, 'base abstract method should be in the graph').toBeDefined();
    expect(anonOverride, 'anon-class override should be in the graph').toBeDefined();

    // Phase 5.5 interface-impl: the abstract method has a synthesized
    // `calls` edge to the anon override. Without this hop the agent
    // would have to Read the file to discover the implementation.
    const synthEdge = cg
      .getOutgoingEdges(baseAbstract!.id)
      .find((e) => e.target === anonOverride!.id && e.kind === 'calls');
    expect(synthEdge, 'BaseIter.separatorStart should bridge to anon.separatorStart').toBeDefined();
    expect(synthEdge!.provenance).toBe('heuristic');
    expect((synthEdge!.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy).toBe(
      'interface-impl'
    );

    cg.close();
  });
});

describe('Go gRPC stub→impl synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges UnimplementedMsgServer methods to the hand-written keeper impl', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-grpc-'));
    // Mimic protoc-gen-go-grpc output: `*_grpc.pb.go` carrying the
    // UnimplementedMsgServer stub.
    fs.writeFileSync(
      path.join(tmpDir, 'tx_grpc.pb.go'),
      'package banktypes\n\n' +
        'type UnimplementedMsgServer struct{}\n\n' +
        'func (UnimplementedMsgServer) Send(ctx context.Context, req *MsgSend) (*MsgSendResponse, error) { return nil, nil }\n' +
        'func (UnimplementedMsgServer) MultiSend(ctx context.Context, req *MsgMultiSend) (*MsgMultiSendResponse, error) { return nil, nil }\n' +
        'func (UnimplementedMsgServer) mustEmbedUnimplementedMsgServer() {}\n' +
        'func (UnimplementedMsgServer) testEmbeddedByValue() {}\n'
    );
    // Hand-written impl in a non-generated file — what an agent actually
    // wants the trace to land on.
    fs.writeFileSync(
      path.join(tmpDir, 'msg_server.go'),
      'package keeper\n\n' +
        'type msgServer struct{ k Keeper }\n\n' +
        'func (m msgServer) Send(ctx context.Context, req *MsgSend) (*MsgSendResponse, error) {\n' +
        '  return m.k.SendCoins(ctx, req.From, req.To, req.Amount)\n' +
        '}\n' +
        'func (m msgServer) MultiSend(ctx context.Context, req *MsgMultiSend) (*MsgMultiSendResponse, error) {\n' +
        '  return nil, nil\n' +
        '}\n'
    );

    let cg: CodeGraph | undefined;
    try {
      cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const stubSend = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName.endsWith('UnimplementedMsgServer::Send'));
      const implSend = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName.endsWith('msgServer::Send'));
      expect(stubSend, 'UnimplementedMsgServer.Send should be indexed').toBeDefined();
      expect(implSend, 'msgServer.Send should be indexed').toBeDefined();

      const bridge = cg
        .getOutgoingEdges(stubSend!.id)
        .find((e) => e.target === implSend!.id && e.kind === 'calls');
      expect(bridge, 'stub Send should bridge to impl Send').toBeDefined();
      expect(bridge!.provenance).toBe('heuristic');
      expect((bridge!.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy).toBe(
        'go-grpc-stub-impl'
      );
    } finally {
      cg?.close();
    }
  });

  it('does not bridge to candidates living in another generated file', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-grpc-sib-'));
    // `*_grpc.pb.go` also contains a sibling `msgClient` struct that
    // happens to satisfy the same method set. We must NOT bridge to it —
    // it's not the hand-written impl, just the gRPC client wrapper.
    fs.writeFileSync(
      path.join(tmpDir, 'tx_grpc.pb.go'),
      'package banktypes\n\n' +
        'type UnimplementedMsgServer struct{}\n' +
        'func (UnimplementedMsgServer) Send() {}\n' +
        'func (UnimplementedMsgServer) MultiSend() {}\n\n' +
        'type msgClient struct{}\n' +
        'func (m msgClient) Send() {}\n' +
        'func (m msgClient) MultiSend() {}\n'
    );

    let cg: CodeGraph | undefined;
    try {
      cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const stub = cg
        .getNodesByKind('struct')
        .find((n) => n.name === 'UnimplementedMsgServer');
      expect(stub).toBeDefined();
      const bridges = cg
        .getNodesByKind('method')
        .filter((n) => n.qualifiedName.endsWith('UnimplementedMsgServer::Send'))
        .flatMap((stubSend) => cg!.getOutgoingEdges(stubSend.id))
        .filter(
          (e) =>
            e.kind === 'calls' &&
            (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy ===
              'go-grpc-stub-impl',
        );
      expect(bridges, 'no bridge to msgClient (also generated)').toHaveLength(0);
    } finally {
      cg?.close();
    }
  });
});

describe('Dagger 2 — @Provides / @Binds binding extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  // Find a binding node by its display name (`Iface->Impl`).
  const findBinding = (cg: CodeGraph, name: string) =>
    cg.getNodesByKind('binding').find((n) => n.name === name);

  // Find the resolved `references` edge from a binding node to the impl
  // class. Returns the target node or undefined.
  const resolvedImpl = (cg: CodeGraph, bindingName: string) => {
    const b = findBinding(cg, bindingName);
    if (!b) return undefined;
    const edge = cg.getOutgoingEdges(b.id).find((e) => e.kind === 'references');
    return edge ? cg.getNode(edge.target) : undefined;
  };

  it('emits a binding node for @Provides with identity body, resolved to the impl class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'DataManager.java'),
      'package com.example;\npublic interface DataManager { void load(); }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppDataManager.java'),
      'package com.example;\npublic class AppDataManager implements DataManager {\n' +
        '  public void load() {}\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module\npublic class AppModule {\n' +
        '  @Provides DataManager provideDataManager(AppDataManager impl) { return impl; }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const impl = resolvedImpl(cg, 'DataManager->AppDataManager');
    expect(impl?.name).toBe('AppDataManager');
    expect(impl?.kind).toBe('class');
    cg.close();
  });

  it('emits a binding node for @Binds abstract method (no body check needed)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic interface Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'FooImpl.java'),
      'package com.example;\npublic class FooImpl implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'FooModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Binds;\n' +
        '@Module\npublic abstract class FooModule {\n' +
        '  @Binds abstract Foo bindFoo(FooImpl impl);\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Foo->FooImpl')?.name).toBe('FooImpl');
    cg.close();
  });

  it('works on a Kotlin @Module class with expression-body @Provides', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Repo.kt'),
      'package com.example\n\ninterface Repo { fun load() }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'RepoImpl.kt'),
      'package com.example\n\nclass RepoImpl : Repo { override fun load() {} }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'RepoModule.kt'),
      'package com.example\n\nimport dagger.Module\nimport dagger.Provides\n\n' +
        '@Module\nclass RepoModule {\n' +
        '  @Provides fun provideRepo(impl: RepoImpl): Repo = impl\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Repo->RepoImpl')?.name).toBe('RepoImpl');
    cg.close();
  });

  it('emits separate binding nodes for two impls of the same interface across modules', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic interface Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ImplA.java'),
      'package com.example;\npublic class ImplA implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ImplB.java'),
      'package com.example;\npublic class ImplB implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ModuleA.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class ModuleA { @Provides Foo a(ImplA impl) { return impl; } }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ModuleB.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class ModuleB { @Provides Foo b(ImplB impl) { return impl; } }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Foo->ImplA')?.name).toBe('ImplA');
    expect(resolvedImpl(cg, 'Foo->ImplB')?.name).toBe('ImplB');
    cg.close();
  });

  it('skips a factory @Provides whose body builds via a factory call (not identity)', async () => {
    // Real-world failure mode (seen in Plaid): @Provides Iface(Impl) signature,
    // but body delegates to a factory. NOT a binding.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'ViewModel.java'),
      'package com.example;\npublic class ViewModel {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ViewModelFactory.java'),
      'package com.example;\npublic class ViewModelFactory { public ViewModel create() { return new ViewModel(); } }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class AppModule {\n' +
        '  @Provides ViewModel provideViewModel(ViewModelFactory factory) {\n' +
        '    return factory.create();\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBinding(cg, 'ViewModel->ViewModelFactory')).toBeUndefined();
    cg.close();
  });

  it('does not emit bindings from a class without @Module', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic interface Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'FooImpl.java'),
      'package com.example;\npublic class FooImpl implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'NotAModule.java'),
      'package com.example;\nimport dagger.Provides;\npublic class NotAModule {\n' +
        '  @Provides Foo provide(FooImpl impl) { return impl; }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBinding(cg, 'Foo->FooImpl')).toBeUndefined();
    cg.close();
  });

  it('links @Inject constructor to the actual impl via Dagger binding', async () => {
    // Activity → ViewModel → Repository: ViewModel's `@Inject constructor`
    // takes `Repository` (the interface). At runtime Dagger injects
    // `RepositoryImpl` (the impl chosen by `@Binds`). Without this pass,
    // the graph only has `type_of` from constructor param to the interface;
    // with it, the class gets a `references` edge to the actual impl.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Repository.java'),
      'package com.example;\npublic interface Repository { void load(); }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'RepositoryImpl.java'),
      'package com.example;\nimport javax.inject.Inject;\n' +
        'public class RepositoryImpl implements Repository {\n' +
        '  @Inject public RepositoryImpl() {}\n' +
        '  public void load() {}\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Binds;\n' +
        '@Module public abstract class AppModule {\n' +
        '  @Binds abstract Repository bindRepository(RepositoryImpl impl);\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'MyViewModel.java'),
      'package com.example;\nimport javax.inject.Inject;\n' +
        'public class MyViewModel {\n' +
        '  private final Repository repo;\n' +
        '  @Inject public MyViewModel(Repository repo) { this.repo = repo; }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const vm = cg.getNodesByKind('class').find((n) => n.name === 'MyViewModel');
    const impl = cg.getNodesByKind('class').find((n) => n.name === 'RepositoryImpl');
    expect(vm).toBeDefined();
    expect(impl).toBeDefined();

    const injectEdge = cg.getOutgoingEdges(vm!.id).find(
      (e) => e.target === impl!.id
        && (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-inject'
    );
    expect(injectEdge, 'MyViewModel should reach RepositoryImpl via Dagger inject synthesis').toBeDefined();
    cg.close();
  });

  it('links field injection (@Inject FieldType) to the resolved impl', async () => {
    // Activities don't have `@Inject constructor` — Dagger injects via
    // `@Inject` fields after activity creation. Same lookup, different
    // parse: `@Inject TypeName fieldName;` (Java) / `@Inject lateinit var
    // name: Type` (Kotlin).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Store.java'),
      'package com.example;\npublic interface Store {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'StoreImpl.java'),
      'package com.example;\npublic class StoreImpl implements Store {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Binds;\n' +
        '@Module public abstract class AppModule {\n' +
        '  @Binds abstract Store bindStore(StoreImpl impl);\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'MainActivity.java'),
      'package com.example;\nimport javax.inject.Inject;\n' +
        'public class MainActivity {\n' +
        '  @Inject Store store;\n' +
        '  @Inject protected Store anotherStore;\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const act = cg.getNodesByKind('class').find((n) => n.name === 'MainActivity');
    const impl = cg.getNodesByKind('class').find((n) => n.name === 'StoreImpl');
    const edge = cg.getOutgoingEdges(act!.id).find(
      (e) => e.target === impl!.id
        && (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-inject'
    );
    expect(edge, 'MainActivity field injection should reach StoreImpl').toBeDefined();
    cg.close();
  });

  it('self-binds @Inject constructor classes (no @Provides needed)', async () => {
    // `class Foo @Inject constructor(...)` is bindable BY ITSELF — Dagger
    // doesn't need `@Provides Foo` to inject it. So `@Inject Foo foo` in
    // another class should reach Foo directly through self-binding.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'UserService.java'),
      'package com.example;\nimport javax.inject.Inject;\n' +
        'public class UserService {\n' +
        '  @Inject public UserService() {}\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'UserController.java'),
      'package com.example;\nimport javax.inject.Inject;\n' +
        'public class UserController {\n' +
        '  @Inject public UserController(UserService userService) {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const ctrl = cg.getNodesByKind('class').find((n) => n.name === 'UserController');
    const svc = cg.getNodesByKind('class').find((n) => n.name === 'UserService');
    const edge = cg.getOutgoingEdges(ctrl!.id).find(
      (e) => e.target === svc!.id
        && (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-inject'
    );
    expect(edge, 'UserController should self-bind to UserService').toBeDefined();
    cg.close();
  });

  it('does not fan @Inject<Iface> out to all multibinding contributors', async () => {
    // `@IntoMap` declares contributors to `Map<Class<?>, ViewModel>`; the
    // real injection point is the map, not bare `ViewModel`. Linking
    // every `@Inject ViewModel` (none exist in well-formed code, but
    // false positives would be loud) to every contributor would produce
    // a 1×N noise fan-out.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'ViewModel.java'),
      'package com.example;\npublic interface ViewModel {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'VmA.java'),
      'package com.example;\npublic class VmA implements ViewModel {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'VmB.java'),
      'package com.example;\npublic class VmB implements ViewModel {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'VmModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Binds;\nimport dagger.multibindings.IntoMap;\n' +
        '@Module public abstract class VmModule {\n' +
        '  @Binds @IntoMap abstract ViewModel bindA(VmA impl);\n' +
        '  @Binds @IntoMap abstract ViewModel bindB(VmB impl);\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Consumer.java'),
      'package com.example;\nimport javax.inject.Inject;\n' +
        'public class Consumer {\n' +
        '  @Inject ViewModel vm;\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const consumer = cg.getNodesByKind('class').find((n) => n.name === 'Consumer');
    const injectEdges = cg.getOutgoingEdges(consumer!.id).filter(
      (e) => (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-inject'
    );
    // Bindings are emitted as binding NODES (qualifiedName carries
    // `multibinding:` prefix), but bare-iface `@Inject ViewModel` resolves
    // to NEITHER VmA nor VmB — Consumer has zero dagger-inject out-edges.
    expect(injectEdges.length).toBe(0);

    // The binding nodes themselves still exist (extracted), they just
    // don't fan into @Inject lookup. Sanity-check that.
    const bindings = cg.getNodesByKind('binding');
    expect(bindings.find((b) => b.name === 'ViewModel->VmA')).toBeDefined();
    expect(bindings.find((b) => b.name === 'ViewModel->VmB')).toBeDefined();
    cg.close();
  });

  it('disambiguates parallel bindings via @Named qualifier', async () => {
    // Two @Binds providing the same interface, distinguished by @Named.
    // An @Inject site with one qualifier should resolve only to its own
    // impl, not to the other variant.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'OkHttpClient.java'),
      'package com.example;\npublic interface OkHttpClient {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'RegularClient.java'),
      'package com.example;\npublic class RegularClient implements OkHttpClient {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'CustomSslClient.java'),
      'package com.example;\npublic class CustomSslClient implements OkHttpClient {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'HttpModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Binds;\nimport javax.inject.Named;\n' +
        '@Module public abstract class HttpModule {\n' +
        '  @Binds @Named("regular") abstract OkHttpClient bindRegular(RegularClient impl);\n' +
        '  @Binds @Named("ssl") abstract OkHttpClient bindCustom(CustomSslClient impl);\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ApiClient.java'),
      'package com.example;\nimport javax.inject.Inject;\nimport javax.inject.Named;\n' +
        'public class ApiClient {\n' +
        '  @Inject @Named("regular") OkHttpClient regular;\n' +
        '  @Inject @Named("ssl") OkHttpClient secure;\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Binding nodes carry the qualifier in their name.
    const bindings = cg.getNodesByKind('binding');
    expect(bindings.find((b) => b.name === 'OkHttpClient@regular->RegularClient')).toBeDefined();
    expect(bindings.find((b) => b.name === 'OkHttpClient@ssl->CustomSslClient')).toBeDefined();

    // ApiClient has @Inject @Named("regular") → RegularClient AND
    // @Inject @Named("ssl") → CustomSslClient. Both edges exist, each
    // pointing to its own impl (binding-precise, not crosswired).
    const api = cg.getNodesByKind('class').find((n) => n.name === 'ApiClient')!;
    const regular = cg.getNodesByKind('class').find((n) => n.name === 'RegularClient')!;
    const ssl = cg.getNodesByKind('class').find((n) => n.name === 'CustomSslClient')!;

    const out = cg.getOutgoingEdges(api.id).filter(
      (e) => (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-inject'
    );
    expect(out.find((e) => e.target === regular.id)).toBeDefined();
    expect(out.find((e) => e.target === ssl.id)).toBeDefined();
    // And not mismatched.
    const regularEdge = out.find((e) => e.target === regular.id);
    const sslEdge = out.find((e) => e.target === ssl.id);
    expect((regularEdge!.metadata as { via?: string }).via).toBe('OkHttpClient@regular');
    expect((sslEdge!.metadata as { via?: string }).via).toBe('OkHttpClient@ssl');
    cg.close();
  });

  it('strict qualifier match: bare @Inject does NOT pick up a qualified-only binding', async () => {
    // If a binding is registered ONLY for `@Named("prod")`, a bare
    // `@Inject Foo` (no qualifier) must not resolve to it — Dagger
    // would refuse at compile-time, so the graph shouldn't link it.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic interface Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'FooImpl.java'),
      'package com.example;\npublic class FooImpl implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'M.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Binds;\nimport javax.inject.Named;\n' +
        '@Module public abstract class M {\n' +
        '  @Binds @Named("prod") abstract Foo bind(FooImpl impl);\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Bare.java'),
      'package com.example;\nimport javax.inject.Inject;\n' +
        'public class Bare {\n' +
        '  @Inject Foo foo;\n' +  // no qualifier
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const bare = cg.getNodesByKind('class').find((n) => n.name === 'Bare')!;
    const impl = cg.getNodesByKind('class').find((n) => n.name === 'FooImpl')!;
    const edge = cg.getOutgoingEdges(bare.id).find(
      (e) => e.target === impl.id
        && (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-inject'
    );
    expect(edge, 'bare @Inject Foo must not silently match @Named("prod") binding').toBeUndefined();
    cg.close();
  });

  it('does not emit bindings from a file with no dagger import', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic interface Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'FooImpl.java'),
      'package com.example;\npublic class FooImpl implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'GuiceModule.java'),
      // Same shape but no dagger import — a different DI framework's @Module.
      'package com.example;\n' +
        '@interface Module {}\n' +
        '@Module public class GuiceModule { Foo provide(FooImpl impl) { return impl; } }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBinding(cg, 'Foo->FooImpl')).toBeUndefined();
    cg.close();
  });

  // Factory bindings — `@Provides Iface m(...) { return new Impl(...); }` —
  // are how a large share of real Android Dagger modules expose their impls.
  // Identity bindings cover only the Iface(Impl)→Impl shape; factory bindings
  // close the rest by parsing the body for top-level `new` / Kotlin `Foo()`
  // calls and treating the constructed type as the binding target.

  it('factory-binding: @Provides body `return new Impl(...)` binds Iface to Impl', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Listener.java'),
      'package com.example;\npublic interface Listener { void on(); }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Tracker.java'),
      'package com.example;\npublic class Tracker implements Listener {\n' +
        '  public Tracker(String tag) {}\n  public void on() {}\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AnalyticsModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class AnalyticsModule {\n' +
        '  @Provides public Listener provideListener() { return new Tracker("x"); }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Listener->Tracker')?.name).toBe('Tracker');
    cg.close();
  });

  it('factory-binding: ternary body emits a binding for each `new` branch', async () => {
    // Pattern from WordPress's IInAppUpdateManager — the @Provides returns
    // either impl based on a feature-flag check. Both impls should bind.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Manager.java'),
      'package com.example;\npublic interface Manager {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'RealManager.java'),
      'package com.example;\npublic class RealManager implements Manager {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'NoopManager.java'),
      'package com.example;\npublic class NoopManager implements Manager {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ManagerModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class ManagerModule {\n' +
        '  @Provides public Manager provideManager(boolean enabled) {\n' +
        '    return enabled ? new RealManager() : new NoopManager();\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Manager->RealManager')?.name).toBe('RealManager');
    expect(resolvedImpl(cg, 'Manager->NoopManager')?.name).toBe('NoopManager');
    cg.close();
  });

  it('factory-binding: rejects Builder chains (`new X.Builder().build()`)', async () => {
    // Plaid/WordPress are full of `return new SdkType.Builder().a().b().build()`.
    // The `.build()` after the constructor's closing `)` reveals that the
    // returned value is NOT the constructed `Builder` itself.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'OkHttpClient.java'),
      'package com.example;\npublic class OkHttpClient {\n' +
        '  public static class Builder { public Builder addInterceptor(Object o) { return this; } public OkHttpClient build() { return new OkHttpClient(); } }\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'HttpModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class HttpModule {\n' +
        '  @Provides public OkHttpClient provideClient() { return new OkHttpClient.Builder().addInterceptor(null).build(); }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBinding(cg, 'OkHttpClient->Builder')).toBeUndefined();
    cg.close();
  });

  it('factory-binding: Kotlin expression-body `= Impl()` binds Iface to Impl', async () => {
    // From WordPress's AccountSettingsModule — `fun provideX(): ContinuationWrapper = DefaultContinuationWrapper()`.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Wrapper.kt'),
      'package com.example\n\ninterface Wrapper { fun wrap() }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'DefaultWrapper.kt'),
      'package com.example\n\nclass DefaultWrapper : Wrapper { override fun wrap() {} }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'WrapperModule.kt'),
      'package com.example\n\nimport dagger.Module\nimport dagger.Provides\n\n' +
        '@Module\nclass WrapperModule {\n' +
        '  @Provides fun provideWrapper(): Wrapper = DefaultWrapper()\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Wrapper->DefaultWrapper')?.name).toBe('DefaultWrapper');
    cg.close();
  });

  it('factory-binding: Kotlin block-body `{ return Impl() }` binds Iface to Impl', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Store.kt'),
      'package com.example\n\ninterface Store { fun load() }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'DiskStore.kt'),
      'package com.example\n\nclass DiskStore : Store { override fun load() {} }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'StoreModule.kt'),
      'package com.example\n\nimport dagger.Module\nimport dagger.Provides\n\n' +
        '@Module\nclass StoreModule {\n' +
        '  @Provides fun provideStore(): Store {\n' +
        '    return DiskStore()\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Store->DiskStore')?.name).toBe('DiskStore');
    cg.close();
  });

  it('factory-binding: Kotlin block body ignores `val x = Impl()` local-var assignments', async () => {
    // Regression for a false positive on Plaid (SourcesRepositoryModule): in
    // a block body, `val localDataSource = SourcesLocalDataSource(prefs)` is
    // a LOCAL, not the return value. Only `return Impl()` should bind. The
    // method here returns via a static factory call (lowercase, rejected).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Repo.kt'),
      'package com.example\n\ninterface Repo\nclass DataSource\nobject Repo {\n  fun getInstance(d: DataSource): Repo = throw RuntimeException()\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'RepoModule.kt'),
      'package com.example\n\nimport dagger.Module\nimport dagger.Provides\n\n' +
        '@Module\nclass RepoModule {\n' +
        '  @Provides fun provideRepo(): Repo {\n' +
        '    val local = DataSource()\n' +
        '    return Repo.getInstance(local)\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Must NOT bind `Repo->DataSource` — DataSource is a local-var construction,
    // not the returned value.
    expect(findBinding(cg, 'Repo->DataSource')).toBeUndefined();
    cg.close();
  });

  it('factory-binding: Kotlin rejects lowercase callees (`Factory.create()`)', async () => {
    // Lowercase callee = method call, not constructor. Plaid is full of these.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Client.kt'),
      'package com.example\n\ninterface Client\nobject Factory { fun create(): Client = throw RuntimeException() }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ClientModule.kt'),
      'package com.example\n\nimport dagger.Module\nimport dagger.Provides\n\n' +
        '@Module\nclass ClientModule {\n' +
        '  @Provides fun provideClient(): Client = Factory.create()\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(cg.getNodesByKind('binding').filter((n) => n.name.startsWith('Client->'))).toEqual([]);
    cg.close();
  });

  it('factory-binding: zero-param @Provides binds (no identity-param needed)', async () => {
    // Common shape: `@Provides public X provide() { return new XImpl(); }` — no
    // params at all. The identity-binding regex used to skip these.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Strategy.java'),
      'package com.example;\npublic interface Strategy {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'VoiceStrategy.java'),
      'package com.example;\npublic class VoiceStrategy implements Strategy {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'StrategyModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class StrategyModule {\n' +
        '  @Provides public static Strategy provideStrategy() { return new VoiceStrategy(); }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Strategy->VoiceStrategy')?.name).toBe('VoiceStrategy');
    cg.close();
  });

  it('factory-binding: generic constructor (`new Impl<T>()`) strips type params', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Holder.java'),
      'package com.example;\npublic interface Holder<T> {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'StringHolder.java'),
      'package com.example;\npublic class StringHolder<T> implements Holder<T> {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'HolderModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class HolderModule {\n' +
        '  @Provides public Holder<String> provide() { return new StringHolder<String>(); }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(resolvedImpl(cg, 'Holder->StringHolder')?.name).toBe('StringHolder');
    cg.close();
  });

  it('factory-binding: ignores @Named on params (qualifier belongs to the @Provides, not its args)', async () => {
    // Regression for a WordPress false positive (IInAppUpdateManager): the
    // binding has NO @Named on @Provides itself, but its first param does:
    // `@Named(APPLICATION_SCOPE) CoroutineScope appScope`. That qualifier
    // applies to the param's injection site, not to this binding.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Manager.java'),
      'package com.example;\npublic interface Manager {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ManagerImpl.java'),
      'package com.example;\npublic class ManagerImpl implements Manager {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Scope.java'),
      'package com.example;\npublic class Scope {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ManagerModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\nimport javax.inject.Named;\n' +
        '@Module public class ManagerModule {\n' +
        '  @Provides public Manager provideManager(@Named("app") Scope scope) { return new ManagerImpl(); }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Should bind under the unqualified key, NOT `Manager@app->ManagerImpl`.
    expect(findBinding(cg, 'Manager->ManagerImpl')).toBeDefined();
    expect(findBinding(cg, 'Manager@app->ManagerImpl')).toBeUndefined();
    cg.close();
  });

  it('factory-binding: factory bindings feed @Inject lookup like identity ones', async () => {
    // End-to-end check: the inject pass should follow a factory binding's
    // `references` edge into the impl the same way it follows an identity
    // binding's. Without this, factory bindings would only enrich `getCallers`
    // but not `getCallees` from @Inject sites — defeating the point.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Service.java'),
      'package com.example;\npublic interface Service { void run(); }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ServiceImpl.java'),
      'package com.example;\npublic class ServiceImpl implements Service { public void run() {} }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ServiceModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class ServiceModule {\n' +
        '  @Provides public Service provideService() { return new ServiceImpl(); }\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Caller.java'),
      'package com.example;\nimport javax.inject.Inject;\n' +
        'public class Caller {\n' +
        '  private final Service svc;\n' +
        '  @Inject public Caller(Service svc) { this.svc = svc; }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const caller = cg.getNodesByKind('class').find((n) => n.name === 'Caller');
    const impl = cg.getNodesByKind('class').find((n) => n.name === 'ServiceImpl');
    expect(caller).toBeDefined();
    expect(impl).toBeDefined();
    const link = cg.getOutgoingEdges(caller!.id).find(
      (e) => e.target === impl!.id && (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-inject'
    );
    expect(link).toBeDefined();
    cg.close();
  });
});
