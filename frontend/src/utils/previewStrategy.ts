export type PreviewCapability = 'sandpack' | 'not-previewable';

export interface PreviewAnalysis {
  capability: PreviewCapability;
  reason: string;
  framework: 'react' | 'vue' | 'vanilla' | 'unknown';
  hasBackendDependency: boolean;
  hasMobilePlatform: boolean;
}

const BACKEND_INDICATORS = [
  'express', 'fastify', 'nestjs', '@nestjs/core', 'koa', 'hapi',
  'django', 'flask', 'prisma', '@prisma/client', 'mongoose',
  'pg', 'mysql2', 'sequelize', 'typeorm',
];

const MOBILE_INDICATORS = [
  'react-native', 'expo', '@react-native', 'flutter',
  '@capacitor/core', '@ionic/react',
];

const BACKEND_SOURCE_PATTERNS: RegExp[] = [
  /fetch\(\s*['"`]\/api\//,
  /fetch\(\s*['"`]https?:\/\//,
  /from\s+['"]axios['"]/,
  /from\s+['"]@supabase\//,
  /from\s+['"]firebase\//,
];

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function scanSourceForBackendCalls(files: Record<string, string>): boolean {
  for (const [path, content] of Object.entries(files)) {
    if (!SCAN_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
    for (const pattern of BACKEND_SOURCE_PATTERNS) {
      if (pattern.test(content)) return true;
    }
  }
  return false;
}

export function analyzePreviewCapability(
  files: Record<string, string>,
): PreviewAnalysis {
  const pkgContent = files['package.json'];

  let hasBackendDependency = false;
  let hasMobilePlatform = false;
  let framework: PreviewAnalysis['framework'] = 'unknown';

  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const depNames = Object.keys(allDeps);

      hasBackendDependency = depNames.some(d => BACKEND_INDICATORS.some(b => d.includes(b)));
      hasMobilePlatform = depNames.some(d => MOBILE_INDICATORS.some(m => d.includes(m)));

      if (depNames.includes('react') || depNames.includes('react-dom')) framework = 'react';
      else if (depNames.includes('vue')) framework = 'vue';
      else framework = 'vanilla';
    } catch {
      framework = 'vanilla';
    }
  } else {
    const hasJsx = Object.keys(files).some(f => f.endsWith('.jsx') || f.endsWith('.tsx'));
    framework = hasJsx ? 'react' : 'vanilla';
  }

  if (hasMobilePlatform) {
    return {
      capability: 'not-previewable',
      reason: 'Mobil uygulama tarayıcıda önizlenemez. Projeyi klonlayıp yerel ortamınızda çalıştırabilirsiniz.',
      framework, hasBackendDependency, hasMobilePlatform,
    };
  }

  if (hasBackendDependency) {
    return {
      capability: 'not-previewable',
      reason: 'Bu uygulama sunucu (backend) gerektirir ve tarayıcıda önizlenemez. Projeyi klonlayıp yerel ortamınızda çalıştırabilirsiniz.',
      framework, hasBackendDependency, hasMobilePlatform,
    };
  }

  if (scanSourceForBackendCalls(files)) {
    return {
      capability: 'not-previewable',
      reason: 'Bu uygulama bir API sunucusu gerektiriyor; tarayıcıda önizlenemez.',
      framework,
      hasBackendDependency: true,
      hasMobilePlatform,
    };
  }

  return {
    capability: 'sandpack',
    reason: 'Uygulama tarayıcıda önizlenebilir.',
    framework, hasBackendDependency, hasMobilePlatform,
  };
}
