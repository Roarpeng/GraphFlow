# @roarpeng/graphflow-dsh — DeepSeek Harness bundle

Configuration-only [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle for
[GraphFlow](https://github.com/Roarpeng/GraphFlow): it registers the GraphFlow MCP server through the
shipped `@deepseek-ai/dsh-mcp-client` Cordis plugin and ships the GraphFlow skill.

- No Host or Client JavaScript, no dependencies, no build step, no install scripts.
- One bundle layer with one MCP row (`id: mcp-graphflow`, `serverName: graphflow`, stdio transport).
- Version always mirrors the root `@roarpeng/graphflow` package.

**DSH capability matrix: MCP ✅ · Skill ✅ · Rules ❌ · Hooks ❌** (details below).

## Capability matrix

| Surface | DSH bundle | Notes |
|---|---|---|
| MCP tools | ✅ | `@deepseek-ai/dsh-mcp-client` row in `cordis.patch.yml`; exposes `mcp__graphflow__gf_read`, `gf_edit`, `gf_exec`, `gf_macro` |
| Skill | ✅ | Shipped at `skills/graphflow/SKILL.md`; DSH discovers user skills from `<DSH_HOME>/skills`, so copy it there (Install step 3) |
| Rules / instructions | ❌ | DSH has no rules-file / instruction-block API; do not expect a `~/.dsh/rules` or managed Markdown block |
| Host hooks | ❌ | DSH has no PreToolUse/PostToolUse host-hook API; GraphFlow never installs DSH hooks and the bundle contains none |

`❌` means "not available on this host", not "not implemented by GraphFlow". The same GraphFlow
server, skill, and four `gf_*` tools are fully available over MCP; only the editor-style rules and
host-hook surfaces are absent on DSH.

## Install

The bundle is a normal DSH bundle (`dsh.bundle.patch` → `./cordis.patch.yml`). DSH's
`plugin_manager` installs it into the current profile (`~/.dsh/profiles/<profile>`).

1. Print the exact install spec (absolute path, no network):

   ```bash
   node scripts/install-dsh-bundle.mjs --print
   ```

2. Install the bundle with the `plugin_manager` tool:

   ```text
   plugin_manager(action: "install_bundle", target: "<absolute path to packages/graphflow-dsh>")
   ```

   `plugin_manager` needs Full access (`danger-full-access`) or explicit approval for that call.
   The bundle appears in Settings → Plugins as **GraphFlow Surgical Code Engine**. After
   activation, the model sees the `mcp__graphflow__gf_*` tools.

3. Make the skill available (DSH skill roots are user directories; a configuration-only bundle
   cannot register a skill provider by itself). Stage the bundle and copy the shipped skill into
   the user skill root:

   ```powershell
   # Windows PowerShell
   node scripts/install-dsh-bundle.mjs --stage
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
   Copy-Item -Recurse -Force ".graphflow/dsh-bundle/skills/graphflow" "$env:USERPROFILE\.dsh\skills\graphflow"
   ```

   ```bash
   # macOS / Linux
   node scripts/install-dsh-bundle.mjs --stage
   mkdir -p "$HOME/.dsh/skills"
   cp -R .graphflow/dsh-bundle/skills/graphflow "$HOME/.dsh/skills/graphflow"
   ```

   Alternatively, keep using the GraphFlow CLI installer instead of the bundle
   (`npx @roarpeng/graphflow install --agents deepseek-harness`); it writes the same skill plus a
   managed block in `~/.dsh/cordis.patch.yml`. **Use one path or the other, not both** — they
   register the same MCP row (`mcp-graphflow`) and the profile patch layer then duplicates it.

## Workspace root

Relative `gf_*` targets (`src/app.ts#main`) resolve against the MCP child's `cwd`. The bundle
patch sets:

```yaml
cwd: !!js process.env.GRAPHFLOW_WORKSPACE_ROOT || ctx.get('workingDirectory')?.defaultDirectory || process.cwd()
```

- Set `GRAPHFLOW_WORKSPACE_ROOT` to your project to pin the child process there (recommended).
- Otherwise DSH's default working directory is used, which is always an existing writable
  directory — unlike the DSH profile directory.
- Any `gf_*` call also accepts an explicit `rootDir`, which overrides `cwd` for that call.

## Uninstall

1. Remove the bundle through the same tool (or Settings → Plugins):

   ```text
   plugin_manager(action: "remove_bundle", target: "@roarpeng/graphflow-dsh")
   ```

2. Remove the copied skill if you added it:

   ```powershell
   Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\graphflow"   # Windows
   rm -rf "$HOME/.dsh/skills/graphflow"                                    # macOS / Linux
   ```

If you used the GraphFlow CLI installer instead, `npx @roarpeng/graphflow uninstall --agents deepseek-harness`
removes its own MCP block and skill and touches nothing else.

## Verification and maintenance

```bash
node scripts/install-dsh-bundle.mjs --check    # manifest, patch, skill, version, capability matrix
node scripts/install-dsh-bundle.mjs --stage    # copy + validate in .graphflow/dsh-bundle
```

`--check` is dependency-free and read-only; it never touches a real profile. The bundle version must
equal the root `package.json` version, so a release bump must update both (the check fails with
both versions shown). `skills/graphflow/SKILL.md` is a copy of the repository skill; `--stage`
refreshes it from `skills/graphflow/SKILL.md` so the staged copy cannot drift.

## Manifest provenance

The manifest shape is not guessed: it follows the shipped DSH `cordis-plugin-development` skill
(`references/mcp-bundle.md`, `templates/mcp/package.json`) and the installed
`@deepseek-ai/dsh-experimental-badge-skill-bundle` package:

- `dsh.bundle.patch` is `./cordis.patch.yml` (relative, `./`-prefixed — exactly as both references);
- a configuration-only bundle needs no Host/Client entry files, dependencies, or build scripts;
- `exports`/`files` carry the patch, `locale/*.json` display metadata, `./icon`, the README, and the
  bundled skill, per the display-metadata checklist in `references/host-plugin.md`;
- `locale/en.json` and `locale/zh.json` provide `meta.title`/`meta.description` for Plugin Manager.

The patch itself is the documented stdio form: `serverName`, `transport: stdio`, `command`,
`args`, `cwd`, `env`, `failOnStartupError` (see `@deepseek-ai/dsh-mcp-client` README).
`!!js` expressions are Loader YAML tags evaluated against the plugin context; `process.env` and
`ctx.get(...)` are both valid there (see the `cordis-composition-reference` skill).

## Files

```text
packages/graphflow-dsh/
├── package.json                 # name, version (mirrors root), dsh.bundle.patch, exports/files
├── cordis.patch.yml             # inserts @deepseek-ai/dsh-mcp-client (serverName graphflow)
├── icon.svg                     # original GraphFlow icon (Plugin Manager display)
├── locale/en.json               # meta.title / meta.description
├── locale/zh.json               # 中文 display metadata
├── README.md                    # this file
└── skills/graphflow/SKILL.md    # GraphFlow skill (copy of skills/graphflow/SKILL.md)
```
