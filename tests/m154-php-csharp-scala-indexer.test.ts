import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { getIndexerForFile } from "../src/graph/language-indexers";
import { phpIndexer } from "../src/graph/language-indexers/php";
import { csharpIndexer } from "../src/graph/language-indexers/c-sharp";
import { scalaIndexer } from "../src/graph/language-indexers/scala";

function makeClient(): { wrapper: GraphClient; inner: GraphifyClient } {
  const inner = new GraphifyClient();
  const wrapper: GraphClient = {
    async upsertNodes(nodes) {
      await inner.upsertNodes(nodes);
    },
    async upsertEdges(edges) {
      await inner.upsertEdges(edges);
    },
    async queryByKeyword(query) {
      return inner.queryByKeyword(query);
    },
  };
  return { wrapper, inner };
}

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `graphflow-m154-${label}-`));
}

describe("M154 PHP, C# and Scala indexers", () => {
  it("indexes PHP class and method symbols via indexWorkspaceFiles", async () => {
    const root = tmpRoot("php");
    try {
      writeFileSync(
        join(root, "UserService.php"),
        [
          "<?php",
          "namespace App\\Core;",
          "",
          "final class UserService extends BaseService implements UserInterface {",
          "    public function fetchUser(int $id): ?User {",
          "        return $this->find($id);",
          "    }",
          "}",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".php"] });
      const snap = inner.snapshot();
      const symbolNames = snap.nodes
        .filter((n) => n.type === "Symbol")
        .map((n) => (n.metadata?.name as string) ?? "");

      expect(symbolNames).toContain("UserService");
      expect(symbolNames).toContain("fetchUser");

      const cls = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "UserService"
      );
      expect(cls?.metadata?.kind).toBe("class");

      const method = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "fetchUser"
      );
      expect(method?.metadata?.kind).toBe("method");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexes C# class and method symbols via indexWorkspaceFiles", async () => {
    const root = tmpRoot("csharp");
    try {
      writeFileSync(
        join(root, "UserService.cs"),
        [
          "using System.Collections.Generic;",
          "",
          "namespace App.Core {",
          "  public class UserService : BaseService, IUser {",
          "    public User FetchUser(int id) {",
          "      return Find(id);",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".cs"] });
      const snap = inner.snapshot();
      const symbolNames = snap.nodes
        .filter((n) => n.type === "Symbol")
        .map((n) => (n.metadata?.name as string) ?? "");

      expect(symbolNames).toContain("UserService");
      expect(symbolNames).toContain("FetchUser");

      const cls = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "UserService"
      );
      expect(cls?.metadata?.kind).toBe("class");

      const method = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "FetchUser"
      );
      expect(method?.metadata?.kind).toBe("method");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexes Scala class and def symbols via indexWorkspaceFiles", async () => {
    const root = tmpRoot("scala");
    try {
      writeFileSync(
        join(root, "UserService.scala"),
        [
          "package app.core",
          "",
          "class UserService extends BaseService {",
          "  def fetchUser(id: Int): User = {",
          "    find(id)",
          "  }",
          "}",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".scala"] });
      const snap = inner.snapshot();
      const symbolNames = snap.nodes
        .filter((n) => n.type === "Symbol")
        .map((n) => (n.metadata?.name as string) ?? "");

      expect(symbolNames).toContain("UserService");
      expect(symbolNames).toContain("fetchUser");

      const cls = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "UserService"
      );
      expect(cls?.metadata?.kind).toBe("class");

      const method = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "fetchUser"
      );
      expect(method?.metadata?.kind).toBe("method");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves indexers for .php, .cs and .scala extensions", () => {
    expect(getIndexerForFile("UserService.php")?.language).toBe("php");
    expect(getIndexerForFile("UserService.cs")?.language).toBe("c-sharp");
    expect(getIndexerForFile("UserService.scala")?.language).toBe("scala");
  });

  it("extracts PHP definitions, imports, calls and inheritance", async () => {
    const result = await phpIndexer.extract(
      "Sample.php",
      [
        "<?php",
        "namespace App\\Core;",
        "use App\\Util\\Logger;",
        "",
        "interface UserInterface {}",
        "trait Loggable {}",
        "",
        "class UserService extends BaseService implements UserInterface {",
        "    use Loggable;",
        "    private $cache;",
        "",
        "    public function fetchUser(int $id): ?User {",
        "        $this->warmup();",
        "        return $this->find($id);",
        "    }",
        "}",
        "",
        "function globalHelper($x) {}",
      ].join("\n")
    );

    const kinds = new Map(result.symbols.map((s) => [s.name, s.kind]));
    expect(kinds.get("UserService")).toBe("class");
    expect(kinds.get("UserInterface")).toBe("interface");
    expect(kinds.get("Loggable")).toBe("trait");
    expect(kinds.get("fetchUser")).toBe("method");
    expect(kinds.get("cache")).toBe("field");
    expect(kinds.get("globalHelper")).toBe("function");

    const fetchUser = result.symbols.find((s) => s.name === "fetchUser");
    expect(fetchUser?.visibility).toBe("public");
    expect(fetchUser?.paramsCount).toBe(1);
    expect(fetchUser?.line).toBe(12);
    expect(fetchUser?.endLine).toBe(15);

    expect(result.imports.some((i) => i.module === "App/Util/Logger")).toBe(true);

    expect(result.calls).toContainEqual({ callee: "find", caller: "fetchUser", line: 14 });
    expect(result.inherits).toContainEqual({
      child: "UserService",
      parent: "BaseService",
      kind: "extends",
      line: 8,
    });
    expect(result.inherits).toContainEqual({
      child: "UserService",
      parent: "UserInterface",
      kind: "implements",
      line: 8,
    });
  });

  it("extracts C# definitions, imports, calls and inheritance", async () => {
    const result = await csharpIndexer.extract(
      "Sample.cs",
      [
        "using System.Collections.Generic;",
        "",
        "namespace App.Core {",
        "  public class UserService : BaseService, IUser {",
        "    private readonly Logger logger;",
        "",
        "    public UserService(Logger logger) {",
        "      this.logger = logger;",
        "    }",
        "",
        "    public User FetchUser(int id) {",
        "      logger.Info(\"fetch\");",
        "      return Find(id);",
        "    }",
        "  }",
        "",
        "  public interface IUser {}",
        "  public struct Point {}",
        "  public enum Mode { On, Off }",
        "}",
      ].join("\n")
    );

    const kinds = new Map(result.symbols.map((s) => [s.name, s.kind]));
    expect(result.symbols.find((s) => s.name === "UserService" && s.kind === "class")).toBeDefined();
    expect(kinds.get("IUser")).toBe("interface");
    expect(kinds.get("Point")).toBe("struct");
    expect(kinds.get("Mode")).toBe("enum");
    expect(kinds.get("FetchUser")).toBe("method");
    expect(kinds.get("logger")).toBe("field");

    const ctor = result.symbols.find((s) => s.name === "UserService" && s.kind === "constructor");
    expect(ctor?.paramsCount).toBe(1);

    const fetchUser = result.symbols.find((s) => s.name === "FetchUser");
    expect(fetchUser?.visibility).toBe("public");
    expect(fetchUser?.paramsCount).toBe(1);
    expect(fetchUser?.returnType).toBe("User");
    expect(fetchUser?.line).toBe(11);
    expect(fetchUser?.endLine).toBe(14);

    expect(result.imports.some((i) => i.module === "System/Collections/Generic")).toBe(true);

    expect(result.calls).toContainEqual({ callee: "Find", caller: "FetchUser", line: 13 });
    expect(result.inherits).toContainEqual({
      child: "UserService",
      parent: "BaseService",
      kind: "extends",
      line: 4,
    });
    expect(result.inherits).toContainEqual({
      child: "UserService",
      parent: "IUser",
      kind: "implements",
      line: 4,
    });
  });

  it("extracts Scala definitions, imports, calls and inheritance", async () => {
    const result = await scalaIndexer.extract(
      "Sample.scala",
      [
        "package app.core",
        "import scala.collection.mutable",
        "",
        "class UserService extends BaseService with Logging {",
        "  private val logger = new Logger()",
        "",
        "  def fetchUser(id: Int): User = {",
        "    logger.info(\"fetch\")",
        "    find(id)",
        "  }",
        "}",
        "",
        "trait UserRepository {",
        "  def find(id: Int): User",
        "}",
        "",
        "object UserService {",
        "  def apply() = new UserService()",
        "}",
        "",
        "case class Point(x: Int, y: Int)",
      ].join("\n")
    );

    const kinds = new Map(result.symbols.map((s) => [s.name, s.kind]));
    expect(result.symbols.find((s) => s.name === "UserService" && s.kind === "class")).toBeDefined();
    expect(kinds.get("UserRepository")).toBe("trait");
    expect(kinds.get("Point")).toBe("class");
    expect(result.symbols.filter((s) => s.name === "UserService").map((s) => s.kind)).toContain("object");

    const fetchUser = result.symbols.find((s) => s.name === "fetchUser");
    expect(fetchUser?.kind).toBe("method");
    expect(fetchUser?.paramsCount).toBe(1);
    expect(fetchUser?.returnType).toBe("User");
    expect(fetchUser?.line).toBe(7);
    expect(fetchUser?.endLine).toBe(10);

    const apply = result.symbols.find((s) => s.name === "apply");
    expect(apply?.kind).toBe("method");

    expect(result.imports.some((i) => i.module === "scala.collection.mutable")).toBe(true);

    expect(result.calls).toContainEqual({ callee: "find", caller: "fetchUser", line: 9 });
    expect(result.inherits).toContainEqual({
      child: "UserService",
      parent: "BaseService",
      kind: "extends",
      line: 4,
    });
    expect(result.inherits).toContainEqual({
      child: "UserService",
      parent: "Logging",
      kind: "extends",
      line: 4,
    });
  });

  it("reports endLine spanning class and method bodies for all three languages", async () => {
    const php = await phpIndexer.extract(
      "Span.php",
      ["<?php", "class App {", "    public function run() {", "        return 1;", "    }", "}"].join("\n")
    );
    expect(php.symbols.find((s) => s.name === "App")?.endLine).toBe(6);
    expect(php.symbols.find((s) => s.name === "run")?.endLine).toBe(5);

    const csharp = await csharpIndexer.extract(
      "Span.cs",
      [
        "public class App {",
        "    public int Run() {",
        "        return 1;",
        "    }",
        "}",
      ].join("\n")
    );
    expect(csharp.symbols.find((s) => s.name === "App")?.endLine).toBe(5);
    expect(csharp.symbols.find((s) => s.name === "Run")?.endLine).toBe(4);

    const scala = await scalaIndexer.extract(
      "Span.scala",
      ["class App {", "  def run(): Int = {", "    1", "  }", "}"].join("\n")
    );
    expect(scala.symbols.find((s) => s.name === "App")?.endLine).toBe(5);
    expect(scala.symbols.find((s) => s.name === "run")?.endLine).toBe(4);
  });
});
