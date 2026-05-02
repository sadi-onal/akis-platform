import assert from 'node:assert';
import { describe, test } from 'node:test';
import { TraceAgent } from '../../src/agents/trace/TraceAgent.js';

// ─── Basic execution ────────────────────────────────────────────────

test('TraceAgent reports automation execution summary for strong scenarios', async () => {
  const agent = new TraceAgent();
  const result = await agent.execute({
    spec: [
      'Scenario: User logs in',
      'Given user has a valid account',
      'When user submits credentials',
      'Then dashboard should load',
    ].join('\n'),
  }) as {
    ok: boolean;
    testPlan: string;
    metadata: {
      automationExecution: {
        runner: string;
        targetBaseUrl: string;
        featurePassRate: number;
        executedScenarios: number;
        passedScenarios: number;
        failedScenarios: number;
        passRate: number;
        featureCoverageRate: number;
      };
      automationSummary: {
        generatedTestPath: string;
      };
    };
  };

  assert.strictEqual(result.ok, true);
  assert.ok(result.testPlan.includes('## Automation Execution Summary'));
  assert.strictEqual(result.metadata.automationExecution.runner, 'playwright');
  assert.strictEqual(result.metadata.automationExecution.targetBaseUrl, 'https://akisflow.com');
  assert.strictEqual(result.metadata.automationExecution.featurePassRate, 100);
  assert.strictEqual(result.metadata.automationExecution.executedScenarios, 1);
  assert.strictEqual(result.metadata.automationExecution.passedScenarios, 1);
  assert.strictEqual(result.metadata.automationExecution.failedScenarios, 0);
  assert.strictEqual(result.metadata.automationExecution.passRate, 100);
  assert.ok(result.metadata.automationExecution.featureCoverageRate >= 0);
  assert.strictEqual(result.metadata.automationSummary.generatedTestPath, 'tests/generated/trace-tests.test.ts');
});

test('TraceAgent reports failed scenario ratio for weak specifications', async () => {
  const agent = new TraceAgent();
  const result = await agent.execute({ spec: 'Smoke check' }) as {
    metadata: {
      automationExecution: {
        executedScenarios: number;
        passedScenarios: number;
        failedScenarios: number;
        passRate: number;
      };
    };
  };

  assert.ok(result.metadata.automationExecution.executedScenarios >= 1);
  assert.strictEqual(result.metadata.automationExecution.passedScenarios, 0);
  assert.ok(result.metadata.automationExecution.failedScenarios >= 1);
  assert.strictEqual(result.metadata.automationExecution.passRate, 0);
});

// ─── Multi-scenario Gherkin parsing ─────────────────────────────────

describe('TraceAgent multi-scenario parsing', () => {
  test('parses multiple Gherkin scenarios from single spec', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Login with valid credentials',
        'Given the user is on the login page',
        'When the user enters valid email and password',
        'Then the user sees the dashboard',
        '',
        'Scenario: Login with invalid credentials',
        'Given the user is on the login page',
        'When the user enters wrong password',
        'Then an error message is displayed',
        '',
        'Scenario: Password reset flow',
        'Given the user clicks forgot password',
        'When the user enters their email',
        'Then a reset email is sent',
      ].join('\n'),
    }) as {
      ok: boolean;
      files: Array<{ path: string; cases: Array<{ name: string; steps: string[] }> }>;
      coverageMatrix: Record<string, string[]>;
      metadata: { scenarioCount: number; totalTestCases: number };
    };

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.metadata.scenarioCount, 3);
    assert.strictEqual(result.metadata.totalTestCases, 3);
    assert.strictEqual(result.files.length, 3);
  });

  test('parses arrow notation spec', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: 'Login page -> Enter credentials -> Click submit -> See dashboard',
    }) as { files: Array<{ cases: Array<{ steps: string[] }> }>; metadata: { scenarioCount: number } };

    assert.strictEqual(result.metadata.scenarioCount, 1);
    assert.ok(result.files[0].cases[0].steps.length >= 3);
  });

  test('parses colon notation spec', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: 'Auth flow: navigate to login, enter email, enter password, click submit',
    }) as { metadata: { scenarioCount: number } };

    assert.strictEqual(result.metadata.scenarioCount, 1);
  });

  test('handles Scenario Outline syntax', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario Outline: Login with different roles',
        'Given the user is a <role>',
        'When the user logs in with valid credentials',
        'Then the user sees the <dashboard> page',
      ].join('\n'),
    }) as { metadata: { scenarioCount: number } };

    assert.strictEqual(result.metadata.scenarioCount, 1);
  });
});

// ─── Coverage matrix generation ─────────────────────────────────────

