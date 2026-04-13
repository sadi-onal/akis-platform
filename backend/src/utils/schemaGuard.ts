/**
 * Schema Drift Guard - PR-2
 * Dev-only startup check that validates critical DB columns exist
 * Prevents silent failures from missing migrations
 */
import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

interface ColumnCheck {
  table: string;
  column: string;
  required: boolean;
}

const CRITICAL_COLUMNS: ColumnCheck[] = [
  // PR-1: Contract-first plan columns
  { table: 'job_plans', column: 'plan_markdown', required: false },
  { table: 'job_plans', column: 'plan_json', required: false },
  { table: 'job_plans', column: 'updated_at', required: false },
  // Core jobs columns
  { table: 'jobs', column: 'error_code', required: false },
  { table: 'jobs', column: 'error_message', required: false },
  { table: 'jobs', column: 'requires_approval', required: false },
  // Quality scoring columns (Sprint-3.1)
  { table: 'jobs', column: 'quality_score', required: false },
  { table: 'jobs', column: 'quality_breakdown', required: false },
];

/**
 * Check if a column exists in the database
 */
async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = ${tableName} 
        AND column_name = ${columnName}
    `);
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Validate critical database columns exist
 * @param exitOnFailure - If true, exit process on failure (dev only)
 * @returns Array of missing columns (empty if all exist)
 */
export async function validateSchemaColumns(exitOnFailure: boolean = false): Promise<string[]> {
  const missing: string[] = [];

  for (const check of CRITICAL_COLUMNS) {
    const exists = await columnExists(check.table, check.column);
    if (!exists) {
      missing.push(`${check.table}.${check.column}`);
    }
  }

  if (missing.length > 0) {
    const message = [
      '',
      '╔══════════════════════════════════════════════════════════════════╗',
      '║                    ⚠️  DB SCHEMA DRIFT DETECTED                   ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      '║  The following columns are missing from your database:           ║',
      ...missing.map(col => `║    • ${col.padEnd(56)}║`),
      '╠══════════════════════════════════════════════════════════════════╣',
      '║  FIX: Run migrations to update your database schema:             ║',
      '║                                                                  ║',
      '║    pnpm -C backend db:migrate                                    ║',
      '║                                                                  ║',
      '╚══════════════════════════════════════════════════════════════════╝',
      '',
    ].join('\n');

    console.error(message);

    if (exitOnFailure) {
      console.error('Exiting due to schema drift (dev mode).');
      process.exit(1);
    }
  }

  return missing;
}

/**
 * Run schema guard (dev-only by default)
 * In production, logs warning but doesn't exit
 */
export async function runSchemaGuard(): Promise<void> {
  const isDev = process.env.NODE_ENV !== 'production';
  
  try {
    const missing = await validateSchemaColumns(isDev);
    
    if (missing.length === 0) {
      logger.info('[SchemaGuard] All critical columns verified');
    }
  } catch (error) {
    console.error('[SchemaGuard] Failed to validate schema:', error);
    // Don't exit on validation error - DB might not be ready yet
  }
}

