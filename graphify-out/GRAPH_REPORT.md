# Graph Report - .  (2026-06-01)

## Corpus Check
- Corpus is ~39,757 words - fits in a single context window. You may not need a graph.

## Summary
- 973 nodes ， 1798 edges ， 67 communities (52 shown, 15 thin omitted)
- Extraction: 96% EXTRACTED ， 4% INFERRED ， 0% AMBIGUOUS ， INFERRED: 70 edges (avg confidence: 0.87)
- Token cost: 0 input ， 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_MCP Surface|MCP Surface]]
- [[_COMMUNITY_Language Indexers|Language Indexers]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_MCP Surface|MCP Surface]]
- [[_COMMUNITY_Test Coverage|Test Coverage]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_Test Coverage|Test Coverage]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_Test Coverage|Test Coverage]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_Test Coverage|Test Coverage]]
- [[_COMMUNITY_Test Coverage|Test Coverage]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_MCP Surface|MCP Surface]]
- [[_COMMUNITY_Test Coverage|Test Coverage]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Test Coverage|Test Coverage]]
- [[_COMMUNITY_Model Routing|Model Routing]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_Graph Storage|Graph Storage]]
- [[_COMMUNITY_Graph Client|Graph Client]]
- [[_COMMUNITY_MCP Surface|MCP Surface]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_Typescript Adddecl|Typescript Adddecl]]
- [[_COMMUNITY_VS Code Extension|VS Code Extension]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Configuration|Configuration]]
- [[_COMMUNITY_Python Extract|Python Extract]]
- [[_COMMUNITY_Rust Extract|Rust Extract]]
- [[_COMMUNITY_Feedback Collector|Feedback Collector]]
- [[_COMMUNITY_Python Pythonindexer|Python Pythonindexer]]
- [[_COMMUNITY_Rust Rustindexer|Rust Rustindexer]]
- [[_COMMUNITY_Typescript Typescriptindexer|Typescript Typescriptindexer]]
- [[_COMMUNITY_Canary Gate|Canary Gate]]
- [[_COMMUNITY_Model Routing|Model Routing]]
- [[_COMMUNITY_Learning Memory|Learning Memory]]
- [[_COMMUNITY_Context Compression|Context Compression]]