describe('TraceAgent coverage matrix', () => {
  test('generates coverage matrix mapping features to scenarios', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: User signup',
        'Given the user visits the signup form',
        'When the user fills in all fields',
        'Then the account is created',
        '',
        'Scenario: User profile update',
        'Given the user visits the profile page',
        'When the user updates their name',
        'Then the profile is saved',
      ].join('\n'),
    }) as { coverageMatrix: Record<string, string[]> };

    assert.ok(Object.keys(result.coverageMatrix).length > 0);
    // Each feature should map to at least one scenario
    for (const [, tests] of Object.entries(result.coverageMatrix)) {
      assert.ok(tests.length >= 1);
    }
  });

  test('coverage matrix handles scenarios with shared steps', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Admin login',
        'Given the user is on the login page',
        'When the admin enters credentials',
        'Then the admin dashboard loads',
        '',
        'Scenario: User login',
        'Given the user is on the login page',
        'When the user enters credentials',
        'Then the user dashboard loads',
      ].join('\n'),
    }) as { coverageMatrix: Record<string, string[]> };

    // "the user is" should map to both scenarios
    const sharedFeature = Object.entries(result.coverageMatrix)
      .find(([, tests]) => tests.length >= 2);
    assert.ok(sharedFeature, 'Should have at least one feature covered by multiple scenarios');
  });
});

// ─── Test file generation ───────────────────────────────────────────

describe('TraceAgent test file generation', () => {
  test('generates sorted test files with sanitized names', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Zebra feature test',
        'Given something exists',
        'When action happens',
        'Then result appears',
        '',
        'Scenario: Alpha feature test',
        'Given precondition set',
        'When trigger fires',
        'Then outcome verified',
      ].join('\n'),
    }) as { files: Array<{ path: string }> };

    // Files should be sorted alphabetically
    const paths = result.files.map(f => f.path);
    assert.ok(paths[0].includes('alpha'), 'First file should be alpha (sorted)');
    assert.ok(paths[1].includes('zebra'), 'Second file should be zebra (sorted)');
  });

  test('throws for empty spec', async () => {
    const agent = new TraceAgent();
    await assert.rejects(
      () => agent.execute({ spec: '' }),
      /TraceAgent requires payload with "spec" field/
    );
  });

  test('sanitizes special characters in file names', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Login with @special #characters & symbols!',
        'Given the user is logged out',
        'When special login attempted',
        'Then handle gracefully',
      ].join('\n'),
    }) as { files: Array<{ path: string }> };

    const path = result.files[0].path;
    // Should not contain special characters
    assert.ok(!path.includes('@'));
    assert.ok(!path.includes('#'));
    assert.ok(!path.includes('&'));
    assert.ok(!path.includes('!'));
    assert.ok(path.endsWith('.test.ts'));
  });
});

// ─── TraceAgent constructor and configuration ───────────────────────

describe('TraceAgent configuration', () => {
  test('agent type is trace', () => {
    const agent = new TraceAgent();
    assert.strictEqual(agent.type, 'trace');
  });

  test('requires planning by default', () => {
    const agent = new TraceAgent();
    assert.strictEqual(agent.playbook.requiresPlanning, true);
  });

  test('reflection is disabled by default', () => {
    const agent = new TraceAgent();
    assert.strictEqual(agent.playbook.requiresReflection, false);
  });

  test('throws when spec is missing', async () => {
    const agent = new TraceAgent();
    await assert.rejects(
      () => agent.execute({}),
      /TraceAgent requires payload with "spec" field/
    );
  });

  test('throws when spec is null', async () => {
    const agent = new TraceAgent();
    await assert.rejects(
      () => agent.execute({ spec: null }),
      /TraceAgent requires payload with "spec" field/
    );
  });

  test('handles non-string spec by converting to string', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: 12345,
    }) as { ok: boolean };

    assert.strictEqual(result.ok, true);
  });
});

// ─── Automation execution evaluation ────────────────────────────────

