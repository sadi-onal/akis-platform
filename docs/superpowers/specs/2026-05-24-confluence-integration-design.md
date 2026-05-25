# S3a — Confluence Page Creation After Spec Approval

## Problem

When Scribe produces a spec and the user approves it, a Jira Epic is automatically created (if Jira is configured). But there's no Confluence integration — the spec lives only in the pipeline state. Teams that use Confluence for documentation have to manually copy the spec content.

## Decision

Auto-create a Confluence page alongside the Jira Epic at `approveSpec()`. Uses the same Atlassian OAuth grant (scope already covers Confluence). New `ConfluenceMCPService` adapter follows the `JiraMCPService` pattern.

## Architecture

### ConfluenceMCPService

New file: `backend/src/services/mcp/adapters/ConfluenceMCPService.ts`

Uses `openMcpClient(userId)` from `AtlassianMcpClient.ts` — same OAuth token, same MCP SDK transport. The Atlassian remote MCP server exposes Confluence tools alongside Jira tools.

```typescript
interface ConfluenceMCPServiceOptions {
  client: Client;
  cloudId: string;
  siteUrl?: string;
}

interface ConfluencePage {
  id: string;
  title: string;
  webUrl: string;
  spaceKey: string;
}

class ConfluenceMCPService {
  static async fromOAuth(userId: string): Promise<ConfluenceMCPService | null>;

  // Core methods
  listSpaces(): Promise<Array<{ key: string; name: string }>>;
  createPage(spaceKey: string, title: string, body: string, parentPageId?: string): Promise<ConfluencePage>;
  updatePage(pageId: string, title: string, body: string, version: number): Promise<ConfluencePage>;
  getPage(pageId: string): Promise<ConfluencePage & { body: string; version: number }>;

  close(): Promise<void>;
}
```

MCP tools used: `createConfluencePage`, `getConfluenceSpaces`, `updateConfluencePage`, `getConfluencePage` (from Atlassian remote MCP server).

### Registration

- Export from `backend/src/services/mcp/adapters/index.ts`
- Add `confluenceMCP?: ConfluenceMCPService` to `MCPTools` interface

### Orchestrator Integration

In `approveSpec()` (alongside existing `runJiraEpicCreation`):

```typescript
if (confluenceConfig?.enabled && confluenceConfig.spaceKey) {
  this.runConfluencePageCreation(pipelineId, userId, confluenceConfig.spaceKey, spec)
    .catch(err => logger.warn({ err, pipelineId }, 'Confluence page creation failed (non-blocking)'));
}
```

New private method `runConfluencePageCreation(pipelineId, userId, spaceKey, spec)`:
1. Create `ConfluenceMCPService.fromOAuth(userId)`
2. Format spec as Confluence storage format (ADF or XHTML — what the MCP tool accepts)
3. `createPage(spaceKey, title, body)`
4. Store `confluencePageUrl` and `confluencePageId` in `intermediateState`
5. If Jira Epic exists, add Confluence link as a comment on the Epic

### Downstream hooks (parallel to Jira)

| Pipeline event | Confluence action |
|---|---|
| Spec approved | Create page with full spec content |
| Proto completes | Update page: add "Implementation" section (branch, files, PR URL) |
| Trace completes | Update page: add "Test Coverage" section (test count, coverage %) |
| Pipeline completes | Update page: add "Result" section (success/partial/failed, CI link) |
| Pipeline fails | Update page: add "Failure" section (error code, stage) |

### Content Format

Page title: `[AKIS] {pipeline.title}`

Page body (Confluence storage format):
```
<h2>Spec Özeti</h2>
<p>{spec.summary}</p>

<h2>Kabul Kriterleri</h2>
<ul>
  {spec.acceptanceCriteria.map(ac => <li>{ac}</li>)}
</ul>

<h2>Teknik Detaylar</h2>
<p>{spec.technicalDetails || spec.description}</p>

<h2>Jira Epic</h2>
<p><a href="{jiraEpicUrl}">{jiraEpicKey}</a></p>

<!-- Added later by downstream hooks: -->
<h2>Implementasyon</h2>
<h2>Test Kapsamı</h2>
<h2>Sonuç</h2>
```

## Pipeline State

New fields in `intermediateState` JSONB:

```typescript
confluencePageId?: string;
confluencePageUrl?: string;
confluencePageVersion?: number;  // needed for updatePage
```

New config field on pipeline creation (from user settings or per-pipeline):

```typescript
interface ConfluenceConfig {
  enabled: boolean;
  spaceKey: string;
  parentPageId?: string;  // optional: nest under a parent page
}
```

## Frontend Changes

### PipelineDetailRail — Confluence Link

Add Confluence icon + link next to existing Jira link in the rail header. Same pattern as `jiraEpicUrl` display.

```
[Jira: AKIS-42] [Confluence: Spec Sayfası]
```

- Icon: Confluence logo SVG (or generic document icon)
- Link opens in new tab
- Only shown when `confluencePageUrl` exists in pipeline state

### Settings → Integrations Tab

The Integrations tab already shows Atlassian OAuth status with `confluenceAvailable`. Add:

- Confluence space selector (dropdown from `listSpaces()`)
- Toggle: "Onaylanan spec'leri Confluence'a otomatik yayınla"
- These persist as user-level settings (like Jira project key selection)

### i18n

Key prefix: `integrations.confluence.*`
- `integrations.confluence.pageCreated`: "Confluence sayfası oluşturuldu"
- `integrations.confluence.spaceSelect`: "Confluence alanı seçin"
- `integrations.confluence.autoPublish`: "Onaylanan spec'leri otomatik yayınla"

## Acceptance Criteria

- [ ] `ConfluenceMCPService` adapter created with `fromOAuth`, `listSpaces`, `createPage`, `updatePage`
- [ ] Service registered in `MCPTools` interface and barrel export
- [ ] Confluence page created at `approveSpec()` when configured
- [ ] Page content includes spec summary, acceptance criteria, technical details
- [ ] Page updated after Proto, Trace, and pipeline completion
- [ ] `confluencePageUrl` stored in pipeline state
- [ ] PipelineDetailRail shows Confluence link when available
- [ ] Settings Integrations tab has space selector + auto-publish toggle
- [ ] Non-blocking: Confluence failure doesn't block the pipeline
- [ ] i18n: TR + EN for all new strings

## Out of Scope

- Confluence → AKIS sync (reading from Confluence back into pipeline)
- Confluence templates (custom page templates)
- Confluence comments/reactions
- Multi-space support (one space per user setting)
- Confluence search integration

## Dependencies

- Atlassian OAuth already working (PR #608)
- Atlassian remote MCP server must expose Confluence tools (verify at implementation time)
- JiraMCPService pattern as reference implementation
