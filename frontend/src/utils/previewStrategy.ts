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

  return {
    capability: 'sandpack',
    reason: 'Uygulama tarayıcıda önizlenebilir.',
    framework, hasBackendDependency, hasMobilePlatform,
  };
}