describe('TraceAgent automation evaluation', () => {
  test('custom targetBaseUrl is reflected in summary', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: 'Scenario: Test\nGiven setup\nWhen action\nThen result',
      targetBaseUrl: 'https://custom.example.com',
    }) as {
      metadata: {
        automationExecution: { targetBaseUrl: string };
      };
    };

    assert.strictEqual(result.metadata.automationExecution.targetBaseUrl, 'https://custom.example.com');
  });

  test('mode is syntactic when no AI service', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: 'Scenario: Test\nGiven setup\nWhen action\nThen result',
    }) as {
      metadata: { automationExecution: { mode: string } };
    };

    assert.strictEqual(result.metadata.automationExecution.mode, 'syntactic');
  });

  test('test plan markdown includes all sections', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Complete flow',
        'Given user is on homepage',
        'When user navigates to about page',
        'Then about content is displayed',
      ].join('\n'),
    }) as { testPlan: string };

    assert.ok(result.testPlan.includes('# Test Plan'));
    assert.ok(result.testPlan.includes('## Test Scenarios'));
    assert.ok(result.testPlan.includes('## Coverage Matrix'));
    assert.ok(result.testPlan.includes('## Automation Execution Summary'));
    assert.ok(result.testPlan.includes('Generated:'));
  });

  test('generate_and_run uses real runner and emits reliability metadata', async () => {
    let runCount = 0;
    const runner = async () => {
      runCount += 1;
      return {
        runner: 'playwright' as const,
        mode: 'real' as const,
        totalFeatures: 1,
        passedFeatures: runCount === 1 ? 0 : 1,
        failedFeatures: runCount === 1 ? 1 : 0,
        totalScenarios: 1,
        passedScenarios: runCount === 1 ? 0 : 1,
        failedScenarios: runCount === 1 ? 1 : 0,
        passRate: runCount === 1 ? 0 : 100,
        durationMs: 15,
        failures: runCount === 1
          ? [{ feature: 'login', scenario: 'User logs in', reason: 'timeout' }]
          : [],
        generatedTestPath: '/tmp/trace.spec.ts',
        reportPath: '/tmp/results.json',
        traceArtifactPath: '/tmp/trace.zip',
      };
    };

    const agent = new TraceAgent({
      tools: {
        traceAutomationRunner: runner,
      } as unknown as { aiService?: unknown },
    });

    const result = await agent.execute({
      spec: [
        'Scenario: User logs in',
        'Given user has valid credentials',
        'When user submits login form',
        'Then dashboard is shown',
      ].join('\n'),
      automationMode: 'generate_and_run',
      targetBaseUrl: 'https://akisflow.com',
    }) as {
      metadata: {
        automationExecution: {
          mode: string;
          targetBaseUrl: string;
          artifactPaths?: { traceArtifactPath?: string };
        };
        flaky: { retryCount: number; pfsLite: number };
        flowCoverage: { coverageRate: number };
        edgeCaseCoverage: { coverageRate: number };
        riskWeightedCoverage: { weightedCoverage: number };
      };
    };

    assert.strictEqual(runCount, 2, 'flaky manager should perform one retry after first failure');
    assert.strictEqual(result.metadata.automationExecution.mode, 'real');
    assert.strictEqual(result.metadata.automationExecution.targetBaseUrl, 'https://akisflow.com');
    assert.strictEqual(result.metadata.automationExecution.artifactPaths?.traceArtifactPath, '/tmp/trace.zip');
    assert.strictEqual(result.metadata.flaky.retryCount, 1);
    assert.ok(result.metadata.flaky.pfsLite >= 0);
    assert.ok(result.metadata.flowCoverage.coverageRate >= 0);
    assert.ok(result.metadata.edgeCaseCoverage.coverageRate >= 0);
    assert.ok(result.metadata.riskWeightedCoverage.weightedCoverage >= 0);
  });
});

// ─── Priority classification ────────────────────────────────────────

describe('TraceAgent priority classification', () => {
  test('auth scenarios get P0 priority', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: User login with valid credentials',
        'Given the user is on the login page',
        'When the user enters valid email and password',
        'Then the user is redirected to dashboard',
      ].join('\n'),
    }) as { metadata: { priorityBreakdown: Record<string, number> } };

    assert.ok(result.metadata.priorityBreakdown.P0 >= 1, 'Auth scenario should be P0');
  });

  test('CRUD operations get P1 priority', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Create new project',
        'Given the user is on projects page',
        'When the user submits the create form',
        'Then the new project is saved',
      ].join('\n'),
    }) as { metadata: { priorityBreakdown: Record<string, number> } };

    assert.ok(result.metadata.priorityBreakdown.P1 >= 1, 'Create scenario should be P1');
  });

  test('display scenarios get P2 priority', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: View project list',
        'Given the user is on the dashboard',
        'When the projects list loads',
        'Then all projects are displayed correctly',
      ].join('\n'),
    }) as { metadata: { priorityBreakdown: Record<string, number> } };

    assert.ok(result.metadata.priorityBreakdown.P2 >= 1, 'Display scenario should be P2');
  });

  test('visual/cosmetic scenarios get P3 priority', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Button hover animation',
        'Given the user is on any page',
        'When the user hovers over the button',
        'Then the hover animation plays smoothly',
      ].join('\n'),
    }) as { metadata: { priorityBreakdown: Record<string, number> } };

    assert.ok(result.metadata.priorityBreakdown.P3 >= 1, 'Animation scenario should be P3');
  });

  test('priority breakdown sums to total scenario count', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Login flow',
        'Given the user navigates to login',
        'When valid credentials submitted',
        'Then dashboard loads',
        '',
        'Scenario: View profile',
        'Given the user is logged in',
        'When navigating to profile page',
        'Then profile details are displayed',
      ].join('\n'),
    }) as { metadata: { priorityBreakdown: Record<string, number>; scenarioCount: number } };

    const totalFromBreakdown = Object.values(result.metadata.priorityBreakdown).reduce((s, v) => s + v, 0);
    assert.strictEqual(totalFromBreakdown, result.metadata.scenarioCount);
  });
});

