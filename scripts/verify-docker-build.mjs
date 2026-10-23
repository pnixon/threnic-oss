import { execSync } from 'node:child_process';

console.log('\n🐳 Verifying Docker build integrity...');

try {
  // Run docker build with BuildKit enabled for cache mounts
  execSync('docker build . -t threnic-ci-test', {
    stdio: 'inherit',
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
  });

  console.log('✅ Docker build passed.\n');
} catch (_error) {
  console.error('\n❌ Docker build failed! Please fix build errors before committing.\n');
  process.exit(1);
}
