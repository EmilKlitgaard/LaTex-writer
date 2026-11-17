// node scripts/same-deps.mjs <package-lock.json> <installed copy of it>
// Exits 0 when the two lock files pin the same dependencies, so nothing needs installing again.
// LaTeX Writer's own version is left out of the comparison: every release raises it, and that
// alone used to reinstall every dependency at the first start after an update.
import fs from 'node:fs'

function deps(file) {
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete lock.version
  if (lock.packages?.['']) delete lock.packages[''].version
  return JSON.stringify(lock)
}

try {
  process.exit(deps(process.argv[2]) === deps(process.argv[3]) ? 0 : 1)
} catch {
  // A missing or unreadable copy means: install.
  process.exit(1)
}