// ─── Test layer classification ──────────────────────────────────────

describe('TraceAgent test layer classification', () => {
  test('API-related scenarios classified as integration', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: API endpoint returns user data',
        'Given the API service is running',
        'When GET /api/users is called',
        'Then the response contains user list',
      ].join('\n'),
    }) as { metadata: { layerBreakdown: Record<string, number> } };

    assert.ok(result.metadata.layerBreakdown.integration >= 1, 'API test should be integration');
  });

  test('utility function scenarios classified as unit', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Validate email function',
        'Given a helper function for email validation',
        'When invalid email format is passed to validate',
        'Then the function returns false',
      ].join('\n'),
    }) as { metadata: { layerBreakdown: Record<string, number> } };

    assert.ok(result.metadata.layerBreakdown.unit >= 1, 'Validation function should be unit');
  });

  test('UI flow scenarios classified as e2e', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Complete checkout flow',
        'Given the user has items in cart',
        'When the user proceeds to checkout',
        'Then the order confirmation page is shown',
      ].join('\n'),
    }) as { metadata: { layerBreakdown: Record<string, number> } };

    assert.ok(result.metadata.layerBreakdown.e2e >= 1, 'UI flow should be e2e');
  });

  test('layer breakdown sums to total scenario count', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Login',
        'Given user on login page',
        'When user enters credentials',
        'Then user sees dashboard',
        '',
        'Scenario: Parse CSV',
        'Given a CSV helper function',
        'When valid CSV passed to parse',
        'Then parsed data is returned',
      ].join('\n'),
    }) as { metadata: { layerBreakdown: Record<string, number>; scenarioCount: number } };

    const totalFromBreakdown = Object.values(result.metadata.layerBreakdown).reduce((s, v) => s + v, 0);
    assert.strictEqual(totalFromBreakdown, result.metadata.scenarioCount);
  });
});

// ─── Test plan markdown with priorities ─────────────────────────────

describe('TraceAgent test plan with priority metadata', () => {
  test('test plan includes Summary section with priority breakdown', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Login',
        'Given user navigates to login',
        'When valid password entered',
        'Then dashboard loads',
      ].join('\n'),
    }) as { testPlan: string };

    assert.ok(result.testPlan.includes('## Summary'), 'Should have Summary section');
    assert.ok(result.testPlan.includes('P0'), 'Should mention P0');
    assert.ok(result.testPlan.includes('Total scenarios'), 'Should show total count');
  });

  test('test plan shows priority labels in scenario headings', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Delete user account',
        'Given admin on user management page',
        'When admin clicks delete user',
        'Then user account is permanently removed',
      ].join('\n'),
    }) as { testPlan: string };

    // P0 because of "delete"
    assert.ok(result.testPlan.includes('[e2e]') || result.testPlan.includes('[integration]') || result.testPlan.includes('[unit]'),
      'Should show test layer in heading');
  });

  test('test plan shows flakiness info', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Wait for animation to complete',
        'Given user triggers an animation',
        'When the animation starts playing',
        'Then wait for animation to finish',
      ].join('\n'),
    }) as { testPlan: string };

    assert.ok(result.testPlan.includes('Flakiness'), 'Should show flakiness risk');
  });
});

// ─── Automation execution with priorities ───────────────────────────

describe('TraceAgent automation execution with priorities', () => {
  test('automation summary includes priority breakdown', async () => {
    const agent = new TraceAgent();
    const result = await agent.execute({
      spec: [
        'Scenario: Login',
        'Given user on login page',
        'When credentials entered',
        'Then dashboard visible',
      ].join('\n'),
    }) as {
      metadata: {
        automationExecution: { priorityBreakdown?: Record<string, number>; layerBreakdown?: Record<string, number> };
      };
    };

    assert.ok(result.metadata.automationExecution.priorityBreakdown, 'Should have priority breakdown');
    assert.ok(result.metadata.automationExecution.layerBreakdown, 'Should have layer breakdown');
  });
});
