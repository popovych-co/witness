// The one answer to "did node run THIS file as its entry point?" for the scripts whose
// module body doubles as a CLI (row 165). Node resolves the entry from the realpath of
// argv[1] and sets the entry module's import.meta.url to that file's URL, so the test
// derives the same URL the same way. The template it replaces, `file://${argv[1]}`, is
// not that URL on Windows (`file://C:\…` against `file:///C:/…`), nor anywhere a path
// needs escaping or runs through a symlink — and the miss was silent: the script loaded,
// skipped its CLI block and exited 0, so a release was never cut and a gate never ran.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @param {string} moduleUrl the calling module's import.meta.url */
export function isMain(moduleUrl) {
  // undefined under `node -e` and the REPL; under `node -e <code> <arg>` argv[1] is the
  // user's argument, which may name nothing — either way this file is not the entry.
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