## God Nodes (most connected - your core abstractions)
1. `orchestrate()` - 30 edges
2. `orchestrate` - 27 edges
3. `GraphifyClient` - 20 edges
4. `indexWorkspaceFiles()` - 19 edges
5. `executeRolePrompt()` - 19 edges
6. `GraphNode` - 17 edges
7. `GraphClient` - 17 edges
8. `createGraphClient()` - 16 edges
9. `applySkillLearning()` - 16 edges
10. `validateConfig()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `v0.3.0 Product Convergence` --semantically_similar_to--> `v0.3.0 Release`  [INFERRED] [semantically similar]
  CHANGELOG.md ★ docs/releases/v0.3.0.md
- `Episodic Memory Feedback Loop` --conceptually_related_to--> `Format Prompt With Context`  [INFERRED]
  tests/m26-episodic-memory.test.ts ★ src/routing/provider-executor.ts
- `VS Code Panel Asset Contract` --rationale_for--> `buildGraphSnapshotHtml`  [INFERRED]
  tests/m15-vscode-panel-observability.test.ts ★ vscode-extension/src/panels.ts
- `v0.3.0 Release` --references--> `buildGraphSnapshotHtml`  [EXTRACTED]
  docs/releases/v0.3.0.md ★ vscode-extension/src/panels.ts
- `v0.4.2 Extension Runtime Fix` --conceptually_related_to--> `loadRuntime`  [INFERRED]
  CHANGELOG.md ★ vscode-extension/src/extension.ts

## Hyperedges (group relationships)
- **Orchestration Execution Flow** ！ orchestrator_orchestrate, triage_triagetask, planner_plantasks, dag_engine_executedag, state_machine_runsimpletask, worker_runworker, validator_validatetaskresult [EXTRACTED 1.00]
- **Graph Client Transport Implementations** ！ client_factory_graphclient, graphify_client_graphifyclient, graphify_file_client_graphifyfileclient, graphify_mcp_client_graphifymcpclient, sqlite_client_graphifysqliteclient [EXTRACTED 1.00]
- **Language Indexer Registry** ！ index_languageindexer, index_getindexerforfile, index_all_language_extensions, c_cpp_cppindexer, go_goindexer, file_indexer_indexworkspacefiles [EXTRACTED 1.00]
- **Language Indexer Implementations** ！ python_pythonindexer, rust_rustindexer, typescript_typescriptindexer [EXTRACTED 1.00]
- **Learning Flywheel Pipeline** ！ nightly_trainer_runnightlylearning, exporter_computelearningmetrics, canary_gate_evaluatecanary, sample_builder_buildrankingsamples, reflector_reflectonepisodes, skill_flywheel_applyskilllearning [INFERRED 0.85]
- **GraphFlow Surface Runtime Tools** ！ index_executecommand, server_executetoolcall, runtime_runtaskresult, runtime_previewcontext, runtime_indexgraph, runtime_inspectgraph, runtime_diagnoseroutingresult [INFERRED 0.95]
- **Agent Surface Contract** ！ runtime_runtask, runtime_previewcontext, server_gettooldefinitions, server_executetoolcall, output_formatcliresult, m16_agent_integrations_agent_surface_contract [INFERRED 0.85]
- **Graph Retrieval Pipeline** ！ file_indexer_indexworkspacefiles, context_slicer_buildcontextslice, context_slicer_buildlayeredcontextpackage, context_slicer_expandsubgraph, context_slicer_vectorrecall [INFERRED 0.85]
- **Learning Memory Flywheel** ！ skill_flywheel_applyskilllearning, skill_flywheel_suggestskillhints, episodic_memory_recordepisode, reflector_reflectonepisodes, exporter_exportlearningdataset, orchestrator_orchestrate [INFERRED 0.85]
- **VS Code Observability Panels** ！ extension_showgraphsnapshotpanel, extension_showskillinsightspanel, panels_buildgraphsnapshothtml, panels_buildskillinsightshtml, graph_snapshot_client_graph_snapshot_webview_client, skill_insights_skill_insights_webview_client [EXTRACTED 1.00]
- **Near-Lossless Context Pipeline** ！ m9_orchestrator_near_lossless_test_context_package_metrics_feedback, panels_contextpreviewresult, panels_buildcontextpreviewhtml, 2026_05_27_graphflow_dual_surface_design_context_slicing_strategy, readme_context_aware_multi_agent_engine [INFERRED 0.85]
- **Release Validation Evidence Chain** ！ v0_1_0_release_notes_v0_1_0_release, v0_3_0_release_notes_v0_3_0_release, 2026_05_28_formal_usage_test_plan_formal_usage_test_plan, 2026_05_28_formal_usage_test_report_final_pass_report, changelog_v0_3_0_product_convergence [EXTRACTED 1.00]

## Communities (67 total, 15 thin omitted)

### Community 0 - "Context Compression"
Cohesion: 0.05
Nodes (65): cppIndexer, createGraphClient, Graph Transport Strategy, GraphClient, InMemoryGraphClientAdapter, buildContextSlice, buildLayeredContextPackage, classifyLayer (+57 more)

### Community 1 - "Context Compression"
Cohesion: 0.05
Nodes (50): buildContextSlice(), buildLayeredContextPackage(), canUseLayer(), classifyLayer(), ContextAnchorItem, ContextLayer, ContextRefillManager, ContextSlice (+42 more)

### Community 2 - "Context Compression"
Cohesion: 0.07
Nodes (51): Execute CLI Command, CLI Main, graphflow.config.json Runtime Contract, M10 CLI runtime coverage, M12 dynamic routing coverage, Agent Integration Surface Contract, M16 agent integrations coverage, M17 release readiness coverage (+43 more)

### Community 3 - "Context Compression"
Cohesion: 0.08
Nodes (32): formatContextBudgetBullets(), formatContextPreviewMarkdown(), GraphFlowRuntime, loadRuntime(), runGraphFlow(), RunRecord, runs, showContextPreviewPanel() (+24 more)

### Community 4 - "Learning Memory"
Cohesion: 0.09
Nodes (35): applySkillLearning(), boundedScore(), composeSkillId(), compositeGateMet(), CompositeSkillState, dedup(), dedupEdges(), dedupNodes() (+27 more)

### Community 5 - "Context Compression"
Cohesion: 0.09
Nodes (31): collectEpisodeCandidates(), deserialize(), EpisodeRecord, extractTaskTokens(), findSimilarEpisodes(), hashText(), isEpisodeNode(), loadAllEpisodes() (+23 more)

### Community 6 - "Learning Memory"
Cohesion: 0.1
Nodes (27): CanaryDecision, evaluateCanary(), computeLearningMetrics(), exportLearningDataset(), LearningMetrics, FeedbackCollector, FeedbackEvent, appendFeedbackEvent() (+19 more)

### Community 7 - "Context Compression"
Cohesion: 0.08
Nodes (31): Evaluate Canary, Collect Episode Candidates, Deserialize Episode, Extract Task Tokens, Find Similar Episodes, Hash Episode Text, Is Episode Node, Load All Episodes (+23 more)

### Community 8 - "Context Compression"
Cohesion: 0.13
Nodes (21): extractCriteria(), parseValidatorJson(), validateTaskResult(), validateTaskResultLlm(), runWorker(), WorkerInput, RunInput, runSimpleTask() (+13 more)

### Community 9 - "Context Compression"
Cohesion: 0.13
Nodes (25): DagExecutionResult, executeDag(), TaskExecutor, appendContextFeedback(), appendRouteFeedback(), buildPromptContext(), buildRouteDecisions(), decisionToSelection() (+17 more)

### Community 10 - "Context Compression"
Cohesion: 0.09
Nodes (15): GraphifySqliteClient, loadBetterSqlite3(), NodeRow, requireFn, rowToNode(), baseDir, bothIds, cfg (+7 more)

### Community 11 - "MCP Surface"
Cohesion: 0.11
Nodes (19): buildInspectOptions(), createMcpServer(), executeToolCall(), getToolDefinitions(), JsonRpcRequest, JsonRpcResponse, McpServer, PACKAGE_VERSION (+11 more)

### Community 12 - "Language Indexers"
Cohesion: 0.17
Nodes (16): cppIndexer, FUNC_NAME_BLACKLIST, goIndexer, DeclaredSymbol, ExtractionResult, ImportTarget, INDEXERS, LanguageIndexer (+8 more)

### Community 13 - "VS Code Extension"
Cohesion: 0.13
Nodes (19): BASE_EXTENSIONS, dedupEdges(), DEFAULT_EXTENSIONS, extOf(), FileIndexerOptions, IGNORED_DIRS, IndexedSymbol, indexWorkspaceFiles() (+11 more)

### Community 14 - "Context Compression"
Cohesion: 0.12
Nodes (18): calculateBudgetUsedPercent(), calculateSavingsPercent(), ContextPreviewResult, estimateRawContextTokens(), estimateTokenCount(), GraphFlowSettings, GraphFlowSettingsInput, GraphIndexResult (+10 more)

### Community 15 - "Learning Memory"
Cohesion: 0.15
Nodes (19): getGraphFlowSettings(), getSkillInsights(), indexGraph(), inspectGraph(), loadGraphStore(), parseEnvPlaceholder(), readFileGraphStore(), readRawConfig() (+11 more)

### Community 16 - "MCP Surface"
Cohesion: 0.11
Nodes (16): alpha, bar, beta, compute, definer, foo, fooNode, greet (+8 more)

### Community 17 - "Test Coverage"
Cohesion: 0.14
Nodes (14): getDefaultConfig(), loadConfig(), resolveEnvTemplates(), validateConfig(), GraphFlowConfig, config, configPath, eventsPath (+6 more)

### Community 18 - "VS Code Extension"
Cohesion: 0.14
Nodes (16): allEdges, allNodes, colors, getRenderable(), getVisibleNodes(), graphFilterState, graphSelection, nodeCards (+8 more)

### Community 19 - "Context Compression"
Cohesion: 0.17
Nodes (14): diagnoseRouting(), diagnoseRoutingResult(), extractTokenCost(), runTask(), runTaskResult(), ProviderName, ALL_PROVIDERS, buildFallbackChain() (+6 more)

### Community 20 - "Learning Memory"
Cohesion: 0.22
Nodes (15): M14 skill flywheel coverage, M20 skill fusion coverage, Apply Skill Learning, Compose Skill Id, Composite Gate Met, Deduplicate Skill Edges, Extract Skill Atoms, Load Composite Skill (+7 more)

### Community 22 - "Learning Memory"
Cohesion: 0.33
Nodes (12): executeCommand(), main(), buildCliUsage(), CliCommandResult, CliOptions, formatCliResult(), getCliVersion(), parseCliOptions() (+4 more)

### Community 23 - "Context Compression"
Cohesion: 0.36
Nodes (8): anthropicGenerateText(), bailianGenerateText(), doubaoGenerateText(), openaiGenerateText(), ProviderTextRequest, executeRolePrompt(), formatPromptWithContext(), hasAnyContext()

### Community 24 - "Learning Memory"
Cohesion: 0.18
Nodes (13): executeDag, TaskExecutor, M2 executeDag coverage, M2 planTasks coverage, buildPlannerPrompt, extractFirstJsonArray, parsePlannerJson, planTasks (+5 more)

### Community 25 - "Test Coverage"
Cohesion: 0.17
Nodes (10): a, b, brute, cfg, client, edges, ids, idsOff (+2 more)

### Community 26 - "Learning Memory"
Cohesion: 0.18
Nodes (12): brainstormTask, brainstormTaskLlm, parseBrainstormIdeas, M1 runSimpleTask coverage, M1 validateTaskResult coverage, finalizeEpisode, runSimpleTask, TaskRunResult (+4 more)

### Community 27 - "Test Coverage"
Cohesion: 0.24
Nodes (8): brainstormTask(), brainstormTaskLlm(), parseBrainstormIdeas(), failingPlan, mockedExec, plannerJson, recoveryPlan, task

### Community 28 - "Context Compression"
Cohesion: 0.18
Nodes (7): formatted, graphClient, longSummary, manySkills, mockedExec, plannerJson, withCtx

### Community 29 - "Learning Memory"
Cohesion: 0.31
Nodes (10): buildPlannerPrompt(), extractFirstJsonArray(), parsePlannerJson(), PlannerJsonItem, planTasks(), planTasksLlm(), PlanTasksLlmOptions, stripCodeFences() (+2 more)

### Community 30 - "Test Coverage"
Cohesion: 0.18
Nodes (9): baselineBytes, compressedBytes, files, hasSuffix, root, snap, symbols, widget (+1 more)

### Community 31 - "Test Coverage"
Cohesion: 0.18
Nodes (9): definerSymbol, fileNodes, names, paths, refEdges, root, snap, symbols (+1 more)

### Community 32 - "VS Code Extension"
Cohesion: 0.22
Nodes (9): filteredSkills(), outcomeFilter, renderSummary(), renderTable(), searchInput, skills, sortSelect, summary (+1 more)

### Community 33 - "VS Code Extension"
Cohesion: 0.18
Nodes (10): dst, extensionRoot, repoRoot, runtimeDeps, scriptDir, sourceDist, src, vendorDist (+2 more)

### Community 34 - "Context Compression"
Cohesion: 0.2
Nodes (11): Prompt Context Contract, M21 prompt context coverage, M2 triageTask coverage, appendContextFeedback, appendRouteFeedback, buildRouteDecisions, maybeSyncSkillGraph, orchestrate (+3 more)

### Community 35 - "Context Compression"
Cohesion: 0.2
Nodes (11): Context Slicing Strategy, Dual Surface Design, Hybrid Routing Mode, Layered Core Architecture, Learning Flywheel Policy, Model Tier Routing, Graphify Incremental Chain, v0.1 Implementation Plan (+3 more)

### Community 36 - "MCP Surface"
Cohesion: 0.36
Nodes (6): GraphEdge, GraphNode, GraphStoreSnapshot, GraphStore, JsonRpcResult, McpQueryResponse

### Community 37 - "Test Coverage"
Cohesion: 0.31
Nodes (7): GraphClient, ChangeRecord, indexChanges(), syncGraphAfterRun(), client, events, plan

### Community 38 - "Context Compression"
Cohesion: 0.2
Nodes (10): v0.4.2 Extension Runtime Fix, GraphFlow Chat Participant, loadRuntime, runGraphFlow, showContextPreviewPanel, VS Code Panel Asset Contract, buildContextPreviewHtml, ContextPreviewResult (+2 more)

### Community 39 - "Test Coverage"
Cohesion: 0.22
Nodes (8): client, configPath, eventsPath, exportPath, output, root, snapshot, summaryPath

### Community 40 - "Model Routing"
Cohesion: 0.25
Nodes (9): Anthropic Generate Text, Bailian Generate Text, brainstormTaskLlm, Doubao Generate Text, M19 LLM agents and drift coverage, OpenAI Generate Text, Execute Role Prompt, parseValidatorJson (+1 more)

### Community 41 - "VS Code Extension"
Cohesion: 0.25
Nodes (9): Formal Usage Test Plan, Final Pass Usage Test Report, v0.3.0 Product Convergence, showSkillInsightsPanel, buildSkillInsightsHtml, SkillInsightsResult, Skill Filter And Sort, Skill Insights Webview Client (+1 more)

### Community 42 - "Context Compression"
Cohesion: 0.28
Nodes (9): GraphFlow Agent Playbook, v0.4.0 MCP And AST Release, GraphFlow Claude Code Guidance, Generate Icon Script, GraphFlow Icon Design, GraphFlow Icon, Context-Aware Multi-Agent Engine, GraphFlow Overview (+1 more)

### Community 43 - "VS Code Extension"
Cohesion: 0.29
Nodes (7): TaskRunResult, createVsCodeRuntime(), registerVsCodeSurface(), RunExecutor, VsCodeRunRecord, VsCodeRuntime, VsCodeSurfaceState

### Community 47 - "VS Code Extension"
Cohesion: 0.32
Nodes (8): showGraphSnapshotPanel, Graph Snapshot Webview Client, Graph Snapshot Node Filtering, Selection Detail Panel, SVG Graph Canvas, buildGraphSnapshotHtml, GraphSnapshotResult, SQLite FTS5 Backend

### Community 49 - "VS Code Extension"
Cohesion: 0.4
Nodes (6): createVsCodeRuntime, registerVsCodeSurface, VsCodeRuntime.runTask, VsCodeRuntime.showRuns, VsCodeRunRecord, M4/M5 VS Code runtime coverage

### Community 50 - "Typescript Adddecl"
Cohesion: 0.33
Nodes (6): Add Declaration, TypeScript Indexer Extract, Extract From TypeScript AST, Fallback TypeScript Extraction, Has Export, Load TypeScript Compiler

### Community 51 - "VS Code Extension"
Cohesion: 0.33
Nodes (6): showSettingsPanel, M15 VS Code panels coverage, buildSettingsHtml, GraphFlowSettings, Save Settings Message, Settings Webview Client

### Community 52 - "Context Compression"
Cohesion: 0.33
Nodes (6): GraphFlow VS Code Extension, GraphFlowRuntime, Context Package Metrics Feedback, M9 Orchestrator Near-Lossless Integration, Parallel Execution Rounds, VS Code Extension Entrypoints

### Community 54 - "Python Extract"
Cohesion: 0.67
Nodes (3): Python Indexer Extract, Python Regex Patterns, Strip Triple Quotes

## Knowledge Gaps
- **368 isolated node(s):** `tseslint`, `tsParser`, `PlanTasksLlmOptions`, `PlannerJsonItem`, `WorkerInput` (+363 more)
  These have ＋1 connection - possible missing edges or undocumented components.
- **15 thin communities (<3 nodes) omitted from report** ！ run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `orchestrate` connect `Context Compression` to `Context Compression`, `Context Compression`, `Model Routing`, `VS Code Extension`, `Learning Memory`, `Learning Memory`, `Learning Memory`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `GraphClient` connect `Test Coverage` to `Context Compression`, `MCP Surface`, `Context Compression`, `Learning Memory`, `Learning Memory`, `Context Compression`, `Context Compression`, `VS Code Extension`, `Context Compression`, `MCP Surface`, `Context Compression`, `Test Coverage`, `Test Coverage`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `GraphifyClient` connect `Graph Storage` to `Learning Memory`, `MCP Surface`, `Test Coverage`, `Test Coverage`, `Context Compression`, `MCP Surface`, `Context Compression`, `Test Coverage`, `Context Compression`, `Test Coverage`, `Test Coverage`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `orchestrate` (e.g. with `VsCodeRunRecord` and `Suggest Skill Hints`) actually correct?**
  _`orchestrate` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `tseslint`, `tsParser`, `PlanTasksLlmOptions` to the rest of the system?**
  _368 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Context Compression` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Context Compression` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._